/* 说明：cpupow.h — 公共内核头
 *
 * 职责：公共系统头、路径宏、跨层共享类型、共享全局 extern、跨文件函数原型。
 * 所有 .c 均可 include，本头自身无业务依赖。
 *
 * 依赖方向：app（编排） -> collect（采集）/ compute（计算）/ output（输出）
 *                        -> core（公共内核）/ cpupow.h -> deps（第三方）
 */
#ifndef CUPOW_H
#define CUPOW_H

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <strings.h>
#include <errno.h>
#include <ctype.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <limits.h>

/* 说明：系统与网络 */
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <sys/signalfd.h>
#include <sys/wait.h>

/* 说明：高性能事件监控 */
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/inotify.h>

/* 说明：时间与随机数 */
#include <sys/random.h>
#include <sys/time.h>
#include <time.h>

/* 说明：Android 平台特定 */
#include <linux/input.h>
#include <linux/input-event-codes.h>

/* 说明：多线程与进程控制 */
#include <pthread.h>
#include <signal.h>

/* 说明：文件系统遍历与搜索 */
#include <dirent.h>
#include <glob.h>
#include <regex.h>
#include "cJSON.h"
#include "output/log.h"

/* 说明：---- 配置区宏（路径、上限） ---- */
/* 说明：[配置区] */
#define MAX_SYSFS_NODES     512
#define MAX_CACHED_PATHS    128
#define MAX_WALK_DEPTH      8

/* 说明：cpufreq sysfs 根目录；允许编译期 -DCPUPOW_CPUFREQ_ROOT='"/fake"' 覆盖，
 * 用于在隔离目录里跑频率采集与分区 boost 的自测（不触碰真实调频节点）。 */
#ifndef CPUPOW_CPUFREQ_ROOT
#define CPUPOW_CPUFREQ_ROOT "/sys/devices/system/cpu/cpufreq"
#endif

/* 说明：部署根目录。默认写死为模块安装路径；
 * 允许编译期用 -DMODULE_DIR='"/some/dir"' 覆盖——用于在隔离目录里跑
 * 编译产物的自测（不污染线上守护进程的日志与 profile）。
 * 注意：只有 MODULE_DIR 可覆盖，下面派生的路径宏全部基于它。
 */
#ifndef MODULE_DIR
#define MODULE_DIR               "/data/adb/modules/cpupow"
#endif
#define CONFIG_FILE              MODULE_DIR "/cpu_policy.json"
#define LOG_FILE_PATH            MODULE_DIR "/cpu_policy.log"
#define PKG_RULE_FILE            MODULE_DIR "/etc/pkg_rules.json"
#define MANUAL_MODE_FILE         MODULE_DIR "/manual_mode.txt"  /* 说明：新增：手动模式文件路径 */
#define CPUSET_TOP_APP_DIR       "/dev/cpuset/top-app/"

/* 说明：耗电采样相关上限（dump 字段名由前端 webroot 依赖，勿改） */
#define BATTERY_FILE             MODULE_DIR "/profile_battery.json"
#define BATT_MAX_APPS            16

/* 说明：v1.6.0：采样分桶 = 屏幕状态 × 触摸状态。息屏时无触摸事件，
 * v1.5.0 的 off_touch 是恒零死桶，已合并：桶 = 亮屏触摸/亮屏静止/息屏
 */
#define BATT_BUCKET_COUNT        3
/* 说明：桶序号 b = 亮屏 ? (触摸?0:1) : 2 */


/* 说明：---- 跨模块枚举与数据结构 ---- */
/* 说明：枚举与数据结构 */
typedef enum {
    MODE_POWERSAVE = 0,
    MODE_BALANCE,
    MODE_PERFORMANCE,
    MODE_FAST,
    MODE_COUNT
} RunMode;

static const char *mode_names[MODE_COUNT] = {
    [MODE_POWERSAVE]   = "powersave",
    [MODE_BALANCE]     = "balance",
    [MODE_PERFORMANCE] = "performance",
    [MODE_FAST]        = "fast"
};

typedef enum {
    POLICY_IDLE,
    POLICY_TOUCH_DOWN,
    POLICY_TOUCH_UP,
    POLICY_TOUCH_LONG,
    POLICY_TOUCH_IDLE,
    POLICY_PHASE_COUNT
} PolicyPhase;

/* 说明：输入快照使用含休眠的毫秒时钟；序号可识别两次主循环之间完成的点按。 */
typedef struct {
    int available;
    int active;
    uint64_t changed_ms;
    uint64_t down_ms;
    uint64_t sequence;
    uint64_t presses;
} TouchSample;

