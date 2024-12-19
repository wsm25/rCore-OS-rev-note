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

/// kernel print string macro
#[macro_export]
macro_rules! kprint {
    ($fmt: literal $(, $($arg: tt)+)?) => {{
        use ::core::fmt::Write;
        let _ = write!($crate::console::Stdout, $fmt $(, $($arg)+)?);
    }}
}

/// kernel println string macro
#[macro_export]
macro_rules! kprintln {
    ($fmt: literal $(, $($arg: tt)+)?) => {{
        use ::core::fmt::Write;
        let _ = writeln!($crate::console::Stdout, $fmt $(, $($arg)+)?);
    }}
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

> 这里启用了内核态的浮点单元。常规的内核中不会启用浮点，但我们为了方便还是启用他吧

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

设计内存区域如下（从 `0x40000000` 开始）：

| 区域 | 大小 | 作用 |
| - | - | - |
| [0, 0x7c000) | 496kB | 初始堆 |
| [0x7c000, 0x80000) | 16 kB | 内核栈 |
| [0x80000, 0x100000) | 512 kB | 内核代码 |
| [0x100000, 0x2000000) | 31 MB | 额外堆 |

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


## LateInit

> OnceCell 什么的补药口牙……

对于一些需要堆内存分配的对象，如果要成为全局变量似乎有点困难，因为 Rust static 变量要求编译时初始化，以保持 Rust 本身的 soundness；甚至在 nightly 所有 static mut 的方法调用都会报 `static_mut_refs`。从而诞生了一堆 OnceCell、OnceLock 之类的玩意，他们维护了一个额外的初始化状态，在第一次访问时进行初始化。很美好，可惜对于我们寸内存寸金的内核还是重了点（生成代码太多了！）。

C 一般的实现方式是允许未初始化的静态变量，而在程序最开始、未使用之前初始化，由编码者来保证 soundness。这显然与 safe Rust 要求相违背，但看着多诱人啊！更严苛的是，Rust 静态变量的可变访问都是 unsafe 的，这是由于多核可能产生竞争；但对于目前的单核硬件来说，这其实很 safe。

我们通过一个 `LateInit` 类允许这样的操作，绕过 Rust 的限制。

```rust
use core::{cell::UnsafeCell, mem::MaybeUninit};

/// late init cell
#[repr(transparent)]
pub struct LateInit<T> {
    inner: UnsafeCell<MaybeUninit<T>>
}

unsafe impl<T> Sync for LateInit<T> {}

impl<T> LateInit<T> {
    pub const fn uninit() -> Self {
        Self{inner: UnsafeCell::new(MaybeUninit::uninit())}
    }
    /// set cell into value. note that original value will not be dropped
    pub fn write(&self, val: T) {
        unsafe{(*self.inner.get()).write(val)};
    }
    /// drop inner value. its inner must have been initialized
    pub unsafe fn drop(&self) {
        (*self.inner.get()).assume_init_drop();
    }
    /// get pointer. note you should init it before dereference, and
    /// drop any generated reference immediately after use
    pub const fn get(&self) -> *mut T {
        unsafe{(*self.inner.get()).as_mut_ptr()}
    }
}
```

然后就可以通过 `LateInit::uninit()` 创建 static 变量，`LateInit::write(val)` 初始化变量，`LateInit::get()` 访问变量了。如果要追求 soundness 可以在程序退出时调用 `drop`。

## uninit

`core::mem::uninitialized` 已经弃用了，我们做一个它：

```rust
pub unsafe fn uninit<T>() -> T {
    let x = core::mem::MaybeUninit::uninit();
    x.assume_init()
}
```

## 后记

至此，我们已经配置好了环境，实现了最基本的内存分配和打印输出。我们的前途一片光明啊（赞赏）！

btw 当前指令数已经到了 2.2k，总大小 9.0kB ；对于内核而言是很小的，但是某些单片机已经放不下了。究其原因 (`cargo bloat`) 是 `memcpy` 和 `core::fmt` 就要占掉 4kB 代码；`talc` crate 也要 2kB 空间；再加上 panic 的 debug message 巨多，因而占用空间巨大。Rust 这是为了性能和便利而牺牲空间啊！

如果要放到单片机上，建议开 [`build-std`](https://doc.rust-lang.org/cargo/reference/unstable.html#build-std) 选项，用 thumb 指令集，实测能把总大小压到 4kB。

