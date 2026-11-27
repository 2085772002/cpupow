/* 说明：触摸时序领域接口；只转换观测与时间，不读设备、不写配置或日志。 */
#ifndef CPUPOW_TOUCH_POLICY_H
#define CPUPOW_TOUCH_POLICY_H
#include "../cpupow.h"
typedef struct {
    int initialized;
    int active;
    uint64_t presses;
    PolicyPhase phase;
} TouchPolicy;
PolicyPhase touch_policy_step(TouchPolicy *state, const TouchSample *sample,
                              const TouchSettings *settings, uint64_t now, int reset);
int touch_policy_timeout(const TouchSample *sample, const TouchSettings *settings,
                         uint64_t now, int maximum);
#endif
