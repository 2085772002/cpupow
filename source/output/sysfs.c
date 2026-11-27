/* 说明：唯一预设写入器；调用方持配置应用互斥锁，防止与重载竞争；数值只来自已校验附件，先上线再写频率最后下线，成对调节上下限，禁止改权限、执行外部命令或自动修改用户数值。 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "../output/log.h"
#include "metrics.h"
#include "sysfs.h"
#include <math.h>

/* 说明：v2.5.6 写节点去重。
 * 真机日志显示：每次触摸相位切换写 8 个节点、每次前台切换写 28 个节点，
 * 但绝大多数时候写下去的值和上一次完全相同（例如三个区域的策略内容一致时，
 * 区域切换也会整批重写）。这些写入要 open/write/close/read 各一遍，
 * 20 分钟就能攒到一万五千多次，纯属白烧。
 * 做法：记住每个节点最近一次「请求值」，请求值没变就不碰 sysfs；
 * 每 WRITE_REFRESH_MS 做一次全量重写，让被外部（PM QoS/温控/PowerHAL）改过的节点自愈。 */
#define WRITE_CACHE_SLOTS 1024
#define WRITE_REFRESH_MS  300000
typedef struct { unsigned long long path_h; unsigned long long value_h; int used; } WriteCacheSlot;
static WriteCacheSlot g_wcache[WRITE_CACHE_SLOTS];
static long long g_wcache_full_at;      /* 上次全量写入的时刻（单调毫秒） */

