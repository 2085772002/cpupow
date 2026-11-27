/* 说明：output/metrics.c — 运行指标实现【输出层】 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "metrics.h"
#include "log.h"

/* 说明：告警阈值（微秒）。超过就记一次 over，用于区分"偶发慢"和"持续慢"。 */
#define WARN_LOOP_US      16000   /* 超过一帧 16ms 的主循环即视为掉帧风险 */
#define WARN_WRITE_US      5000
#define WARN_CFG_LOAD_US 300000
#define WARN_FREQ_US       5000
#define WARN_ZONE_US       2000
#define WARN_PROBE_US    1500000
#define WARN_BAT_US      200000

static MetricLatency s_lat[MET_COUNT];
static _Atomic long long s_cnt[CNT_COUNT];

static const char *const s_lat_names[MET_COUNT] = {
    "loop", "epoll", "write", "cfg_load", "freq_sample", "zone_calc", "probe", "bat_sample"
};
static const char *const s_cnt_names[CNT_COUNT] = {
    "loop", "write_ok", "write_diff", "write_miss", "write_err", "write_skip",
    "maxfreq_apply", "maxfreq_fail", "maxfreq_clamp", "boost_clamp",
    "zone_apply", "zone_skip", "zone_fail", "mode_switch", "phase_switch",
    "cfg_reload", "cfg_invalid", "touch_reconnect", "errors"
};

long long metrics_now_us(void)
{
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
    return (long long)ts.tv_sec * 1000000LL + ts.tv_nsec / 1000;
}

MetricLatency *metrics_slot(int index)
{
    if (index < 0 || index >= MET_COUNT) index = MET_LOOP;
    return &s_lat[index];
}

const char *metrics_name(int index)
{
    if (index < 0 || index >= MET_COUNT) index = MET_LOOP;
    return s_lat_names[index];
}

void metric_inc(int counter, long long delta)
{
    if (counter < 0 || counter >= CNT_COUNT) return;
    atomic_fetch_add_explicit(&s_cnt[counter], delta, memory_order_relaxed);
}

long long metric_get(int counter)
{
    if (counter < 0 || counter >= CNT_COUNT) return 0;
    return atomic_load_explicit(&s_cnt[counter], memory_order_relaxed);
}

const char *metric_counter_name(int counter)
{
    if (counter < 0 || counter >= CNT_COUNT) return "?";
    return s_cnt_names[counter];
}

void metrics_reset(void)
{
    for (int i = 0; i < MET_COUNT; i++) {
        atomic_store_explicit(&s_lat[i].count, 0, memory_order_relaxed);
        atomic_store_explicit(&s_lat[i].total_us, 0, memory_order_relaxed);
        atomic_store_explicit(&s_lat[i].max_us, 0, memory_order_relaxed);
        atomic_store_explicit(&s_lat[i].over_us, 0, memory_order_relaxed);
    }
    for (int i = 0; i < CNT_COUNT; i++)
        atomic_store_explicit(&s_cnt[i], 0, memory_order_relaxed);
}

/* 说明：把微秒渲染成便于阅读的短字符串：<1000 用 us，否则 ms 保留一位小数。 */
static void fmt_us(long long us, char *out, size_t cap)
{
    if (us < 1000) snprintf(out, cap, "%lldus", us);
    else snprintf(out, cap, "%lld.%lldms", us / 1000, (us % 1000) / 100);
}

