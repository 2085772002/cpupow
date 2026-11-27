/* 说明：chg_state.h — 充放状态判读（v1.25.0，dump v15）
 * 
 * 问题（实测，见 RELEASE.md v1.25.0 第二节）：只看 power_supply/battery/status
 * 判"是否在充电"，满电 100% 插着充电器时 status 会在 Charging / Discharging
 * 之间摆动——部署机 hist 实录：
 * 
 * 19:22  chg 1→0  cap 100     （顶充结束）
 * 19:24  chg 0→1  cap 100     （status 又回到 Charging）
 * 20:04  chg 1→0  cap 100
 * 
 * 于是①页面在 100% 上显示"充电中"（用户反馈的误判）；②每次摆动都被当成
 * "拔电→插电"，触发一次画像自动重置，插电锚点跟着漂。
 * 
 * 判读规则（插电与充电解耦，插电由 power_supply/<设备>/online 判定）：
 * · 插电 且 电量>=100        → FULL 已充满：插着电、电池不再充入，不算充电中
 * · status=Charging          → CHG  充电中
 * · 插电但不在充电            → PLUG 插电未充电（限充/温控暂停/顶充间隙）
 * · 其余                      → DIS  放电
 * 插电节点探测不到（plugged=-1）时退回只看 status，与 v1.24.x 行为一致。
 * 
 * 纯函数、零 IO：采样器与单元测试共用（testing/test_chg_state.c）。
 */
#ifndef CPUPOW_CHG_STATE_H
#define CPUPOW_CHG_STATE_H

#define BATT_CHG_DIS   0   /* 说明：放电 */
#define BATT_CHG_CHG   1   /* 说明：充电中（有电流充入电池） */
#define BATT_CHG_FULL  2   /* 说明：已充满（插电 + 电量到顶，电池不再充入） */
#define BATT_CHG_PLUG  3   /* 说明：插电未充电（限充/温控暂停等，少见） */

/* 说明：raw_chg：status 语义的"正在充电"(1/0)；plugged：充电器在线(1/0/-1 未知)；
 * cap：电量百分比（-1 未知）。
 */
static inline int batt_chg_state(int raw_chg, int plugged, long long cap)
{
    if (plugged == 1 && cap >= 100) return BATT_CHG_FULL;
    if (raw_chg) return BATT_CHG_CHG;
    if (plugged == 1) return BATT_CHG_PLUG;
    return BATT_CHG_DIS;
}

/* 说明：是否真的在向电池充入电流：只有 CHG。
 * 充电时长、充电分侧统计只认这一档；FULL/PLUG 不计充电。
 */
static inline int batt_chg_is_charging(int state)
{
    return state == BATT_CHG_CHG;
}

/* 说明：v1.27.0：是否处于放电侧（未插电放电）：只有 DIS。
 * 插电未充电（FULL=已充满 / PLUG=限充或温控暂停）既不是在充电，也不是在放电待机，
 * 不得记入放电侧时长/功耗/应用/频率画像（修复夜间充满后插电到早上被算进息屏待机）。
 */
static inline int batt_chg_is_discharge(int state)
{
    return state == BATT_CHG_DIS;
}

/* 说明：v1.27.0：是否插着外部供电（含充电中 / 已充满 / 插电未充电）：非 DIS 即插电/供电态。 */
static inline int batt_chg_is_plugged(int state)
{
    return state != BATT_CHG_DIS;
}

#endif /* 说明：头文件结束：CPUPOW_CHG_STATE_H */