/* 说明：app/main.c — 守护进程入口与事件编排【接入层】
 * 
 * 职责：进程生命周期（信号、Root 校验）、事件源装配（inotify / eventfd / epoll）、
 * 主循环状态机（前台切换 / 触摸相位 / 配置热更新）、退出收尾。
 * 
 * 约束：本层只做编排与委托，不含业务规则；
 * 一切能力均经头文件声明的窄接口调用，不触碰任何模块的私有状态。
 * 
 * 事件源与响应：
 * manual_mode.txt 增/改 → 解析并立即应用；删除 → 恢复自动模式
 * cpu_policy.json / pkg_rules.json 改动 → 热重载 + 重新探测
 * /dev/cpuset/top-app 变更 → 只触发重新探测
 * touch fd → 触摸观测发布；领域状态机负责短触摸、长触摸及有限尾段
 * probe fd → 探测结果就绪，切模式并重置触摸相位基线
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "../output/log.h"
#include "../core/util.h"
#include "../core/state.h"
#include "../compute/config.h"
#include "../collect/touch.h"
#include "../compute/pkgrules.h"
#include "../collect/manualmode.h"
#include "../compute/mode.h"
#include "../compute/touch_policy.h"
#include "../compute/zone_window.h"
#include "../compute/cap.h"
#include "../collect/freq.h"
#include "probe.h"
#include "diag.h"
#include "../output/sysfs.h"
#include "../core/instance.h"
#include "../core/clock.h"
#include "../output/status.h"
#include "../output/metrics.h"

/* 说明：主循环独占：manual_mode.txt 的 inotify 监听描述符 */
static int wd_manual_file = -1;

/* 说明：耗电采样线程句柄（实现在 collect/battery/sampler.c） */
static pthread_t battery_thread_id;

static void sig_handler(int sig)
{
    if (sig == SIGINT || sig == SIGTERM || sig == SIGHUP)
        atomic_store(&g_running, 0);
}

/* 说明：接入层只组合公开接口的观测值，健康落盘不反向依赖业务模块。 */
static char g_freq_text[512] = "";
/* 说明：v2.5.6：每个核组当前用的策略区域（"id:zone,..."），随运行快照一起发布，
 * 供诊断与界面直接读取——之前诊断进程读到的永远是自己的默认 0。 */
static char g_zone_text[128] = "";
/* 说明：v2.5.8：每核组当前的最大频上限（"id:khz,..."），随运行快照发布。 */
static char g_cap_text[256] = "";
static unsigned long long g_cap_now[MAX_CLUSTERS];
/* 说明：v2.5.13：内核真正接受的上限（写入后读回）。请求值可能是非真实频点，
 * 内核会向下取整，顶住判定必须用这个值，否则永远顶不住、永远不解锁。 */
static unsigned long long g_cap_effective[MAX_CLUSTERS];
/* 说明：v2.5.6：最近一次「有用户输入」的时刻。触摸、前台切换、配置热重载都会刷新它；
 * 长时间没有输入时主循环降低唤醒频率（见循环头的空闲退避）。 */
static uint64_t g_last_input_ms;
/* 说明：v2.5.9：单实例自检。模块升级会整体替换目录，锁文件换 inode，
 * 旧实例的 flock 落在已删除的文件上——新实例照样能拿到锁，两个一起写 sysfs。
 * 每 5 秒核对自己的锁还是不是当前那个 inode，不是就干净退出、不再碰硬件。 */
static uint64_t g_last_fence_ms;
static int g_fenced;
#define FENCE_CHECK_MS 5000
/* 说明：分区 boost 变化检测：只在 boost 值或所在区变化时记日志，避免高频采样刷屏。 */
static int g_last_zone_boost[MAX_CLUSTERS];
static int g_last_zone_idx[MAX_CLUSTERS];
static int g_zone_logged[MAX_CLUSTERS];
/* 说明：上次成功写入 boost 的时刻，用于 2 秒强制重写（防外部覆盖）。 */
static uint64_t g_last_zone_write[MAX_CLUSTERS];
/* 说明：区域切换迟滞。按区域取策略意味着「写下去的 min_freq 会改变当前频率」，
 * 而频率又决定区域——不加迟滞会在边界附近来回震荡（每轮都重下发一整批参数）。
 *
 * v2.5.7 改用「多数决窗口」：早先要求「同一区域连续 3 次采样」，
 * 但真机上大核频率在 768MHz 与 3648MHz 之间反复跳，连续同区几乎不成立，
 * 结果是区域策略永远停在 0 区（日志里 4.7 分钟只提交过 1 次）。
 * 现在看最近 8 次采样里有没有某个区严格过半：五五开抖动不提交，
 * 真的长期待在某个区就很快提交。提交后 1 秒内不再切换。 */
