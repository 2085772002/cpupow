/* 说明：通用心跳快照；业务状态由调用方提交，公共层不反向读取配置或页面。 */
#ifndef CPUPOW_STATUS_H
#define CPUPOW_STATUS_H
#include <stdint.h>
typedef struct {
    int stopping;
    int config_valid;
    uint64_t config_revision;
    const char *mode;
    const char *package;
    int touch_available;
    int log_level;
    unsigned long long start_ticks;
    const char *frequencies;   /* 说明：各集群当前频率，格式 "id:cur,id:cur"，无则空串 */
    const char *zones;         /* 说明：v2.5.6：各集群当前策略区域，格式 "id:zone,id:zone" */
    const char *caps;          /* 说明：v2.5.8：各集群当前最大频上限（kHz），格式 "id:khz,id:khz" */
} StatusSnapshot;
void status_battery_tick(void);
void status_publish(const StatusSnapshot *snapshot);
#endif