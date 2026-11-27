/* 说明：compute/zone.c — 频率分区与动态 boost 公式实现【计算层，零 IO】 */
#include "zone.h"

/* 说明：弯曲度折算成人性化的曲线权重。
 *
 * 早先版本用幂函数 t^p：bend 为负时 p<1，t→0 处导数趋于无穷，曲线在起点几乎垂直
 * 跳起，看起来像折线——这是缺陷。现在改用「抛物线偏移」：
 *
 *   f(t) = t + k·(t - t²)     （bend<0：先快后缓，起步快、收尾缓）
 *   f(t) = t - k·(t - t²)     （bend>0：先缓后快，起步缓、收尾快）
 *   k = |bend| / 100          （0..1）
 *
 * 两端导数恒为有限值：k=1 时 f 退化为 t²（先缓后快）或 2t-t²（先快后缓），
 * 全程平滑，不会出现折线。f(0)=0、f(1)=1 恒成立，保证区端点 boost 精确命中。 */
static double shape_factor(const ZoneBoost *b, double t)
{
    double k, bell;
    if (t < 0.0) t = 0.0;
    if (t > 1.0) t = 1.0;
    if (b->bend == 0) return t;
    k = (b->bend > 0 ? b->bend : -b->bend) / 100.0;
    if (k > 1.0) k = 1.0;
    bell = t - t * t;               /* 说明：中间大、两端为 0 的钟形偏移量 */
    return b->bend > 0 ? t - k * bell : t + k * bell;
}

/* 说明：把配置里的分区边界钳制到硬件实际频率范围内。
 * 用户可能把 linear_end 配得比 cpuinfo_max 还高，此时若直接用原值算比例，
 * 曲线永远走不到区终点的 boost 值。统一在这里钳制，命中与计算公式共用同一组边界。 */
static void zone_bounds(const ClusterZone *z, unsigned long long min_freq,
                        unsigned long long max_freq,
                        unsigned long long *linear, unsigned long long *decay)
{
    unsigned long long lo = z->linear_end, de = z->decay_end;
    if (lo < min_freq) lo = min_freq;
    if (lo > max_freq) lo = max_freq;
    if (de < lo) de = lo;
    if (de > max_freq) de = max_freq;
    *linear = lo;
    *decay = de;
}

int zone_index(const ClusterZone *z, unsigned long long min_freq,
               unsigned long long max_freq, unsigned long long freq)
{
    unsigned long long linear, decay;
    if (!z) return 0;
    zone_bounds(z, min_freq, max_freq, &linear, &decay);
    if (freq <= linear) return 0;
    if (freq <= decay) return 1;
    return 2;
}

int zone_compute_boost(const ClusterZone *z, unsigned long long min_freq,
                       unsigned long long max_freq, unsigned long long freq)
{
    unsigned long long lo, hi, linear, decay;
    const ZoneBoost *b;
    double t, factor, delta, boost;
    int idx;
    if (!z) return 0;

    zone_bounds(z, min_freq, max_freq, &linear, &decay);
    idx = zone_index(z, min_freq, max_freq, freq);
    b = &z->zones[idx];

    /* 说明：区边界。线性区 [min, linear]，递减区 (linear, decay]，饱和区 (decay, max]。 */
    if (idx == 0) {
        lo = min_freq;
        hi = linear;
    } else if (idx == 1) {
        lo = linear;
        hi = decay;
    } else {
        lo = decay;
        hi = max_freq;
    }
    if (hi < lo) hi = lo;
    if (hi <= lo) return b->start;
    if (freq < lo) freq = lo;
    if (freq > hi) freq = hi;

    t = (double)(freq - lo) / (double)(hi - lo);
    factor = shape_factor(b, t);

    /* 说明：方向由 start/end 差值决定，弯曲只改变过渡速度。 */
    delta = (double)b->end - (double)b->start;
    boost = (double)b->start + delta * factor;
    return (int)(boost >= 0.0 ? boost + 0.5 : boost - 0.5);
}