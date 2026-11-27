/* 说明：独占生命周期锁在进程死亡后由内核释放；记录仅为描述，操作前须核验进程号、启动时刻、开机标识和可执行文件；锁描述符禁止由子进程继承。 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include <sys/file.h>
#include "instance.h"
static int lock_fd=-1;
static unsigned long long instance_ticks;
unsigned long long instance_start_ticks(void) { return instance_ticks; }
int instance_start(void)
{
 lock_fd=open(MODULE_DIR "/.daemon.lock",O_CREAT|O_RDWR|O_CLOEXEC|O_NOFOLLOW,0600);
 if(lock_fd<0||flock(lock_fd,LOCK_EX|LOCK_NB)){if(lock_fd>=0)close(lock_fd);lock_fd=-1;return -1;}
 char statline[2048],boot[64],*p;unsigned long long start=0;
 FILE *f=fopen("/proc/self/stat","r");
 if(!f||!fgets(statline,sizeof(statline),f)){if(f)fclose(f);instance_stop();return -1;}fclose(f);
 p=strrchr(statline,')');if(!p){instance_stop();return -1;}p+=2;
 char *save=NULL,*token=strtok_r(p," ",&save);
 for(int field=3;token && field<22;field++)token=strtok_r(NULL," ",&save);
 if(!token){instance_stop();return -1;}start=strtoull(token,NULL,10);instance_ticks=start;
 f=fopen("/proc/sys/kernel/random/boot_id","r");
 if(!f||!fgets(boot,sizeof(boot),f)){if(f)fclose(f);instance_stop();return -1;}fclose(f);boot[strcspn(boot,"\n")]=0;
 f=fopen(MODULE_DIR "/.daemon.pid.tmp","w");if(!f){instance_stop();return -1;}
 int ok=fprintf(f,"%d %llu %s\n",(int)getpid(),start,boot)>0 && fflush(f)==0;
 if(fclose(f))ok=0;
 if(!ok||rename(MODULE_DIR "/.daemon.pid.tmp",MODULE_DIR "/.daemon.pid")){instance_stop();return -1;}
 return 0;
}
/* 说明：v2.5.9：模块目录被整体替换后，锁文件会换 inode——此时自己锁的是已删除的旧文件，
 * 新实例在同一个路径上建立了新锁，两个进程都以为自己独占。用 inode 比对识别这种分裂。 */
int instance_lock_still_ours(void)
{
    struct stat by_fd, by_path;
    if (lock_fd < 0) return 0;
    if (fstat(lock_fd, &by_fd) != 0) return 0;
    if (stat(MODULE_DIR "/.daemon.lock", &by_path) != 0) return 0;
    return by_fd.st_dev == by_path.st_dev && by_fd.st_ino == by_path.st_ino;
}

void instance_stop(void)
{
 if(lock_fd>=0){unlink(MODULE_DIR "/.daemon.pid");close(lock_fd);lock_fd=-1;}
}