static ZoneWindow g_zone_window[MAX_CLUSTERS];
static uint64_t g_zone_switch_at[MAX_CLUSTERS];
#define ZONE_DWELL_MS   1000
#define ZONE_MIN_SAMPLES 4   /* 说明：窗口至少攒到 4 次采样（约 0.3 秒）才认多数 */

/* 说明：v2.5.8 动态限最大频的档位状态（状态机本身在 compute/cap.c，纯函数）。
 * 这里只留「上次写下去的 kHz」与「上次写入时刻」用于去重和周期性重写。 */
static CapState g_cap[MAX_CLUSTERS];
static unsigned long long g_cap_written[MAX_CLUSTERS];
static uint64_t g_cap_write_at[MAX_CLUSTERS];
#define CAP_REWRITE_MS 2000

static void publish_status(int stopping)
{
    char current_pkg[256];
    pthread_mutex_lock(&g_pkg_mtx);
    safe_strncpy(current_pkg, g_current_pkg, sizeof(current_pkg));
    pthread_mutex_unlock(&g_pkg_mtx);
    StatusSnapshot snapshot = {
        .stopping = stopping,
        .config_valid = config_is_valid(),
        .config_revision = config_get_revision(),
        .mode = mode_names[g_current_mode],
        .package = current_pkg,
        .touch_available = touch_is_available(),
        .log_level = log_level(),
        .start_ticks = instance_start_ticks(),
        .frequencies = g_freq_text,
        .zones = g_zone_text,
        .caps = g_cap_text
    };
    status_publish(&snapshot);
}

