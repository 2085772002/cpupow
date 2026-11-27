/* 说明：collect/touch.h — 触摸事件采集接口 */
#ifndef CPUPOW_TOUCH_H
#define CPUPOW_TOUCH_H

#include <stdatomic.h>

int  touch_start(void);
void touch_stop(void);

/* 说明：供主循环 epoll 注册的通知 fd。 */
int  touch_event_fd(void);

/* 说明：1=当前处于按下状态。 */
int  touch_is_active(void);

/* 说明：设备就绪才处理相位切换；未就绪时主循环应跳过触摸逻辑。 */
int  touch_is_available(void);
void touch_get_sample(TouchSample *sample);

void touch_release_device(void);

#endif /* 说明：头文件结束：CPUPOW_TOUCH_H */
