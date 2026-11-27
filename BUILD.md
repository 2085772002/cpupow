# 构建与打包说明

## 工具链

- 原生 C 编译器（本机 clang）+ `ld.lld`
- Python 3
- Android NDK（默认 `/opt/android-ndk-r30`，可设 `ANDROID_NDK_HOME`）

本机为 ARM64（无需 x86 模拟）。构建脚本用**系统 clang**（ARM64 原生）编译，
并**显式链接 NDK 的目标 CRT/运行库**（crtbegin_dynamic.o / libc.so / libm.so /
libdl.so / liblog.so / compiler-rt），**不运行 NDK 自带的 x86 工具**。

## 构建

```sh
python3 build.py                 # 三 ABI：arm64-v8a / armeabi-v7a / x86_64
python3 build.py --abi arm64-v8a # 只构建单个 ABI
python3 build.py --no-touch      # 离线测试构建（不含触摸采集，非 Android 主机）
make                             # 等价于 build.py --abi arm64-v8a
```

- API 级别默认 28（Android 9.0+），`--api N` 可调。
- 正式构建输出到 `module/lib/<abi>/cpupow`（动态 PIE，依赖系统 bionic）。
- 离线测试构建输出到 `.work/no-touch/<abi>/cpupow`，不污染正式交付物。

产物校验：每个 ABI 检查 ELF 架构与动态 PIE 类型；项目源码 `-Wall -Wextra` 零警告
（NDK 头文件自带的 `unused parameter` 等警告不属项目代码，已按源码级过滤）。

## 触摸采集条件编译

`collect/touch.c` 用 `CPUPOW_NO_TOUCH` 宏切换：

- 正式构建（Android 三 ABI）：包含完整触摸采集（BTN_TOUCH 监听、热插拔重连）。
- 离线测试构建（非 Android 主机）：`--no-touch` 定义该宏，触摸退化为恒定无触摸，
  主循环按轮询超时推进，便于在无触摸设备的环境跑核心逻辑。

## 打包 Magisk 模块

```sh
python3 pack.py                 # 输出到 out/
```

模块包含三份 `lib/<abi>/cpupow`，`install.sh` 按设备 `$ARCH` 选择对应架构并
复制到 `$MODPATH/cpupow`。打包前请先 `python3 build.py` 完成正式构建。

## 目录结构

```
.
├── source/          # C 源码（collect/compute/output 三层 + app/core/deps）
├── module/          # Magisk 模块树
│   ├── bin/         # 脚本（生命周期/看门狗/状态/电源/配置事务/CPU枚举/默认生成）
│   ├── etc/         # 数据（pkg_rules.json / powercfg.json）
│   ├── lib/         # 三 ABI cpupow 二进制
│   └── webroot/     # WebUI 前端
├── build.py         # NDK 三 ABI 构建入口
├── Makefile         # 单 ABI 便捷构建
├── pack.py          # 模块包 / 源码包打包
├── README.md
├── ARCHITECTURE.md
└── BUILD.md
```

## 关于性能与 busybox

配置页的设备发现（`bin/cpu_info.sh`）已改为**纯 shell 内建 `read` 读 sysfs（零 fork）**，
不再为每个节点 fork `tr`/`awk`。这是配置页卡顿的主要来源；换成 busybox **不会**带来
可感知提升——busybox/toybox 每次调用同样要 fork 一个进程，瓶颈在 fork 次数而非工具本身。
应用页的前端已使用 `useMemo`/分页/图标预热/应用名缓存，剩余开销主要是 `pm list packages`
等系统命令，与 shell 工具无关。

## 前端资源版本与主题约定

- `index.html` 里的 `?v=<版本>&rev=ui-<12 位>` 是缓存标记：`v` 跟随 `module.prop`，
  `rev` 取该文件内容的 sha256 前 12 位。改了 css/js 就要重新生成，否则升级后
  管理器的 WebView 仍可能吃旧缓存。
- 深色主题有两种写法并存，改动样式时不要混：
  - Tailwind `dark:xxx` 变体写在 `css/app.css` 的 `@media (prefers-color-scheme: dark)` 块里；
  - 组件类（`.cp-*` / `.cpu-*` / `.mode-*`）的深色规则写成 `html.dark` 后代选择器。
  两者由同一个系统偏好驱动：`index.html` 头部的主题引导把 `dark` 类写到 `html` 上，
  并设置 `color-scheme`。新增组件类深色规则时，确认 `html` 真的有 `dark` 类可依赖。
- 资源表是**构建期生成**的静态产物：页面里用到新的工具类，需要同时把对应的
  CSS 规则补进 `css/app.css`（设备上不运行 Tailwind 编译器）。
