# cpupow调度（cpupow）

对小米澎湃（HyperOS）CPU WALT 调速器参数做修改的 Magisk 模块，按经验配置能效。

- 模块 id / 名称 / 作者见 `module/module.prop`
- C 守护进程读 sysfs 采集状态 → 计算调度策略 → 写 sysfs 下发调频，并提供 WebView 界面

## 代码分层（按数据流）

| 层 | 目录 | 职责 |
|---|---|---|
| 数据采集 | `source/collect/` | 读 sysfs、前台应用探测、触摸事件、网络状态、电池/耗电采样 |
| 数据计算 | `source/compute/` | 运行模式判定、触摸相位状态机、策略配置解析与编译、包名规则匹配 |
| 数据输出 | `source/output/` | 写 sysfs 下发调频、运行状态 JSON、分级日志 |
| 编排 | `source/app/` | 主循环，粘合采集→计算→输出，事件源装配与生命周期 |
| 公共内核 | `source/core/` | 共享状态、字符串工具、进程锁、时钟工具 |
| 第三方 | `source/deps/` | cJSON |

依赖方向：`app → collect/compute/output → core → deps`。

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
├── pack.py          # 模块包打包
├── ARCHITECTURE.md  # 架构与数据流说明
└── BUILD.md         # 构建与打包说明
```

## 快速构建

```sh
python3 build.py      # 三 ABI（arm64-v8a / armeabi-v7a / x86_64）
python3 pack.py       # 打包模块 zip
```

需要 Android NDK（默认 `/opt/android-ndk-r30`，可设 `ANDROID_NDK_HOME`）。详见 `BUILD.md`。