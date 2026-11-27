/* 说明：collect/manualmode.c — 手动模式文件【采集层】
 * 
 * 职责：读 manual_mode.txt 的单行模式名并校验合法性。
 * 语义：文件存在且内容合法时，主循环忽略自动探测结果。
 * 对外：parse_manual_mode_file。
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "manualmode.h"

RunMode parse_manual_mode_file(void)
{
    FILE *fp = fopen(MANUAL_MODE_FILE, "r");
    if (!fp) return MODE_COUNT;

    char buf[64] = {0};
    if (!fgets(buf, sizeof(buf), fp)) {
        fclose(fp);
        return MODE_COUNT;
    }
    fclose(fp);

    /* 说明：去除首尾空白字符 */
    char *start = buf;
    while (*start && isspace((unsigned char)*start)) start++;
    if (!*start) return MODE_COUNT;

    char *end = start + strlen(start) - 1;
    while (end > start && isspace((unsigned char)*end)) *end-- = '\0';

    /* 说明：校验模式名 */
    for (int i = 0; i < MODE_COUNT; i++) {
        if (strcmp(mode_names[i], start) == 0) {
            return (RunMode)i;
        }
    }
    return MODE_COUNT; /* 说明：无效模式 */
}
