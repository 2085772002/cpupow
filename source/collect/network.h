#ifndef CPUPOW_NETWORK_H
#define CPUPOW_NETWORK_H

/* 说明：采集事实，不在采集层决定业务标签。 */
typedef struct {
    int known;
    int connected;
    int wifi;
    int cellular;
    int other;
    int vpn;
} NetworkFacts;

/* 说明：完整 connectivity 快照；失败/未知格式返回 known=0。 */
NetworkFacts network_parse_connectivity(const char *text);
/* 说明：最长 3000ms、512KiB，不发起公网请求。 */
NetworkFacts network_read_default(void);
#endif