/* 说明：时序配置缺失时保留旧版二值事件语义，范围由配置模块校验。 */
typedef struct {
    int enabled;
    unsigned long_press_ms;
    unsigned release_delay_ms;
} TouchSettings;

/* 说明：v2.5.8 动态限最大频。
 * 用两条区域分界线（linear_end / decay_end）当「档位上限」：默认把每核组的
 * scaling_max_freq 压在 linear_end；持续顶住当前上限够久才解锁到下一档，
 * 直到硬件最高频率。打开后策略树不再写 scaling_max_freq（固定限最大频让位）。
 * 每档要顶住的时长由「解锁到哪一区」决定：递减区一档、饱和区一档；线性区没有上一档，故无此项。 */
#define MAXFREQ_DEFAULT_DECAY_MS     200
#define MAXFREQ_DEFAULT_SATURATE_MS  400
typedef struct {
    int enabled;
    unsigned decay_hold_ms;      /* 说明：从 linear_end 解锁到 decay_end 需要持续顶住多久 */
    unsigned saturate_hold_ms;   /* 说明：从 decay_end 解锁到硬件最高频需要持续顶住多久 */
} MaxFreqSettings;

typedef struct {
    char raw_path[256]; /* 说明：新增：记录原始路径模板用于查重与覆盖 */
    char value[128];
    int  is_sh;
    /* 说明：v2.5.5：该节点属于哪个 cluster（编译期由 {policy} 展开得到，-1=非核组节点）。
     * 有了它才能按「每个核组自己所在的区域」挑出对应的那一套节点。 */
    int  policy_id;
    char **resolved_paths;
    int  path_count;
} SysfsItem;

typedef struct {
    SysfsItem items[MAX_SYSFS_NODES];
    int count;
} PolicyParams;

/* 说明：v2.5.5：策略树改成「模式 × 频率区域 × 触摸阶段」三层。
 * 区域固定三段（线性/递减/饱和），每段各存一套基本配置与触摸增量；
 * 运行时按每个核组当前频率所在的区域取对应那一套下发。 */
#define ZONE_COUNT 3
typedef struct {
    PolicyParams zones[ZONE_COUNT][POLICY_PHASE_COUNT];
    TouchSettings touch;
    /* 说明：v2.5.11：动态限最大频的两个「顶住时长」按模式各自配置
     * （性能档该更快放行、省电档该更钝）。总开关仍在 global.maxfreq.enabled。 */
    MaxFreqSettings maxfreq;
} ModePolicy;

typedef struct {
    int sysfs_ok;
    int sysfs_err;
    int sysfs_missing; /* 说明：v1.3.0：ENOENT=本内核无此节点（能力缺失），与 sysfs_err 分开记账 */
    int readback_ok;
    int readback_mismatch;
    int readback_err;
    int sh_count;
    int skipped;   /* 说明：v2.5.6：与上次写入值相同、完全没碰 sysfs 的节点数 */
} ApplyStats;


/* 说明：---- 日志宏 ----
 * 新代码优先用带模块标签的 LOGI/LOGE/LOGD，日志里能直接按模块过滤；
 * 旧宏保留给尚未迁移的调用点，模块记为 core。 */
#define LOGF(mod, ...) do { log_writef(0, mod, __VA_ARGS__); abort(); } while(0)
#define LOGE(mod, ...) log_writef(1, mod, __VA_ARGS__)
#define LOGW(mod, ...) log_writef(1, mod, __VA_ARGS__)
#define LOGI(mod, ...) log_writef(1, mod, __VA_ARGS__)
#define LOGD(mod, ...) log_writef(2, mod, __VA_ARGS__)
#define LOGT(mod, ...) log_writef(3, mod, __VA_ARGS__)

#define LOG_FATAL(...) do { \
    log_write(0, "【致命崩溃】" __VA_ARGS__); \
    abort(); \
} while(0)

#define LOG_ERROR(...) log_write(1, "【错误】" __VA_ARGS__)
#define LOG_INFO(...)  log_write(1, __VA_ARGS__)
#define LOG_DEBUG(...) log_write(2, __VA_ARGS__)
#define LOG_TRACE(...) log_write(3, __VA_ARGS__)

/* 说明：---- 跨文件函数原型 ---- */
void log_write(int level, const char *fmt, ...);
void safe_strncpy(char *dst, const char *src, size_t n);
void *battery_worker(void *arg);   /* 说明：耗电采样线程入口（collect/battery.c） */

/* 说明：---- 跨模块共享全局（定义于 core/state.c）---- */
extern RunMode g_current_mode;
extern char g_current_pkg[256];
extern pthread_mutex_t g_pkg_mtx;
extern atomic_int g_running;

#endif /* 说明：头文件结束：CUPOW_H */