static long long mono_ms(void)
{
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static unsigned long long hash64(const char *s)
{
    unsigned long long h = 1469598103934665603ULL;   /* FNV-1a 64 */
    if (!s) return h;
    while (*s) { h ^= (unsigned char)*s++; h *= 1099511628211ULL; }
    return h;
}
static int cache_lookup(const char *path, const char *value)
{
    unsigned long long ph = hash64(path), vh = hash64(value);
    for (int i = 0; i < WRITE_CACHE_SLOTS; i++) {
        int slot = (int)((ph + (unsigned long long)i * 131) % WRITE_CACHE_SLOTS);
        if (!g_wcache[slot].used) return 0;
        if (g_wcache[slot].path_h == ph) return g_wcache[slot].value_h == vh;
    }
    return 0;
}
static void cache_store(const char *path, const char *value)
{
    unsigned long long ph = hash64(path), vh = hash64(value);
    for (int i = 0; i < WRITE_CACHE_SLOTS; i++) {
        int slot = (int)((ph + (unsigned long long)i * 131) % WRITE_CACHE_SLOTS);
        if (!g_wcache[slot].used || g_wcache[slot].path_h == ph) {
            g_wcache[slot].used = 1;
            g_wcache[slot].path_h = ph;
            g_wcache[slot].value_h = vh;
            return;
        }
    }
    /* 说明：表满就整体作废，下次全量重写；这比覆盖别人的条目更安全。 */
    memset(g_wcache, 0, sizeof(g_wcache));
    g_wcache[0].used = 1; g_wcache[0].path_h = ph; g_wcache[0].value_h = vh;
    g_wcache_full_at = 0;
}
/* 说明：配置重载后旧缓存全部作废——新配置可能故意把某个节点改回旧值。 */
void sysfs_invalidate_write_cache(void)
{
    memset(g_wcache, 0, sizeof(g_wcache));
    g_wcache_full_at = 0;
}

static pthread_mutex_t status_mutex=PTHREAD_MUTEX_INITIALIZER;
static cJSON *last_base,*last_event;
static int dirty;
static long long saved_at;

static int read_text(const char *path,char *text,size_t capacity)
{
 int fd=open(path,O_RDONLY|O_CLOEXEC);
 if(fd<0)return -1;
 ssize_t n=read(fd,text,capacity-1);int saved=errno;close(fd);errno=saved;
 if(n<0)return -1;
 text[n]=0;return 0;
}
/* 说明：内核读回可能添加空白，保留词项与冒号进行内容比较，写入成功不等同实际生效。 */
static void normalize(char *text)
{
 char *out=text;int space=0;
 for(char *p=text;*p;p++){
  if(isspace((unsigned char)*p)){space=out>text;continue;}
  if(space)*out++=' ';
  *out++=*p;space=0;
 }
 *out=0;
}
static int suffix(const char *path,const char *tail)
{
 size_t a=strlen(path),b=strlen(tail);return a>=b&&!strcmp(path+a-b,tail);
}
static int priority(const SysfsItem *item,const PolicyParams *params)
{
 if(suffix(item->raw_path,"/online"))return !strcmp(item->value,"0")?100:0;
 /* 说明：先撤销自适应入口，再调整台阶，最后开启入口，降低阶段切换的中间态。 */
 if(suffix(item->raw_path,"/adaptive_high_freq"))return !strcmp(item->value,"0")?5:60;
 if(suffix(item->raw_path,"/scaling_max_freq"))return 20;
 if(suffix(item->raw_path,"/scaling_min_freq")){
  char maxpath[256],old[128];safe_strncpy(maxpath,item->raw_path,sizeof(maxpath));
  char *tail=strrchr(maxpath,'/');if(!tail)return 30;
  strcpy(tail,"/scaling_max_freq");
  if(item->path_count && !read_text(item->resolved_paths[0],old,sizeof(old))){
   for(int i=0;i<params->count;i++)
    if(!strcmp(params->items[i].raw_path,maxpath) && strtoll(params->items[i].value,NULL,10)<strtoll(old,NULL,10))return 10;
  }
  return 30;
 }
 return 40;
}
static void write_one(const char *path,const char *value,ApplyStats *stats,cJSON *rows)
{
 char actual[256]={0},expected[256];int error=0;
 /* 说明：请求值与上次写入相同就完全跳过 sysfs（全量刷新窗口内）。 */
 if(mono_ms()-g_wcache_full_at<WRITE_REFRESH_MS && cache_lookup(path,value)){
  stats->skipped++;metric_inc(CNT_WRITE_SKIP,1);
  cJSON *row=cJSON_CreateObject();
  cJSON_AddStringToObject(row,"path",path);cJSON_AddStringToObject(row,"requested",value);
  cJSON_AddStringToObject(row,"actual","");cJSON_AddStringToObject(row,"result","unchanged");
  cJSON_AddItemToArray(rows,row);
  return;
 }
 cache_store(path,value);
 int fd=open(path,O_WRONLY|O_TRUNC|O_CLOEXEC);
 const char *result;
 long long __w0 = metrics_now_us();
 if(fd<0){error=errno;result=error==ENOENT?"missing":"rejected";
  if(error==ENOENT){stats->sysfs_missing++;metric_inc(CNT_WRITE_MISS,1);}
  else {stats->sysfs_err++;metric_inc(CNT_WRITE_ERR,1);}
 }else{
  size_t len=strlen(value);ssize_t n=write(fd,value,len);error=n==(ssize_t)len?0:errno?errno:EIO;
  if(close(fd)&&!error)error=errno;
  if(error){stats->sysfs_err++;result="rejected";metric_inc(CNT_WRITE_ERR,1);}
  else{
   stats->sysfs_ok++;metric_inc(CNT_WRITE_OK,1);
   if(read_text(path,actual,sizeof(actual))){stats->readback_err++;result="unreadable";error=errno;}
   else{
    normalize(actual);safe_strncpy(expected,value,sizeof(expected));normalize(expected);
    if(strcmp(expected,actual)){
     stats->readback_mismatch++;
     /* 说明：区分"内核拒绝"与"被其它子系统改写"。
      * 读回值与请求值不等，但都是合法数字时，通常是 thermal / PM QoS / qcom limits
      * 在并发施加更严的约束——写入本身成功了，只是最终生效值由最严格的请求决定。
      * 方向也记下来：读回更大 = 被抬高（如 min_freq），读回更小 = 被压低（如 max_freq）。 */
     long long want = strtoll(expected, NULL, 10), got = strtoll(actual, NULL, 10);
     result = got > want ? "clamped_up" : (got < want ? "clamped_down" : "different");
     metric_inc(CNT_WRITE_DIFF,1);
    }
    else {stats->readback_ok++;result="matched";}
   }
  }
 }
 metric_add(metrics_slot(MET_WRITE), metrics_now_us()-__w0, 5000);
 cJSON *row=cJSON_CreateObject();
 cJSON_AddStringToObject(row,"path",path);cJSON_AddStringToObject(row,"requested",value);
 cJSON_AddStringToObject(row,"actual",actual);cJSON_AddStringToObject(row,"result",result);
 cJSON_AddNumberToObject(row,"errno",error);cJSON_AddItemToArray(rows,row);
 if(error && error!=ENOENT)LOG_ERROR("[写入] %s <= %s: errno=%d",path,value,error);
 else if(strncmp(result,"clamped",7)==0)LOG_TRACE("[写入被改写] %s 请求=%s 实际=%s 方向=%s",path,value,actual,result+8);
 else if(!strcmp(result,"different"))LOG_DEBUG("[写入差异] %s <= %s 读回=%s",path,value,actual);
 else LOG_TRACE("[写入] %s <= %s | %s | 读回=%s",path,value,result,actual);
}
void sysfs_apply_policy(const PolicyParams *params,uint64_t revision,RunMode mode,PolicyPhase phase,ApplyStats *stats)
{
 if(!params||!stats)return;
 /* 说明：v2.5.6：stats 由调用方清零并在一次「下发」里累积（恢复触摸基线 + 主体块），
  * 这样回执与日志里的 writ 数才等于这次真正碰过的节点数。 */
 pthread_mutex_lock(&status_mutex);
 cJSON *event=cJSON_CreateObject(),*rows=cJSON_AddArrayToObject(event,"nodes");
 cJSON_AddNumberToObject(event,"revision",(double)revision);
 cJSON_AddNumberToObject(event,"at_s",(double)time(NULL));
 cJSON_AddStringToObject(event,"mode",mode_names[mode]);
 const char *phases[]={"*","touch_down","touch_up","touch_long","touch_idle"};
 cJSON_AddStringToObject(event,"phase",phases[phase]);
 int ranks[]={0,5,10,20,30,40,60,100};
 int order[MAX_SYSFS_NODES];
 for(int i=0;i<params->count;i++)order[i]=priority(&params->items[i],params);
 for(unsigned r=0;r<sizeof(ranks)/sizeof(ranks[0]);r++)for(int i=0;i<params->count;i++){
  const SysfsItem *item=&params->items[i];if(order[i]!=ranks[r])continue;
  if(!item->path_count){stats->sysfs_missing++;cJSON *row=cJSON_CreateObject();
   cJSON_AddStringToObject(row,"path",item->raw_path);cJSON_AddStringToObject(row,"requested",item->value);
   cJSON_AddStringToObject(row,"result","missing");cJSON_AddItemToArray(rows,row);
  }
  for(int j=0;j<item->path_count;j++)write_one(item->resolved_paths[j],item->value,stats,rows);
 }
 cJSON_AddNumberToObject(event,"written",stats->sysfs_ok);
 cJSON_AddNumberToObject(event,"skipped",stats->skipped);
 cJSON_AddNumberToObject(event,"rejected",stats->sysfs_err);
 cJSON_AddNumberToObject(event,"missing",stats->sysfs_missing);
 cJSON_AddNumberToObject(event,"readback_matched",stats->readback_ok);
 cJSON_AddNumberToObject(event,"readback_different",stats->readback_mismatch);
 cJSON_AddNumberToObject(event,"readback_unreadable",stats->readback_err);
 g_wcache_full_at = mono_ms();
 if(phase==POLICY_IDLE){cJSON_Delete(last_base);last_base=event;}
 else {cJSON_Delete(last_event);last_event=event;}
 dirty=1;pthread_mutex_unlock(&status_mutex);
}
/* 说明：触摸状态写盘每两秒最多一次，退出强制刷新；回执只是最近一次观测，不表示持续拥有硬件。 */
void sysfs_flush_status(int force)
{
 struct timespec ts;clock_gettime(CLOCK_MONOTONIC,&ts);long long now=ts.tv_sec*1000LL+ts.tv_nsec/1000000;
 pthread_mutex_lock(&status_mutex);
 if(!dirty||(!force&&saved_at&&now-saved_at<2000)){pthread_mutex_unlock(&status_mutex);return;}
 cJSON *root=cJSON_CreateObject();cJSON_AddNumberToObject(root,"schema",1);
 if(last_base)cJSON_AddItemToObject(root,"base",cJSON_Duplicate(last_base,1));
 if(last_event)cJSON_AddItemToObject(root,"touch",cJSON_Duplicate(last_event,1));
 char *text=cJSON_PrintUnformatted(root);cJSON_Delete(root);
 if(text){FILE *fp=fopen(MODULE_DIR "/policy_status.json.tmp","w");
  if(fp){int ok=fputs(text,fp)>=0 && fflush(fp)==0;if(fclose(fp))ok=0;
   if(ok&&!rename(MODULE_DIR "/policy_status.json.tmp",MODULE_DIR "/policy_status.json")){dirty=0;saved_at=now;}
   else unlink(MODULE_DIR "/policy_status.json.tmp");
  }free(text);
 }
 pthread_mutex_unlock(&status_mutex);
}

/* 说明：v2.5.8 动态限最大频：写指定 policy 的 scaling_max_freq（kHz）。
 * 与 boost 一样是运行期高频路径，不走策略快照账本；读回被平台钳制不算错。
 * v2.5.13：把读回值带出去——内核会把你写的值取整到真实频点（或更严的平台上限），
 * 限频器必须知道「实际能到的天花板」，否则拿请求值当顶住判定会永远顶不住。 */
int sysfs_write_maxfreq(int policy_id, unsigned long long khz, unsigned long long *effective)
{
    char path[320], value[32], actual[64];
    int fd;
    ssize_t n;
    if (effective) *effective = khz;
    if (policy_id < 0 || !khz) return -1;
    snprintf(path, sizeof(path), "%s/policy%d/scaling_max_freq", CPUPOW_CPUFREQ_ROOT, policy_id);
    snprintf(value, sizeof(value), "%llu", khz);
    fd = open(path, O_WRONLY | O_TRUNC | O_CLOEXEC);
    if (fd < 0) return -1;
    n = write(fd, value, strlen(value));
    if (close(fd) != 0 && n == (ssize_t)strlen(value)) n = -1;
    if (n != (ssize_t)strlen(value)) return -1;
    /* 说明：读回只是观测；PM QoS/温控可能给出更严的上限，不因此判失败。 */
    if (read_text(path, actual, sizeof(actual)) != 0) return 0;
    normalize(actual);
    if (strcmp(value, actual) != 0) {
        long long want = strtoll(value, NULL, 10), got = strtoll(actual, NULL, 10);
        if (effective && got > 0) *effective = (unsigned long long)got;
        /* 说明：v2.5.9：读回更低是平台给了更严的上限（PM QoS/温控），属正常现象，
         * 单独计数，不要混进策略写入的 write_diff——那边一旦变大才是真出问题。 */
        if (got < want) { metric_inc(CNT_MAXFREQ_CLAMP, 1); return 0; }
    }
    return 0;
}

/* 说明：动态写指定 policy 的 walt/boost。轻量写入 + 读回核验，不参与策略状态账本。
 * 分区 boost 按采样周期高频调用，故不经过 last_base/last_event 快照。 */
int sysfs_write_boost(int policy_id, int boost)
{
    char path[320], value[32], actual[64];
    int fd;
    ssize_t n;
    if (policy_id < 0) return -1;
    snprintf(path, sizeof(path), "%s/policy%d/walt/boost",
             CPUPOW_CPUFREQ_ROOT, policy_id);
    snprintf(value, sizeof(value), "%d", boost);

    fd = open(path, O_WRONLY | O_TRUNC | O_CLOEXEC);
    if (fd < 0) return -1;
    n = write(fd, value, strlen(value));
    if (close(fd) != 0 && n == (ssize_t)strlen(value)) n = -1;
    if (n != (ssize_t)strlen(value)) return -1;

    /* 说明：读回仅作观测。节点不可读回不算错（部分内核 boost 只写不回读）；
     * v2.5.13：读回被内核改写也不算写失败——写入本身已经成功，把它当失败会让
     * 「每 2 秒强制重写」反复刷 E 级日志、并把 CNT_ZONE_FAIL 灌成几百次。
     * 真正的失败只保留 open/write 出错。 */
    if (read_text(path, actual, sizeof(actual)) != 0) return 0;
    normalize(actual);
    if (strcmp(value, actual) != 0) {
        metric_inc(CNT_BOOST_CLAMP, 1);
        LOGT(MOD_ZONE, "boost c=%d 请求=%s 实际=%s（内核改写）", policy_id, value, actual);
    }
    return 0;
}
