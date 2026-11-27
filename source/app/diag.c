/* 说明：app/diag.c — 诊断报告生成【编排层】
 *
 * 设计目标：只做只读观测，不启动线程、不加锁、不写 sysfs。
 * 产出一份 JSON，包含：
 *   env      —— 模块路径、自身 pid、开机时长、boot_id
 *   config   —— 配置是否有效/代次/日志级别/触摸时序/频率分区全文
 *   clusters —— 每个集群的当前/最小/最大频率 + 落在哪个区 + 该区算出的 boost
 *   runtime  —— 运行中的 runtime_status.json（含 metrics 与心跳）
 *   metrics  —— 若守护进程未运行则缺失，提示需要运行中才有统计
 *
 * 这样"某个集群 boost 为什么是这个值"可以在离线状态下完整复现。
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "../compute/config.h"
#include "../compute/zone.h"
#include "../collect/freq.h"
#include "../output/metrics.h"
#include "diag.h"

static char *read_whole(const char *path, long limit)
{
    FILE *fp = fopen(path, "r");
    if (!fp) return NULL;
    fseek(fp, 0, SEEK_END);
    long len = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    if (len <= 0 || len > limit) { fclose(fp); return NULL; }
    char *buf = malloc((size_t)len + 1);
    if (!buf) { fclose(fp); return NULL; }
    size_t got = fread(buf, 1, (size_t)len, fp);
    fclose(fp);
    buf[got] = 0;
    return buf;
}

/* 说明：v2.5.6：诊断进程是独立进程，自己加载配置时的「当前模式」永远是默认值，
 * 每个核组的区域也永远是 0。这两个值只有运行中的守护进程知道，它已把它们写进
 * runtime_status.json（mode / zones），这里先读出来给后面的分区判定用。 */
static RunMode g_runtime_mode = MODE_POWERSAVE;
static int g_runtime_zone[MAX_CLUSTERS];   /* -1 表示未取到 */
static int g_runtime_zone_known;
static unsigned long long g_runtime_cap[MAX_CLUSTERS];  /* 0 表示未取到 */
static int g_runtime_cap_known;

static void load_runtime_hints(void)
{
    for (int i = 0; i < MAX_CLUSTERS; i++) { g_runtime_zone[i] = -1; g_runtime_cap[i] = 0; }
    char *text = read_whole(MODULE_DIR "/runtime_status.json", 65536);
    if (!text) return;
    cJSON *rt = cJSON_Parse(text);
    free(text);
    if (!rt) return;
    const cJSON *m = cJSON_GetObjectItemCaseSensitive(rt, "mode");
    if (cJSON_IsString(m) && m->valuestring) {
        for (int i = 0; i < MODE_COUNT; i++)
            if (!strcmp(mode_names[i], m->valuestring)) g_runtime_mode = (RunMode)i;
    }
    const cJSON *cap = cJSON_GetObjectItemCaseSensitive(rt, "caps");
    if (cJSON_IsString(cap) && cap->valuestring && cap->valuestring[0]) {
        char cbuf[256];
        safe_strncpy(cbuf, cap->valuestring, sizeof(cbuf));
        char *csave = NULL;
        for (char *tok = strtok_r(cbuf, ",", &csave); tok; tok = strtok_r(NULL, ",", &csave)) {
            char *colon = strchr(tok, ':');
            if (!colon) continue;
            *colon = 0;
            int id = atoi(tok);
            unsigned long long khz = strtoull(colon + 1, NULL, 10);
            if (id >= 0 && id < MAX_CLUSTERS) { g_runtime_cap[id] = khz; g_runtime_cap_known = 1; }
        }
    }
    const cJSON *z = cJSON_GetObjectItemCaseSensitive(rt, "zones");
    if (cJSON_IsString(z) && z->valuestring && z->valuestring[0]) {
        char buf[128];
        safe_strncpy(buf, z->valuestring, sizeof(buf));
        char *save = NULL;
        for (char *tok = strtok_r(buf, ",", &save); tok; tok = strtok_r(NULL, ",", &save)) {
            char *colon = strchr(tok, ':');
            if (!colon) continue;
            *colon = 0;
            int id = atoi(tok), zone = atoi(colon + 1);
            if (id >= 0 && id < MAX_CLUSTERS) { g_runtime_zone[id] = zone; g_runtime_zone_known = 1; }
        }
    }
    cJSON_Delete(rt);
}

