/* 说明：core/state.c — 跨模块共享状态【单一所有权】
 * 
 * 职责：集中定义被多线程读写的进程级状态。本模块不含业务逻辑，只做状态容器。
 * 
 * 访问纪律：
 * g_running           atomic，任意线程可读写；置 0 表示请求全部退出。
 * g_current_mode      主循环独占写；耗电采样线程只读。
 * g_current_pkg       读写必须先取 g_pkg_mtx（跨线程拷贝）。
 * g_manual_override   主循环独占读写。
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "state.h"

/* 说明：进程生命周期：置 0 触发全部工作线程退出 */
atomic_int  g_running = 1;

/* 说明：当前调度目标 */
RunMode     g_current_mode = MODE_POWERSAVE;

/* 说明：当前前台包名与其保护锁 */
char            g_current_pkg[256] = {0};
pthread_mutex_t g_pkg_mtx = PTHREAD_MUTEX_INITIALIZER;

/* 说明：手动模式覆盖：manual_mode.txt 生效时为 1，此时忽略自动探测结果 */
atomic_int  g_manual_override = 0;

