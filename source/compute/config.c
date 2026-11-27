/* 说明：compute/config.c — 配置解析与策略编译【计算层】
 * 
 * 职责：读 cpu_policy.json → 展开 sysfs 模板 → 把 defaults 与 presets 编译成
 * 每种运行模式的基础、短触摸、长触摸、松手过渡及恢复节点表。
 * 
 * 热更新语义：新策略树完整构建成功后才整体替换，读端永远看到完整快照；
 * 解析或编译失败清空旧树并撤销写权限；不推定硬件旧值已恢复。
 * 
 * 对外：load_config / config_apply_phase_for / config_destroy_all。
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "../output/log.h"
#include "../output/metrics.h"
#include "../core/util.h"
#include "config.h"
#include "../output/sysfs.h"
#include <math.h>

/* 说明：---- 模块私有状态：策略树与读写锁，外部一律经函数访问 ---- */
static ModePolicy       g_mode_policies[MODE_COUNT];
static pthread_rwlock_t g_rwlock = PTHREAD_RWLOCK_INITIALIZER;

static void clean_policy_resources(ModePolicy *policies)
{
    if (!policies)
        return;

    for (int m = 0; m < MODE_COUNT; m++) {
        for (int z = 0; z < ZONE_COUNT; z++)
        for (int p = 0; p < POLICY_PHASE_COUNT; p++) {
            PolicyParams *params = &policies[m].zones[z][p];
            for (int i = 0; i < params->count; i++) {
                SysfsItem *item = &params->items[i];
                if (item->resolved_paths) {
                    for (int j = 0; j < item->path_count; j++)
                        free(item->resolved_paths[j]);
                    free(item->resolved_paths);
                    item->resolved_paths = NULL;
                }
                item->path_count = 0;
            }
            params->count = 0;
        }
    }
}

typedef struct {
    char name[64];
    char path[256];
    regex_t id,policy,dir,prop;
    int has_id,has_policy,has_dir,has_prop;
} TmplDict;

static TmplDict g_templates[64];
static int g_tmpl_count = 0;
static uint64_t config_revision;
static pthread_mutex_t g_apply_mtx = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t g_load_mtx = PTHREAD_MUTEX_INITIALIZER;
/* 说明：配置加载和应用均按应用互斥锁、读写锁顺序加锁；加载失败后旧策略不得继续写入，附件格式本身限定预设权限。 */
static int config_valid;
static RunMode applied_mode;
static PolicyPhase applied_phase;
static int has_applied;
static ZoneConfig g_zones;
/* 说明：v2.5.8 动态限最大频。启用时策略树不再写 scaling_max_freq（由运行时限频器接管）。 */
static MaxFreqSettings g_maxfreq;
/* 说明：v2.5.5：每模式每区的 boost 公式，以及「该区是否配置了该核组」。
 * boost 不是 sysfs 节点，所以与策略树分开存放。 */
static ZoneBoost g_mode_boost[MODE_COUNT][ZONE_COUNT][MAX_CLUSTERS];
static int g_boost_present[MODE_COUNT][ZONE_COUNT][MAX_CLUSTERS];
/* 说明：运行期每个核组当前所在区域（0=线性 1=递减 2=饱和），由采集侧采样后写入。 */
static int g_cluster_zone[MAX_CLUSTERS];
static PolicyParams *build_fused_locked(RunMode mode, PolicyPhase phase);
static void free_params(PolicyParams *params);

/* 说明：仅在已有成功快照的时序相位退出时恢复已知基线；调用方持应用互斥锁。 */
/* 说明：v2.5.6：恢复基线的写入并进调用方的统计，否则一次「回到空闲」可能报 writ=0
 * 却实际改了节点（恢复用的是另一个 stats 副本），日志与回执会对不上。 */
static void restore_touch_locked(ApplyStats *out)
{
    if (!config_valid || !has_applied ||
        applied_phase == POLICY_IDLE || applied_phase == POLICY_TOUCH_IDLE) return;
    if (!g_mode_policies[applied_mode].touch.enabled) return;
    /* 说明：v2.5.5：恢复基线也按「每个核组自己所在的区域」取，不能再取一份扁平基线。 */
    PolicyParams *snap = build_fused_locked(applied_mode, POLICY_TOUCH_IDLE);
    if (!snap) return;
    ApplyStats local;
    memset(&local, 0, sizeof(local));
    sysfs_apply_policy(snap, config_revision, applied_mode, POLICY_TOUCH_IDLE, out ? out : &local);
    free_params(snap);
    applied_phase = POLICY_TOUCH_IDLE;
}

void config_restore_touch(void)
{
    pthread_mutex_lock(&g_apply_mtx);
    restore_touch_locked(NULL);
    pthread_mutex_unlock(&g_apply_mtx);
}

/* 说明：触摸时序按模式各自配置，这里返回「当前运行模式」的那一份。 */
void config_get_touch_settings(TouchSettings *settings)
{
 if (!settings) return;
 memset(settings, 0, sizeof(*settings));
 pthread_rwlock_rdlock(&g_rwlock);
 if (config_valid) *settings = g_mode_policies[g_current_mode].touch;
 pthread_rwlock_unlock(&g_rwlock);
}
/* 说明：返回频率分区边界副本；配置无效时 enabled=0。boost 由 config_get_mode_zones 填。 */
void config_get_zones(ZoneConfig *out)
{
 if (!out) return;
 pthread_rwlock_rdlock(&g_rwlock);
 *out = g_zones;
 for (int c = 0; c < MAX_CLUSTERS; c++) memset(out->clusters[c].zones, 0, sizeof(out->clusters[c].zones));
 if (!config_valid) out->enabled = 0;
 pthread_rwlock_unlock(&g_rwlock);
}
/* 说明：边界 + 指定模式的每区 boost。main/diag 用这一份才能算出该模式真正会写的 boost。 */
void config_get_mode_zones(RunMode mode, ZoneConfig *out)
{
 if (!out) return;
 config_get_zones(out);
 if (mode < 0 || mode >= MODE_COUNT) return;
 pthread_rwlock_rdlock(&g_rwlock);
 if (config_valid) {
  for (int c = 0; c < MAX_CLUSTERS; c++)
   for (int z = 0; z < ZONE_COUNT; z++)
    if (g_boost_present[mode][z][c]) out->clusters[c].zones[z] = g_mode_boost[mode][z][c];
 }
 pthread_rwlock_unlock(&g_rwlock);
}
/* 说明：运行期区域记录。采集侧算完区就写，下发侧据此挑节点；不参与配置有效性判断。 */
void config_set_cluster_zone(int cluster, int zone)
{
 if (cluster < 0 || cluster >= MAX_CLUSTERS) return;
 g_cluster_zone[cluster] = (zone >= 0 && zone < ZONE_COUNT) ? zone : 0;
}
int config_cluster_zone(int cluster)
{
 if (cluster < 0 || cluster >= MAX_CLUSTERS) return 0;
 return g_cluster_zone[cluster];
}
void config_get_maxfreq(MaxFreqSettings *out)
{
 if (!out) return;
 memset(out, 0, sizeof(*out));
 pthread_rwlock_rdlock(&g_rwlock);
 if (config_valid) {
  /* 说明：v2.5.11：时长取当前模式自己的那一份，总开关取 global。 */
  *out = g_mode_policies[g_current_mode].maxfreq;
  out->enabled = g_maxfreq.enabled;
 }
 pthread_rwlock_unlock(&g_rwlock);
}
PolicyPhase config_current_phase(void) { return applied_phase; }
int config_has_applied(void) { return has_applied; }
static void config_release_tree_locked(void)
{
 pthread_rwlock_wrlock(&g_rwlock);
 clean_policy_resources(g_mode_policies); config_valid=0; has_applied=0; config_revision++;
 pthread_rwlock_unlock(&g_rwlock);
}
int config_is_valid(void)
{
 pthread_rwlock_rdlock(&g_rwlock);int ok=config_valid;pthread_rwlock_unlock(&g_rwlock);return ok;
}
uint64_t config_get_revision(void)
{
 pthread_rwlock_rdlock(&g_rwlock);uint64_t r=config_revision;pthread_rwlock_unlock(&g_rwlock);return r;
}