static void add_env(cJSON *root)
{
    cJSON *env = cJSON_AddObjectToObject(root, "env");
    cJSON_AddStringToObject(env, "module_dir", MODULE_DIR);
    /* 说明：这是 --diag 自身的 pid，不是守护进程；守护进程 pid 见 runtime.pid。 */
    cJSON_AddNumberToObject(env, "diag_pid", (double)getpid());

    struct timespec bt;
    if (clock_gettime(CLOCK_BOOTTIME, &bt) == 0)
        cJSON_AddNumberToObject(env, "uptime_s", (double)bt.tv_sec);

    char *boot = read_whole("/proc/sys/kernel/random/boot_id", 128);
    if (boot) {
        boot[strcspn(boot, "\r\n")] = 0;
        cJSON_AddStringToObject(env, "boot_id", boot);
        free(boot);
    }
}

static void add_config(cJSON *root)
{
    cJSON *cfg = cJSON_AddObjectToObject(root, "config");
    /* 说明：以下是本次诊断进程自己加载的副本；运行中守护进程的代次见 runtime.config_revision。 */
    cJSON_AddBoolToObject(cfg, "valid", config_is_valid() != 0);
    cJSON_AddNumberToObject(cfg, "revision", (double)config_get_revision());

    TouchSettings ts;
    memset(&ts, 0, sizeof(ts));
    config_get_touch_settings(&ts);
    cJSON *touch = cJSON_AddObjectToObject(cfg, "touch");
    cJSON_AddBoolToObject(touch, "enabled", ts.enabled != 0);
    cJSON_AddNumberToObject(touch, "long_press_ms", (double)ts.long_press_ms);
    cJSON_AddNumberToObject(touch, "release_delay_ms", (double)ts.release_delay_ms);

    ZoneConfig zc;
    memset(&zc, 0, sizeof(zc));
    config_get_zones(&zc);
    cJSON *zones = cJSON_AddObjectToObject(cfg, "zones");
    cJSON_AddBoolToObject(zones, "enabled", zc.enabled != 0);
    cJSON_AddNumberToObject(zones, "sample_ms", zc.sample_ms);
    cJSON_AddNumberToObject(zones, "cluster_count", zc.cluster_count);
}

