# Hello, World!

终于我们来到了~~万恶之源~~ Hello World！

## 极简版

心急吃不了热豆腐，我们从最简单的版本开始：

运行 `cargo new os` 新建一个名为 os 的 binary 项目。

`src/main.rs`
```rust
#![no_std]
#![no_main]

core::arch::global_asm!("
    .section .text.entry
    .globl _start
_start:
    li a7, 0x53525354 # Extension ID: System Reset 
    li a6, 0 # Function ID: System Reset
    li a0, 0 # Reset Type: System Shutdown
    li a1, 0 # Reset Reason: No Reason
    ecall
");

#[panic_handler]
fn handle_panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
```

是很朴素的 no_std Rust。首先它 `#![no_std]` `#![no_main]` 小连招去除了编译器默认带的 rust 标准库
（毕竟我们内核环境可没有堆内存/网络文件接口），并去除了 main 函数依赖，因为我们要用链接器和汇编手动定义入口。

然后它用一个 `global_asm` 写了一小段汇编，调用了关机的 SBI ecall。

[RISC-V SBI](https://github.com/riscv-non-isa/riscv-sbi-doc/)
是 RISC-V 特有的 Suprtvisor 接口集。它定义了一系列一个 RISC-V firmware 应该实现的 ecall。

现在只要暂时认为我们用到的 ecall 是宿主机和虚拟机之间的桥梁就行。这里就用到了
[System Reset Extension](https://github.com/riscv-non-isa/riscv-sbi-doc/blob/master/src/ext-sys-reset.adoc)，
实现了虚拟机的关机/宿主程序的结束。

后面是一个 `panic_handler`，这是 Rust no_std 程序必要的一部分，以处理异常；这里就先死循环了，反正用不到。

当然，现在编译产物还是没法运行的。首先，我们要让入口点指向 `_start`；其次，在 QEMU 里只有 `0x80000000`
之后的空间是可用的，因此我们要让链接器把所有东西的绝对地址放在 `0x80000000` 之后且不能和 bios
重叠。我们就选国际惯例的 `0x80200000` 入口了。

这可以通过 ldscript 实现：

`src/link-qemu.ld`
```ld
OUTPUT_ARCH(riscv)
ENTRY(_start)
BASE_ADDRESS = 0x80200000;

SECTIONS
{
    . = BASE_ADDRESS;
    skernel = .;

    stext = .;
    .text : {
        *(.text.entry)
        *(.text .text.*)
    }

    . = ALIGN(4K);
    etext = .;
    srodata = .;
    .rodata : {
        *(.rodata .rodata.*)
        *(.srodata .srodata.*)
    }

    . = ALIGN(4K);
    erodata = .;
    sdata = .;
    .data : {
        *(.data .data.*)
        *(.sdata .sdata.*)
    }

    . = ALIGN(4K);
    edata = .;
    .bss : {
        *(.bss.stack)
        sbss = .;
        *(.bss .bss.*)
        *(.sbss .sbss.*)
    }

    . = ALIGN(4K);
    ebss = .;
    ekernel = .;

    /DISCARD/ : {
        *(.eh_frame)
    }
}
```

为了避免每次编译的时候手动指定编译工具链和链接脚本，为了我们身心健康着想，再加入以下文件：

`.cargo/config.toml`
```toml
[build]
target = "riscv64gc-unknown-none-elf"

[target.riscv64gc-unknown-none-elf]
rustflags = ["-Clink-arg=-Tsrc/link-qemu.ld"]
```

如果碰到版本兼容问题，可以设定本书使用的 toolchain（可选）

`rust-toolchain.toml`
```toml
[toolchain]
profile = "minimal"
channel = "stable-2024-10-15"
targets = ["riscv64gc-unknown-none-elf"]
```

至此文件树如下：

```txt
.
├── .cargo
│   └── config.toml
├── Cargo.toml
└── src
    ├── link-qemu.ld
    └── main.rs
```

`cargo build -r`，编译成功！

`qemu-system-riscv64 -nographic -kernel target/riscv64gc-unknown-none-elf/release/os -machine virt`
运行，虚拟机没有卡住而是直接结束，运行成功！

启动过程具体发生了什么不在本书讨论范围内；若感兴趣可以参考 [RISC-V SBI and the full boot process](https://popovicu.com/posts/risc-v-sbi-and-full-boot-process/) 和 [原书](https://rcore-os.cn/rCore-Tutorial-Book-v3/chapter1/4first-instruction-in-kernel2.html#id5)。（这里指定了 `-machine virt` 因为实测在默认 ucbbar,spike-bare 下关不了机）

## 真 · Hello World

然而上面的例子过于草率：只有一个关机，啥都做不了。其次，里面只有纯粹的汇编，无法用上
Rust。更重要的是，说好的 hello, world，至少要按照国际惯例看到 "hello, world" 内容吧！

我们先实现 Rust 调用。

### Rust 调用

实现想法很简单：设置好（内核）栈空间，然后调用 `rust_main`。我们在汇编里分配好栈空间供函数使用 (64K)：

`entry.asm`
```riscv
    .section .text.entry
    .globl _start
_start:
    la sp, boot_stack_top
    call rust_main

    .section .bss.stack
    .globl boot_stack_lower_bound
boot_stack_lower_bound:
    .space 4096 * 16
    .globl boot_stack_top
boot_stack_top:
```

然后写 Rust
`main.rs`

```rust
use core::arch::{global_asm, asm};

global_asm!(include_str!("entry.asm"));

#[no_mangle]
pub fn rust_main() -> ! {
    let (a7, a6, a0, a1) = (0x53525354, 0, 0, 0);
    unsafe{asm!(
        "ecall", in("a7") a7, in("a6") a6, in("a0") a0, in("a1") a1,
        options(noreturn)
    )}
}
```

终于是用上 Rust 了！只是功能还是和之前完全一样，只有一个关机。不过有 Rust 了就可以开心地调包调函数了。

上面用内联汇编实现了 sbi 调用；更好的做法是引用 `sbi_rt`，它是对 risc-v sbi 的 Rust 包装。
`cargo add sbi_rt`，就可以使用它了。

```rust
#[no_mangle]
pub fn rust_main() -> ! {
    sbi_rt::system_reset(sbi_rt::Shutdown, sbi_rt::NoReason);
    unreachable!()
}
```

### 输出

riscv sbi 提供了 console debug 接口，对于虚拟机环境调试尤其有用；后期我们将强依赖于该功能调试。

这里就直接放出我们包装的 console 模块：

`console.rs`
```rust
//! SBI console driver, for text output

use core::fmt::{self, Write};

struct Stdout;

impl Write for Stdout {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        let s = sbi_rt::Physical::new(s.len(), s.as_ptr() as usize, 0);
        match sbi_rt::console_write(s).is_err() {
            false => Ok(()),
            true  => Err(fmt::Error)
        }
    }
}

pub fn print(args: fmt::Arguments) {
    Stdout.write_fmt(args).unwrap();
}

/// print string macro
#[macro_export]
macro_rules! print {
    ($fmt: literal $(, $($arg: tt)+)?) => {
        $crate::console::print(format_args!($fmt $(, $($arg)+)?));
    }
}

/// println string macro
#[macro_export]
macro_rules! println {
    ($fmt: literal $(, $($arg: tt)+)?) => {
        $crate::console::print(format_args!(concat!($fmt, "\n") $(, $($arg)+)?));
    }
}
```

可以看到，我们基于 `console_write` 接口实现了一个 `core::fmt::Write` 的 `Stdout`；
Rust 会帮助我们利用它实现 `write_fmt`，从而实现 `print` 和 `println` 宏。

p.s. 实测 rCore-OS 项目提供的旧版 rustsbi 不支持 `console_write`；只能用旧版的逐字符输出。

终于可以实现我们的真 · Hello World 了：

`main.rs`
```rust
#[macro_use]
mod console;

#[no_mangle]
pub fn rust_main() -> ! {
    println!("Hello, world!");
    sbi_rt::system_reset(sbi_rt::Shutdown, sbi_rt::NoReason);
    unreachable!()
}
```

再 `cargo build -r && qemu-system-riscv64 -nographic -kernel target/riscv64gc-unknown-none-elf/release/os -machine virt` 丝滑小连招运行，输出了 "Hello, world!"；可喜可贺，可喜可贺！

你也可以试试 utf8，实测是支持的（只要终端支持）。
