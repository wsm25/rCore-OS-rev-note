# Hello, World!

终于我们来到了~~万恶之源~~ Hello World！

## 设备初窥

一个合格的 Hello World 程序需要做哪些事？当然是打印 "Hello, world" 然后退出！这涉及两个外设操作。一个是“打印”，一个是关机。

我们要用到的有两个设备。一个是 PL011，它是一个 arm 的 uart 串口设备，本机上基地址在 `0x9000000`，直接映射到 qemu 的控制台输入输出。我们暂时认为只要写入这个地址就可以输出。一个是一个 `psci` 设备，它是 arm 电源控制设备，通过 `hvc` 指令即 hypervisor call 使用。

> 可以通过 Device Tree Blob (DTB) 看看我们的系统有哪些设备：
> 
> ```bash
> qemu-system-aarch64 -M virt-9.1,dumpdtb=virt.dtb -cpu cortex-a53 -nographic
> dtc -I dtb -O dts virt.dtb -o virt.dts
> ```
> 
> 如果你发现在你的 qemu 上无法实现对应设备操作，可以尝试看 dts 文件找到对应设备，其中会说明设备的使用方式。我们在后面也会实现 DTB 的动态解析。

## 手工版

我们先只用汇编和编译器写一个 Hello World，熟悉一下编译流程。

首先是汇编源文件

`hello.s`
```arm
.section .rodata
msg:
    // Hello, world!🎉
    .asciz "Hello, world!\xF0\x9F\x8E\x89\n"

// 入口
.section .text
.global _start
_start:
    mov x0, 0x9000000   // PL011 UART 基地址
    adr x1, msg         // 通过相对取址获得字符串地址
print_loop:
    ldrb w2, [x1], #1   // 读一个字符，增加 x1 Load one byte and increment x1
    cbz w2, exit        // 如果字符为 `\0` 就跳转到 `exit`
    strb w2, [x0]       // 向 UART 写一个字符
    b print_loop        // 循环
exit:
    ldr x0, =0x84000008 // PSCI SYSTEM_OFF 调用
    hvc #0              // Hypervisor Call
```

然后编译运行

```bash
# 汇编编译成二进制
aarch64-linux-gnu-as -ohello.o hello.s
# 二进制链接，指定入口
aarch64-linux-gnu-ld -e _start -ohello.elf hello.o
# 以 elf 文件为 kernel 启动
qemu-system-aarch64 -M virt -cpu cortex-a53 -nographic -kernel hello.elf
```

此时理应可以看到输出 `Hello, world!🎉` 字符串并退出。

当然，此时我们用的是加载 elf 的方式启动的，qemu 会把此时的内核当作一个野鸡内核；只有传入一个非 elf 文件 qemu 才会认为我们给他的是 Linux 内核，然后以 Linux 的方式启动。二者区别是 Linux 要求 `x0` 设为 dtb 头指针，而 qemu 加载野鸡内核会把 `x0` 设为 0。可以用下面的代码判断：

```arm
.section .text
.global _start
_start:
    mov x2, #0x9000000
    cmp x0, #0
    cset w1, ne
    add w1, w1, #48 // '0'
    strb w1, [x2]
    ldr x0, =0x84000008
    hvc #0
```

目前的流程会输出 0。要输出 1，需要用 `objcopy` 把 elf 变成 binary 文件：

```bash
aarch64-linux-gnu-objcopy -O binary hello.elf hello.bin
qemu-system-aarch64 -M virt -cpu cortex-a53 -nographic -kernel hello.bin
```

