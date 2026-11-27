/* 说明：compute/mode.c — 运行模式判定【计算层】
 * 
 * 职责：把「当前前台是谁」翻译成「该用哪个调度模式」。
 * 依赖：只依赖 platform 层暴露的探测与规则查询接口；本模块自身不做 IO。
 * 对外：determine_mode。
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "../core/util.h"
#include "../collect/foreground.h"
#include "../compute/pkgrules.h"
#include "mode.h"

/* 说明：探测前台并匹配规则；探测失败时包名填 "unknown" 并回落到默认模式。
 * 规则匹配语义（子串、首个命中）由 pkg_rules_resolve 负责，本层不留副本。
 */
RunMode determine_mode(char *out_pkg, size_t len)
{
    if (get_foreground_info(out_pkg, len) != 0) {
        safe_strncpy(out_pkg, "unknown", len);
        return pkg_rules_default();
    }
    return pkg_rules_resolve(out_pkg);
}
