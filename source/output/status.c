/* 说明：运行快照基础设施；采用开机时钟、实例身份和同目录原子替换，不依赖日志开关。 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "status.h"
#include "metrics.h"

static atomic_llong battery_at_ms = 0;
static long long published_at_ms;
static char boot_id[64];

static long long uptime_ms(void)
{
    struct timespec ts;
    if (clock_gettime(CLOCK_BOOTTIME, &ts) != 0) return 0;
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

void status_battery_tick(void)
{
    atomic_store(&battery_at_ms, uptime_ms());
}

void status_publish(const StatusSnapshot *snapshot)
{
    if (!snapshot) return;
    long long now = uptime_ms();
    /* 说明：两秒限频属于本接口契约；状态页按十五秒判断主循环过期。 */
    if (!snapshot->stopping && published_at_ms && now - published_at_ms < 2000) return;
    if (!boot_id[0]) {
        FILE *fp = fopen("/proc/sys/kernel/random/boot_id", "r");
        if (!fp) return;
        int ok = fgets(boot_id, sizeof(boot_id), fp) != NULL;
        fclose(fp);
        if (!ok) return;
        boot_id[strcspn(boot_id, "\r\n")] = 0;
    }
    cJSON *root = cJSON_CreateObject();
    if (!root) return;
    cJSON_AddNumberToObject(root, "schema", 1);
    cJSON_AddNumberToObject(root, "pid", (double)getpid());
    cJSON_AddNumberToObject(root, "start_ticks", (double)snapshot->start_ticks);
    cJSON_AddStringToObject(root, "boot_id", boot_id);
    cJSON_AddNumberToObject(root, "uptime_s", (double)now / 1000);
    cJSON_AddNumberToObject(root, "battery_uptime_s", (double)atomic_load(&battery_at_ms) / 1000);
    cJSON_AddBoolToObject(root, "stopping", snapshot->stopping);
    cJSON_AddBoolToObject(root, "config_valid", snapshot->config_valid);
    cJSON_AddNumberToObject(root, "config_revision", (double)snapshot->config_revision);
    cJSON_AddStringToObject(root, "mode", snapshot->mode ? snapshot->mode : "");
    cJSON_AddStringToObject(root, "package", snapshot->package ? snapshot->package : "");
    cJSON_AddBoolToObject(root, "touch_available", snapshot->touch_available);
    cJSON_AddNumberToObject(root, "log_level", snapshot->log_level);
    cJSON_AddStringToObject(root, "frequencies", snapshot->frequencies ? snapshot->frequencies : "");
    /* 说明：v2.5.6：把每个核组当前用的策略区域也发布出来——诊断进程读得到，
     * 界面也能显示「我正在用哪一区的参数」，不必再靠猜。 */
    cJSON_AddStringToObject(root, "zones", snapshot->zones ? snapshot->zones : "");
    cJSON_AddStringToObject(root, "caps", snapshot->caps ? snapshot->caps : "");
    /* 说明：把性能指标并进运行快照。状态页可以直接展示，--diag 也能读到同一份数据，
     * 不必再为"守护进程内存里的统计"另开一条 IPC。 */
    {
        char *mj = metrics_json();
        if (mj) {
            cJSON *mobj = cJSON_Parse(mj);
            if (mobj) cJSON_AddItemToObject(root, "metrics", mobj);
            free(mj);
        }
    }
    char *text = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!text) return;
    const char *tmp = MODULE_DIR "/runtime_status.json.tmp";
    FILE *fp = fopen(tmp, "w");
    if (fp) {
        int ok = fputs(text, fp) >= 0 && fflush(fp) == 0;
        if (fclose(fp) != 0) ok = 0;
        if (ok && rename(tmp, MODULE_DIR "/runtime_status.json") == 0) published_at_ms = now;
        else unlink(tmp);
    }
    free(text);
}