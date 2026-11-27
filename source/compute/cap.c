/* 说明：compute/cap.c — 动态限最大频的档位状态机实现【计算层，零 IO】 */
#include "cap.h"

#define CAP_PINNED_PCT   98    /* 说明：频率达到当前上限的 98% 视为顶住 */
#define CAP_RELEASE_PCT  90    /* 说明：回落到上一档上限的 90% 以下才算需求真的降了 */
#define CAP_TIGHTEN_MS   500   /* 说明：持续回落多久才降档 */
#define CAP_MIN_STEP_MS  100   /* 说明：两次换档的最小间隔 */

void cap_state_reset(CapState *state)
{
    if (!state) return;
    state->level = 0;
    state->hit_since = 0;
    state->below_since = 0;
    state->level_at = 0;
}

unsigned long long cap_freq_of(int level, const ClusterZone *cz, const FreqSample *fs)
{
    unsigned long long cap;
    if (!cz || !fs) return 0;
    if (level <= 0) cap = cz->linear_end;
    else if (level == 1) cap = cz->decay_end > cz->linear_end ? cz->decay_end : cz->linear_end;
    else cap = fs->max_freq > cz->decay_end ? fs->max_freq : cz->decay_end;
    if (cap < fs->min_freq) cap = fs->min_freq;
    if (fs->max_freq && cap > fs->max_freq) cap = fs->max_freq;
    return cap;
}

CapDecision cap_step(CapState *state, const ClusterZone *cz, const FreqSample *fs,
                     const MaxFreqSettings *settings, uint64_t now_ms,
                     unsigned long long effective_cap)
{
    CapDecision out = {0, 0, 0};
    int level;
    unsigned long long cap, prev;
    unsigned hold;

    if (!state || !cz || !fs || !settings) return out;
    level = state->level;
    if (level < 0 || level > 2) level = 0;
    cap = cap_freq_of(level, cz, fs);
    prev = level > 0 ? cap_freq_of(level - 1, cz, fs) : 0;
    out.level = level;

    if (now_ms - state->level_at < CAP_MIN_STEP_MS) { out.cap = cap; return out; }

    /* 说明：先判降档——需求真的退了就不该继续压着高价档位。 */
    if (level > 0 && prev && fs->cur_freq * 100ULL <= prev * CAP_RELEASE_PCT) {
        if (!state->below_since) state->below_since = now_ms;
        else if (now_ms - state->below_since >= CAP_TIGHTEN_MS) {
            level--;
            state->level = level;
            state->level_at = now_ms;
            state->below_since = 0;
            state->hit_since = 0;
            cap = cap_freq_of(level, cz, fs);
            out.cap = cap;
            out.level = level;
            out.changed = -1;
            return out;
        }
    } else {
        state->below_since = 0;
    }

    /* 说明：再判升档——必须持续顶住当前上限，短促毛刺不解锁。
     * 天花板取「请求值」与「内核实际接受值」里更小的那个：写下去的值被取整/钳制后，
     * 频率只能到实际值，拿请求值比就永远差一点，解锁永远不会发生。 */
    {
    unsigned long long ceiling = cap;
    if (effective_cap && effective_cap < ceiling) ceiling = effective_cap;
    if (level < 2 && fs->cur_freq * 100ULL >= ceiling * CAP_PINNED_PCT) {
        hold = level == 0 ? settings->decay_hold_ms : settings->saturate_hold_ms;
        if (!state->hit_since) state->hit_since = now_ms;
        else if (hold && now_ms - state->hit_since >= hold) {
            level++;
            state->level = level;
            state->level_at = now_ms;
            state->hit_since = 0;
            cap = cap_freq_of(level, cz, fs);
            out.cap = cap;
            out.level = level;
            out.changed = 1;
            return out;
        }
    } else if (level < 2) {
        state->hit_since = 0;
    }
    }

    out.cap = cap;
    return out;
}
