/* 说明：compute/pkgrules.h — 包名规则接口【计算层】 */
#ifndef CPUPOW_PKGRULES_H
#define CPUPOW_PKGRULES_H

#include "../cpupow.h"

/* 说明：重新读取 pkg_rules.json。文件缺失时清空规则并回到默认模式。 */
void    load_pkg_rules(void);

/* 说明：首个子串命中的模式；无命中返回默认模式。 */
RunMode pkg_rules_resolve(const char *pkg);

RunMode pkg_rules_default(void);

#endif /* 说明：头文件结束：CPUPOW_PKGRULES_H */
