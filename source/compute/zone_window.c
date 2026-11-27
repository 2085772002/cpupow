/* 说明：compute/zone_window.c — 区域多数决窗口实现【计算层，零 IO】 */
#include "zone_window.h"

void zone_window_reset(ZoneWindow *w)
{
    if (!w) return;
    for (int i = 0; i < ZONE_WINDOW_SIZE; i++) w->samples[i] = -1;
    w->count = 0;
    w->pos = 0;
}

void zone_window_push(ZoneWindow *w, int zone)
{
    if (!w) return;
    if (zone < 0 || zone >= ZONE_COUNT) zone = 0;
    w->samples[w->pos] = zone;
    w->pos = (w->pos + 1) % ZONE_WINDOW_SIZE;
    if (w->count < ZONE_WINDOW_SIZE) w->count++;
}

int zone_window_majority(const ZoneWindow *w, int *total)
{
    int hits[ZONE_COUNT];
    if (total) *total = w ? w->count : 0;
    if (!w || w->count <= 0) return -1;
    for (int i = 0; i < ZONE_COUNT; i++) hits[i] = 0;
    for (int i = 0; i < w->count; i++)
        if (w->samples[i] >= 0 && w->samples[i] < ZONE_COUNT) hits[w->samples[i]]++;
    /* 说明：要求 2/3 多数，而不是简单过半。窗口未填满时（比如 5 个样本 3:2），
     * 简单过半会把一次轻微的抖动误判成「稳定在某区」；2/3 要求明显倾向才算稳定。 */
    for (int i = 0; i < ZONE_COUNT; i++)
        if (hits[i] * 3 >= w->count * 2) return i;
    return -1;
}
