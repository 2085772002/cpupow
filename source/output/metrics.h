/* 说明：output/metrics.h — 运行指标与自诊断数据【输出层】
 *
 * 目的：让「事后分析」不再靠猜。所有关键路径的耗时与计数都收敛到这里，
 * 既能周期性打进日志（perf/diag 事件），也能经 --diag 一次性导出 JSON，
 * 供人工或自动化工具比对前后差异。
 *
 * 全部读写是原子的，可在任意线程调用；不做 IO，不依赖日志开关。
 */
#ifndef CPUPOW_METRICS_H
#define CPUPOW_METRICS_H

#include <stdint.h>
#include <stdatomic.h>

/* 说明：一组耗时统计。单位统一为微秒，避免浮点在原子操作上的麻烦。 */
typedef struct {
    _Atomic long long count;
    _Atomic long long total_us;
    _Atomic long long max_us;
    _Atomic long long over_us;   /* 说明：超过告警阈值的次数 */
} MetricLatency;

/* 说明：指标槽位。新增指标只在这里加一项，日志与 --diag 自动带上。 */
enum {
    MET_LOOP = 0,      /* 主循环一轮的总耗时 */
    MET_EPOLL,         /* epoll_wait 阻塞等待 */
    MET_WRITE,         /* 单次 sysfs 写入 + 读回校验 */
    MET_CFG_LOAD,      /* 配置解析与策略树编译 */
    MET_FREQ_SAMPLE,   /* 各集群频率采样 */
    MET_ZONE_CALC,     /* 分区 boost 计算 */
    MET_PROBE,         /* 前台 dumpsys 探测 */
    MET_BAT_SAMPLE,    /* 耗电采样一次 */
    MET_COUNT
};

/* 说明：统一用 C11 原子 API。GCC 的 __atomic_* 内建与 _Atomic 限定类型不兼容，
 * 混用会直接编译失败。 */
static inline void metric_add(MetricLatency *m, long long us, long long warn_us)
{
    atomic_fetch_add_explicit(&m->count, 1, memory_order_relaxed);
    atomic_fetch_add_explicit(&m->total_us, us, memory_order_relaxed);
    long long cur_max = atomic_load_explicit(&m->max_us, memory_order_relaxed);
    while (us > cur_max &&
           !atomic_compare_exchange_weak_explicit(&m->max_us, &cur_max, us,
                                                  memory_order_relaxed,
                                                  memory_order_relaxed))
        ;
    if (warn_us > 0 && us > warn_us)
        atomic_fetch_add_explicit(&m->over_us, 1, memory_order_relaxed);
}

static inline long long metric_count(const MetricLatency *m)
{
    return atomic_load_explicit(&m->count, memory_order_relaxed);
}
static inline long long metric_avg_us(const MetricLatency *m)
{
    long long c = atomic_load_explicit(&m->count, memory_order_relaxed);
    return c > 0 ? atomic_load_explicit(&m->total_us, memory_order_relaxed) / c : 0;
}
static inline long long metric_max_us(const MetricLatency *m)
{
    return atomic_load_explicit(&m->max_us, memory_order_relaxed);
}
static inline long long metric_over(const MetricLatency *m)
{
    return atomic_load_explicit(&m->over_us, memory_order_relaxed);
}

/* 说明：单调时钟微秒，用于各路径计时。 */
long long metrics_now_us(void);

/* 说明：取指定槽位的指针（越界返回 MET_LOOP）。 */
MetricLatency *metrics_slot(int index);
/* 说明：槽位短名，用于日志与 JSON 键。 */
const char *metrics_name(int index);

/* 说明：---- 事件计数器 ---- */
enum {
    CNT_LOOP = 0,        /* 主循环迭代次数 */
    CNT_WRITE_OK,
    CNT_WRITE_DIFF,      /* 写成功但读回不一致 */
    CNT_WRITE_MISS,      /* 节点不存在 */
    CNT_WRITE_ERR,       /* 写入失败或不可读 */
    CNT_WRITE_SKIP,      /* 值未变、跳过实际写入 */
    CNT_MAXFREQ_APPLY,   /* 动态限最大频写入次数 */
    CNT_MAXFREQ_FAIL,
    CNT_MAXFREQ_CLAMP,   /* 限频写入后读回更低（平台/温控给了更严的上限，属正常） */
    CNT_BOOST_CLAMP,     /* boost 写入后读回被内核改写（取整/钳制），不是写失败 */
    CNT_ZONE_APPLY,      /* 分区 boost 实际写入次数 */
    CNT_ZONE_SKIP,       /* 分区 boost 因值未变而跳过的次数 */
    CNT_ZONE_FAIL,
    CNT_MODE_SWITCH,
    CNT_PHASE_SWITCH,
    CNT_CFG_RELOAD,
    CNT_CFG_INVALID,
    CNT_TOUCH_RECONNECT,
    CNT_ERROR,           /* 所有 E 级日志累计 */
    CNT_COUNT
};

void metric_inc(int counter, long long delta);
long long metric_get(int counter);
const char *metric_counter_name(int counter);

/* 说明：周期性性能快照。每 60 秒或每 1200 次循环调一次即可，内部自己限频。 */
void metrics_report(int force);

/* 说明：把全部指标写成 JSON（供 --diag）。返回 malloc 的字符串，调用方 free。 */
char *metrics_json(void);

/* 说明：重置统计（配置重载后可选调用，便于分段观察）。 */
void metrics_reset(void);

#endif /* 说明：头文件结束：CPUPOW_METRICS_H */