#!/bin/sh
# cpupow 构建入口：委托 build.py（NDK 三 ABI 构建）
exec python3 "$(dirname "$0")/build.py" "$@"