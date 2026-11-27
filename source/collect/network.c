/* 说明：Android 默认网络事实采集。无需流量计数、接口名猜测或公网探测。 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "network.h"
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define NETWORK_DUMP_LIMIT (512 * 1024)
#define NETWORK_DEADLINE_MS 3000

static int net_token(const char *p, const char *end, const char *token)
{
    size_t n = strlen(token);
    while (p && p < end) {
        const char *q = p;
        while (p < end && (isalnum((unsigned char)*p) || *p == '_')) p++;
        if ((size_t)(p - q) == n && memcmp(q, token, n) == 0) return 1;
        if (p < end) p++;
    }
    return 0;
}

NetworkFacts network_parse_connectivity(const char *text)
{
    NetworkFacts f = {0};
    if (!text) return f;
    const char *active = text;
    while ((active = strstr(active, "Active default network:")) != NULL) {
        if (active == text || active[-1] == '\n') break;
        active++;
    }
    if (!active) return f;
    active += strlen("Active default network:");
    while (*active == ' ' || *active == '\t') active++;
    const char *endline = strchr(active, '\n');
    if (!endline) endline = active + strlen(active);
    const char *trim = endline;
    while (trim > active && isspace((unsigned char)trim[-1])) trim--;
    size_t n = (size_t)(trim - active);
    if ((n == 4 && memcmp(active, "none", 4) == 0) ||
        (n == 4 && memcmp(active, "null", 4) == 0) ||
        (n == 2 && memcmp(active, "-1", 2) == 0)) {
        f.known = 1;
        return f;
    }
    char *ep;
    long id = strtol(active, &ep, 10);
    if (ep == active || ep != trim || id <= 0 || id > 2147483647L) return f;
    char key[64];
    snprintf(key, sizeof(key), "NetworkAgentInfo{network{%ld}", id);
    const char *agent = text;
    while ((agent = strstr(agent, key)) != NULL) {
        /* 说明：限定当前 agent 列表，拒绝后面的事件日志/历史 dump。 */
        if (agent >= text + 2 && agent[-1] == ' ' && agent[-2] == ' ' &&
            (agent == text + 2 || agent[-3] == '\n')) break;
        agent++;
    }
    if (!agent) return f;
    const char *end = strstr(agent, "\n  NetworkAgentInfo");
    if (!end) end = strstr(agent, "\n\n");
    if (!end) end = agent + strlen(agent);
    const char *tp = strstr(agent, "Transports:");
    if (!tp || tp >= end) return f;
    tp += strlen("Transports:");
    const char *cap = strstr(tp, "Capabilities:");
    if (!cap || cap >= end) return f;
    f.wifi = net_token(tp, cap, "WIFI");
    f.cellular = net_token(tp, cap, "CELLULAR");
    f.vpn = net_token(tp, cap, "VPN");
    f.other = net_token(tp, cap, "ETHERNET") || net_token(tp, cap, "BLUETOOTH") ||
        net_token(tp, cap, "USB") || net_token(tp, cap, "LOWPAN") ||
        net_token(tp, cap, "SATELLITE");
    f.known = 1;
    f.connected = 1;
    return f;
}

static long long net_mono_ms(void)
{
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return -1;
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

NetworkFacts network_read_default(void)
{
    NetworkFacts f = {0};
    long long start = net_mono_ms();
    if (start < 0) return f;
    char *buf = malloc(NETWORK_DUMP_LIMIT + 1);
    if (!buf) return f;
    int fd[2];
    if (pipe(fd) != 0) { free(buf); return f; }
    pid_t pid = fork();
    if (pid == 0) {
        close(fd[0]);
        dup2(fd[1], STDOUT_FILENO);
        close(fd[1]);
        int nullfd = open("/dev/null", O_WRONLY);
        if (nullfd >= 0) { dup2(nullfd, STDERR_FILENO); close(nullfd); }
        execl("/system/bin/dumpsys", "dumpsys", "-t", "2", "connectivity", (char *)NULL);
        _exit(127);
    }
    close(fd[1]);
    if (pid < 0) { close(fd[0]); free(buf); return f; }
    int flags = fcntl(fd[0], F_GETFL, 0);
    int valid = flags >= 0 && fcntl(fd[0], F_SETFL, flags | O_NONBLOCK) == 0;
    size_t used = 0;
    int eof = 0, status = 0, reaped = 0, auto_reaped = 0;
    while (valid) {
        long long now = net_mono_ms();
        if (now < 0 || now - start >= NETWORK_DEADLINE_MS) { valid = 0; break; }
        if (!eof) {
            struct pollfd pfd = {fd[0], POLLIN | POLLHUP, 0};
            int r = poll(&pfd, 1, 50);
            if (r < 0 && errno != EINTR) { valid = 0; break; }
            if (r > 0) {
                ssize_t got = read(fd[0], buf + used, NETWORK_DUMP_LIMIT - used);
                if (got > 0) {
                    used += (size_t)got;
                    if (used >= NETWORK_DUMP_LIMIT) valid = 0;
                } else if (got == 0) eof = 1;
                else if (errno != EINTR && errno != EAGAIN) valid = 0;
            }
        } else {
            /* 说明：pipe 先关闭但子进程尚未退出时也保持 deadline，不阻塞 waitpid。 */
            poll(NULL, 0, 10);
        }
        if (!reaped) {
            pid_t r = waitpid(pid, &status, WNOHANG);
            if (r == pid) reaped = 1;
            else if (r < 0 && errno == ECHILD) {
                /* 说明：app/main 忽略 SIGCHLD：子进程已自动回收，不能再 kill 旧 PID。
 * 退出码不可用，仍要求完整 pipe EOF 和受限快照解析成功。
 */
                reaped = 1;
                auto_reaped = 1;
            } else if (r < 0 && errno != EINTR) { valid = 0; break; }
        }
        if (eof && reaped) break;
    }
    close(fd[0]);
    if (!reaped) {
        kill(pid, SIGKILL);
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    }
    if (valid && eof && reaped && (auto_reaped || (WIFEXITED(status) && WEXITSTATUS(status) == 0))) {
        buf[used] = '\0';
        f = network_parse_connectivity(buf);
    }
    free(buf);
    return f;
}