# 额外工作

在实现更多事情之前，先做一些额外工作：


## log

我们不妨引入 log crate，实现内核日志输出，更方便我们 debug。

`logging.rs`
```rust
use log::{self, Level, LevelFilter, Log, Metadata, Record};

struct SimpleLogger;

impl Log for SimpleLogger {
    fn enabled(&self, _metadata: &Metadata) -> bool {
        true
    }
    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let color = match record.level() {
            Level::Error => 31, // Red
            Level::Warn => 93,  // BrightYellow
            Level::Info => 34,  // Blue
            Level::Debug => 32, // Green
            Level::Trace => 90, // BrightBlack
        };
        println!(
            "\u{1B}[{}m[{:>5}] {}\u{1B}[0m",
            color,
            record.level(),
            record.args(),
        );
    }
    fn flush(&self) {}
}

pub fn init() {
    static LOGGER: SimpleLogger = SimpleLogger;
    log::set_logger(&LOGGER).unwrap();
    log::set_max_level(match option_env!("LOG") {
        Some("ERROR") => LevelFilter::Error,
        Some("WARN") => LevelFilter::Warn,
        Some("INFO") => LevelFilter::Info,
        Some("DEBUG") => LevelFilter::Debug,
        Some("TRACE") => LevelFilter::Trace,
        _ => LevelFilter::Off,
    });
}
```

在编译时可以指定 LOG Level。这样就可以用 `info` `warn` 等 macro 轻松 debug 了。

## panic_handler

既然有了输出，不妨改进一下我们的 panic handler。

`main.rs`
```rust
pub fn shutdown(failure: bool) -> ! {
    use sbi_rt::{system_reset, NoReason, Shutdown, SystemFailure};
    if !failure {
        system_reset(Shutdown, NoReason);
    } else {
        system_reset(Shutdown, SystemFailure);
    }
    unreachable!()
}

#[panic_handler]
fn handle_panic(info: &core::panic::PanicInfo) -> ! {
    if let Some(location) = info.location() {
        println!(
            "[kernel] Panicked at {}:{} {}",
            location.file(),
            location.line(),
            info.message()
        );
    } else {
        println!("[kernel] Panicked: {}", info.message());
    }
    shutdown(true)
}
```

## BSS 段

在 C/Rust 中要求在程序运行时清零 BSS 段[^1]。其实在前面的 Rust 调用开始就应该清零，但是
Qemu 似乎会帮我们清零，所以运行没问题；但是为了兼容性我们还是清零吧：

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

我们有了栈，何不实现一个堆呢？


我们来实现一个最简单的内存管理模块。它预分配了一大块堆(4M)，维护着不同长度的指针列表。在 malloc 被调用时，若对应列表非空则直接出队返回；若空则从 heap 中“切”一块内存出来返回。在 free 时若能合并回 heap 则合并，不能则插入列表。

在 bss 段中加入 `.bss.heap` 部分：

```riscv
    .align 4
    .section .bss.heap
    .globl kernel_heap
    .globl kernel_heap_top
kernel_heap:
    .space 0x400000 # 4M
kernel_heap_top:
```

ldscript 中对应部分也需要修改。

```ldscript
. = ALIGN(4K);
.bss : {
    *(.bss.heap)
    *(.bss.stack)
    sbss = .;
    *(.bss .bss.*)
    *(.sbss .sbss.*)
    ebss = .;
}
```

然后是 Rust 部分实现。我们通过 `struct MallocMeta` 维护了：
- 堆的下限和上限
- 不同长度的指针列表。我们对 `1*8`-`8*8` 长度的指针各自一个列表；而对更大空间的指针长度做 log 2^(1/4) 上取整处理，这样空间利用率最坏为 84% 

```rust
const MLIST_LEN: usize = 48;

struct MallocMeta {
    cursor: usize,
    top: usize,
    mlist: [MallocPtr; MLIST_LEN],
}

static mut MALLOC_META: MallocMeta = unsafe{core::mem::zeroed()};

type MallocPtr = Option<core::ptr::NonNull<MallocPtrInner>>;

#[repr(transparent)]
struct MallocPtrInner {
    next: MallocPtr,
}

const fn size_to_index(sz: u32) -> (u32, u32) {
    if sz<=8 {(sz, sz)}
    else {
        let log2sz = sz.ilog2()-3;
        let mut id = [0,1,1,2,2,3,3,3][((sz>>log2sz)%8) as usize];
        if [8, 9, 11, 13][id]<<log2sz != sz {
            id+=1;
        }
        // 8, 9, 11, 13
        (8+log2sz*4 + id as u32, [8, 9, 11, 13][id]<<log2sz)
    }
}

pub fn init() {
    extern {
        fn kernel_heap();
        fn kernel_heap_top();
    }
    unsafe{
        MALLOC_META.cursor = kernel_heap as usize;
        MALLOC_META.top = kernel_heap_top as usize;
    }
}
```

然后是利用 `core::alloc::GlobalAlloc` trait 实现我们的 Global Allocator

```rust

use core::alloc::GlobalAlloc;

#[global_allocator]
static GLOBAL_ALLOC: RosAlloc = RosAlloc;
pub struct RosAlloc;
unsafe impl GlobalAlloc for RosAlloc {
    unsafe fn alloc(&self, layout: core::alloc::Layout) -> *mut u8 {
        let size = (layout.size()+7)/8;
        if size >= u32::MAX as usize { // too large
            return core::ptr::null_mut()
        }
        let (id, real_size) = size_to_index(size as u32);
        let real_size = real_size as usize*8;
        let id = id as usize;
        if id >= MLIST_LEN { // too large
            return core::ptr::null_mut()
        }
        match MALLOC_META.mlist[id] {
            None => {
                let ptr = MALLOC_META.cursor;
                let new_cursor = MALLOC_META.cursor + real_size;
                if new_cursor > MALLOC_META.top { // oom
                    return core::ptr::null_mut()
                }
                MALLOC_META.cursor = new_cursor;
                ptr as *mut u8
            },
            Some(ptr) => {
                MALLOC_META.mlist[id] = ptr.as_ref().next;
                ptr.as_ptr() as *mut u8
            }
        }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: core::alloc::Layout) {
        let size = (layout.size() as u32+7)/8;
        let id = size_to_index(size).0 as usize;
        if id >= MLIST_LEN { // too large
            panic!("unsupported pointer");
        }
        let ptr = ptr as *mut MallocPtrInner;
        (*ptr).next = MALLOC_META.mlist[id];
        MALLOC_META.mlist[id] = core::ptr::NonNull::new(ptr);
    }
}
```

当然真实实现会有更多合并、内存返还、升高 heap top、快速列表等操作，但我们这里就怎么简单怎么来。

## 后记

至此，我们已经配置好了环境，实现了最基本的内存分配和打印输出。我们的未来一片光明！

## References
[^1]: [Why do we have to clear bss in assembly? - Reddit](https://www.reddit.com/r/AskProgramming/comments/7r8scm/why_do_we_have_to_clear_bss_in_assembly/)
