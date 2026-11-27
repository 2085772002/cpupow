/* 说明：app/probe.h — 前台探测线程接口【编排层】 */
#ifndef CPUPOW_PROBE_H
#define CPUPOW_PROBE_H

#include <stddef.h>
#include "../cpupow.h"

int  probe_start(void);
void probe_stop(void);

/* 说明：供主循环 epoll 注册的结果通知 fd。 */
int  probe_event_fd(void);

/* 说明：异步请求一次探测。 */
void probe_request(void);

/* 说明：取结果：1=有效，0=暂无。 */
int  probe_take_result(char *pkg, size_t len, RunMode *mode);

#endif /* 说明：头文件结束：CPUPOW_PROBE_H */