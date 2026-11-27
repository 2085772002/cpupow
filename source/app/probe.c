/* 说明：app/probe.c — 前台探测线程【编排层】
 * 
 * 职责：把「需要重新探测前台」的请求串行化。主循环只写触发事件，
 * 本线程执行阻塞的 dumpsys 探测并回传结果，主循环永不被阻塞。
 * 
 * 并发契约：
 * probe_request()     可重入，重复请求由 eventfd 计数语义自然合并。
 * probe_take_result() 取走即清 ready 标志，同一份结果不会被重复处理。
 * 
 * 对外：probe_start / probe_stop / probe_event_fd / probe_request /
 * probe_take_result。
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "../output/log.h"
#include "../core/util.h"
#include "../compute/mode.h"
#include "../output/metrics.h"
#include "probe.h"
#include "../collect/foreground.h"
#include "../compute/pkgrules.h"

/* 说明：---- 模块私有状态 ---- */
static int        probe_event_fd_num = -1;  /* 说明：结果就绪 → 通知主循环 */
static int        probe_trigger_fd   = -1;  /* 说明：主循环 → 请求探测 */
static pthread_t  probe_thread_id;
static atomic_int g_probe_ready       = 0;
static char       g_probe_result_pkg[256] = {0};
static atomic_int g_probe_result_mode = MODE_POWERSAVE;
static pthread_mutex_t probe_result_mutex=PTHREAD_MUTEX_INITIALIZER;

static void* probe_worker(void *arg)
{
    (void)arg;
    uint64_t dummy;

    struct pollfd pfd = {
        .fd     = probe_trigger_fd,
        .events = POLLIN
    };
    while (atomic_load(&g_running)) {
        int ret = poll(&pfd, 1, 1000); /* 说明：1s 超时用于检查退出状态 */

        if (ret > 0 && (pfd.revents & POLLIN)) {
            /* 说明：清除 eventfd 计数 */
            read(probe_trigger_fd, &dummy, sizeof(dummy));
            
            usleep(250000);

            /* 说明：执行探测任务 */
            char tmp_pkg[256] = {0};
            long long __pt0 = metrics_now_us();
            int ok=get_foreground_info(tmp_pkg,sizeof(tmp_pkg))==0;
            /* 说明：前台探测要 fork dumpsys，是最容易变慢的一环，单独计时。 */
            metric_add(metrics_slot(MET_PROBE), metrics_now_us() - __pt0, 1500000);
            if (!ok) LOGW(MOD_PROBE, "fg_fail elapsed_ms=%lld", (metrics_now_us() - __pt0) / 1000);
            RunMode mode=ok?pkg_rules_resolve(tmp_pkg):pkg_rules_default();
            pthread_mutex_lock(&probe_result_mutex);
            safe_strncpy(g_probe_result_pkg, tmp_pkg, sizeof(g_probe_result_pkg));
            atomic_store(&g_probe_result_mode, (int)mode);
            atomic_store(&g_probe_ready, 1);
            pthread_mutex_unlock(&probe_result_mutex);

            if (probe_event_fd_num >= 0) {
                uint64_t v = 1;
                write(probe_event_fd_num, &v, sizeof(v));
            }
        } else if (ret < 0 && errno != EAGAIN && errno != EINTR) {
            break;
        }
    }
    return NULL;
}

/* 说明：---- 对外接口 ---- */

int probe_event_fd(void)
{
    return probe_event_fd_num;
}

/* 说明：请求一次探测；eventfd 计数语义天然合并重复请求。 */
void probe_request(void)
{
    if (probe_trigger_fd >= 0) {
        uint64_t u = 1;
        write(probe_trigger_fd, &u, sizeof(u));
    }
}

/* 说明：取走一次探测结果。
 * 返回 1=有结果（pkg/mode 已写入），0=暂无结果。取走后 ready 标志清零。
 */
int probe_take_result(char *pkg, size_t len, RunMode *mode)
{
    pthread_mutex_lock(&probe_result_mutex);
    if (!atomic_load(&g_probe_ready))
        { pthread_mutex_unlock(&probe_result_mutex); return 0; }

    if (pkg && len)
        safe_strncpy(pkg, g_probe_result_pkg, len);
    if (mode)
        *mode = (RunMode)atomic_load(&g_probe_result_mode);

    atomic_store(&g_probe_ready, 0);
    pthread_mutex_unlock(&probe_result_mutex);
    return 1;
}

int probe_start(void)
{
    probe_event_fd_num = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    probe_trigger_fd   = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    if (probe_event_fd_num < 0 || probe_trigger_fd < 0) {
        if (probe_event_fd_num >= 0) { close(probe_event_fd_num); probe_event_fd_num = -1; }
        if (probe_trigger_fd >= 0)   { close(probe_trigger_fd);   probe_trigger_fd   = -1; }
        return -1;
    }
    if (pthread_create(&probe_thread_id, NULL, probe_worker, NULL) != 0) {
        close(probe_event_fd_num); probe_event_fd_num = -1;
        close(probe_trigger_fd);   probe_trigger_fd   = -1;
        return -1;
    }
    return 0;
}

/* 说明：唤醒并回收探测线程，关闭两个 eventfd。需在 g_running=0 之后调用。 */
void probe_stop(void)
{
    if (probe_trigger_fd >= 0) {
        uint64_t u = 1;
        write(probe_trigger_fd, &u, sizeof(u));
        close(probe_trigger_fd);
        probe_trigger_fd = -1;
    }
    pthread_join(probe_thread_id, NULL);
    if (probe_event_fd_num >= 0) {
        close(probe_event_fd_num);
        probe_event_fd_num = -1;
    }
}

