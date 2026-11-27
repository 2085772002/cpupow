/* 说明：compute/mode.h — 运行模式判定接口【计算层】 */
#ifndef CPUPOW_MODE_H
#define CPUPOW_MODE_H

#include <stddef.h>
#include "../cpupow.h"

/* 说明：探测前台并匹配规则，返回应使用的模式，同时把包名写入 out_pkg。
 * 探测失败：out_pkg="unknown"，返回默认模式。
 */
RunMode determine_mode(char *out_pkg, size_t len);

#endif /* 说明：头文件结束：CPUPOW_MODE_H */