/* 说明：周期性性能快照。每 60 秒输出一次，日志里可直接看出"哪段在变慢"。 */
void metrics_report(int force)
{
    static long long last_ms = 0;
    /* 说明：日志级别低于 1 时整段快照都会被 log_writef 丢弃，
     * 不必先花时间做多次 snprintf 格式化——直接返回。 */
    if (log_level() < 1) return;
    long long now_ms = metrics_now_us() / 1000;
    if (!force && last_ms && now_ms - last_ms < 60000) return;
    last_ms = now_ms;

    char buf[64];
    /* 说明：主循环节奏——最能反映守护进程是否被拖慢。 */
    fmt_us(metric_avg_us(&s_lat[MET_LOOP]), buf, sizeof(buf));
    char mx[64];
    fmt_us(metric_max_us(&s_lat[MET_LOOP]), mx, sizeof(mx));
    LOGI(MOD_PERF, "loop n=%lld avg=%s max=%s slow=%lld",
         metric_count(&s_lat[MET_LOOP]), buf, mx, metric_over(&s_lat[MET_LOOP]));

    /* 说明：写入账本——成功、读回不一致、缺失、失败分开看，能区分"内核拒绝"与"节点不存在"。 */
    LOGI(MOD_PERF, "write ok=%lld diff=%lld miss=%lld err=%lld skip=%lld",
         metric_get(CNT_WRITE_OK), metric_get(CNT_WRITE_DIFF),
         metric_get(CNT_WRITE_MISS), metric_get(CNT_WRITE_ERR),
         metric_get(CNT_WRITE_SKIP));

    /* 说明：v2.5.13：boost 读回被内核改写也单独记——之前它被当成写失败，
     * 于是每 2 秒的强制重写都会刷一条 E 级 boost_wr_fail（真机 8 小时 649 次）。 */
    LOGI(MOD_PERF, "boost clamp=%lld", metric_get(CNT_BOOST_CLAMP));

    /* 说明：v2.5.9：动态限最大频的写入与钳制分开看——clamp 不为零是平台更严，不是故障。 */
    LOGI(MOD_PERF, "maxfreq apply=%lld fail=%lld clamp=%lld",
         metric_get(CNT_MAXFREQ_APPLY), metric_get(CNT_MAXFREQ_FAIL),
         metric_get(CNT_MAXFREQ_CLAMP));

    /* 说明：分区 boost 生效情况。apply 有增量而 fail 不为零，说明部分核组写不进去。 */
    char za[64];
    fmt_us(metric_avg_us(&s_lat[MET_ZONE_CALC]), za, sizeof(za));
    LOGI(MOD_PERF, "zone apply=%lld skip=%lld fail=%lld calc_avg=%s",
         metric_get(CNT_ZONE_APPLY), metric_get(CNT_ZONE_SKIP),
         metric_get(CNT_ZONE_FAIL), za);

    /* 说明：其余耗时一次性列出，便于横向对比哪段最贵。 */
    char a[64], b2[64], c[64], d[64];
    fmt_us(metric_avg_us(&s_lat[MET_WRITE]), a, sizeof(a));
    fmt_us(metric_avg_us(&s_lat[MET_CFG_LOAD]), b2, sizeof(b2));
    fmt_us(metric_avg_us(&s_lat[MET_FREQ_SAMPLE]), c, sizeof(c));
    fmt_us(metric_avg_us(&s_lat[MET_PROBE]), d, sizeof(d));
    LOGI(MOD_PERF, "lat write=%s cfg=%s freq=%s probe=%s errors=%lld",
         a, b2, c, d, metric_get(CNT_ERROR));

    /* 说明：事件计数，用于判断守护进程是否在按预期工作（而不是空转）。 */
    LOGI(MOD_PERF, "evt mode=%lld phase=%lld reload=%lld invalid=%lld tch_reconn=%lld",
         metric_get(CNT_MODE_SWITCH), metric_get(CNT_PHASE_SWITCH),
         metric_get(CNT_CFG_RELOAD), metric_get(CNT_CFG_INVALID),
         metric_get(CNT_TOUCH_RECONNECT));
}

/* 说明：完整指标 JSON。键名与日志里的指标同名，便于交叉比对。 */
char *metrics_json(void)
{
    cJSON *root = cJSON_CreateObject();
    if (!root) return NULL;

    cJSON *lat = cJSON_AddObjectToObject(root, "latency_us");
    for (int i = 0; i < MET_COUNT; i++) {
        cJSON *o = cJSON_AddObjectToObject(lat, s_lat_names[i]);
        cJSON_AddNumberToObject(o, "count", (double)metric_count(&s_lat[i]));
        cJSON_AddNumberToObject(o, "avg", (double)metric_avg_us(&s_lat[i]));
        cJSON_AddNumberToObject(o, "max", (double)metric_max_us(&s_lat[i]));
        cJSON_AddNumberToObject(o, "over_warn", (double)metric_over(&s_lat[i]));
    }

    cJSON *cnt = cJSON_AddObjectToObject(root, "counters");
    for (int i = 0; i < CNT_COUNT; i++)
        cJSON_AddNumberToObject(cnt, s_cnt_names[i], (double)metric_get(i));

    char *text = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    return text;
}