# cpupow 标准构建（NDK 三 ABI，默认 arm64-v8a）
# 依赖：系统 clang/lld + Android NDK（默认 /opt/android-ndk-r30，可设 ANDROID_NDK_HOME）

ABI ?= arm64-v8a
API ?= 28

.PHONY: all clean

all:
	python3 build.py --abi $(ABI) --api $(API)

clean:
	rm -rf .work module/lib