/* 说明：低开销触摸时序状态机；每次按住独立计时，松手期限不因轮询延长。 */
#include "touch_policy.h"

static uint64_t elapsed(uint64_t now, uint64_t start)
{
    return now >= start ? now - start : 0;
}

PolicyPhase touch_policy_step(TouchPolicy *state, const TouchSample *sample,
                              const TouchSettings *settings, uint64_t now, int reset)
{
    if (!state || !sample || !settings) return POLICY_PHASE_COUNT;
    PolicyPhase before = state->phase;
    int first = !state->initialized || reset;
    int new_press = sample->presses != state->presses;
    PolicyPhase next = before;
    if (!settings->enabled) {
        if (!sample->available) {
            state->initialized = 0;
            state->active = 0;
            return POLICY_PHASE_COUNT;
        }
        next = sample->active ? POLICY_TOUCH_DOWN : POLICY_TOUCH_UP;
        int changed = first || sample->active != state->active;
        state->initialized = 1;
        state->active = sample->active;
        state->presses = sample->presses;
        state->phase = next;
        return changed ? next : POLICY_PHASE_COUNT;
    }
    if (!sample->available) next = POLICY_TOUCH_IDLE;
    else if (sample->active) {
        next = elapsed(now,sample->down_ms) >= settings->long_press_ms ? POLICY_TOUCH_LONG : POLICY_TOUCH_DOWN;
    } else {
        /* 说明：从未触摸或切换模式时不重放旧尾段；合并到一帧内的点按仍可触发剩余尾段。 */
        int touched = !first && (state->active || new_press || before == POLICY_TOUCH_UP);
        next = touched && elapsed(now,sample->changed_ms) < settings->release_delay_ms ? POLICY_TOUCH_UP : POLICY_TOUCH_IDLE;
    }
    state->initialized = 1;
    state->active = sample->available && sample->active;
    state->presses = sample->presses;
    state->phase = next;
    return first || next != before || (new_press && next == POLICY_TOUCH_UP) ? next : POLICY_PHASE_COUNT;
}

/* 说明：仅缩短已有主循环等待；无新增线程、忙等或连续重写。 */
int touch_policy_timeout(const TouchSample *sample, const TouchSettings *settings,
                         uint64_t now, int maximum)
{
    if (!sample || !settings || !settings->enabled || !sample->available || maximum <= 0) return maximum;
    uint64_t duration = sample->active ? settings->long_press_ms : settings->release_delay_ms;
    uint64_t age = elapsed(now,sample->active ? sample->down_ms : sample->changed_ms);
    if (age >= duration) return maximum;
    uint64_t remaining = duration - age;
    return remaining < (uint64_t)maximum ? (int)remaining : maximum;
}