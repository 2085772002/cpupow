#!/usr/bin/env python3
"""cpupow 模块包打包：module/ → Magisk 模块 zip（并附源码包）。

用法：python3 pack.py [输出目录]
默认输出到当前目录的 out/。
"""
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODULE = ROOT / 'module'
STAMP = (2026, 11, 25, 0, 0, 0)  # 固定时间戳保证可复现
def is_exec(name: str) -> bool:
    """可执行文件：所有 .sh 脚本（根目录与 bin/）+ cpupow 二进制（含 lib/<abi>/cpupow）。"""
    return name.endswith('.sh') or name == 'cpupow' or name.endswith('/cpupow')
IGNORED = {'.git', '.svn', '.idea', '.vscode', '__pycache__', '.pytest_cache', '.mypy_cache',
           'node_modules', 'backup', 'out', 'dist', 'build', '.work', '.cache'}
# 运行时生成文件（安装目录里可能有残留，不能进包）
RUNTIME_IGNORED = {'profile_battery.json', 'profile.json', 'profile_reset', 'manual_mode.txt',
                   'cpu_policy.v2.json', 'cpu_policy.json.bak',
                   'cycle_hidden.txt', 'watchdog.log', '.watchdog.pid', '.lifecycle.lock',
                   '.daemon.pid', '.daemon.lock', 'policy_status.json', 'runtime_status.json',
                   'policy_status.json.tmp', 'runtime_status.json.tmp', 'cpu_policy.log'}


def read_version() -> str:
    for line in (MODULE / 'module.prop').read_text(encoding='utf-8').splitlines():
        if line.startswith('version='):
            return line.partition('=')[2].strip()
    raise SystemExit('module.prop 缺少 version')


def module_files() -> dict:
    """返回 {zip内相对路径: 源文件路径}，module/ 前缀打平。"""
    out = {}
    for p in sorted(MODULE.rglob('*')):
        if not p.is_file():
            continue
        rel = p.relative_to(MODULE).as_posix()
        if any(part in IGNORED for part in p.parts):
            continue
        if p.name in RUNTIME_IGNORED:
            continue
        # 运行时图标缓存目录：只保留 .keep 占位（目录本身是前端写图标用的）
        if rel.startswith('webroot/icons/') and rel != 'webroot/icons/.keep':
            continue
        out[rel] = p
    return out


def source_files() -> dict:
    """源码包：source/ + module/ + 构建脚本与文档。"""
    out = {}
    base = ROOT
    for p in sorted(base.rglob('*')):
        if not p.is_file():
            continue
        rel = p.relative_to(base).as_posix()
        if rel.startswith(('out/', '.git/')):
            continue
        if any(part in IGNORED for part in p.parts):
            continue
        if p.name in RUNTIME_IGNORED:
            continue
        out[rel] = p
    return out


def make_zip(path: Path, files: dict, is_module: bool):
    with zipfile.ZipFile(path, 'x', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, STAMP)
            info.create_system = 3
            mode = 0o755 if (is_module and is_exec(name)) else 0o644
            info.external_attr = mode << 16
            z.writestr(info, files[name].read_bytes())
    return path


def main():
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'out'
    out_dir.mkdir(exist_ok=True)
    version = read_version()

    mod_zip = make_zip(out_dir / f'cpupow_sched_{version}.zip',
                       module_files(), is_module=True)
    src_zip = make_zip(out_dir / f'cpupow_sched_{version}_source.zip',
                       source_files(), is_module=False)

    print(f'模块包: {mod_zip}  ({mod_zip.stat().st_size} 字节)')
    print(f'源码包: {src_zip}  ({src_zip.stat().st_size} 字节)')


if __name__ == '__main__':
    main()