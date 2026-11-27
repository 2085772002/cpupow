/* 说明：core/util.c — 通用字符串工具【公共内核】
 * 
 * 职责：无业务语义的字符串安全操作，任意层均可调用。
 * 对外：safe_strncpy / str_replace / str_trim。
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "util.h"

void safe_strncpy(char *dst, const char *src, size_t dst_size)
{
    if (dst == NULL || dst_size == 0) {
        return;
    }

    snprintf(dst, dst_size, "%s", src);
}

void str_replace(char *orig, const char *rep, const char *with) {
    if (!orig || !rep || !with) return; /* 说明：阻断空指针崩溃 */
    char *pos = orig;
    int len_rep = strlen(rep);
    int len_with = strlen(with);
    if (len_rep == 0) return;
    
    while ((pos = strstr(pos, rep)) != NULL) {
        /* 说明：生产级安全防线：预判替换后的总长度，防止撑爆上层 512 字节的栈缓冲区 */
        if (strlen(orig) - len_rep + len_with >= 511) break; 
        
        memmove(pos + len_with, pos + len_rep, strlen(pos + len_rep) + 1);
        memcpy(pos, with, len_with);
        pos += len_with; /* 说明：推移指针，彻底防止无限循环和内存越界 */
    }
}


/* 说明：就地去掉首尾空白，返回新的起始指针（可能指向缓冲中部）。 */
char *str_trim(char *s)
{
    if (!s)
        return NULL;
    while (*s && isspace((unsigned char)*s))
        s++;
    if (!*s)
        return s;
    char *end = s + strlen(s) - 1;
    while (end > s && isspace((unsigned char)*end))
        *end-- = '\0';
    return s;
}
