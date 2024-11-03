# 环境配置

本书就用 WSL/Ubuntu 了。其他环境可以参考 [原书](https://rcore-os.cn/rCore-Tutorial-Book-v3/chapter0/5setup-devel-env.html)。

## Rust

本书假定读者应当已经至少安装了 rustup 和 cargo 并配置了镜像，本书不再赘述。

rCore-OS 强依赖于 risc-v 架构，因此需要安装 riscv 工具链：

```bash
rustup target add riscv64gc-unknown-none-elf
```

## Qemu

Qemu 实现了 risc-v sbi，也相当轻量，很适合作为我们迷你 OS 的宿主。

我就直接用写作日 (2024/10) 最新 release 9.1.1 了

最新的 wsl 已经支持了图形界面，可以链接 sdl 库。

在拥有正常程序员环境 (C Compiler, Python3, pkg-config) 后安装下面的东西（缺啥装啥）

```bash
# requirement
pip install tomli
sudo apt install ninja-build libglib2.0-dev libslirp-dev libsdl2-dev
# download and compile
wget https://download.qemu.org/qemu-9.1.1.tar.xz
tar xf qemu*.tar.xz && cd qemu-9.1.1/build
../configure --target-list=riscv64-softmmu,riscv64-linux-user --enable-sdl --enable-slirp --disable-docs
make -j$(nproc)
```

测试：
```bash
./qemu-system-riscv64 -nographic
```

输出：
```txt
OpenSBI v1.5.1
   ____                    _____ ____ _____
  / __ \                  / ____|  _ \_   _|
 | |  | |_ __   ___ _ __ | (___ | |_) || |
 | |  | | '_ \ / _ \ '_ \ \___ \|  _ < | |
 | |__| | |_) |  __/ | | |____) | |_) || |_
  \____/| .__/ \___|_| |_|_____/|____/_____|
        | |
        |_|

Platform Name             : ucbbar,spike-bare,qemu
Platform Features         : medeleg
Platform HART Count       : 1
Platform IPI Device       : aclint-mswi
Platform Timer Device     : aclint-mtimer @ 10000000Hz
Platform Console Device   : htif
Platform HSM Device       : ---
Platform PMU Device       : ---
Platform Reboot Device    : htif
Platform Shutdown Device  : htif
Platform Suspend Device   : ---
Platform CPPC Device      : ---
Firmware Base             : 0x80000000
Firmware Size             : 327 KB
Firmware RW Offset        : 0x40000
Firmware RW Size          : 71 KB
Firmware Heap Offset      : 0x49000
Firmware Heap Size        : 35 KB (total), 2 KB (reserved), 11 KB (used), 21 KB (free)
Firmware Scratch Size     : 4096 B (total), 392 B (used), 3704 B (free)
Runtime SBI Version       : 2.0

Domain0 Name              : root
Domain0 Boot HART         : 0
Domain0 HARTs             : 0*
Domain0 Region00          : 0x0000000001000000-0x0000000001000fff M: (I,R,W) S/U: (R,W)
Domain0 Region01          : 0x0000000002000000-0x000000000200ffff M: (I,R,W) S/U: ()
Domain0 Region02          : 0x0000000080040000-0x000000008005ffff M: (R,W) S/U: ()
Domain0 Region03          : 0x0000000080000000-0x000000008003ffff M: (R,X) S/U: ()
Domain0 Region04          : 0x0000000000000000-0xffffffffffffffff M: () S/U: (R,W,X)
Domain0 Next Address      : 0x0000000000000000
Domain0 Next Arg1         : 0x0000000087e00000
Domain0 Next Mode         : S-mode
Domain0 SysReset          : yes
Domain0 SysSuspend        : yes

Boot HART ID              : 0
Boot HART Domain          : root
Boot HART Priv Version    : v1.12
Boot HART Base ISA        : rv64imafdch
Boot HART ISA Extensions  : sstc,zihpm,zicboz,zicbom,sdtrig,svadu
Boot HART PMP Count       : 16
Boot HART PMP Granularity : 2 bits
Boot HART PMP Address Bits: 54
Boot HART MHPM Info       : 16 (0x0007fff8)
Boot HART Debug Triggers  : 2 triggers
Boot HART MIDELEG         : 0x0000000000001666
Boot HART MEDELEG         : 0x0000000000f0b509
```

按 Ctrl-A 后按 X 退出。（后期卡住时都可以这么强制退出）

你可以 `sudo make install` 装到系统里，或者在开发目录下添加 `PATH` 环境变量。

## Debug

本项目 Debug 主要靠两种方法：gdb-multiarch 和打印 debug 法。因此可以装个 gdb-multiarch。

```bash
sudo apt install gdb-multiarch # 安装
qemu-system-riscv64 -nographic -kernel target/riscv64gc-unknown-none-elf/release/os -machine virt -s -S # debug 启动虚拟机并等待
gdb-multiarch -ex 'target remote localhost:1234' # debug
```

处理一些控制流怪异的疑难杂症时有奇效。建议 `Cargo.toml` 中添加

```toml
[profile.release]
debug = true
```

debug 更丝滑！

## VSCode

如果你和本书一样用的是 VSCode 开发，建议把 Workspace 里的 `rust-analyzer.cargo.allTargets` 设为 false。