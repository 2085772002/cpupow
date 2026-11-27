/* 说明：collect/manualmode.h — 手动模式接口【采集层】 */
#ifndef CPUPOW_MANUALMODE_H
#define CPUPOW_MANUALMODE_H

#include "../cpupow.h"

/* 说明：读 manual_mode.txt。
 * 返回合法模式；文件缺失/为空/内容非法时返回 MODE_COUNT 作为哨兵值。
 */
RunMode parse_manual_mode_file(void);

#endif /* 说明：头文件结束：CPUPOW_MANUALMODE_H */
