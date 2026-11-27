/* 说明：collect/freq.h — 各 cluster 当前频率采集接口【采集层】
 *
 * 读 /sys/devices/system/cpu/cpufreq/ 下 policy* 目录里的
 * scaling_cur_freq / cpuinfo_min_freq / cpuinfo_max_freq。
 * 只读系统事实，不做业务判断。
 */
#ifndef CPUPOW_FREQ_H
#define CPUPOW_FREQ_H

/* 说明：单个 cluster 的频率快照 */
typedef struct {
    int id;                    /* 说明：policy 编号（0/4/6/7 等，高通不连续） */
    unsigned long long cur_freq;   /* 说明：当前频率 kHz */
    unsigned long long min_freq;   /* 说明：cpuinfo_min_freq kHz */
    unsigned long long max_freq;   /* 说明：cpuinfo_max_freq kHz */
    int valid;                 /* 说明：三个字段都读到才为 1 */
} FreqSample;

/* 说明：采样所有 cluster 的频率，填充 samples（按 policy 扫描顺序），
 * 返回采样到的 cluster 数量；失败返回 -1。max_clusters 为 samples 数组容量。 */
int freq_sample(FreqSample *samples, int max_clusters);

/* 说明：v2.5.6：cpuinfo_min_freq / cpuinfo_max_freq 是硬件静态属性（只在开机时确定），
 * policy 目录也很少变。采样只读 scaling_cur_freq，静态部分缓存起来复用。
 * 配置重载、或读到失效节点时调用 freq_invalidate() 让下一次采样重建缓存。 */
void freq_invalidate(void);

#endif /* 说明：头文件结束：CPUPOW_FREQ_H */