/* 说明：每个集群把「输入」和「判定结果」并排给出，方便核对分区公式与边界钳制是否符合预期。 */
static void add_clusters(cJSON *root)
{
    FreqSample samples[MAX_CLUSTERS];
    int n = freq_sample(samples, MAX_CLUSTERS);
    cJSON *arr = cJSON_AddArrayToObject(root, "clusters");
    if (n <= 0) return;

    /* 说明：v2.5.5 起 boost 公式按「模式 × 区域」存放，诊断要按当前模式取，
     * 否则打印出来的三个区弯曲度永远是 0。 */
    ZoneConfig zc;
    memset(&zc, 0, sizeof(zc));
    config_get_mode_zones(g_runtime_mode, &zc);
    cJSON_AddStringToObject(root, "boost_mode", mode_names[g_runtime_mode]);

    for (int i = 0; i < n; i++) {
        FreqSample *fs = &samples[i];
        if (!fs->valid) continue;
        cJSON *o = cJSON_CreateObject();
        cJSON_AddNumberToObject(o, "id", fs->id);
        cJSON_AddNumberToObject(o, "cur_khz", (double)fs->cur_freq);
        cJSON_AddNumberToObject(o, "min_khz", (double)fs->min_freq);
        cJSON_AddNumberToObject(o, "max_khz", (double)fs->max_freq);

        /* 说明：边界来自 global.zones，与 boost 开关无关；开关只决定写不写 boost。 */
        int configured = fs->id >= 0 && fs->id < MAX_CLUSTERS &&
                         zc.clusters[fs->id].linear_end > 0;
        cJSON_AddBoolToObject(o, "zone_configured", configured != 0);
        cJSON_AddBoolToObject(o, "boost_enabled", zc.enabled != 0);
        if (configured) {
            ClusterZone *cz = &zc.clusters[fs->id];
            cJSON_AddNumberToObject(o, "linear_end", (double)cz->linear_end);
            cJSON_AddNumberToObject(o, "decay_end", (double)cz->decay_end);
            cJSON_AddNumberToObject(o, "zone_index",
                zone_index(cz, fs->min_freq, fs->max_freq, fs->cur_freq));
            /* 说明：policy_zone 是守护进程实际在用的区域；守护进程没运行时标 -1（未知），
             * 不要用本进程的默认 0 冒充。 */
            /* 说明：v2.5.8：动态限最大频当前给这个核组的最大频上限（kHz）；
             * 未运行时为 0，表示未知而不是「上限为零」。 */
            cJSON_AddNumberToObject(o, "cap_khz",
                g_runtime_cap_known ? (double)g_runtime_cap[fs->id] : 0);
            cJSON_AddNumberToObject(o, "policy_zone",
                (g_runtime_zone_known && fs->id >= 0 && fs->id < MAX_CLUSTERS) ? g_runtime_zone[fs->id] : -1);
            cJSON_AddNumberToObject(o, "computed_boost",
                zone_compute_boost(cz, fs->min_freq, fs->max_freq, fs->cur_freq));
            for (int z = 0; z < 3; z++) {
                const char *names[3] = { "linear", "decay", "saturate" };
                cJSON *zb = cJSON_AddObjectToObject(o, names[z]);
                cJSON_AddNumberToObject(zb, "bend", cz->zones[z].bend);
                cJSON_AddNumberToObject(zb, "start", cz->zones[z].start);
                cJSON_AddNumberToObject(zb, "end", cz->zones[z].end);
            }
        }
        cJSON_AddItemToArray(arr, o);
    }
}

/* 说明：把运行中守护进程写下的快照原样嵌进来（含 metrics / 心跳 / 模式 / 包名）。 */
static void add_runtime(cJSON *root)
{
    char *text = read_whole(MODULE_DIR "/runtime_status.json", 65536);
    if (!text) {
        cJSON_AddStringToObject(root, "runtime",
                               "unavailable: 守护进程未运行或尚未写出 runtime_status.json");
        return;
    }
    cJSON *obj = cJSON_Parse(text);
    free(text);
    if (obj) cJSON_AddItemToObject(root, "runtime", obj);
    else cJSON_AddStringToObject(root, "runtime", "unavailable: runtime_status.json 解析失败");
}

int diag_run(void)
{
    /* 说明：只加载配置，不启动实例锁、不写日志文件、不碰 sysfs。 */
    load_config();
    load_runtime_hints();

    cJSON *root = cJSON_CreateObject();
    if (!root) return 1;
    cJSON_AddNumberToObject(root, "schema", 1);
    cJSON_AddStringToObject(root, "tool", "cpupow --diag");
    cJSON_AddStringToObject(root, "note",
                            "只读诊断快照；metrics 来自运行中的守护进程，未运行时缺失");

    char stamp[64];
    time_t now = time(NULL);
    struct tm tmv;
    localtime_r(&now, &tmv);
    strftime(stamp, sizeof(stamp), "%Y-%m-%d %H:%M:%S", &tmv);
    cJSON_AddStringToObject(root, "generated_at", stamp);

    add_env(root);
    add_config(root);
    add_clusters(root);
    add_runtime(root);

    char *text = cJSON_Print(root);
    cJSON_Delete(root);
    if (!text) return 1;
    fputs(text, stdout);
    fputc('\n', stdout);
    free(text);
    return 0;
}