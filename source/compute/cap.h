/* 说明：compute/cap.h — 动态限最大频的档位状态机【计算层，零 IO】
 *
 * 用两条区域分界线当档位上限：
 *   0 档 = linear_end（默认停在这里）
 *   1 档 = decay_end
 *   2 档 = 硬件最高频
 * 升档要「持续顶住当前上限」够久（防毛刺），降档要「持续回落到上一档上限以下」够久
 * （防一次瞬时降频就把正在跑的应用打回低档）。时间阈值来自配置，纯函数、无系统调用。
 */
#ifndef CPUPOW_CAP_H
#define CPUPOW_CAP_H

#include "../cpupow.h"
#include "zone.h"
#include "../collect/freq.h"

/* 说明：换档的最小间隔、回落判定比例等都是机制常量，不对外暴露。 */
typedef struct {
    int level;              /* 说明：当前档位 0/1/2 */
    uint64_t hit_since;     /* 说明：当前上限开始被顶住的时刻，0=没顶住 */
    uint64_t below_since;   /* 说明：回落到上一档以下的起始时刻，0=没回落 */
    uint64_t level_at;      /* 说明：上次换档时刻 */
} CapState;

typedef struct {
    unsigned long long cap; /* 说明：本次该写下去的最大频上限（kHz） */
    int level;              /* 说明：换档后的档位 */
    int changed;            /* 说明：0=没换档，1=升档，-1=降档 */
} CapDecision;

void cap_state_reset(CapState *state);

/* 说明：推进一次。now_ms 用单调毫秒时钟。
 * effective_cap：上一轮写下去之后内核真正接受的上限（0=未知，用请求值）。
 * 把请求值当顶住判定会出事：内核会把非真实频点向下取整（真机日志里 2048000 落到 1977600），
 * 于是「顶住 100%」永远不成立，超大核被硬压在低一档再也升不上去。 */
CapDecision cap_step(CapState *state, const ClusterZone *cz, const FreqSample *fs,
                     const MaxFreqSettings *settings, uint64_t now_ms,
                     unsigned long long effective_cap);

/* 说明：某档对应的上限频率（已钳制到 [min_freq, max_freq]）。 */
unsigned long long cap_freq_of(int level, const ClusterZone *cz, const FreqSample *fs);

#endif /* 说明：头文件结束 */
