/* 说明：compute/pkgrules.c — 包名规则表【计算层】
 * 
 * 职责：加载 pkg_rules.json，提供「包名 → 运行模式」查询。
 * 
 * 文件格式兼容两种：
 * {"default": "balance", "rules": [{"pkg": "...", "mode": "..."}]}
 * [{"pkg": "...", "mode": "..."}]
 * 
 * 匹配语义：strstr 子串匹配，按文件顺序取首个命中——沿用历史行为。
 * 对外：load_pkg_rules / pkg_rules_resolve / pkg_rules_default。
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "../core/util.h"
#include "../output/log.h"
#include "pkgrules.h"

#define MAX_PKG_RULES 128
typedef struct {
    char    pkg[128];
    RunMode mode;
} PkgRule;

/* 说明：---- 模块私有状态：g_rule_mtx 保护整张规则表 ---- */
static PkgRule         g_pkg_rules[MAX_PKG_RULES];
static int             g_pkg_rule_count = 0;
static atomic_int      g_default_mode   = MODE_POWERSAVE;
static pthread_mutex_t g_rule_mtx       = PTHREAD_MUTEX_INITIALIZER;

void load_pkg_rules(void)
{
    FILE *fp = fopen(PKG_RULE_FILE, "r");
    if (!fp) {
        pthread_mutex_lock(&g_rule_mtx);
        g_pkg_rule_count = 0;
        /* 说明：规则文件缺失或不可读时退回中性默认（均衡），并明确报错，
         * 避免「配置写的是均衡、实际却跑省电」这种沉默降级。 */
        atomic_store(&g_default_mode, MODE_BALANCE);
        pthread_mutex_unlock(&g_rule_mtx);
        LOG_ERROR("应用规则文件不可读（%s），默认模式退回均衡", PKG_RULE_FILE);
        return;
    }

    fseek(fp, 0, SEEK_END);
    long len = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    if (len <= 0 || len > 1024 * 1024) {
        fclose(fp);
        return;
    }

    char *json = (char *)malloc(len + 1);
    if (!json) { fclose(fp); return; }
    size_t rb = fread(json, 1, len, fp);
    fclose(fp);
    json[rb] = '\0';

    cJSON *root = cJSON_Parse(json);
    free(json);
    if (!root)
        return;

    cJSON *arr = root;
    /* 说明：兼容新旧格式：支持 {"default": "balance", "rules": [...]} 或纯数组 [...] */
    if (cJSON_IsObject(root)) {
        cJSON *def = cJSON_GetObjectItem(root, "default");
        if (cJSON_IsString(def)) {
            for (int i = 0; i < MODE_COUNT; i++) {
                if (strcmp(mode_names[i], def->valuestring) == 0) {
                    atomic_store(&g_default_mode, (int)i);
                    break;
                }
            }
        }
        arr = cJSON_GetObjectItem(root, "rules");
        if (!cJSON_IsArray(arr))
            arr = NULL;
    }

    pthread_mutex_lock(&g_rule_mtx);
    g_pkg_rule_count = 0;
    /* 说明：移除硬编码重置，避免覆盖用户配置的默认模式 */
    if (arr) {
        cJSON *item;
        cJSON_ArrayForEach(item, arr) {
            if (g_pkg_rule_count >= MAX_PKG_RULES)
                break;

            cJSON *p = cJSON_GetObjectItem(item, "pkg");
            cJSON *m = cJSON_GetObjectItem(item, "mode");
            if (cJSON_IsString(p) && cJSON_IsString(m)) {
                safe_strncpy(g_pkg_rules[g_pkg_rule_count].pkg,
                             p->valuestring,
                             sizeof(g_pkg_rules[0].pkg));
                for (int i = 0; i < MODE_COUNT; i++) {
                    if (strcmp(mode_names[i], m->valuestring) == 0) {
                        g_pkg_rules[g_pkg_rule_count].mode = i;
                        break;
                    }
                }
                g_pkg_rule_count++;
            }
        }
    }
    pthread_mutex_unlock(&g_rule_mtx);
    cJSON_Delete(root);
}


/* 说明：按包名匹配规则表；无命中返回默认模式。线程安全。 */
RunMode pkg_rules_resolve(const char *pkg)
{
    RunMode result = (RunMode)atomic_load(&g_default_mode);
    if (!pkg)
        return result;

    pthread_mutex_lock(&g_rule_mtx);
    for (int i = 0; i < g_pkg_rule_count; i++) {
        if (strstr(pkg, g_pkg_rules[i].pkg)) {
            result = g_pkg_rules[i].mode;
            break;
        }
    }
    pthread_mutex_unlock(&g_rule_mtx);
    return result;
}

/* 说明：无规则命中时使用的模式。 */
RunMode pkg_rules_default(void)
{
    return (RunMode)atomic_load(&g_default_mode);
}
