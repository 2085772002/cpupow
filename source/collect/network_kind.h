/* 说明：collect/network_kind.h — 网络事实分类（纯函数，零 IO）
 * 供耗电采样把 NetworkFacts 映射为 dump 用的稳定枚举。
 */
#ifndef CPUPOW_NETWORK_KIND_H
#define CPUPOW_NETWORK_KIND_H
#include "network.h"

enum {
    NET_KIND_UNKNOWN = -1,
    NET_KIND_NONE = 0,
    NET_KIND_WLAN = 1,
    NET_KIND_CELL = 2,
    NET_KIND_OTHER = 3
};

static inline int network_kind(NetworkFacts f)
{
    if (!f.known) return NET_KIND_UNKNOWN;
    if (!f.connected) return NET_KIND_NONE;
    if (f.wifi && !f.cellular && !f.other) return NET_KIND_WLAN;
    if (f.cellular && !f.wifi && !f.other) return NET_KIND_CELL;
    if (f.other || (f.wifi && f.cellular)) return NET_KIND_OTHER;
    return NET_KIND_UNKNOWN;
}

static inline int network_restore(double value)
{
    if (value == -1 || value == 0 || value == 1 || value == 2 || value == 3)
        return (int)value;
    return NET_KIND_UNKNOWN;
}
#endif