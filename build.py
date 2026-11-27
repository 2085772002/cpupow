#!/usr/bin/env python3
"""cpupow NDK 构建脚本：三 ABI 动态 bionic 构建。

用法：
    python3 build.py                 # 构建三 ABI，产物到 module/lib/<abi>/cpupow
    python3 build.py --abi arm64-v8a # 只构建单个 ABI
    python3 build.py --no-touch      # 离线测试构建：不含触摸采集（非 Android 主机）
    python3 build.py --api 28        # 指定 Android API 级别（默认 28）

依赖：系统 clang + ld.lld（ARM64 原生）+ Android NDK（默认 /opt/android-ndk-r30，
可设 ANDROID_NDK_HOME）。构建脚本显式链接 NDK 目标 CRT/运行库，不运行 NDK 的 x86 工具。

产物为动态 PIE（PT_INTERP=/system/bin/linker64），运行时依赖系统 bionic，兼容性最高。
"""
import argparse
import os
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'source'
MODULE = ROOT / 'module'
DEFAULT_NDK = '/opt/android-ndk-r30'
DEFAULT_API = 28

ABIS = {
    'arm64-v8a': 'aarch64-linux-android',
    'armeabi-v7a': 'armv7a-linux-androideabi',
    'x86_64': 'x86_64-linux-android',
}
# 各 ABI 的 ELF machine 值（用于产物校验）
ELF_MACHINE = {'arm64-v8a': 183, 'armeabi-v7a': 40, 'x86_64': 62}

SRCS = [
    'app/main.c', 'app/probe.c', 'app/diag.c',
    'collect/battery.c', 'collect/touch.c', 'collect/foreground.c',
    'collect/network.c', 'collect/manualmode.c', 'collect/freq.c',
    'compute/config.c', 'compute/mode.c', 'compute/touch_policy.c', 'compute/pkgrules.c',
    'compute/zone.c', 'compute/zone_window.c', 'compute/cap.c',
    'output/sysfs.c', 'output/status.c', 'output/log.c', 'output/metrics.c',
    'core/state.c', 'core/util.c', 'core/instance.c',
    'deps/cJSON.c',
]

CC = os.environ.get('CC', 'clang')


def find_ndk() -> tuple[Path, Path]:
    ndk = Path(os.environ.get('ANDROID_NDK_HOME', DEFAULT_NDK))
    prebuilt = ndk / 'toolchains/llvm/prebuilt/linux-x86_64'
    sysroot = prebuilt / 'sysroot'
    if not sysroot.is_dir():
        sys.exit(f'NDK sysroot 不存在: {sysroot}\n请设置 ANDROID_NDK_HOME 或安装到 {DEFAULT_NDK}')
    clang_lib = prebuilt / 'lib/clang'
    versions = sorted(p.name for p in clang_lib.glob('*') if p.is_dir())
    if not versions:
        sys.exit(f'NDK 缺少 clang resource 目录: {clang_lib}')
    resource = clang_lib / versions[-1]
    return sysroot, resource


def compile_one(cc: str, target: str, sysroot: Path, resource: Path,
                src: Path, obj: Path, defines: list[str]):
    cmd = [cc, f'--target={target}', f'--sysroot={sysroot}', f'-resource-dir={resource}',
           '-Os', '-D_GNU_SOURCE', '-DFORTIFY_SOURCE=0', '-Wall', '-Wextra',
           '-I', str(SRC), '-I', str(SRC / 'deps')] + defines + \
          ['-c', str(src), '-o', str(obj)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f'编译失败 {src}:\n{r.stderr}')
    # 项目源码零警告自检
    for line in r.stderr.splitlines():
        if 'warning:' in line or 'error:' in line:
            sys.exit(f'编译告警 {src}:\n{line}')


def link(cc: str, target: str, sysroot: Path, resource: Path,
         objs: list[Path], out: Path):
    cmd = [cc, f'--target={target}', f'--sysroot={sysroot}', f'-resource-dir={resource}',
           '-fuse-ld=lld', '--rtlib=compiler-rt',
           '-Wl,-z,max-page-size=16384', '-Wl,--build-id',
           *(str(o) for o in objs), '-lc', '-ldl', '-lm', '-llog', '-o', str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f'链接失败:\n{r.stderr}')


def verify_elf(path: Path, abi: str):
    data = path.read_bytes()
    if data[:4] != b'\x7fELF':
        sys.exit(f'非 ELF: {path}')
    machine = struct.unpack('<H', data[18:20])[0]
    etype = struct.unpack('<H', data[16:18])[0]
    if machine != ELF_MACHINE[abi]:
        sys.exit(f'{abi} 架构不符: machine={machine}')
    if etype != 3:
        sys.exit(f'非动态 PIE: {path}')
    print(f'  {abi}: {len(data)} 字节, 动态 PIE ✓')


def build_abi(abi: str, api: int, no_touch: bool, sysroot: Path, resource: Path):
    target = f'{ABIS[abi]}{api}'
    defines = ['-DCPUPOW_NO_TOUCH'] if no_touch else []
    objdir = ROOT / '.work' / 'obj' / abi
    objdir.mkdir(parents=True, exist_ok=True)
    objs = []
    for i, s in enumerate(SRCS):
        obj = objdir / f'{i}.o'
        compile_one(CC, target, sysroot, resource, SRC / s, obj, defines)
        objs.append(obj)
    # 正式构建输出到 module/lib/<abi>/；离线测试构建输出到 .work/no-touch/<abi>/，
    # 不污染正式交付物。
    out = (ROOT / '.work' / 'no-touch' / abi / 'cpupow') if no_touch \
        else (MODULE / 'lib' / abi / 'cpupow')
    out.parent.mkdir(parents=True, exist_ok=True)
    link(CC, target, sysroot, resource, objs, out)
    verify_elf(out, abi)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--abi', choices=sorted(ABIS), help='只构建指定 ABI（默认全部）')
    ap.add_argument('--no-touch', action='store_true', help='离线测试构建：不含触摸采集')
    ap.add_argument('--api', type=int, default=DEFAULT_API, help=f'Android API 级别（默认 {DEFAULT_API}）')
    args = ap.parse_args()

    sysroot, resource = find_ndk()
    print(f'NDK sysroot: {sysroot}')
    print(f'clang resource: {resource}')
    print(f'触摸采集: {"关闭(离线测试)" if args.no_touch else "开启(正式构建)"}')

    abis = [args.abi] if args.abi else sorted(ABIS)
    for abi in abis:
        print(f'构建 {abi} (target={ABIS[abi]}{args.api}) ...')
        build_abi(abi, args.api, args.no_touch, sysroot, resource)

    print('构建完成。产物:')
    base = ROOT / '.work' / 'no-touch' if args.no_touch else MODULE / 'lib'
    for abi in abis:
        out = base / abi / 'cpupow'
        print(f'  {out}  ({out.stat().st_size} 字节)')


if __name__ == '__main__':
    main()