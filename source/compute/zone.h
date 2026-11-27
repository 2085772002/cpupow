/* 说明：compute/zone.h — 频率分区与动态 boost 公式【计算层】
 *
 * 把每个 cluster 的频率范围切成三段：
 *   [min_freq, linear_end]     线性区   —— 频率与收益近似成正比
 *   (linear_end, decay_end]    收益递减区 —— 频率继续提升、收益放缓
 *   (decay_end, max_freq]      饱和区   —— 频率很高、收益趋平
 *
 * 每个区独立配置一个 boost 公式：bend 控制曲线弯曲方向与程度，
 * start=区起点 boost、end=区终点 boost。boost 是调频需求加减成百分比，
 * 负值=降低需求更省电，正值=更积极。本模块纯计算、零 IO。
 */
#ifndef CPUPOW_ZONE_H
#define CPUPOW_ZONE_H

typedef struct {
    int bend;    /* 说明：弯曲度 -100..100。0=线性，>0 先缓后快，<0 先快后缓，绝对值越大越弯 */
    int start;   /* 说明：区起点 boost（百分比，可为负，如 -7） */
    int end;     /* 说明：区终点 boost（百分比，可为负，如 -18） */
} ZoneBoost;

typedef struct {
    unsigned long long linear_end; /* 说明：线性区上界（kHz，含） */
    unsigned long long decay_end;  /* 说明：递减区上界（kHz，含） */
    ZoneBoost zones[3];            /* 说明：[0]=线性 [1]=递减 [2]=饱和 */
} ClusterZone;

/* 说明：返回当前频率所在区：0=线性 1=递减 2=饱和。越界钳制到最近区。 */
int zone_index(const ClusterZone *z, unsigned long long min_freq,
               unsigned long long max_freq, unsigned long long freq);

/* 说明：计算当前频率对应的 boost 值（百分比，四舍五入到整数）。 */
int zone_compute_boost(const ClusterZone *z, unsigned long long min_freq,
                       unsigned long long max_freq, unsigned long long freq);

#endif /* 说明：头文件结束：CPUPOW_ZONE_H */