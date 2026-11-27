/* 说明：collect/touch.c — 触摸感知【采集层】
 * 
 * 职责：定位触摸输入设备、监听 BTN_TOUCH 事件、断线热插拔重连。
 * 线程模型：内部单线程轮询（500ms 心跳超时，避免关机时阻塞在 read），
 * 状态变化经 eventfd 通知主循环，主循环不做阻塞等待。
 * 
 * 对外：touch_start / touch_stop / touch_event_fd / touch_is_active /
 * touch_is_available / touch_release_device。
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "../cpupow.h"
#include "../output/log.h"
#include "touch.h"
#include "../core/clock.h"

/* 说明：CPUPOW_NO_TOUCH 用于非 Android 主机离线测试构建：无触摸设备，触摸相位退化为
 * 恒定无触摸，主循环按轮询超时推进。Android 三 ABI 正式构建不定义此宏，包含完整采集。 */
#ifndef CPUPOW_NO_TOUCH

/* 说明：EVIOCSMASK 在较老内核头里可能缺失，这里补一份本地定义 */
#ifndef EVIOCSMASK
struct input_mask {
    uint32_t type;
    uint32_t codes_size;
    uint64_t codes_ptr;
};
#define EVIOCSMASK _IOW('E', 0x93, struct input_mask)
#endif

/* 说明：---- 模块私有状态 ---- */
static int        touch_event_fd_num = -1;  /* 说明：通知主循环的 eventfd */
static atomic_int touch_device_fd    = -1;  /* 说明：当前打开的 /dev/input/eventN */
static atomic_int touch_available    = 0;   /* 说明：设备是否就绪 */
static pthread_t  touch_thread_id;
static atomic_int touch_active = 0;
static atomic_int reconnect_requested;
static pthread_mutex_t sample_mutex = PTHREAD_MUTEX_INITIALIZER;
static TouchSample current_sample;

/* 说明：快照及时间戳整体发布，保持耗电采样兼容；通知不携带坐标数据。 */
static void publish_touch(int available, int active, int force)
{
    pthread_mutex_lock(&sample_mutex);
    int changed = current_sample.available != available || current_sample.active != active;
    if (changed || force) {
        uint64_t now = runtime_boot_ms();
        if (available && active && (!current_sample.active || !current_sample.available)) {
            current_sample.down_ms = now;
            current_sample.presses++;
        }
        current_sample.available = available;
        current_sample.active = active;
        current_sample.changed_ms = now;
        current_sample.sequence++;
    }
    atomic_store(&touch_active,active);
    atomic_store(&touch_available,available);
    pthread_mutex_unlock(&sample_mutex);
    if ((changed || force) && touch_event_fd_num >= 0) {
        uint64_t signal = 1;
        (void)write(touch_event_fd_num,&signal,sizeof(signal));
    }
}

void touch_get_sample(TouchSample *sample)
{
    if (!sample) return;
    pthread_mutex_lock(&sample_mutex);
    *sample = current_sample;
    pthread_mutex_unlock(&sample_mutex);
}

/* 说明：耗电采样共享原子观测，定义在文件状态区。 */

static char* sanitize_value(char *str)
{
    if (!str)
        return NULL;
    while (*str && (isspace((unsigned char)*str) || *str == '"')) str++;
    size_t slen = strlen(str);
    if (slen == 0) return str;
    char *end = str + slen - 1;
    while (end > str && (isspace((unsigned char)*end) ||
                         *end == '"' || *end == '\n' || *end == '\r')) {
        *end = '\0';
        end--;
    }
    return str;
}

static char* find_touch_device(void)
{
    FILE *fp = fopen("/proc/bus/input/devices", "r");
    if (!fp)
        return NULL;
    char line[512], name_buf[256] = {0};
    char *dev_path = NULL;

    while (fgets(line, sizeof(line), fp)) {
        if (strlen(line) < 3 || line[1] != ':')
            continue;

        char prefix = line[0];
        char *content = line + 3;

        if (prefix == 'I') {
            name_buf[0] = '\0';
        } else if (prefix == 'N' && strncmp(content, "Name=", 5) == 0) {
            strncpy(name_buf, sanitize_value(content + 5), sizeof(name_buf) - 1);
        } else if (prefix == 'H' && strncmp(content, "Handlers=", 9) == 0) {
            if (strcasestr(name_buf, "Touch") || strcasestr(name_buf, "Screen") ||
            strcasestr(name_buf, "ts") || strcasestr(name_buf, "TS") ||
            strcasestr(name_buf, "panel") || strcasestr(name_buf, "Panel") ||
            strcasestr(name_buf, "digitizer") || strcasestr(name_buf, "touchscreen")) {
                char *ev_pos = strstr(content + 9, "event");
                if (ev_pos) {
                    char ev_name[32] = {0};
                    if (sscanf(ev_pos, "%31s", ev_name) == 1) {
                        size_t len = strlen("/dev/input/") + strlen(ev_name) + 1;
                        dev_path = malloc(len);
                        if (dev_path)
                            snprintf(dev_path, len, "/dev/input/%s", ev_name);
                        break;
                    }
                }
            }
        }
    }

    fclose(fp);
    return dev_path;
}

#define BITS_PER_BYTE        8
#define BITS_PER_LONG        (sizeof(unsigned long) * BITS_PER_BYTE)
#define DIV_ROUND_UP(n, d)   (((n) + (d) - 1) / (d))
#define BIT_WORD(nr)         ((nr) / BITS_PER_LONG)
#define BIT_MASK(nr)         (1UL << ((nr) % BITS_PER_LONG))

