/* 说明：core/util.h — 通用字符串工具接口【公共内核】 */
#ifndef CPUPOW_UTIL_H
#define CPUPOW_UTIL_H

#include <stddef.h>

/* 说明：安全拷贝：保证 dst 以 NUL 结尾；dst_size==0 时不做任何事。 */
void safe_strncpy(char *dst, const char *src, size_t dst_size);

/* 说明：就地替换全部 rep→with。替换后长度达 511 字节即停止（保护调用方栈缓冲）。 */
void str_replace(char *orig, const char *rep, const char *with);

/* 说明：就地去掉首尾空白，返回新的起始指针。 */
char *str_trim(char *s);

#endif /* 说明：头文件结束：CPUPOW_UTIL_H */