/* 说明：配置编译必须全有或全无，包含通配展开与内存分配；禁止发布被截断的路径、数值和节点列表。 */
static int cache_path(SysfsItem *item, const char *path)
{
    if (item->path_count >= MAX_CACHED_PATHS || strlen(path) >= sizeof(item->raw_path))
        return -1;
    char *copy = strdup(path);
    if (!copy) return -1;
    char **next = realloc(item->resolved_paths, (size_t)(item->path_count + 1) * sizeof(*next));
    if (!next) { free(copy); return -1; }
    item->resolved_paths = next;
    item->resolved_paths[item->path_count++] = copy;
    return 0;
}
/* 说明：动态限最大频启用时，策略树不能再写 scaling_max_freq —— 这个节点归运行时限频器。 */
static int maxfreq_node(const char *path)
{
    static const char tail[] = "/scaling_max_freq";
    size_t n = path ? strlen(path) : 0, m = sizeof(tail) - 1;
    return n >= m && !strcmp(path + n - m, tail);
}

static int upsert_sysfs_item(PolicyParams *params, const char *raw_path, const char *value, int is_sh, int policy_id)
{
    if (is_sh) return -1;
    if (g_maxfreq.enabled && maxfreq_node(raw_path)) return 0;
    if (!raw_path[0] || strlen(raw_path) >= sizeof(params->items[0].raw_path) ||
        !value[0] || strlen(value) >= sizeof(params->items[0].value)) return -1;
    for (int i = 0; i < params->count; i++) {
        if (params->items[i].is_sh == is_sh && !strcmp(params->items[i].raw_path, raw_path)) {
            safe_strncpy(params->items[i].value, value, sizeof(params->items[i].value));
            return 0;
        }
    }
    if (params->count >= MAX_SYSFS_NODES) return -1;
    SysfsItem *cur = &params->items[params->count++];
    safe_strncpy(cur->raw_path, raw_path, sizeof(cur->raw_path));
    safe_strncpy(cur->value, value, sizeof(cur->value));
    cur->is_sh = is_sh;
    cur->policy_id = (is_sh ? -1 : policy_id);
    if (is_sh) return 0;
    if (!strpbrk(raw_path, "*?[]")) return cache_path(cur, raw_path);
    glob_t matches = {0};
    int code = glob(raw_path, GLOB_NOSORT, NULL, &matches);
    int result = (code == 0 || code == GLOB_NOMATCH) ? 0 : -1;
    if (!result && matches.gl_pathc > MAX_CACHED_PATHS) result = -1;
    for (size_t j = 0; !result && j < matches.gl_pathc; j++)
        result = cache_path(cur, matches.gl_pathv[j]);
    globfree(&matches);
    return result;
}

static int copy_policy_params(PolicyParams *dest, const PolicyParams *src) {
    dest->count=0;
    for(int i=0;i<src->count;i++) {
        SysfsItem *d=&dest->items[i];*d=src->items[i];d->resolved_paths=NULL;d->path_count=0;
        dest->count=i+1;
        if(src->items[i].path_count) {
            d->resolved_paths=calloc((size_t)src->items[i].path_count,sizeof(char *));
            if(!d->resolved_paths)return -1;
            for(int j=0;j<src->items[i].path_count;j++) {
                d->resolved_paths[j]=strdup(src->items[i].resolved_paths[j]);
                if(!d->resolved_paths[j])return -1;
                d->path_count++;
            }
        }
    }
    return 0;
}

