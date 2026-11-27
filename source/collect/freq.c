/* 说明：collect/freq.c — 各 cluster 当前频率采集【采集层】
 *
 * 遍历 cpufreq 目录下的 policy*，读当前频率与 min/max 频率。
 * 纯只读、无业务判断；失败项标记 invalid 不产生错误数据。
 */
#include "../cpupow.h"
#include "freq.h"
#include <dirent.h>

static int read_ull(const char *path, unsigned long long *out)
{
    char buf[64];
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n <= 0) return -1;
    buf[n] = 0;
    char *end = NULL;
    unsigned long long v = strtoull(buf, &end, 10);
    if (!end || end == buf) return -1;
    *out = v;
    return 0;
}

/* 说明：v2.5.6：把「有哪些 policy」和「它们的 cpuinfo_min/max」缓存起来。
 * 这两个节点是硬件静态属性，每次采样重读纯属浪费——实测每次采样要 6~9 次 open
 * （3 个文件 × 2~3 个核组 + opendir），是主循环里最大的一笔固定开销。
 * 现在每次只读 scaling_cur_freq；缓存 60 秒过期一次，核组热插拔也能被发现。 */
#define FREQ_CACHE_TTL_MS 60000
#define FREQ_MAX_CLUSTERS 16
typedef struct {
    int id;
    unsigned long long min_freq;
    unsigned long long max_freq;
} FreqStatic;
static FreqStatic g_cache[FREQ_MAX_CLUSTERS];
static int g_cache_count = -1;
static long long g_cache_at_ms;

static long long freq_now_ms(void)
{
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

void freq_invalidate(void)
{
    g_cache_count = -1;
    g_cache_at_ms = 0;
}

/* 说明：扫描一次 cpufreq 目录，记录每个 policy 的静态上下限；失败返回 -1。 */
static int freq_build_cache(void)
{
    DIR *d = opendir(CPUPOW_CPUFREQ_ROOT);
    int count = 0;
    if (!d) return -1;
    struct dirent *e;
    while ((e = readdir(d)) != NULL && count < FREQ_MAX_CLUSTERS) {
        char path[320];
        unsigned long long min = 0, max = 0;
        int id;
        if (strncmp(e->d_name, "policy", 6) != 0) continue;
        id = atoi(e->d_name + 6);
        if (id < 0) continue;
        snprintf(path, sizeof(path), "%s/policy%d/cpuinfo_min_freq", CPUPOW_CPUFREQ_ROOT, id);
        if (read_ull(path, &min) != 0) continue;
        snprintf(path, sizeof(path), "%s/policy%d/cpuinfo_max_freq", CPUPOW_CPUFREQ_ROOT, id);
        if (read_ull(path, &max) != 0) continue;
        g_cache[count].id = id;
        g_cache[count].min_freq = min;
        g_cache[count].max_freq = max;
        count++;
    }
    closedir(d);
    /* 说明：readdir 顺序不保证稳定，按 policy 编号排序，保证状态页与日志顺序一致。 */
    for (int i = 1; i < count; i++) {
        FreqStatic key = g_cache[i];
        int j = i - 1;
        while (j >= 0 && g_cache[j].id > key.id) { g_cache[j + 1] = g_cache[j]; j--; }
        g_cache[j + 1] = key;
    }
    g_cache_count = count;
    g_cache_at_ms = freq_now_ms();
    return count;
}

int freq_sample(FreqSample *samples, int max_clusters)
{
    int count = 0;
    if (!samples || max_clusters <= 0) return -1;
    if (g_cache_count < 0 || freq_now_ms() - g_cache_at_ms > FREQ_CACHE_TTL_MS)
        if (freq_build_cache() < 0) { g_cache_count = -1; return -1; }

    for (int i = 0; i < g_cache_count && count < max_clusters; i++) {
        char path[320];
        unsigned long long cur = 0;
        snprintf(path, sizeof(path), "%s/policy%d/scaling_cur_freq",
                 CPUPOW_CPUFREQ_ROOT, g_cache[i].id);
        if (read_ull(path, &cur) != 0) {
            /* 说明：读到失效节点说明核组集合变了，丢弃缓存让下一轮重建。 */
            freq_invalidate();
            continue;
        }
        samples[count].id = g_cache[i].id;
        samples[count].cur_freq = cur;
        samples[count].min_freq = g_cache[i].min_freq;
        samples[count].max_freq = g_cache[i].max_freq;
        samples[count].valid = 1;
        count++;
    }
    return count;
}