int main(int argc, char **argv)
{
    /* 说明：候选校验必须在实例锁、日志和线程启动前退出，不影响线上守护进程。 */
    /* 说明：诊断导出必须在实例锁之前，才能在守护进程运行中随时调用。 */
    if (argc == 2 && !strcmp(argv[1], "--diag")) {
        return diag_run();
    }

    if (argc == 3 && !strcmp(argv[1], "--check-config")) {
        int valid = config_check_file(argv[2]);
        if (valid) puts("配置校验通过");
        else fputs("配置校验失败：请检查结构、模板、数值及上下限关系\n", stderr);
        return valid ? 0 : 2;
    }

    struct sigaction sa;
    sa.sa_handler = sig_handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = SA_RESTART;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);
    signal(SIGCHLD, SIG_IGN);
    signal(SIGPIPE, SIG_IGN);

    if (geteuid() != 0) {
        LOG_FATAL("权限缺失！必须以 Root (UID=0) 环境执行");
        return 1;
    }

    if(argc!=1){fprintf(stderr,"Usage: %s\n",argv[0]);return 2;}
    if(instance_start()){LOG_ERROR("已有运行实例或无法取得进程锁");return 1;}
    load_config();
    load_pkg_rules();

    int inotify_fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if (inotify_fd < 0) {
        LOG_FATAL("inotify 初始化失败");
        return 1;
    }

    /* 说明：保持与 shell 脚本的 :Mc 完全一致的监控级别 (修改与创建) */
    int wd_tasks = inotify_add_watch(inotify_fd, CPUSET_TOP_APP_DIR, IN_MODIFY | IN_CREATE);
    int wd_conf  = inotify_add_watch(inotify_fd, MODULE_DIR,
                                     IN_CLOSE_WRITE | IN_MOVED_TO | IN_MOVED_FROM | IN_CREATE | IN_DELETE);

    int epoll_fd = epoll_create1(EPOLL_CLOEXEC);
    if (epoll_fd < 0) {
        LOG_FATAL("epoll 创建失败");
        return 1;
    }

    struct epoll_event ev, events[5];

    ev.events  = EPOLLIN;
    ev.data.fd = inotify_fd;
    epoll_ctl(epoll_fd, EPOLL_CTL_ADD, inotify_fd, &ev);

    /* 说明：启动时检查手动模式文件是否存在 */
    struct stat mst;
    if (stat(MANUAL_MODE_FILE, &mst) == 0) {
        wd_manual_file = inotify_add_watch(inotify_fd, MANUAL_MODE_FILE,
                                           IN_CLOSE_WRITE);
        if (wd_manual_file >= 0) {
            atomic_store(&g_manual_override, 1);
            RunMode m = parse_manual_mode_file();
            if (m != MODE_COUNT) g_current_mode = m;
        }
    }

    /* 说明：顺序约束：touch_start()/probe_start() 内部才创建 eventfd，
 * touch_event_fd()/probe_event_fd() 在 start 之前只能返回 -1。
 * 若先取 fd 再注册，epoll_ctl 会以 EBADF 失败，
 * 触摸与探测事件就永远唤醒不了主循环（退化为 100ms 轮询）。
 * 因此必须先 start、后取 fd、再注册。
 */
    if (touch_start() != 0 || probe_start() != 0 ||
        pthread_create(&battery_thread_id, NULL, battery_worker, NULL) != 0) {
        LOG_FATAL("工作线程创建失败");
        return 1;
    }

    int touch_fd = touch_event_fd();
    if (touch_fd >= 0) {
        ev.data.fd = touch_fd;
        if (epoll_ctl(epoll_fd, EPOLL_CTL_ADD, touch_fd, &ev) != 0)
            LOG_ERROR("触摸事件 fd 注册失败 (errno=%d)，触摸相位将退化为轮询", errno);
    }

    int probe_fd = probe_event_fd();
    ev.data.fd = probe_fd;
    if (epoll_ctl(epoll_fd, EPOLL_CTL_ADD, probe_fd, &ev) != 0)
        LOG_ERROR("探测事件 fd 注册失败 (errno=%d)，前台切换将退化为轮询", errno);

    char pkg[256] = {0};
    ApplyStats stats;

    RunMode detected=determine_mode(pkg, sizeof(pkg));
    if(!atomic_load(&g_manual_override))g_current_mode=detected;
    pthread_mutex_lock(&g_pkg_mtx);
    safe_strncpy(g_current_pkg, pkg, sizeof(g_current_pkg));
    pthread_mutex_unlock(&g_pkg_mtx);

    config_apply_phase_for(g_current_mode, POLICY_IDLE, &stats);

    /* 说明：启动横幅把所有"后续分析需要的坐标"一次交代清楚：版本能力、配置代次、
     * 初始模式判定来源、日志级别。出问题时不用再猜当时是什么状态。 */
    LOGI(MOD_BOOT, "start pid=%d cfg_valid=%d cfg_rev=%llu pkg=%s mode=%s log_level=%d touch=%d",
         (int)getpid(), config_is_valid() ? 1 : 0,
         (unsigned long long)config_get_revision(),
         g_current_pkg, mode_names[g_current_mode], log_level(), touch_is_available());

    /* 说明：启动输出频率分区配置摘要，便于确认分区是否生效、边界与弯曲度是否按预期加载。 */
    {
        ZoneConfig zc;
        config_get_mode_zones(g_current_mode, &zc);
        if (zc.enabled) {
            LOGI(MOD_ZONE, "enabled sample_ms=%d clusters=%d", zc.sample_ms, zc.cluster_count);
            for (int i = 0; i < MAX_CLUSTERS; i++) {
                ClusterZone *cz = &zc.clusters[i];
                if (cz->linear_end > 0) {
                    LOGI(MOD_ZONE, "cfg c=%d linear_end=%llu decay_end=%llu L[bend=%d %d..%d] D[bend=%d %d..%d] S[bend=%d %d..%d]",
                             i, cz->linear_end, cz->decay_end,
                             cz->zones[0].bend, cz->zones[0].start, cz->zones[0].end,
                             cz->zones[1].bend, cz->zones[1].start, cz->zones[1].end,
                             cz->zones[2].bend, cz->zones[2].start, cz->zones[2].end);
                }
            }
        } else {
            LOGI(MOD_ZONE, "disabled reason=zones.enabled=false boost=untouched");
        }
    }

    TouchPolicy touch_policy = {0};
    TouchSettings touch_timing;
    TouchSample touch_sample;
    int touch_reset = 0;
    int probe_pending_logged = 0;
    uint64_t last_probe=runtime_now_ms();
    ZoneConfig zones;
    MaxFreqSettings maxfreq;
    FreqSample freq_samples[MAX_CLUSTERS];
    uint64_t last_zone_sample = 0;

    memset(&maxfreq, 0, sizeof(maxfreq));
    g_last_input_ms = runtime_now_ms();
    int nfds = 0, timeout = 100;
    long long __ep_t0 = 0, __ep_us = 0;
    while (atomic_load(&g_running)) {
        long long __loop_t0 = metrics_now_us();
        config_get_touch_settings(&touch_timing);
        touch_get_sample(&touch_sample);
        /* 说明：v2.5.6 空闲退避。原先最大等待固定 100ms，手机静置时主循环也每秒醒 10 次，
         * 每次都要采样频率 + 可能的 sysfs 写入，实测约 1% 的一整个核心常年白烧。
         * 触摸线程有自己的 eventfd，按下会立刻唤醒主循环，所以放宽等待不影响触摸响应；
         * 只有「完全没有输入」才逐步退到 300ms / 1s。 */
        {
            uint64_t wait_now = runtime_now_ms();
            int max_wait = 100;
            if (!touch_sample.active) {
                uint64_t idle = wait_now > g_last_input_ms ? wait_now - g_last_input_ms : 0;
                if (idle >= 30000) max_wait = 1000;
                else if (idle >= 3000) max_wait = 300;
            }
            timeout = touch_policy_timeout(&touch_sample,&touch_timing,runtime_boot_ms(),max_wait);
        }
        __ep_t0 = metrics_now_us();
        nfds = epoll_wait(epoll_fd, events, 5, timeout);
        __ep_us = metrics_now_us() - __ep_t0;
        metric_add(metrics_slot(MET_EPOLL), __ep_us, 0);
        metric_inc(CNT_LOOP, 1);
        if (nfds < 0) {
            if (errno == EINTR)
                continue;
            LOG_FATAL("epoll_wait 异常 (%d)", errno);
            break;
        }

        int trigger_recheck = 0;
        uint64_t now=runtime_now_ms();
        /* 说明：v2.5.9 单实例自检：被新实例接管就停手，别和新实例抢同一个节点。 */
        if (now - g_last_fence_ms >= FENCE_CHECK_MS) {
            g_last_fence_ms = now;
            if (!instance_lock_still_ours()) {
                g_fenced = 1;
                LOGE(MOD_BOOT, "锁已被新实例接管，旧实例退出 pid=%d", (int)getpid());
                atomic_store(&g_running, 0);
            }
        }
        /* 说明：v2.5.7：前台探测是 fork dumpsys，实测每次约 32ms、约两秒一次
         * （≈一整个核心的 1.8%），比主循环本身还贵。真正的切换由 /dev/cpuset/top-app
         * 的 inotify 即时触发，这里只是兜底轮询，放宽到 5 秒。 */
        if(now-last_probe>=5000){probe_request();last_probe=now;}
        sysfs_flush_status(0);
        publish_status(0);

        /* 说明：周期采集各 cluster 当前频率供状态页展示；zones 启用时额外按分区公式写 boost。
         * 采样间隔是公用的（区域判定 / 动态限最大频 / boost / 频率展示共用 sample_ms），
         * 与「写入动态 boost」开关无关；v2.5.10 起缺省 10ms。 */
        config_get_mode_zones(g_current_mode, &zones);
        {
            MaxFreqSettings mf;
            config_get_maxfreq(&mf);
            maxfreq = mf;
        }
        {
            int interval = zones.sample_ms > 0 ? zones.sample_ms : 10;
            if (!zones.enabled && !maxfreq.enabled && interval < 200) interval = 200;
            if (now - last_zone_sample >= (uint64_t)interval) {
                last_zone_sample = now;
                long long __ft0 = metrics_now_us();
                int nfreq = freq_sample(freq_samples, MAX_CLUSTERS);
                metric_add(metrics_slot(MET_FREQ_SAMPLE), metrics_now_us() - __ft0, 5000);
                if (nfreq > 0) {
                    int off = 0, zoff = 0, coff = 0;
                    g_cap_text[0] = 0;
                    for (int i = 0; i < nfreq && off < (int)sizeof(g_freq_text) - 16; i++) {
                        FreqSample *fs = &freq_samples[i];
                        if (!fs->valid) continue;
                        off += snprintf(g_freq_text + off, sizeof(g_freq_text) - off,
                                        "%s%d:%llu", off ? "," : "", fs->id, fs->cur_freq);
                        if (zoff < (int)sizeof(g_zone_text) - 12)
                            zoff += snprintf(g_zone_text + zoff, sizeof(g_zone_text) - zoff,
                                             "%s%d:%d", zoff ? "," : "", fs->id,
                                             config_cluster_zone(fs->id));
                        if (coff < (int)sizeof(g_cap_text) - 24)
                            coff += snprintf(g_cap_text + coff, sizeof(g_cap_text) - coff,
                                             "%s%d:%llu", coff ? "," : "", fs->id,
                                             g_cap_now[fs->id]);
                    }
                }
                /* 说明：v2.5.5：区域选择与 boost 写入分开。
                 * 区域决定「用哪一套策略」，即使 boost 写入被关掉也必须跟踪；
                 * 只有 boost 值的计算与写入受 zones.enabled 控制。 */
                {
                    int zone_reapply = 0;
                    for (int i = 0; i < nfreq; i++) {
                        FreqSample *fs = &freq_samples[i];
                        ClusterZone *cz;
                        int boost, idx;
                        if (!fs->valid || fs->id < 0 || fs->id >= MAX_CLUSTERS) continue;
                        cz = &zones.clusters[fs->id];
                        if (cz->linear_end == 0) continue; /* 说明：该 cluster 未配置分区，跳过 */
                        idx = zone_index(cz, fs->min_freq, fs->max_freq, fs->cur_freq);

                        /* 说明：动态限最大频与 boost 开关无关，先跑它再决定是否写 boost。 */
                        if (maxfreq.enabled) {
                            CapDecision d = cap_step(&g_cap[fs->id], cz, fs, &maxfreq, now,
                                                     g_cap_effective[fs->id]);
                            g_cap_now[fs->id] = g_cap_effective[fs->id] ? g_cap_effective[fs->id] : d.cap;
                            if (d.changed)
                                LOGD(MOD_ZONE, "cap c=%d %s level=%d cap=%llu eff=%llu freq=%llu",
                                     fs->id, d.changed > 0 ? "up" : "down", d.level, d.cap,
                                     g_cap_effective[fs->id], fs->cur_freq);
                            int stale = (now - g_cap_write_at[fs->id]) >= CAP_REWRITE_MS;
                            if (d.changed || stale || d.cap != g_cap_written[fs->id]) {
                                unsigned long long eff = 0;
                                if (sysfs_write_maxfreq(fs->id, d.cap, &eff) != 0) {
                                    metric_inc(CNT_MAXFREQ_FAIL, 1);
                                    LOGE(MOD_ZONE, "cap_wr_fail c=%d cap=%llu level=%d",
                                         fs->id, d.cap, d.level);
                                } else {
                                    metric_inc(CNT_MAXFREQ_APPLY, 1);
                                    g_cap_written[fs->id] = d.cap;
                                    g_cap_effective[fs->id] = eff ? eff : d.cap;
                                    g_cap_write_at[fs->id] = now;
                                    if (eff && eff != d.cap)
                                        LOGD(MOD_ZONE, "cap c=%d 请求=%llu 实际=%llu（内核取整/平台钳制）",
                                             fs->id, d.cap, eff);
                                }
                            }
                        }
                        zone_window_push(&g_zone_window[fs->id], idx);
                        {
                            int window_total = 0;
                            int majority = zone_window_majority(&g_zone_window[fs->id], &window_total);
                            if (majority >= 0 && majority != config_cluster_zone(fs->id) &&
                                window_total >= ZONE_MIN_SAMPLES &&
                                now - g_zone_switch_at[fs->id] >= ZONE_DWELL_MS) {
                                config_set_cluster_zone(fs->id, majority);
                                g_zone_switch_at[fs->id] = now;
                                zone_reapply = 1;
                                LOGD(MOD_ZONE, "switch c=%d zone=%d freq=%llu window=%d/%d",
                                     fs->id, majority, fs->cur_freq, window_total, ZONE_WINDOW_SIZE);
                            }
                        }

                        if (!zones.enabled) { g_last_zone_idx[fs->id] = idx; continue; }
                        long long __zt0 = metrics_now_us();
                        boost = zone_compute_boost(cz, fs->min_freq, fs->max_freq, fs->cur_freq);
                        metric_add(metrics_slot(MET_ZONE_CALC), metrics_now_us() - __zt0, 2000);
                        /* 说明：降噪。进入新区间才记详细；同区内 boost 微变只记追踪，
                         * 否则 10ms 采样会把日志刷屏（实测 12 分钟 9500+ 条）。 */
                        if (!g_zone_logged[fs->id] || idx != g_last_zone_idx[fs->id]) {
                            LOGD(MOD_ZONE, "enter c=%d zone=%d freq=%llu boost=%d border=%llu/%llu",
                                 fs->id, idx, fs->cur_freq, boost, cz->linear_end, cz->decay_end);
                        } else if (boost != g_last_zone_boost[fs->id]) {
                            LOGT(MOD_ZONE, "move c=%d zone=%d freq=%llu boost %d->%d",
                                 fs->id, idx, fs->cur_freq, g_last_zone_boost[fs->id], boost);
                        }
                        /* 说明：只在 boost 值真的变了才写 sysfs。
                         * 10ms 采样下，同一频点内 boost 是不变的；原先每次采样都 open/write/read/close
                         * 一遍，实测 40 分钟写了 72308 次（30 次/秒），白烧约 12 秒 CPU。
                         * 同时保留每 2 秒一次的强制重写：高通 perfmgr / PowerHAL 会覆盖这个值，
                         * 不重写就会被外部改写丢失。 */
                        int changed = !g_zone_logged[fs->id] || boost != g_last_zone_boost[fs->id];
                        int stale = (now - g_last_zone_write[fs->id]) >= 2000;
                        if (changed || stale) {
                            if (sysfs_write_boost(fs->id, boost) != 0) {
                                metric_inc(CNT_ZONE_FAIL, 1);
                                LOGE(MOD_ZONE, "boost_wr_fail c=%d boost=%d freq=%llu zone=%d",
                                     fs->id, boost, fs->cur_freq, idx);
                            } else {
                                metric_inc(CNT_ZONE_APPLY, 1);
                                g_last_zone_write[fs->id] = now;
                            }
                        } else {
                            metric_inc(CNT_ZONE_SKIP, 1);
                        }
                        g_zone_logged[fs->id] = 1;
                        g_last_zone_boost[fs->id] = boost;
                        g_last_zone_idx[fs->id] = idx;
                    }
                    /* 说明：区域变了，该核组要用另一套参数——按当前阶段重下发一次。
                     * 这里用的是「已下发的阶段」，不会把触摸状态机带跑。 */
                    if (zone_reapply && config_has_applied()) {
                        long long __zr = metrics_now_us();
                        config_apply_phase_for(g_current_mode, config_current_phase(), &stats);
                        metric_add(metrics_slot(MET_WRITE), metrics_now_us() - __zr, 5000);
                        LOGD(MOD_ZONE, "reapply phase=%d mode=%s", (int)config_current_phase(), mode_names[g_current_mode]);
                    }
                }
            }
        }

        for (int n = 0; n < nfds; ++n) {
            if (events[n].data.fd == inotify_fd) {
                char ibuf[16384] __attribute__((aligned(_Alignof(struct inotify_event))));
                ssize_t len = read(inotify_fd, ibuf, sizeof(ibuf));
                if (len > 0) {
                    for (char *p = ibuf; p < ibuf + len; ) {
                        struct inotify_event *ie = (struct inotify_event *)p;
                        if (p + sizeof(struct inotify_event) + ie->len > ibuf + len)
                            break;

                        /* 说明：1. 手动模式文件内容修改监听 */
                        if (ie->wd == wd_manual_file) {
                            RunMode m = parse_manual_mode_file();
                            if (m != MODE_COUNT) {
                                g_current_mode = m; /* 说明：无论模式是否变化，都更新状态并执行应用 */
                                config_apply_phase_for(g_current_mode, POLICY_IDLE, &stats);
                                LOG_INFO("手动模式配置应用 -> %s", mode_names[g_current_mode]);
                            }
                            touch_reset = 1;
                        }
                        /* 说明：2. 模块目录事件监听 (处理手动文件创建/删除 & JSON重载) */
                        else if (ie->wd == wd_conf && ie->len > 0) {
                            if (strcmp(ie->name, "manual_mode.txt") == 0) {
                                if (ie->mask & (IN_CREATE | IN_MOVED_TO)) {
                                    wd_manual_file = inotify_add_watch(inotify_fd, MANUAL_MODE_FILE,
                                                                       IN_CLOSE_WRITE);
                                    if (wd_manual_file >= 0) {
                                        atomic_store(&g_manual_override, 1);
                                        RunMode m = parse_manual_mode_file();
                                        if (m != MODE_COUNT) {
                                            g_current_mode = m;
                                            config_apply_phase_for(g_current_mode, POLICY_IDLE, &stats);
                                            LOG_INFO("检测到手动模式文件 -> %s", mode_names[g_current_mode]);
                                        }
                                    }
                                    touch_reset = 1;
                                } else if (ie->mask & (IN_DELETE | IN_MOVED_FROM)) {
                                    if (wd_manual_file >= 0) {
                                        inotify_rm_watch(inotify_fd, wd_manual_file);
                                        wd_manual_file = -1;
                                    }
                                    atomic_store(&g_manual_override, 0);
                                    LOG_INFO("手动模式文件已移除，恢复自动包名模式");
                                    trigger_recheck = 1;
                                }
                            }
                            if (strcmp(ie->name, "cpu_policy.json") == 0 ||
                                strcmp(ie->name, "pkg_rules.json") == 0) {
                                load_config();
                                load_pkg_rules();
                                /* 说明：v2.5.6：新配置可能故意把节点改回旧值，
                                 * 频率的静态缓存也要重读（核组可能变了）。 */
                                sysfs_invalidate_write_cache();
                                freq_invalidate();
                                /* 说明：边界可能变了，限频档位与计时全部重来，
                                 * 否则会拿着旧边界算出的档位继续压。 */
                                for (int c = 0; c < MAX_CLUSTERS; c++) {
                                    cap_state_reset(&g_cap[c]);
                                    g_cap_written[c] = 0;
                                    g_cap_effective[c] = 0;
                                    g_cap_write_at[c] = 0;
                                }
                                g_last_input_ms = runtime_now_ms();
                                config_apply_phase_for(g_current_mode,POLICY_IDLE,&stats);
                                touch_reset=1;
                                trigger_recheck = 1;
                            }
                        } else if (ie->wd == wd_tasks) {
                            trigger_recheck = 1;
                        }
                        p += sizeof(struct inotify_event) + ie->len;
                    }
                }
            } else if (events[n].data.fd == touch_fd ||
                       events[n].data.fd == probe_fd) {
                uint64_t u;
                read(events[n].data.fd, &u, sizeof(uint64_t));
            }
        }

        char probe_pkg[256] = {0};
        RunMode probe_mode = MODE_POWERSAVE;
        if (probe_take_result(probe_pkg, sizeof(probe_pkg), &probe_mode)) {

            RunMode new_mode = atomic_load(&g_manual_override) ? g_current_mode : probe_mode;
            if (new_mode != g_current_mode ||
                strcmp(probe_pkg, g_current_pkg) != 0) {
                pthread_mutex_lock(&g_pkg_mtx);
                safe_strncpy(g_current_pkg, probe_pkg,
                             sizeof(g_current_pkg));
                pthread_mutex_unlock(&g_pkg_mtx);
                RunMode __prev = g_current_mode;
                g_current_mode = new_mode;

                long long __sw_t0 = metrics_now_us();
                config_apply_phase_for(g_current_mode, POLICY_IDLE, &stats);
                metric_add(metrics_slot(MET_WRITE), metrics_now_us() - __sw_t0, 5000);
                if (__prev != g_current_mode) metric_inc(CNT_MODE_SWITCH, 1);
                /* 说明：结构化的前台切换记录。带 from/to 模式，事后能算出各模式的实际驻留时长。 */
                /* 说明：v2.5.7：前台切换每次都记一条 I 级日志太吵（切一次应用一条）。
                 * 模式真的变了才升到 I 级——那才是需要留档的事件。 */
                if (__prev != g_current_mode)
                    LOGI(MOD_BOOT, "focus pkg=%s mode=%s from=%s writ=%d match=%d diff=%d ms=%lld",
                         g_current_pkg, mode_names[g_current_mode], mode_names[__prev],
                         stats.sysfs_ok, stats.readback_ok, stats.readback_mismatch,
                         (metrics_now_us() - __sw_t0) / 1000);
                else
                    LOGD(MOD_BOOT, "focus pkg=%s mode=%s from=%s writ=%d match=%d diff=%d ms=%lld",
                         g_current_pkg, mode_names[g_current_mode], mode_names[__prev],
                         stats.sysfs_ok, stats.readback_ok, stats.readback_mismatch,
                         (metrics_now_us() - __sw_t0) / 1000);
                touch_reset = 1;
                g_last_input_ms = runtime_now_ms();
            }
        } else if (trigger_recheck && !probe_pending_logged) {
            probe_request();
            probe_pending_logged = 1;
        } else if (!trigger_recheck) {
            probe_pending_logged = 0;
        }

        /* 说明：业务时序独立于输入线程；只在相位变化或模式重置时下发受控参数。 */
        config_get_touch_settings(&touch_timing);
        touch_get_sample(&touch_sample);
        PolicyPhase phase = touch_policy_step(&touch_policy,&touch_sample,&touch_timing,
                                               runtime_boot_ms(),touch_reset);
        touch_reset = 0;
        if (phase != POLICY_PHASE_COUNT) {
            g_last_input_ms = runtime_now_ms();
            long long __ph_t0 = metrics_now_us();
            config_apply_phase_for(g_current_mode,phase,&stats);
            metric_add(metrics_slot(MET_WRITE), metrics_now_us() - __ph_t0, 5000);
            metric_inc(CNT_PHASE_SWITCH, 1);
            /* 说明：结构化一行，键值可直接被脚本/模型解析，不需要在中文里找片段。 */
            LOGI(MOD_TOUCH, "phase=%d(%s) pkg=%s mode=%s writ=%d match=%d diff=%d miss=%d err=%d ms=%lld",
                 (int)phase,
                 phase==POLICY_IDLE?"idle":phase==POLICY_TOUCH_DOWN?"down":phase==POLICY_TOUCH_UP?"up":
                 phase==POLICY_TOUCH_LONG?"long":"restore",
                 g_current_pkg, mode_names[g_current_mode],
                 stats.sysfs_ok, stats.readback_ok, stats.readback_mismatch,
                 stats.sysfs_missing, stats.sysfs_err,
                 (metrics_now_us() - __ph_t0) / 1000);
        }
        /* 说明：只统计「处理耗时」——必须扣掉 epoll_wait 的阻塞时间。
         * 早先把等待时间算进去，导致 loop 均值 84ms、90% 被误判为慢，
         * 掩盖了真实处理只用了不到 1ms 这个事实。 */
        long long __busy = (metrics_now_us() - __loop_t0) - __ep_us;
        if (__busy < 0) __busy = 0;
        metric_add(metrics_slot(MET_LOOP), __busy, 16000);
        /* 说明：每 60 秒输出一次性能快照（函数内部限频）。 */
        metrics_report(0);
    }

    LOG_INFO("收到退出信号，保存耗电数据并释放资源");
    atomic_store(&g_running, 0);
    publish_status(1);
    struct timespec ts = {0, 100000000};
    nanosleep(&ts, NULL);

    /* 说明：1. 唤醒并回收触摸线程 */
    touch_stop();

    /* 说明：2. 唤醒并回收探测线程 */
    probe_stop();

    /* 说明：3. 回收耗电采样线程（退出前落盘） */
    pthread_join(battery_thread_id, NULL);

    /* 说明：被新实例接管时不要回写触摸基线——配置已经归新实例，回写等于拿旧值打架。 */
    if (!g_fenced) config_restore_touch();
    sysfs_flush_status(1);
    config_destroy_all();
    close(inotify_fd);
    close(epoll_fd);

    pthread_mutex_destroy(&g_pkg_mtx);

    instance_stop();
    LOG_INFO("守护进程已安全退出");
    log_close();
    return 0;
}