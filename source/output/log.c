/* 说明：output/log.c — 结构化分级日志【输出层】
 *
 * 职责：按级别过滤写日志；跨小时重开文件；超 5MB 轮转为 .bak；全线程安全。
 * 格式：[HH:MM:SS.mmm][级别][模块] 消息——带毫秒、带模块、键值可解析。
 * 依赖：仅 cpupow.h（路径宏与系统头）。不含任何业务语义。
 * 对外：log_writef / log_write / log_level / log_set_level / log_close。
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "log.h"

/* 说明：---- 模块私有状态：外部只能经 log_level()/log_set_level() 访问 ---- */
static atomic_int      g_log_level = 1;
static pthread_mutex_t g_log_mtx   = PTHREAD_MUTEX_INITIALIZER;
static FILE           *s_log_fp    = NULL;
static int             s_last_hour = -1;

/* 说明：级别字符。日志里用单字母，便于 grep '\[E\]' 直接筛错误。 */
static char level_char(int level)
{
    switch (level) {
    case 0: return 'F';
    case 1: return 'I';
    case 2: return 'D';
    default: return 'T';
    }
}

void log_writef(int level, const char *module, const char *fmt, ...)
{
    if (level > log_level())
        return;

    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tm_info;
    localtime_r(&ts.tv_sec, &tm_info);
    int millis = (int)(ts.tv_nsec / 1000000);

    pthread_mutex_lock(&g_log_mtx);

    /* 说明：再处理跨小时重置 */
    if (s_last_hour != -1 && s_last_hour != tm_info.tm_hour) {
        if (s_log_fp) {
            fclose(s_log_fp);
            s_log_fp = NULL;
        }
        s_last_hour = tm_info.tm_hour;
    }

    if (s_log_fp == NULL) {
        s_log_fp = fopen(LOG_FILE_PATH, "a");
        if (!s_log_fp) {
            pthread_mutex_unlock(&g_log_mtx); /* 说明：v1.3.0 修复：原此处直接 return，漏解锁导致后续日志调用全部死锁 */
            return;
        }
        setvbuf(s_log_fp, NULL, _IOLBF, 0);
        s_last_hour = tm_info.tm_hour;
    }

    /* 说明：v1.3.0：体积截断改用 stat 实际文件大小。
 * 原实现按“本小时写入计数器”判断且跨小时归零，慢速日志可无限增长不轮转。
 */
    struct stat log_st;
    if (stat(LOG_FILE_PATH, &log_st) == 0 && log_st.st_size > 5 * 1024 * 1024) {
        fclose(s_log_fp);
        s_log_fp = NULL;
        char bak[512];
        snprintf(bak, sizeof(bak), "%s.bak", LOG_FILE_PATH);
        rename(LOG_FILE_PATH, bak);
        s_log_fp = fopen(LOG_FILE_PATH, "a");
        if (!s_log_fp) {
            pthread_mutex_unlock(&g_log_mtx);
            return;
        }
        setvbuf(s_log_fp, NULL, _IOLBF, 0);
    }

    if (s_log_fp) {
        char lv = level_char(level);
        /* 说明：错误级别统一打 E，让「慢」和「错」在日志里可一眼分开。 */
        if (level >= 1 && fmt && (strstr(fmt, "【错误】") || strstr(fmt, "失败") ||
                                  strstr(fmt, "无法") || strstr(fmt, "不可读") ||
                                  strstr(fmt, "未确认")))
            lv = 'E';
        fprintf(s_log_fp, "[%02d:%02d:%02d.%03d][%c][%s] ",
                tm_info.tm_hour, tm_info.tm_min, tm_info.tm_sec, millis,
                lv, module ? module : MOD_CORE);
        va_list args;
        va_start(args, fmt);
        vfprintf(s_log_fp, fmt, args);
        va_end(args);
        fputc('\n', s_log_fp);
        fflush(s_log_fp);
    }

    pthread_mutex_unlock(&g_log_mtx);
}

/* 说明：旧接口（无模块）转发到结构化接口，模块记为 core。 */
void log_write(int level, const char *fmt, ...)
{
    if (level > log_level())
        return;
    va_list args;
    va_start(args, fmt);
    /* 说明：先格式化一次再交给 log_writef，避免变参无法二次转发。 */
    char body[1024];
    vsnprintf(body, sizeof(body), fmt, args);
    va_end(args);
    log_writef(level, MOD_CORE, "%s", body);
}


/* 说明：---- 对外接口 ---- */

int log_level(void)
{
    return atomic_load(&g_log_level);
}

void log_set_level(int level)
{
    atomic_store(&g_log_level, level);
}

/* 说明：落盘并关闭句柄；退出路径调用，幂等。 */
void log_close(void)
{
    pthread_mutex_lock(&g_log_mtx);
    if (s_log_fp) {
        fclose(s_log_fp);
        s_log_fp = NULL;
    }
    pthread_mutex_unlock(&g_log_mtx);
}
