/* 说明：单调时钟期限工具，不保存观测或业务状态。 */
#ifndef CPUPOW_CLOCK_H
#define CPUPOW_CLOCK_H
#include <stdint.h>
#include <time.h>
static inline uint64_t runtime_now_ms(void) {
 struct timespec t;if(clock_gettime(CLOCK_MONOTONIC,&t))return 0;
 return (uint64_t)t.tv_sec*1000+(uint64_t)t.tv_nsec/1000000;
}
/* 说明：触摸期限计入休眠，避免唤醒后继续保留过期的尾段。 */
static inline uint64_t runtime_boot_ms(void) {
 struct timespec t;if(clock_gettime(CLOCK_BOOTTIME,&t))return runtime_now_ms();
 return (uint64_t)t.tv_sec*1000+(uint64_t)t.tv_nsec/1000000;
}
#endif
