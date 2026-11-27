#ifndef CPUPOW_INSTANCE_H
#define CPUPOW_INSTANCE_H
int instance_start(void);
unsigned long long instance_start_ticks(void);
void instance_stop(void);
/* 说明：v2.5.9：确认自己锁的还是当前那个锁文件。
 * 模块升级会整体替换目录，锁文件换成新 inode：旧实例的 flock 落在已被删除的旧 inode 上，
 * 新实例能重新拿到锁，于是两个守护进程同时写 sysfs。这里比对 inode，不是自己的就退出。 */
int instance_lock_still_ours(void);
#endif
