/* 说明：collect/foreground.c — 前台应用探测【采集层】
 * 
 * 职责：fork+exec dumpsys window displays，从焦点行解析当前前台包名。
 * 
 * 边界条件：
 * - 兼容 mCurrentFocus 与 mFocusedApp 两种输出格式。
 * - 焦点若为系统窗口（通知栏等），该行不含点号，跳过继续扫后续行，
 * 避免把窗口名当作包名参与统计与调度。
 * - 最多扫 5000 行；子进程挂起则强杀。
 * 
 * 对外：get_foreground_info。
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "../output/log.h"
#include "foreground.h"
#include "../core/clock.h"
#ifndef CPUPOW_DUMPSYS
#define CPUPOW_DUMPSYS "/system/bin/dumpsys"
#endif
typedef struct { char buffer[4096]; size_t offset, length, bytes; uint64_t deadline; } FocusReader;
static int focus_line(int fd,FocusReader *r,char *line,size_t cap)
{
    size_t used=0;
    while(used+1<cap){
        uint64_t now=runtime_now_ms();if(now>=r->deadline)return 0;
        if(r->offset==r->length){
            struct pollfd p={.fd=fd,.events=POLLIN};int rc=poll(&p,1,(int)(r->deadline-now));
            if(rc<0&&errno==EINTR)continue;if(rc<=0)return 0;
            ssize_t n=read(fd,r->buffer,sizeof(r->buffer));
            if(n<0&&(errno==EINTR||errno==EAGAIN))continue;
            if(n<=0||r->bytes+(size_t)n>262144)return 0;
            r->bytes+=(size_t)n;r->offset=0;r->length=(size_t)n;
        }
        char c=r->buffer[r->offset++];line[used++]=c;if(c=='\n'){line[used]=0;return 1;}
    }
    return 0; /* 说明：过大或截断的焦点行按未知处理，不接受部分身份。 */
}

int get_foreground_info_user(char *pkg_name, size_t len, int *user_id) {
    if (user_id) *user_id=-1;
    if (!pkg_name || len <= 1) return -1;

    int pipefd[2];
    if (pipe(pipefd) == -1) return -1;

    pid_t pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }

    if (pid == 0) {
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        int null_fd = open("/dev/null", O_WRONLY);
        if (null_fd >= 0) { dup2(null_fd, STDERR_FILENO); close(null_fd); }
        close(pipefd[1]);
        execl(CPUPOW_DUMPSYS, "dumpsys", "window", "displays", (char *)NULL);
        _exit(127); 
    }

    close(pipefd[1]);
    fcntl(pipefd[0],F_SETFL,O_NONBLOCK);
    FocusReader reader={.deadline=runtime_now_ms()+2000};

    char line[1024];
    int found = 0;
    int max_lines = 5000; 
    char crlf[3] = {13, 10, 0}; 

    while (max_lines-- > 0 && focus_line(pipefd[0],&reader,line,sizeof(line))) {
        /* 说明：双管齐下：同时兼容 mCurrentFocus 和 mFocusedApp */
        if ((strstr(line, "mCurrentFocus") || strstr(line, "mFocusedApp")) && !strstr(line, "=null")) {
            
            line[strcspn(line, crlf)] = 0; 
            /* 说明：焦点原文为短暂输入，不记录原始内容。 */

            /* 说明：【兼容补丁】查找斜杠，如果没有斜杠（桌面环境），就找右大括号 */
            char *end = strchr(line, '/');
            if (!end) end = strchr(line, '}'); 
            
            if (end) {
                char *start = end;
                /* 说明：往前倒推，直到遇到空格或左大括号，完美提取纯净包名 */
                while (start > line && *(start - 1) != ' ' && *(start - 1) != '{') {
                    start--;
                }
                size_t pkg_len = end - start;
                /* 说明：焦点行无斜杠分支：窗口名（如通知面板 NotificationShade）不含点，不是包名——
 * 跳过继续扫后续焦点行，避免把系统窗口名当应用统计/调度目标
 */
                if (pkg_len > 0 && pkg_len < len && memchr(start, '.', pkg_len)) {
                    memcpy(pkg_name, start, pkg_len);
                    pkg_name[pkg_len] = 0; 
                    if (user_id) {
                        const char *u=line;
                        while ((u=strstr(u," u"))!=NULL) {
                            char *tail; errno=0; long id=strtol(u+2,&tail,10);
                            if (!errno && tail>u+2 && *tail==' ' && id>=0 && id<=21474) { *user_id=(int)id; break; }
                            u+=2;
                        }
                    }
                    found = 1;
                    break; /* 说明：成功获取，立刻打断逃离 */
                }
            }
        }
    }

    close(pipefd[0]);

    int status;
    pid_t w = waitpid(pid, &status, WNOHANG);
    if (w == 0) {
        kill(pid, SIGKILL);
        /* 说明：内核中卡住的子进程不能同步回收，禁止因此阻塞前台探测线程。 */
        for(unsigned retry=0;retry<10&&waitpid(pid,&status,WNOHANG)==0;retry++)usleep(10000);
        /* 说明：【静音错杀】如果是成功抓取后主动打断的，不再报 ERROR 污染日志 */
        if (!found) {
            LOG_ERROR("Dumpsys 底层探测挂起，已强制清理");
        }
    }

    return found ? 0 : -1;
}

int get_foreground_info(char *pkg_name,size_t len) { return get_foreground_info_user(pkg_name,len,NULL); }
