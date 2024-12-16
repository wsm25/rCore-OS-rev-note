# 环境配置

本书的环境如下：
- Ubuntu 22.04, x86_64 Linux 5.15.153.1-microsoft-standard-WSL2
- cargo 1.82.0, rustc 1.82.0
- QEMU emulator version 9.1.1, virt-9.1, cortex-a53

## Rust

本书假定读者应当已经至少安装了 rustup 和 cargo，在此不再赘述。

本书假定用于 aarch64 架构。首先安装 aarch64 工具链：

```bash
sudo apt install gcc-aarch64-linux-gnu
rustup target add aarch64-unknown-linux-musl aarch64-unknown-none
```

不过无标准库 target 在 rust 里都还是 Tier 2.5，会有某些 bug 可能要很久才能解决。

## Qemu

在拥有常规编译环境 (C Compiler, Python3, pkg-config) 后安装下面的东西（缺啥装啥）

```bash
VERSION=9.1.1
# dependency
pip install tomli
sudo apt install ninja-build libglib2.0-dev libslirp-dev libsdl2-dev
# download and compile
wget https://download.qemu.org/qemu-${VERSION}.tar.xz
tar xf qemu*.tar.xz && cd qemu-${VERSION}/build
../configure --target-list=aarch64-softmmu,aarch64-linux-user --enable-sdl --enable-slirp --disable-docs
make -j$(nproc)
```

测试：
```bash
./qemu-system-aarch64 --version
```

输出

```txt
QEMU emulator version 9.1.1
Copyright (c) 2003-2024 Fabrice Bellard and the QEMU Project developers
```

通过 `./qemu-system-aarch64 -M virt -nographic` 可以启动虚拟机，但现在啥都没有，会直接卡住；按 Ctrl-A 后按 X 退出。（后期卡住时都可以这么强制退出）更多快捷键可以 Ctri-A 后按 H 查看。

你可以 `sudo make install` 装到系统里，或者在开发目录下添加 `PATH` 环境变量。

## Debug

本项目 Debug 主要靠两种方法：gdb-multiarch 和打印 debug 法。因此可以装个 gdb-multiarch。

```bash
sudo apt install gdb-multiarch # 安装
qemu-system-aarch64 -nographic -kernel $KERNEL -machine virt -s -S # debug 启动虚拟机并等待
gdb-multiarch -ex 'target remote localhost:1234' $KERNEL # 加载内核文件并 gdb 连到虚拟机上
```

处理一些控制流怪异的疑难杂症时有奇效。建议在 `Cargo.toml` 中添加

```toml
[profile.release]
debug = true
```

debug 更丝滑！

## VSCode

如果你和本书一样用的是 VSCode 开发，建议把 Workspace 里的 `rust-analyzer.cargo.allTargets` 设为 false。从而禁用依赖 std 的 `test` target，防止报错；或者 `Cargo.toml` 在目标文件配置 `test = false` `bench = false`。

