/* 说明：完整附件格式快照；加载失败撤销后续写入。 */
#ifndef CPUPOW_CONFIG_H
#define CPUPOW_CONFIG_H
#include "../cpupow.h"
#include "zone.h"

#define MAX_CLUSTERS 16

/* 说明：频率分区配置。集群边界与开关来自 global.zones（全局一份，物理分段），
 * 每个区域内的 boost 公式来自 presets[模式].zones[区域].boost（每模式每区一套）。
 * config_get_zones() 只回边界；config_get_mode_zones() 额外填入指定模式的 boost。 */
typedef struct {
    int enabled;                        /* 说明：0=关闭动态分区 boost 写入 */
    int sample_ms;                      /* 说明：当前频率采样间隔（毫秒） */
    ClusterZone clusters[MAX_CLUSTERS]; /* 说明：按 policy id 索引 */
    int cluster_count;                  /* 说明：实际配置的 cluster 数 */
} ZoneConfig;

void load_config(void);
int config_check_file(const char *path);
int config_is_valid(void);
uint64_t config_get_revision(void);
void config_apply_phase_for(RunMode mode,PolicyPhase phase,ApplyStats *stats);
void config_destroy_all(void);

/* 说明：触摸时序按模式各自配置，取当前模式（g_current_mode）的那一份。 */
void config_get_touch_settings(TouchSettings *settings);
void config_restore_touch(void);

void config_get_zones(ZoneConfig *out);
/* 说明：边界 + 指定模式的每区 boost。zones.enabled=0 时 boost 仍会填入（仅用于诊断），
 * 但守护进程不会写 boost 节点。 */
void config_get_mode_zones(RunMode mode, ZoneConfig *out);

/* 说明：运行期「每个核组当前所在区域」。由采集侧在采样后写入，配置侧在下发时读取。
 * 未写入过的核组按 0（线性区）处理。 */
void config_set_cluster_zone(int cluster, int zone);
int config_cluster_zone(int cluster);
/* 说明：最近一次成功下发的阶段，供「区域切换后按当前阶段重下发」使用。 */
/* 说明：动态限最大频设置；配置无效或未启用时 enabled=0。 */
void config_get_maxfreq(MaxFreqSettings *out);
PolicyPhase config_current_phase(void);
int config_has_applied(void);
#endif