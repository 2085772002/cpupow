/* 说明：调用方负责将完整预设应用与配置重载串行化。 */
#ifndef CPUPOW_SYSFS_H
#define CPUPOW_SYSFS_H
#include "../cpupow.h"
void sysfs_apply_policy(const PolicyParams *,uint64_t,RunMode,PolicyPhase,ApplyStats *);
void sysfs_flush_status(int force);
/* 说明：动态写指定 policy 的 walt/boost（频率分区 boost 用）。轻量写入 + 读回核验。
 * 返回 0 成功，-1 失败。 */
int sysfs_write_boost(int policy_id, int boost);
/* 说明：v2.5.8：动态限最大频写 scaling_max_freq（kHz）。返回 0 成功，-1 写失败。
 * v2.5.13：*effective 回填实际生效值（内核取整/平台钳制后的读回），读不到时等于请求值。 */
int sysfs_write_maxfreq(int policy_id, unsigned long long khz, unsigned long long *effective);
/* 说明：配置重载后作废写缓存，强制下一次下发把每个节点都写一遍。 */
void sysfs_invalidate_write_cache(void);
#endif