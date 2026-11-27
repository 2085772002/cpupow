/* 说明：compute/zone_window.h — 区域判定的多数决窗口【计算层，零 IO】
 *
 * 频率在分区边界附近抖动时，逐次采样会在两个区之间来回横跳
 * （真机日志里大核 freq 在 768MHz 与 3648MHz 之间反复跳）。
 * 早先用「连续 3 次同区」做迟滞，在这种抖动下几乎永不成立，
 * 于是区域策略永远停留在 0 区。
 *
 * 这里改成看最近 N 次采样：某一个区占到 2/3 才算「稳定在这个区」。
 * 五五开抖动时没有多数（不提交）；真的长期待在某个区时很快就有多数。
 */
#ifndef CPUPOW_ZONE_WINDOW_H
#define CPUPOW_ZONE_WINDOW_H

#include "../cpupow.h"

#define ZONE_WINDOW_SIZE 8

typedef struct {
    int samples[ZONE_WINDOW_SIZE];
    int count;   /* 说明：窗口内有效样本数（最多 ZONE_WINDOW_SIZE） */
    int pos;     /* 说明：下一次写入位置 */
} ZoneWindow;

void zone_window_reset(ZoneWindow *w);

/* 说明：压入一次采样（越界值按 0 处理）。 */
void zone_window_push(ZoneWindow *w, int zone);

/* 说明：返回占 2/3 多数的区域（0..ZONE_COUNT-1）；没有明确多数时返回 -1，
 * *total 回填窗口内有效样本数（用于要求「窗口够长才作数」）。 */
int zone_window_majority(const ZoneWindow *w, int *total);

#endif /* 说明：头文件结束 */
