/* 说明：core/state.h — 跨模块共享状态【单一所有权】
 * 集中声明进程级共享全局并附访问纪律，便于审计全局耦合。
 */
#ifndef CPUPOW_STATE_H
#define CPUPOW_STATE_H

#include <stdatomic.h>
#include <pthread.h>
#include "../cpupow.h"

extern atomic_int      g_running;          /* 说明：0 = 请求全部退出 */
extern RunMode         g_current_mode;     /* 说明：主循环独占写 */
extern char            g_current_pkg[256]; /* 说明：读写须持 g_pkg_mtx */
extern pthread_mutex_t g_pkg_mtx;
extern atomic_int      g_manual_override;

#endif /* 说明：头文件结束：CPUPOW_STATE_H */
