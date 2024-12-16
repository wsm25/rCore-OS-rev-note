# 额外工作

在实现更多事情之前，先做一些额外工作。

## 格式化输出

我们来实现 `kprint` 和 `kprintln` 宏。

`console.rs`
```rust
pub struct Stdout;

impl core::fmt::Write for Stdout {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        puts(s);
        Ok(())
    }
}

/// print string macro
#[macro_export]
macro_rules! kprint {
    ($fmt: literal $(, $($arg: tt)+)?) => {
        use ::core::fmt::Write;
        write!($crate::console::Stdout, $fmt $(, $($arg)+)?).unwrap()
    }
}

/// println string macro
#[macro_export]
macro_rules! kprintln {
    ($fmt: literal $(, $($arg: tt)+)?) => {
        use ::core::fmt::Write;
        writeln!($crate::console::Stdout, $fmt $(, $($arg)+)?).unwrap()
    }
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
```

`main.rs`
```rust
#![no_std]
#![no_main]

// entry
core::arch::global_asm!("
    .section .text.entry
    .globl _start
_start:
    // enable fpu
    mrs x1, cpacr_el1
    orr x1, x1, #(3<<20)
    msr cpacr_el1, x1
    isb

    mov x1, #0x40080000
    mov sp, x1
    b rust_main
");

#[no_mangle]
pub fn rust_main(_: usize) -> ! {
    let x=1;
    panic!("Hello, Rust!🎉, {x:#x}");
}

#[macro_use]
mod console;

fn shutdown() -> ! {
    unsafe{core::arch::asm!("hvc #0", in("w0") 0x84000008u32, options(noreturn))};
}

#[panic_handler]
fn handle_panic(info: &core::panic::PanicInfo) -> ! {
    if let Some(location) = info.location() {
        kprintln!(
            "Kernel Panicked at {}:{} {}",
            location.file(),
            location.line(),
            info.message()
        );
    } else {
        kprintln!("Kernel Panicked: {}", info.message());
        
    }
    shutdown();
}
```

> 这里启用了内核态的浮点单元。常规的内核中不会启用浮点，但我们为了 debug 方便还是启用他吧

输出 `Kernel Panicked at src/main.rs:23 Hello, Rust!🎉, 0x1`

## BSS 段

在 C/Rust 中默认在程序运行时 BSS 段为 0；而在启动时内存的状态未知，我们需要自己清零。

`main.rs`
```rust
pub fn clear_bss() {
    extern "C" {
        fn sbss(); // start addr of BSS segment
        fn ebss(); // end addr of BSS segment
    }
    let bss_slice = unsafe{core::slice::from_raw_parts_mut(
        sbss as *mut u8, 
        ebss as usize - sbss as usize
    )};
    bss_slice.fill(0);
}
```

## 堆内存分配

设计内存 Layout 如下（从 `0x40000000` 开始）：
| 区域 | 大小 | 作用 |
| - | - | - |
| [0, 0x7c000) | 496kB | 初始堆 |
| [0x7c000, 0x80000) | 16kB | 内核栈 |
| [0x80000, 0x100000) | 512kB | 内核代码 |
| [0x100000, 0x2000000) | 31.5MB | 额外堆 |

我们基于 [talc](https://github.com/SFBdragon/talc) 实现堆。
`Cargo.toml`
```toml
[dependencies]
talc = { version = "4.4", default-features = false }
```

`mem.rs`
```rust
use talc::*;

static mut ALLOC_IMPL: Talc<ClaimOnOom> = unsafe{Talc::new(ClaimOnOom::new(Span::empty()))};

pub fn init() {
    let base = 0x40000000 as *mut u8;
    let span1 = (0, 0x7c000);
    let span2 = (0x100000, 0x2000000);
    unsafe{
        let _ = ALLOC_IMPL.claim(Span::new(base.add(span1.0), base.add(span1.1)));
        ALLOC_IMPL.oom_handler = ClaimOnOom::new(Span::new(base.add(span2.0), base.add(span2.1)));
    };
}

#[global_allocator]
static ALLOC: Alloc = Alloc;

struct Alloc;
unsafe impl core::alloc::GlobalAlloc for Alloc {
    unsafe fn alloc(&self, layout: core::alloc::Layout) -> *mut u8 {
        ALLOC_IMPL.malloc(layout).expect("out of memory").as_ptr()
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: core::alloc::Layout) {
        ALLOC_IMPL.free(core::ptr::NonNull::new_unchecked(ptr), layout);
    }
}
```

`main.rs`
```rust
#[no_mangle]
pub fn rust_main(_: usize) -> ! {
    clear_bss();
    mem::init();
    let x = "Hello, Rust!🎉".to_owned();
    kprintln!("{x} @ {:#x}", x.as_ptr() as usize);
    shutdown();
}
```

输出 `Hello, Rust!🎉 @ 0x40000410`。可以通过 `extern crate alloc` 使用 `Box`, `Vec` 等动态分配内存的容器啦！

## 后记

至此，我们已经配置好了环境，实现了最基本的内存分配和打印输出。我们的未来一片光明！

btw 当前指令数已经到了 2.2k，总大小 13.2kB ；对于内核而言是很小的，但是某些单片机已经放不下了。究其原因 (`cargo bloat`) 是 `memcpy` 和 `core::fmt` 就要占掉 5kB 代码；再加上 panic 的 debug message 巨多，因而占用空间巨大。Rust 这是为了性能和便利而牺牲空间啊！