static int query_touch_state_initial(int fd)
{
    if (BTN_TOUCH >= KEY_MAX)
        return -1;

    unsigned long keys[DIV_ROUND_UP(KEY_MAX, BITS_PER_LONG)] = {0};
    if (ioctl(fd, EVIOCGKEY(sizeof(keys)), keys) < 0)
        return -1;
    return (keys[BIT_WORD(BTN_TOUCH)] & BIT_MASK(BTN_TOUCH)) ? 1 : 0;
}

static void configure_event_mask(int fd)
{
    unsigned long zero_mask[DIV_ROUND_UP(ABS_CNT, BITS_PER_LONG)] = {0};
    struct input_mask mask = {
        .type       = EV_ABS,
        .codes_size = sizeof(zero_mask),
        .codes_ptr  = (uintptr_t)zero_mask
    };
    ioctl(fd, EVIOCSMASK, &mask);
}

static void* touch_monitor_thread(void *arg)
{
    (void)arg;
    struct input_event ev;

    /* 说明：外层循环：负责断线热插拔自动重连 */
    while (atomic_load(&g_running)) {
        char *dev_path = find_touch_device();
        if (!dev_path) {
            LOG_ERROR("无法定位 Touch 输入设备，3秒后重试...");
            sleep(3);
            continue;
        }

        int fd = open(dev_path, O_RDONLY | O_CLOEXEC);
        free(dev_path);
        if (fd < 0) {
            LOG_ERROR("无法打开触摸设备节点 (errno: %d)，3秒后重试...", errno);
            sleep(3);
            continue;
        }

        atomic_store(&touch_device_fd, fd);
        configure_event_mask(fd);

        int last_state = query_touch_state_initial(fd);
        if (last_state < 0) {
            atomic_store(&touch_device_fd,-1);
            close(fd);
            sleep(1);
            continue;
        }
        publish_touch(1,last_state,1);
        int sync_lost = 0;
        LOG_INFO("Touch 监听设备已连接并就绪");

        struct pollfd pfd = { .fd = fd, .events = POLLIN };

        /* 说明：内层循环：带有 500ms 心跳超时机制的事件轮询，防止阻塞关机死锁 */
        while (atomic_load(&g_running)) {
            if (atomic_exchange(&reconnect_requested,0)) break;
            int pret = poll(&pfd, 1, 500); 
            if (pret == 0) continue; /* 说明：超时心跳，再次检查 g_running 状态 */
            if (pret < 0) {
                if (errno == EINTR) continue;
                LOG_ERROR("触摸设备轮询异常，准备重新连接...");
                break;
            }

            if (pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) break;
            if (!(pfd.revents & POLLIN)) continue;
            ssize_t n = read(fd, &ev, sizeof(ev));
            if (n < (ssize_t)sizeof(ev)) {
                if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
                LOG_ERROR("触摸设备断开或读取失败，准备重新连接...");
                break;
            }

            /* 说明：丢事件后以同步边界查询真实按键，不把缺失的抬起长期当作按住。 */
            if (ev.type == EV_SYN && ev.code == SYN_DROPPED) { sync_lost=1; continue; }
            if (sync_lost) {
                if (ev.type == EV_SYN && ev.code == SYN_REPORT) {
                    int actual=query_touch_state_initial(fd);
                    if (actual < 0) break;
                    last_state=actual;
                    publish_touch(1,last_state,0);
                    sync_lost=0;
                }
                continue;
            }
            if (ev.type == EV_KEY && ev.code == BTN_TOUCH) {
                if (ev.value == 0 || ev.value == 1) {
                    if (ev.value != last_state) {
                        last_state = ev.value;
                        publish_touch(1,last_state,0);
                    }
                }
            }
        }

        publish_touch(0,0,0);
        atomic_store(&touch_device_fd, -1);
        close(fd);
        
        if (atomic_load(&g_running)) sleep(1); 
    }
    return NULL;
}

/* 说明：---- 对外接口 ---- */

int touch_event_fd(void)
{
    return touch_event_fd_num;
}

int touch_is_active(void)
{
    return atomic_load(&touch_active);
}

int touch_is_available(void)
{
    return atomic_load(&touch_available);
}

/* 说明：仅请求重连；设备句柄只由监听线程关闭，避免跨线程重复关闭复用后的编号。 */
void touch_release_device(void)
{
    atomic_store(&reconnect_requested,1);
}

/* 说明：建 eventfd 并启动监听线程。返回 0 成功，-1 失败（失败时已回滚）。 */
int touch_start(void)
{
    touch_event_fd_num = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    if (touch_event_fd_num < 0)
        return -1;
    if (pthread_create(&touch_thread_id, NULL, touch_monitor_thread, NULL) != 0) {
        close(touch_event_fd_num);
        touch_event_fd_num = -1;
        return -1;
    }
    return 0;
}

/* 说明：回收线程与设备并关闭 eventfd。需在 g_running=0 之后调用。 */
void touch_stop(void)
{
    pthread_join(touch_thread_id, NULL);
    touch_release_device();
    if (touch_event_fd_num >= 0) {
        close(touch_event_fd_num);
        touch_event_fd_num = -1;
    }
}

#else /* CPUPOW_NO_TOUCH：离线测试构建，无触摸设备 */

#include <string.h>

void touch_get_sample(TouchSample *sample)
{
    if (sample) memset(sample, 0, sizeof(*sample));
}

int touch_event_fd(void)     { return -1; }
int touch_is_active(void)    { return 0; }
int touch_is_available(void) { return 0; }
void touch_release_device(void) {}
int touch_start(void)        { return 0; }
void touch_stop(void)        {}

#endif /* CPUPOW_NO_TOUCH */