static int policy_key_valid(const char *key)
{
    return key && key[0] && strcmp(key, ".") && strcmp(key, "..") &&
        strspn(key, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-") == strlen(key);
}
static int template_match(const regex_t *rx,const char *key)
{
 return policy_key_valid(key) && regexec(rx,key,0,NULL,0)==0;
}
static int compile_value(PolicyParams *out, const TmplDict *t, const char *key,
                         const char *prop, const cJSON *value)
{
 char path[512],text[128];
 if ((prop && (!t->has_policy || !template_match(&t->policy,key) || !template_match(&t->prop,prop))) ||
     (!prop && ((t->has_id && !template_match(&t->id,key)) ||
                (t->has_prop && !template_match(&t->prop,key)) || t->has_policy))) return -1;
 if (cJSON_IsString(value) && value->valuestring[0] && strlen(value->valuestring)<sizeof(text) &&
     strspn(value->valuestring,"0123456789-+ .:\t")==strlen(value->valuestring))
     safe_strncpy(text,value->valuestring,sizeof(text));
 else if(cJSON_IsNumber(value) && isfinite(value->valuedouble) && value->valuedouble==(double)value->valueint)
     snprintf(text,sizeof(text),"%d",value->valueint);
 else return -1;
 safe_strncpy(path,t->path,sizeof(path));
 if(prop){str_replace(path,"{policy}",key);str_replace(path,"{prop}",prop);}
 else {str_replace(path,"{id}",key);str_replace(path,"{prop}",key);}
 if(t->has_dir){
  char *mark=strstr(path,"{dir}");if(!mark)return -1;
  char parent[512];size_t len=(size_t)(mark-path);if(!len||len>=sizeof(parent))return -1;
  memcpy(parent,path,len);parent[len]=0;
  DIR *d=opendir(parent);int found=0;
  if(d){struct dirent *e;
   while((e=readdir(d))){
    if(!strcmp(e->d_name,".")||!strcmp(e->d_name,"..")||strchr(e->d_name,'/'))continue;
    if(regexec(&t->dir,e->d_name,0,NULL,0))continue;
    char dirpath[512];int n=snprintf(dirpath,sizeof(dirpath),"%s%s",parent,e->d_name);struct stat st;
    if(n<0||(size_t)n>=sizeof(dirpath)){closedir(d);return -1;}
    if(stat(dirpath,&st)||!S_ISDIR(st.st_mode))continue;
    char resolved[512];safe_strncpy(resolved,path,sizeof(resolved));str_replace(resolved,"{dir}",e->d_name);
    if(strchr(resolved,'{')||upsert_sysfs_item(out,resolved,text,0,-1)){closedir(d);return -1;}
    found++;
   }closedir(d);
  }
  /* 说明：缺失的通配节点保留为明确的缺失观测。 */
  if(!found){str_replace(path,"{dir}","*");return upsert_sysfs_item(out,path,text,0,-1);}
  return 0;
 }
 if(strpbrk(path,"{}")||strstr(path,"/../")||strstr(path,"/./"))return -1;
 /* 说明：带 {policy} 的模板一个节点只属于一个核组，编译期就把归属记下来。 */
 return upsert_sysfs_item(out,path,text,0,prop?atoi(key):-1);
}
static int parse_config_block(const cJSON *block, PolicyParams *out)
{
    if (!cJSON_IsObject(block)) return -1;
    for (const cJSON *node = block->child; node; node = node->next) {
        const TmplDict *tmpl = NULL;
        for (int i = 0; i < g_tmpl_count; i++)
            if (!strcmp(g_templates[i].name, node->string)) tmpl = &g_templates[i];
        if (!tmpl) return -1;
        if (!cJSON_IsObject(node)) return -1;
        for (const cJSON *entry = node->child; entry; entry = entry->next) {
            if (cJSON_IsObject(entry)) {
                for (const cJSON *value = entry->child; value; value = value->next)
                    if (compile_value(out, tmpl, entry->string, value->string, value)) return -1;
            } else if (compile_value(out, tmpl, entry->string, NULL, entry)) return -1;
        }
    }
    return 0;
}

/* 说明：结构和转义交由解析库，同时拒绝宽松数字和空白解析额外接受的非法标记。 */
static int json_tokens_strict(const char *text)
{
    const unsigned char *p = (const unsigned char *)text;
    while (*p) {
        if (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n' || strchr("{}[],:", *p)) { p++; continue; }
        if (*p == '"') {
            p++;
            while (*p && *p != '"') {
                if (*p < 32) return 0;
                if (*p++ == '\\') {
                    if (!*p) return 0;
                    if (*p == 'u') {
                        p++;
                        unsigned code = 0;
                        for (int i = 0; i < 4; i++) {
                            if (!isxdigit(*p)) return 0;
                            code = code * 16 + (*p <= '9' ? *p - '0' : (tolower(*p) - 'a' + 10));
                            p++;
                        }
                        if (!code) return 0;
                    } else {
                        if (!strchr("\"\\/bfnrt", *p)) return 0;
                        p++;
                    }
                }
            }
            if (*p++ != '"') return 0;
            continue;
        }
        if (*p == '-' || isdigit(*p)) {
            if (*p == '-') p++;
            if (*p == '0') p++;
            else {
                if (*p < '1' || *p > '9') return 0;
                while (isdigit(*p)) p++;
            }
            if (*p == '.') { p++; if (!isdigit(*p)) return 0; while (isdigit(*p)) p++; }
            if (*p == 'e' || *p == 'E') {
                p++; if (*p == '+' || *p == '-') p++;
                if (!isdigit(*p)) return 0;
                while (isdigit(*p)) p++;
            }
        } else if (!strncmp((const char *)p, "true", 4)) p += 4;
        else if (!strncmp((const char *)p, "false", 5)) p += 5;
        else if (!strncmp((const char *)p, "null", 4)) p += 4;
        else return 0;
        if (*p && !strchr(" \t\r\n,]}", *p)) return 0;
    }
    return 1;
}

static int json_tree_valid(const cJSON *node, unsigned depth)
{
    if (!node || depth > 32 || (cJSON_IsNumber(node) && !isfinite(node->valuedouble)))
        return 0;
    if (cJSON_IsObject(node)) {
        unsigned count = 0;
        for (const cJSON *child = node->child; child; child = child->next) {
            if (!child->string || ++count > 512)
                return 0;
            for (const cJSON *prior = node->child; prior != child; prior = prior->next)
                if (prior->string && !strcmp(prior->string, child->string))
                    return 0;
            if (!json_tree_valid(child, depth + 1))
                return 0;
        }
    } else if (cJSON_IsArray(node)) {
        unsigned count = 0;
        for (const cJSON *child = node->child; child; child = child->next)
            if (++count > 512 || !json_tree_valid(child, depth + 1))
                return 0;
    } else if (cJSON_IsString(node) && !node->valuestring) {
        return 0;
    }
    return 1;
}
static int integer_in_range(const cJSON *item, int minimum, int maximum)
{
    return cJSON_IsNumber(item) && item->valuedouble == (double)item->valueint &&
           item->valueint >= minimum && item->valueint <= maximum;
}
/* 说明：---- 动态频率分区（global.zones）解析 ---- */
/* 说明：旧 formula 字符串映射到弯曲度（新配置直接用 bend）。 */
static int zone_bend_from_formula(const char *s)
{
    if (!s) return -1;
    if (!strcmp(s, "linear") || !strcmp(s, "linear_up") || !strcmp(s, "linear_down")) return 0;
    if (!strcmp(s, "curve") || !strcmp(s, "curve_up") || !strcmp(s, "curve_down")) return 25;
    return -1;
}
/* 说明：解析单个区的 boost 对象。新格式 {bend,start,end}；兼容旧 {formula,start,end}。 */
static int zone_boost_parse(const cJSON *b, ZoneBoost *out)
{
    const cJSON *bend, *f, *s, *e;
    if (!cJSON_IsObject(b) || cJSON_GetArraySize(b) != 3) return 0;
    s = cJSON_GetObjectItemCaseSensitive(b, "start");
    e = cJSON_GetObjectItemCaseSensitive(b, "end");
    if (!integer_in_range(s, -1000, 1000) || !integer_in_range(e, -1000, 1000)) return 0;
    out->start = s->valueint;
    out->end = e->valueint;
    bend = cJSON_GetObjectItemCaseSensitive(b, "bend");
    if (bend) {
        if (!integer_in_range(bend, -100, 100)) return 0;
        out->bend = bend->valueint;
    } else {
        f = cJSON_GetObjectItemCaseSensitive(b, "formula");
        if (!cJSON_IsString(f)) return 0;
        out->bend = zone_bend_from_formula(f->valuestring);
        if (out->bend < 0) return 0;
    }
    return 1;
}
/* 说明：v2.5.5：global.zones 只描述「三个区域的边界」（物理分段，全局一份）。
 * 每个区域内的 boost 公式已移到 presets[模式].zones[区域].boost。 */
static int zones_parse(const cJSON *zones, ZoneConfig *out)
{
    const cJSON *en, *sm, *clusters, *node;
    memset(out, 0, sizeof(*out));
    if (!cJSON_IsObject(zones) || cJSON_GetArraySize(zones) < 1 || cJSON_GetArraySize(zones) > 3) return 0;
    en = cJSON_GetObjectItemCaseSensitive(zones, "enabled");
    sm = cJSON_GetObjectItemCaseSensitive(zones, "sample_ms");
    clusters = cJSON_GetObjectItemCaseSensitive(zones, "clusters");
    if (!cJSON_IsBool(en)) return 0;
    out->enabled = cJSON_IsTrue(en) ? 1 : 0;
    /* 说明：v2.5.10：sample_ms 是「公用的采样间隔」——区域判定、动态限最大频、boost 与频率展示
     * 都按它来，不再依附于「写入动态 boost」这个开关。缺省 10ms。 */
    if (sm) { if (!integer_in_range(sm, 10, 10000)) return 0; out->sample_ms = sm->valueint; }
    else out->sample_ms = 10;
    /* 说明：关闭动态分区时允许不给边界；开启则必须给每核组边界。 */
    if (!clusters) return out->enabled ? 0 : 1;
    if (!cJSON_IsObject(clusters)) return 0;
    for (node = clusters->child; node; node = node->next) {
        const cJSON *le, *de;
        ClusterZone *cz;
        int id;
        if (!node->string || node->string[0] == '\0' ||
            strspn(node->string, "0123456789") != strlen(node->string)) return 0;
        id = atoi(node->string);
        /* 说明：超出可索引范围的 policy 编号直接跳过该项，不让整份配置因单个核组失效。 */
        if (id < 0 || id >= MAX_CLUSTERS) continue;
        if (!cJSON_IsObject(node) || cJSON_GetArraySize(node) != 2) return 0;
        le = cJSON_GetObjectItemCaseSensitive(node, "linear_end");
        de = cJSON_GetObjectItemCaseSensitive(node, "decay_end");
        if (!integer_in_range(le, 1, 2147483647) ||
            !integer_in_range(de, 1, 2147483647) ||
            le->valueint > de->valueint) return 0;
        cz = &out->clusters[id];
        cz->linear_end = (unsigned long long)le->valueint;
        cz->decay_end = (unsigned long long)de->valueint;
        if (out->cluster_count < MAX_CLUSTERS) out->cluster_count++;
    }
    return 1;
}
/* 说明：v2.5.11：顶住时长按模式各自配置。
 * global.maxfreq 只留 enabled（总开关）；旧配置把两个时长写在 global 里也认，
 * 当作「所有模式没单独配置时的缺省」。 */
static int maxfreq_parse_global(const cJSON *node, MaxFreqSettings *out)
{
    int keys;
    const cJSON *en, *decay, *sat;
    memset(out, 0, sizeof(*out));
    out->decay_hold_ms = MAXFREQ_DEFAULT_DECAY_MS;
    out->saturate_hold_ms = MAXFREQ_DEFAULT_SATURATE_MS;
    if (!cJSON_IsObject(node)) return 0;
    en = cJSON_GetObjectItemCaseSensitive(node, "enabled");
    if (!cJSON_IsBool(en)) return 0;
    out->enabled = cJSON_IsTrue(en) ? 1 : 0;
    keys = cJSON_GetArraySize(node);
    if (keys < 1 || keys > 3) return 0;
    decay = cJSON_GetObjectItemCaseSensitive(node, "decay_hold_ms");
    sat = cJSON_GetObjectItemCaseSensitive(node, "saturate_hold_ms");
    if (decay || sat) {
        if (!integer_in_range(decay, 20, 5000) || !integer_in_range(sat, 20, 5000)) return 0;
        out->decay_hold_ms = (unsigned)decay->valueint;
        out->saturate_hold_ms = (unsigned)sat->valueint;
    }
    return 1;
}

/* 说明：模式下自带的两个时长；缺省不填（由 global 的缺省兜底）。 */
static int maxfreq_parse_mode(const cJSON *node, MaxFreqSettings *out)
{
    const cJSON *decay, *sat;
    if (!cJSON_IsObject(node) || cJSON_GetArraySize(node) != 2) return 0;
    decay = cJSON_GetObjectItemCaseSensitive(node, "decay_hold_ms");
    sat = cJSON_GetObjectItemCaseSensitive(node, "saturate_hold_ms");
    if (!integer_in_range(decay, 20, 5000) || !integer_in_range(sat, 20, 5000)) return 0;
    out->decay_hold_ms = (unsigned)decay->valueint;
    out->saturate_hold_ms = (unsigned)sat->valueint;
    return 1;
}

static int global_settings_valid(const cJSON *global)
{
    int keys;
    const cJSON *zones, *maxfreq;
    if (!cJSON_IsObject(global) ||
        !integer_in_range(cJSON_GetObjectItemCaseSensitive(global,"log_level"),0,3)) return 0;
    keys = cJSON_GetArraySize(global);
    if (keys < 1 || keys > 3) return 0;
    zones = cJSON_GetObjectItemCaseSensitive(global,"zones");
    if (zones && !zones_parse(zones, &g_zones)) return 0;
    if (!zones) { memset(&g_zones, 0, sizeof(g_zones)); g_zones.enabled = 0; }
    /* 说明：v2.5.8：动态限最大频默认开启。配置里没有这个块（2.5.7 及更早的配置）
     * 按「开启 + 200/400ms」处理——升级后不需要重新生成就生效；
     * 想关掉就在界面里关，或写 "maxfreq":{"enabled":false}。 */
    memset(&g_maxfreq, 0, sizeof(g_maxfreq));
    g_maxfreq.enabled = 1;
    g_maxfreq.decay_hold_ms = MAXFREQ_DEFAULT_DECAY_MS;
    g_maxfreq.saturate_hold_ms = MAXFREQ_DEFAULT_SATURATE_MS;
    maxfreq = cJSON_GetObjectItemCaseSensitive(global,"maxfreq");
    if (maxfreq && !maxfreq_parse_global(maxfreq, &g_maxfreq)) return 0;
    return 1;
}
static void clear_templates(void)
{
 for(int i=0;i<g_tmpl_count;i++){
  TmplDict *t=&g_templates[i];
  if(t->has_id)regfree(&t->id);
  if(t->has_policy)regfree(&t->policy);
  if(t->has_dir)regfree(&t->dir);
  if(t->has_prop)regfree(&t->prop);
 }
 memset(g_templates,0,sizeof(g_templates));g_tmpl_count=0;
}
static int parameter_regex(const cJSON *params,const char *name,regex_t *rx,int *present)
{
 const cJSON *v=cJSON_GetObjectItemCaseSensitive(params,name);
 if(!v)return 0;
 if(!cJSON_IsString(v)||!v->valuestring[0]||strlen(v->valuestring)>240)return -1;
 char pattern[256];snprintf(pattern,sizeof(pattern),"^(%s)$",v->valuestring);
 if(regcomp(rx,pattern,REG_EXTENDED|REG_NOSUB))return -1;
 *present=1;return 0;
}
static int manual_templates_valid(const cJSON *sysfs)
{
 clear_templates();
 if(!cJSON_IsArray(sysfs)||cJSON_GetArraySize(sysfs)<1||cJSON_GetArraySize(sysfs)>64)return 0;
 for(const cJSON *e=sysfs->child;e;e=e->next){
  const cJSON *n=cJSON_GetObjectItemCaseSensitive(e,"name"),*p=cJSON_GetObjectItemCaseSensitive(e,"path");
  const cJSON *params=cJSON_GetObjectItemCaseSensitive(e,"params");
  if(!cJSON_IsObject(e)||cJSON_GetArraySize(e)!=3||!cJSON_IsString(n)||!policy_key_valid(n->valuestring)||
     strlen(n->valuestring)>=64||!cJSON_IsString(p)||strncmp(p->valuestring,"/sys/",5)||
     strlen(p->valuestring)>=240||strstr(p->valuestring,"/../")||strstr(p->valuestring,"/./")||
     strpbrk(p->valuestring,"*?[]\n\r")||!cJSON_IsObject(params))return 0;
  for(int i=0;i<g_tmpl_count;i++)if(!strcmp(g_templates[i].name,n->valuestring))return 0;
  TmplDict *t=&g_templates[g_tmpl_count++];safe_strncpy(t->name,n->valuestring,sizeof(t->name));
#ifdef CPUPOW_SYSFS_ROOT
  if(snprintf(t->path,sizeof(t->path),"%s%s",CPUPOW_SYSFS_ROOT,p->valuestring)>=(int)sizeof(t->path))return 0;
#else
  safe_strncpy(t->path,p->valuestring,sizeof(t->path));
#endif
  if(parameter_regex(params,"id",&t->id,&t->has_id)||parameter_regex(params,"policy",&t->policy,&t->has_policy)||
     parameter_regex(params,"dir",&t->dir,&t->has_dir)||parameter_regex(params,"prop",&t->prop,&t->has_prop))return 0;
  if(cJSON_GetArraySize(params)!=t->has_id+t->has_policy+t->has_dir+t->has_prop)return 0;
  if(!((t->has_id&&!t->has_prop&&!t->has_dir&&!t->has_policy)||
       (t->has_prop&&!t->has_id&&(t->has_dir!=t->has_policy))))return 0;
  char copy[512];safe_strncpy(copy,t->path,sizeof(copy));
  const char *names[]={"{id}","{policy}","{dir}","{prop}"};
  int flags[]={t->has_id,t->has_policy,t->has_dir,t->has_prop};
  for(int j=0;j<4;j++){
   char *at=strstr(copy,names[j]);if(!!at!=flags[j]||(at&&strstr(at+strlen(names[j]),names[j])))return 0;
   if(at)str_replace(copy,names[j],"x");
  }
  if(strpbrk(copy,"{}"))return 0;
 }
 return 1;
}

/* 说明：v2.5.5：区域块 = boost（每核组公式）+ 阶段（"*" 必填，触摸增量可选）。 */
static int zone_block_valid(const cJSON *zb)
{
    int has_idle = 0;
    const cJSON *boost;
    ClusterZone scratch;
    if (!cJSON_IsObject(zb)) return 0;
    boost = cJSON_GetObjectItemCaseSensitive(zb, "boost");
    if (!cJSON_IsObject(boost) || cJSON_GetArraySize(boost) < 1 ||
        cJSON_GetArraySize(boost) > MAX_CLUSTERS) return 0;
    for (const cJSON *node = boost->child; node; node = node->next) {
        if (!node->string || node->string[0] == '\0' ||
            strspn(node->string, "0123456789") != strlen(node->string)) return 0;
        if (!zone_boost_parse(node, &scratch.zones[0])) return 0;
    }
    for (const cJSON *phase = zb->child; phase; phase = phase->next) {
        if (!strcmp(phase->string, "boost")) continue;
        if (!cJSON_IsObject(phase)) return 0;
        if (!strcmp(phase->string, "*")) { has_idle = 1; continue; }
        if (strcmp(phase->string, "touch_down") && strcmp(phase->string, "touch_up") &&
            strcmp(phase->string, "touch_long")) return 0;
    }
    return has_idle;
}

/* 说明：每档必须给出触摸时序与三个区域，每个区域必须显式提供空闲相位；
 * 触摸增量可选且不推断，未知档位/区域/相位名称必须报错。 */
static int manual_presets_valid(const cJSON *presets)
{
    static const char *zone_keys[ZONE_COUNT] = {"linear", "decay", "saturate"};
    if (!cJSON_IsObject(presets) || cJSON_GetArraySize(presets) != MODE_COUNT) return 0;
    for (int m = 0; m < MODE_COUNT; m++) {
        const cJSON *mode = cJSON_GetObjectItemCaseSensitive(presets, mode_names[m]);
        const cJSON *timing, *zones;
        int mode_keys = cJSON_IsObject(mode) ? cJSON_GetArraySize(mode) : 0;
        if (mode_keys != 2 && mode_keys != 3) return 0;
        timing = cJSON_GetObjectItemCaseSensitive(mode, "touch");
        zones = cJSON_GetObjectItemCaseSensitive(mode, "zones");
        if (!cJSON_IsObject(timing) || cJSON_GetArraySize(timing) != 2 ||
            !integer_in_range(cJSON_GetObjectItemCaseSensitive(timing,"long_press_ms"),100,5000) ||
            !integer_in_range(cJSON_GetObjectItemCaseSensitive(timing,"release_delay_ms"),0,2000)) return 0;
        if (!cJSON_IsObject(zones) || cJSON_GetArraySize(zones) != ZONE_COUNT) return 0;
        for (int z = 0; z < ZONE_COUNT; z++)
            if (!zone_block_valid(cJSON_GetObjectItemCaseSensitive(zones, zone_keys[z]))) return 0;
        /* 说明：v2.5.11：可选的每模式限频时长。 */
        if (mode_keys == 3) {
            MaxFreqSettings scratch;
            const cJSON *mf = cJSON_GetObjectItemCaseSensitive(mode, "maxfreq");
            if (!maxfreq_parse_mode(mf, &scratch)) return 0;
        }
    }
    return 1;
}
static int frequency_pairs_valid(const PolicyParams *p)
{
 for(int i=0;i<p->count;i++){
  const SysfsItem *min=&p->items[i];const char *tail=strrchr(min->raw_path,'/');
  if(!tail||strcmp(tail,"/scaling_min_freq"))continue;
  char path[256];safe_strncpy(path,min->raw_path,sizeof(path));strcpy(strrchr(path,'/'),"/scaling_max_freq");
  for(int j=0;j<p->count;j++)if(!strcmp(p->items[j].raw_path,path) &&
      strtoll(min->value,NULL,10)>strtoll(p->items[j].value,NULL,10))return 0;
 }
 return 1;
}
static void free_params(PolicyParams *params);

/* 说明：只恢复全部触摸增量路径的并集；所有路径必须有基线，禁止猜测内核旧值。 */
static int compile_touch_restore_zone(ModePolicy *mode, int zone)
{
    PolicyParams *idle = &mode->zones[zone][POLICY_IDLE];
    PolicyParams *restore = &mode->zones[zone][POLICY_TOUCH_IDLE];
    for (int phase = POLICY_TOUCH_DOWN; phase <= POLICY_TOUCH_LONG; phase++) {
        PolicyParams *delta = &mode->zones[zone][phase];
        for (int i = 0; i < delta->count; i++) {
            const SysfsItem *base = NULL;
            for (int j = 0; j < idle->count; j++)
                if (!strcmp(idle->items[j].raw_path,delta->items[i].raw_path)) { base=&idle->items[j]; break; }
            if (!base || upsert_sysfs_item(restore,base->raw_path,base->value,0,base->policy_id)) return -1;
        }
    }
    for (int phase = POLICY_TOUCH_DOWN; phase <= POLICY_TOUCH_LONG; phase++) {
        PolicyParams *delta = &mode->zones[zone][phase];
        PolicyParams *effective = calloc(1,sizeof(*effective));
        PolicyParams *projected = calloc(1,sizeof(*projected));
        int invalid = !effective || !projected;
        if (!invalid) invalid = copy_policy_params(effective,idle) || copy_policy_params(projected,restore);
        for (int i = 0; !invalid && i < delta->count; i++) {
            const SysfsItem *item=&delta->items[i];
            invalid = upsert_sysfs_item(effective,item->raw_path,item->value,0,item->policy_id) ||
                      upsert_sysfs_item(projected,item->raw_path,item->value,0,item->policy_id);
        }
        if (!invalid) invalid = !frequency_pairs_valid(effective);
        if (!invalid) {
            for (int i=0;i<delta->count;i++) {
                for (int j=0;j<delta->items[i].path_count;j++) free(delta->items[i].resolved_paths[j]);
                free(delta->items[i].resolved_paths);
            }
            *delta = *projected;
            projected->count=0;
        }
        free_params(effective);
        free_params(projected);
        if (invalid) return -1;
    }
    return 0;
}

static void free_params(PolicyParams *params)
{
    if (!params) return;
    for (int i = 0; i < params->count; i++) {
        for (int j = 0; j < params->items[i].path_count; j++) free(params->items[i].resolved_paths[j]);
        free(params->items[i].resolved_paths);
    }
    free(params);
}

static int load_config_file(const char *path, int check_only)
{
    long long __c0 = metrics_now_us();
    pthread_mutex_lock(&g_load_mtx);
    pthread_mutex_lock(&g_apply_mtx);
    FILE *fp = fopen(path, "r");
    if (!fp) {
        if (!check_only) config_release_tree_locked();
        pthread_mutex_unlock(&g_apply_mtx);
        pthread_mutex_unlock(&g_load_mtx);
        if (!check_only) LOG_ERROR("配置不可读，已停止项目策略写入 (%s)", CONFIG_FILE);
        return 0;
    }

    int seek_failed = fseek(fp, 0, SEEK_END);
    long len = seek_failed ? -1 : ftell(fp);
    if (fseek(fp, 0, SEEK_SET)) len = -1;

    if (len <= 0 || len > 10 * 1024 * 1024) {
        fclose(fp);
        if (!check_only) config_release_tree_locked();
        pthread_mutex_unlock(&g_apply_mtx);
        pthread_mutex_unlock(&g_load_mtx);
        return 0;
    }

    char *json_str = (char *)malloc(len + 1);
    if (!json_str) {
        fclose(fp);
        if (!check_only) config_release_tree_locked();
        pthread_mutex_unlock(&g_apply_mtx);
        pthread_mutex_unlock(&g_load_mtx);
        if (!check_only) LOG_ERROR("配置内存不足，已停止项目策略写入");
        return 0;
    }

    size_t read_bytes = fread(json_str, 1, len, fp);
    fclose(fp);
    json_str[read_bytes] = '\0'; /* 说明：v1.3.0 修复：原误写为 '0'（ASCII 0x30），字符串未真正闭合，存在越界读风险 */

    cJSON *root = read_bytes == (size_t)len && !memchr(json_str, 0, read_bytes) &&
        json_tokens_strict(json_str) ? cJSON_ParseWithOpts(json_str, NULL, 1) : NULL;
    free(json_str);

    if (!cJSON_IsObject(root) || !json_tree_valid(root, 0)) {
        cJSON_Delete(root);
        if (!check_only) config_release_tree_locked();
        pthread_mutex_unlock(&g_apply_mtx);
        pthread_mutex_unlock(&g_load_mtx);
        if (!check_only) LOG_ERROR("配置无效或包含重复键，已停止项目策略写入");
        return 0;
    }

    cJSON *global=cJSON_GetObjectItemCaseSensitive(root,"global");
    cJSON *version=cJSON_GetObjectItemCaseSensitive(root,"version");
    if(cJSON_GetArraySize(root)!=5||!cJSON_IsString(version)||!version->valuestring[0]||
       !global_settings_valid(global)||
       !manual_templates_valid(cJSON_GetObjectItemCaseSensitive(root,"sysfs"))||
       !cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(root,"defaults"))||
       !manual_presets_valid(cJSON_GetObjectItemCaseSensitive(root,"presets"))) {
      clear_templates();cJSON_Delete(root);if (!check_only) config_release_tree_locked();
      pthread_mutex_unlock(&g_apply_mtx);pthread_mutex_unlock(&g_load_mtx);
      if (!check_only) LOG_ERROR("配置格式/参数无效，停止后续策略写入");return 0;
    }
    /* 说明：2. 预编译 Defaults 基线 (改为安全的堆内存分配，彻底消灭栈溢出) */
    PolicyParams *master_defaults = (PolicyParams *)calloc(1, sizeof(PolicyParams));
    ModePolicy *new_policies = calloc(MODE_COUNT, sizeof(*new_policies));
    /* 说明：boost 公式按「模式 × 区域 × 核组」暂存，与策略树一起原子发布。 */
    ZoneBoost (*new_boost)[ZONE_COUNT][MAX_CLUSTERS] = calloc(MODE_COUNT, sizeof(*new_boost));
    int (*new_present)[ZONE_COUNT][MAX_CLUSTERS] = calloc(MODE_COUNT, sizeof(*new_present));
    int invalid = !master_defaults || !new_policies || !new_boost || !new_present ||
        parse_config_block(cJSON_GetObjectItemCaseSensitive(root, "defaults"), master_defaults);
    const cJSON *presets = cJSON_GetObjectItemCaseSensitive(root, "presets");
    static const char *zone_keys[ZONE_COUNT] = {"linear", "decay", "saturate"};
    static const char *phase_keys[3] = {"touch_down", "touch_up", "touch_long"};
    for (int m = 0; !invalid && m < MODE_COUNT; m++) {
        const cJSON *mode = cJSON_GetObjectItemCaseSensitive(presets, mode_names[m]);
        const cJSON *timing = cJSON_GetObjectItemCaseSensitive(mode, "touch");
        const cJSON *zone_obj = cJSON_GetObjectItemCaseSensitive(mode, "zones");
        new_policies[m].touch.enabled = 1;
        new_policies[m].touch.long_press_ms = (unsigned)cJSON_GetObjectItemCaseSensitive(timing,"long_press_ms")->valueint;
        new_policies[m].touch.release_delay_ms = (unsigned)cJSON_GetObjectItemCaseSensitive(timing,"release_delay_ms")->valueint;
        /* 说明：v2.5.11：模式自带限频时长，没有就用 global 里的缺省（含旧配置的写法）。 */
        new_policies[m].maxfreq.decay_hold_ms = g_maxfreq.decay_hold_ms;
        new_policies[m].maxfreq.saturate_hold_ms = g_maxfreq.saturate_hold_ms;
        {
            const cJSON *mode_mf = cJSON_GetObjectItemCaseSensitive(mode, "maxfreq");
            if (mode_mf && !maxfreq_parse_mode(mode_mf, &new_policies[m].maxfreq)) { invalid = 1; break; }
        }
        for (int z = 0; !invalid && z < ZONE_COUNT; z++) {
            const cJSON *zb = cJSON_GetObjectItemCaseSensitive(zone_obj, zone_keys[z]);
            const cJSON *boost = cJSON_GetObjectItemCaseSensitive(zb, "boost");
            PolicyParams *idle = &new_policies[m].zones[z][POLICY_IDLE];
            for (const cJSON *node = boost->child; node; node = node->next) {
                int cid = atoi(node->string);
                if (cid < 0 || cid >= MAX_CLUSTERS ||
                    !zone_boost_parse(node, &new_boost[m][z][cid])) { invalid = 1; break; }
                new_present[m][z][cid] = 1;
            }
            if (invalid) break;
            invalid = copy_policy_params(idle, master_defaults) ||
                parse_config_block(cJSON_GetObjectItemCaseSensitive(zb, "*"), idle) ||
                !idle->count || !frequency_pairs_valid(idle);
            for (int p = 0; !invalid && p < 3; p++) {
                const cJSON *delta = cJSON_GetObjectItemCaseSensitive(zb, phase_keys[p]);
                if (delta) invalid = parse_config_block(delta, &new_policies[m].zones[z][p + 1]);
            }
            if (!invalid) {
                if (!cJSON_GetObjectItemCaseSensitive(zb,"touch_long"))
                    invalid = copy_policy_params(&new_policies[m].zones[z][POLICY_TOUCH_LONG],
                                                 &new_policies[m].zones[z][POLICY_TOUCH_DOWN]);
                if (!invalid) invalid = compile_touch_restore_zone(&new_policies[m], z);
            }
        }
    }
    if (invalid) {
        clean_policy_resources(new_policies);
        free(new_policies);
        free(new_boost);
        free(new_present);
        free_params(master_defaults);
        cJSON_Delete(root);
        if (!check_only) config_release_tree_locked();
        pthread_mutex_unlock(&g_apply_mtx);
        pthread_mutex_unlock(&g_load_mtx);
        if (!check_only) LOG_ERROR("手工策略编译失败：未知字段、类型、容量或内存错误，已撤销 CPU 写权限");
        return 0;
    }
    /* 说明：只读候选校验复用全部解析和编译约束，不发布策略、不写日志、不触碰硬件。 */
    if (check_only) {
        clean_policy_resources(new_policies);
        free(new_policies);
        free(new_boost);
        free(new_present);
        free_params(master_defaults);
        cJSON_Delete(root);
        clear_templates();
        pthread_mutex_unlock(&g_apply_mtx);
        pthread_mutex_unlock(&g_load_mtx);
        return 1;
    }
    /* 说明：有效新树已完成编译，替换前恢复旧触摸受控项，避免新配置删除路径后遗留增强。 */
    restore_touch_locked(NULL);
    /* 说明：新配置可能故意把某些节点改回旧值，写缓存必须整体作废。 */
    sysfs_invalidate_write_cache();
    log_set_level(cJSON_GetObjectItemCaseSensitive(global,"log_level")->valueint);
    pthread_rwlock_wrlock(&g_rwlock);
    clean_policy_resources(g_mode_policies);
    memcpy(g_mode_policies, new_policies, sizeof(g_mode_policies));
    memcpy(g_mode_boost, new_boost, sizeof(g_mode_boost));
    memcpy(g_boost_present, new_present, sizeof(g_boost_present));
    config_revision++;
    has_applied = 0;
    config_valid = 1;
    pthread_rwlock_unlock(&g_rwlock);
    /* 说明：配置快照与实际写入保持串行，直到重载结束。 */
    free(new_policies);
    free(new_boost);
    free(new_present);
    free_params(master_defaults);
    cJSON_Delete(root);
    pthread_mutex_unlock(&g_apply_mtx);
    pthread_mutex_unlock(&g_load_mtx);
    metric_add(metrics_slot(MET_CFG_LOAD), metrics_now_us() - __c0, 300000);
    metric_inc(CNT_CFG_RELOAD, 1);
    /* 说明：结构化交代这次加载到底装进了什么——节点数、模式数、分区状态，
     * 事后比对"配置改了但行为没变"时，一眼能看出是不是没重新加载。 */
    {
        int nodes = 0, zones_configured = 0;
        for (int m = 0; m < MODE_COUNT; m++) {
            for (int z = 0; z < ZONE_COUNT; z++)
                for (int p = 0; p < POLICY_PHASE_COUNT; p++)
                    nodes += g_mode_policies[m].zones[z][p].count;
        }
        for (int m = 0; m < MODE_COUNT; m++)
            for (int z = 0; z < ZONE_COUNT; z++)
                for (int c = 0; c < MAX_CLUSTERS; c++)
                    zones_configured += g_boost_present[m][z][c] ? 1 : 0;
        LOGI(MOD_CFG, "load rev=%llu nodes=%d boost=%d touch=%d zones=%d ms=%lld",
             (unsigned long long)config_revision, nodes, zones_configured,
             g_mode_policies[MODE_BALANCE].touch.enabled,
             g_zones.enabled,
             (metrics_now_us() - __c0) / 1000);
    }
    return 1;
}

void load_config(void)
{
    (void)load_config_file(CONFIG_FILE, 0);
}

/* 说明：供独立校验进程使用，调用者不得据此声称硬件参数已生效。 */
int config_check_file(const char *path)
{
    return path && path[0] ? load_config_file(path, 1) : 0;
}


/* 说明：把单个节点（含已解析路径）复制进快照；同一路径重复出现时以先写为准。 */
static int copy_item_into(PolicyParams *out, const SysfsItem *src)
{
    SysfsItem *dst = NULL;
    for (int i = 0; i < out->count; i++)
        if (!strcmp(out->items[i].raw_path, src->raw_path)) { dst = &out->items[i]; break; }
    if (!dst) {
        if (out->count >= MAX_SYSFS_NODES) return -1;
        dst = &out->items[out->count++];
        dst->resolved_paths = NULL;
        dst->path_count = 0;
        safe_strncpy(dst->raw_path, src->raw_path, sizeof(dst->raw_path));
        dst->is_sh = src->is_sh;
        dst->policy_id = src->policy_id;
        if (src->path_count) {
            dst->resolved_paths = calloc((size_t)src->path_count, sizeof(char *));
            if (!dst->resolved_paths) return -1;
            for (int j = 0; j < src->path_count; j++) {
                dst->resolved_paths[j] = strdup(src->resolved_paths[j]);
                if (!dst->resolved_paths[j]) return -1;
                dst->path_count++;
            }
        }
    }
    safe_strncpy(dst->value, src->value, sizeof(dst->value));
    return 0;
}

/* 说明：v2.5.5：把「每个核组自己所在区域」的那一套节点融合成一次下发快照。
 * · 非核组节点（模板里没有 {policy}）只取线性区那一份，避免重复写同一个节点；
 * · 某个区域没有配置该核组的某项时，这一轮就不写它（保持当前值），
 *   不做跨区回退——回退会让「这个区不覆盖」和「这个区覆盖成线性区的值」两种意图混在一起。
 *   区域里的常规基础（"*"）会在下一次空闲相位完整下发，届时该项自动落到该区的基线。 */
static PolicyParams *build_fused_locked(RunMode mode, PolicyPhase phase)
{
    if (mode < 0 || mode >= MODE_COUNT || phase < 0 || phase >= POLICY_PHASE_COUNT) return NULL;
    PolicyParams *out = calloc(1, sizeof(*out));
    if (!out) return NULL;
    const PolicyParams *base = &g_mode_policies[mode].zones[0][phase];
    for (int i = 0; i < base->count; i++) {
        if (base->items[i].policy_id < 0 && copy_item_into(out, &base->items[i])) {
            free_params(out);
            return NULL;
        }
    }
    for (int c = 0; c < MAX_CLUSTERS; c++) {
        int z = g_cluster_zone[c];
        const PolicyParams *src = &g_mode_policies[mode].zones[z][phase];
        for (int i = 0; i < src->count; i++) {
            if (src->items[i].policy_id != c) continue;
            if (copy_item_into(out, &src->items[i])) { free_params(out); return NULL; }
        }
    }
    return out;
}

/* 说明：在配置读锁保护下应用「某模式某阶段」。
 * 锁的所有权收敛在本模块内，调用方无需也不应直接触碰策略树。
 */
void config_apply_phase_for(RunMode mode, PolicyPhase phase, ApplyStats *stats)
{
    if (!stats) return;
    memset(stats, 0, sizeof(*stats));
    if (mode < 0 || mode >= MODE_COUNT || phase < 0 || phase >= POLICY_PHASE_COUNT) {
        stats->sysfs_err = 1;
        return;
    }
    pthread_mutex_lock(&g_apply_mtx);
    if (phase == POLICY_IDLE) restore_touch_locked(stats);
    pthread_rwlock_rdlock(&g_rwlock);
    if (!config_valid) {
        pthread_rwlock_unlock(&g_rwlock);
        pthread_mutex_unlock(&g_apply_mtx);
        return;
    }
    PolicyParams *snapshot = build_fused_locked(mode, phase);
    uint64_t revision = config_revision;
    pthread_rwlock_unlock(&g_rwlock);
    if (!snapshot) {
        stats->sysfs_err = 1;
        pthread_mutex_unlock(&g_apply_mtx);
        return;
    }
    sysfs_apply_policy(snapshot, revision, mode, phase, stats);
    applied_mode = mode;
    applied_phase = phase;
    has_applied = 1;
    free_params(snapshot);
    pthread_mutex_unlock(&g_apply_mtx);
}

/* 说明：退出路径：释放全部策略树并销毁读写锁。 */
void config_destroy_all(void)
{
    pthread_rwlock_wrlock(&g_rwlock);
    clean_policy_resources(g_mode_policies);
    config_valid = 0;
    clear_templates();
    pthread_rwlock_unlock(&g_rwlock);
    pthread_rwlock_destroy(&g_rwlock);
}