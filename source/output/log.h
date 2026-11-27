/* 说明：output/log.h — 结构化日志接口【输出层】
 *
 * 日志格式（单行，便于 grep / awk / 正则提取）：
 *   [HH:MM:SS.mmm][级别][模块] 事件名 k=v k=v ...
 *
 *   级别：F 致命 / E 错误 / W 警告 / I 常规 / D 调试 / T 追踪
 *   模块：定长 4 字符（boot cfg  tch  prb  zone wrt  bat  perf diag core）
 *
 * 这样一条日志既人能读，也能被脚本按「模块 + 事件 + 键值」解析，
 * 不需要在自由文本里做模糊匹配。
 */
#ifndef CPUPOW_LOG_H
#define CPUPOW_LOG_H

/* 说明：模块标签。定长右填充，日志里列对齐，便于肉眼扫读与正则提取。 */
#define MOD_BOOT "boot"
#define MOD_CFG  "cfg "
#define MOD_TOUCH "tch "
#define MOD_PROBE "prb "
#define MOD_ZONE "zone"
#define MOD_WRT  "wrt "
#define MOD_BAT  "bat "
#define MOD_PERF "perf"
#define MOD_DIAG "diag"
#define MOD_CORE "core"

/* 说明：写一条结构化日志。level 越小越重要：0=致命 1=常规/错误 2=调试 3=追踪。 */
void log_writef(int level, const char *module, const char *fmt, ...);

/* 说明：兼容旧接口（无模块标签，按 core 处理）。 */
void log_write(int level, const char *fmt, ...);

int  log_level(void);
void log_set_level(int level);
void log_close(void);

#endif /* 说明：头文件结束：CPUPOW_LOG_H */