就能输出 1 啦！当然现在的 bin 文件还不符合 Linux kernel image [标准](https://docs.kernel.org/arch/arm64/booting.html)，以后再说！

## Rust 版

运行 `cargo new os` 新建一个名为 os 的 binary 项目。

`src/main.rs`
```rust
#![no_std]
#![no_main]

// entry
core::arch::global_asm!("
    .section .text.entry
    .globl _start
_start:
    mov x1, #0x40080000
    mov sp, x1
    b rust_main
");

#[no_mangle]
pub fn rust_main(_: usize) -> ! {
    puts("Hello, Rust!🎉\n");
    shutdown();
}

pub fn puts(b: &str) {
    let b = b.as_bytes();
    let uart0: *mut u8 = 0x09000000 as _; // UART0 base address (QEMU default for PL011 UART)
    for ch in b {
        // Volatile operations are intended to act on I/O memory, and 
        // are guaranteed to not be elided or reordered by the compiler
        // across other volatile operations.
        unsafe{uart0.write_volatile(*ch);}
    }
}

fn shutdown() -> ! {
    unsafe{core::arch::asm!("hvc #0", in("w0") 0x84000008u32, options(noreturn))};
}

#[panic_handler]
fn handle_panic(_: &core::panic::PanicInfo) -> ! {
    puts("kernel panic!!!\n");
    shutdown()
}
```

是很朴素的 no_std Rust。首先它 `#![no_std]` `#![no_main]` 小连招去除了 rust 标准库（毕竟我们内核环境可没有系统调用），并去除了 main 函数依赖，因为我们要用链接器和汇编手动定义入口。

然后是一小段 `global_asm` 全局汇编，设置栈空间然后直接跳转到 `rust_main`，在此之前可没有栈。我们硬编码一个 `0x40080000` 作为栈顶，因为在 qemu virt 中 `0x40080000` 到 `0x40080000` 都是未使用的自由内存；`0x40080000` 往后 QEMU 加载了内核二进制文件。

后面是一个 `panic_handler`，这是 Rust no_std 程序必要的一部分，以处理异常。

当然，现在编译产物还是没法运行的。因为它没有指定入口，同时我们也显然没实现 [基地址修正](https://xinqiu.gitbooks.io/linux-insides-cn/content/Initialization/linux-initialization-1.html#修正页表基地址)，所以得硬编码 QEMU 上的基地址 `0x40080000`。这都是链接器的事，可以通过一个链接脚本进行：

`link-qemu.ld`
```ld
OUTPUT_ARCH(aarch64)
ENTRY(_start)
BASE_ADDRESS = 0x40080000;

SECTIONS
{
    . = BASE_ADDRESS;
    skernel = .;
    .text : {
        *(.text.entry)
        *(.text .text.*)
    }

    . = ALIGN(4K);
    .rodata : {
        *(.rodata .rodata.*)
        *(.srodata .srodata.*)
    }

    . = ALIGN(4K);
    .data : {
        *(.data .data.*)
        *(.sdata .sdata.*)
    }

    . = ALIGN(4K);
    .bss : {
        *(.bss.heap)
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

为了我们身心健康着想，再加入以下文件：

`.cargo/config.toml`
```toml
[build]
# 指定目标架构
target = "aarch64-unknown-none"

[target.aarch64-unknown-none]
# 指定链接脚本
rustflags = ["-Clink-arg=-Tlink-qemu.ld"]
```

`Makefile`
```Makefile
.PHONY: run clean

TDIR = target/aarch64-unknown-none/release
QEMU_OPT = -M virt-9.1 -cpu cortex-a53 -nographic -m 32M

os: src/*
	cargo build -r
	aarch64-linux-gnu-objcopy -O binary $(TDIR)/os $(TDIR)/os.bin
run: os
	qemu-system-aarch64 $(QEMU_OPT) -kernel $(TDIR)/os.bin $(QEMU_FLASH)
clean:
	cargo clean
```

目前文件结构：

```txt
.
├── src
│   └── main.rs
├── link-qemu.ld
├── Makefile
├── Cargo.toml
```

从而可以 `make run` 丝滑运行！

## 小思考题

1. 手工版汇编为什么用 `ldr x0, =0x84000008` 而非 `mov x0, #0x84000008` 呢？有没有更好的做法？
2. 为什么 `puts` 中用了 `core::ptr::write_volatile`？直接解指针会发生什么？
3. 上面哪些部分是破坏兼容性的？兼容的做法是什么？
