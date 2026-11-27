/* 说明：app/diag.h — 诊断报告接口【编排层】
 *
 * --diag 一次性导出一份自包含的 JSON：环境、配置、频率、分区判定、
 * 守护进程运行快照与性能指标。目的是把"排查需要问用户的一堆问题"
 * 收敛成"发我这一份文件"。
 */
#ifndef CPUPOW_DIAG_H
#define CPUPOW_DIAG_H

/* 说明：生成并打印诊断 JSON。返回值同进程退出码：0 成功。 */
int diag_run(void);

#endif /* 说明：头文件结束：CPUPOW_DIAG_H */