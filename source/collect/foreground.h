/* 说明：collect/foreground.h — 前台应用探测接口【采集层】 */
#ifndef CPUPOW_FOREGROUND_H
#define CPUPOW_FOREGROUND_H

#include <stddef.h>

/* 说明：把当前前台包名写入 pkg_name。
 * 返回 0=成功，-1=失败（此时 pkg_name 内容不可信，调用方自行兜底）。
 */
int get_foreground_info(char *pkg_name, size_t len);
int get_foreground_info_user(char *pkg_name, size_t len, int *user_id);

#endif /* 说明：头文件结束：CPUPOW_FOREGROUND_H */