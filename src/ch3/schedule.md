# 任务切换

我们来着手实现一个支持 `spawn`, `yield` 和 `exit` 的多任务系统。

## 结构定义和内存管理

一个任务需要哪些内存？一个正在执行或者 yield 的任务需要一个栈空间，还有一份上下文；而尚未执行的任务只需要其入口。

初步定义 Task 如下：

```rust
#[repr(C)]
pub struct TaskContext {
    x: [usize;12],
    sp: usize,
}

#[repr(C)]
pub struct Task {
    stack: [u128; 256], // 4k, 16B aligned stack in default
    context: TaskContext,
}
```

我们用一个循环队列来储存任务列表。

```rust
pub enum TaskHandle {
    Pending{ entry: fn() },
    Yield{ task: Box<Task> },
}

static TASK_QUEUE: LateInit<VecDeque<TaskHandle>> = LateInit::uninit();
fn tq<'a>() -> &'a mut VecDeque<TaskHandle> {
    unsafe{&mut (*TASK_QUEUE.get())}
}
```

最后，还需要一个记录当前任务的变量，方便切入切出。

```rust
static CURRENT_TASK: LateInit<Box<Task>> = LateInit::uninit();
fn ct<'a>() -> &'a mut Box<Task> {
    unsafe{&mut (*CURRENT_TASK.get())}
}
```

万事俱备，只需开始实现！


## 实现 spawn

spawn 是多任务的开始。它的功能是把一个任务插入任务列表中。

```rust
pub fn spawn(entry: fn()) {
    tq().push_back(TaskHandle::Pending { entry });
}
```

轻松写意！

## 实现 yield

yield 是本章节最核心的功能。它的功能就是让目前的任务暂停，把 cpu 让给其他任务。具体流程就是把当前上下文和下个任务的上下文互换。

上一章分析过，“切任务”关键在于上下文尤其是 `x30` 寄存器；我们的实现要非常仔细地处理它，并时刻提醒自己：`__switch` 之后的上下文完全不同了，此后的代码会在再次切回来时才会执行到。

让我们逐步实现它。

```rust
pub fn task_yield() {
    use TaskHandle::*;
    match tq().pop_front() { 
        None => {
            // no more task, spin and continue
            core::hint::spin_loop();
        }
        Some(Pending { entry }) => {
            unimplemented!()
        },
        Some(Yield { task }) => {
            unimplemented!()
        }
    }
}
```

我们从队列中取一个任务，匹配他，然后做不同的处理。

这里已经处理了没有其他任务的情况——啥都不做！当然为了允许一些情况用户利用 `yield` 做自旋，我们用了 `core::hint::spin_loop` 来稍微暂停一下（如停）。

接下来都是未实现的部分了。不妨先来看较为容易的 yield task。由于它同属于 yield 暂停的任务，只要简单切换一下上下文就行了。

```rust
let mut old_task = core::mem::replace(ct(), task);
let old_ctx = (&mut old_task.context) as *mut _;
let ctx = &ct().context;
tq().push_back(Yield { task: old_task });
unsafe{__switch(old_ctx, ctx)}
```

浅显易懂！不过这里 `old_ctx` 是一个 reference after move，但是我们这里的 `context` 是 Boxed value，可以认为是 [pinned](https://doc.rust-lang.org/std/pin/)，因此是一个正确的引用；同时我们的的流程中一个 task 只有在 exit 的时候才会 drop，所以引用的内存也不会 dealloc。因此这一个暂时的 reference after move 是合法的。

最后是较为麻烦的 pending task：它还没有上下文！我们得造一个上下文出来切到它。

```rust
let mut task = Box::new(unsafe{uninit::<Task>()});
task.context.sp = (&mut task.context) as *mut _ as usize;
task.context.x[11] = entry as usize; // x30
```

这里最值得深思的是 `x30` 寄存器：对于一个 yield context，其中 `x30` 应该是对应任务在 yield 之前调用 `__switch` 函数时的 PC+4，这样切换回来时会回到 `task_yield` 调用内；而我们新建的上下文却是直接把 `x30` 设为 entry，切换后直接到了 `entry` 地址；这看起来有点不对称，读者可以思考有没有更优美的做法。

其他流程就和 yield task 一样啦。

最终完整实现如下：

```rust
pub fn task_yield() { unsafe {
    use TaskHandle::*;
    let next_id = match TASK_SCHEDULE.pop_front() { 
        None => { // spin rather than switch context
            core::hint::spin_loop();
            return;
        } 
        Some(Pending { entry }) => {
            let mut task = Box::new(unsafe{uninit::<Task>()});
            task.context.sp = (&mut task.context) as *mut _ as usize;
            task.context.x[11] = entry as usize; // x30
            task
        },
        Some(Yield { task }) => task
    };
    let mut old_task = core::mem::replace(ct(), task);
    let old_ctx = (&mut old_task.context) as *mut _;
    tq().push_back(Yield { task: old_task });
    // reference after move: only drop when exit is called
    unsafe{__switch(old_ctx, &ct().context)}
}}
```

不算太难！

## 实现 exit

exit 其实和 yield 差不多，就是当前任务的上下文直接不要了，切到下一个任务。我们要创建一个 context 作为“垃圾桶”（如果沿用 `ct().context` 会发生什么？）

```rust
pub fn task_exit() -> ! { unsafe {
    use TaskHandle::*;
    unsafe{core::ptr::drop_in_place(ct())};
    let next_id = match TASK_SCHEDULE.pop_front() { 
        None => { // spin rather than switch context
            core::hint::spin_loop();
            return;
        } 
        Some(Pending { entry }) => {
            let mut task = Box::new(unsafe{uninit::<Task>()});
            task.context.sp = (&mut task.context) as *mut _ as usize;
            task.context.x[11] = entry as usize; // x30
            task
        },
        Some(Yield { task }) => task
    };
    unsafe{core::ptr::write(ct(), task)};
    // drop(core::mem::replace(ct(), task)); // why not replace 2 unsafe ptr operation with this line?
    unsafe{__switch(&mut uninit(), &ct().context)};
    unreachable!()
}}
```

## 最终文件

`task.rs`
```rust
use alloc::{boxed::Box, collections::vec_deque::VecDeque};
use crate::utils::{LateInit, uninit};

static TASK_QUEUE: LateInit<VecDeque<TaskHandle>> = LateInit::uninit();
static CURRENT_TASK: LateInit<Box<Task>> = LateInit::uninit();

pub fn init() {
    TASK_QUEUE.write(VecDeque::new());
    CURRENT_TASK.write(Box::new(unsafe{uninit()}));
}

pub fn yield_() {
    use TaskHandle::*;
    let Some(task) = next_task() else {
        core::hint::spin_loop();
        return;
    };
    let mut old_task = core::mem::replace(ct(), task);
    let old_ctx = (&mut old_task.context) as *mut _;
    tq().push_back(Yield { task: old_task });
    // reference after move: only drop when exit is called
    unsafe{__switch(old_ctx, &ct().context)}
}

pub fn spawn(entry: fn()) {
    tq().push_back(TaskHandle::Pending { entry });
}

fn next_task() -> Option<Box<Task>> {
    use TaskHandle::*;
    tq().pop_front().map(|t| match t {
        Pending { entry } => {
            let mut task = Box::new(unsafe{uninit::<Task>()});
            task.context.sp = (&mut task.context) as *mut _ as usize;
            task.context.x[11] = entry as usize;
            task
        },
        Yield { task } => task
    })
}

pub fn exit() -> ! {
    unsafe{core::ptr::drop_in_place(ct())};
    let Some(task) = next_task() else {
        kprintln!("No more tasks to do, shutdowning...");
        crate::utils::shutdown();
    };
    unsafe{core::ptr::write(ct(), task)};
    // drop(core::mem::replace(ct(), task));
    unsafe{__switch(&mut uninit(), &ct().context)};
    unreachable!()
}

fn tq<'a>() -> &'a mut VecDeque<TaskHandle> {
    unsafe{&mut (*TASK_QUEUE.get())}
}

fn ct<'a>() -> &'a mut Box<Task> {
    unsafe{&mut (*CURRENT_TASK.get())}
}

pub enum TaskHandle {
    Pending{ entry: fn() },
    Yield{ task: Box<Task> },
}

#[repr(C)]
pub struct TaskContext {
    x: [usize;12],
    sp: usize,
}

#[repr(C)]
pub struct Task {
    stack: [u128; 244],
    context: TaskContext,
}

extern "C" { fn __switch(old: *mut TaskContext, new: *const TaskContext); }
core::arch::global_asm!("
    .section .text
    .globl __switch
__switch:
    stp x19, x20, [x0, #0]
    stp x21, x22, [x0, #16]
    stp x23, x24, [x0, #32]
    stp x25, x26, [x0, #48]
    stp x27, x28, [x0, #64]
    stp x29, x30, [x0, #80]
    mov x2, sp
    str x2, [x0, #96]
    ldr x2, [x1, #96]
    mov sp, x2
    ldp x19, x20, [x1, #0]
    ldp x21, x22, [x1, #16]
    ldp x23, x24, [x1, #32]
    ldp x25, x26, [x1, #48]
    ldp x27, x28, [x1, #64]
    ldp x29, x30, [x1, #80]
    ret
");
```

## 测试

写完了！总共 100 行出头，短小精悍！

`main.rs`
```rust
#[no_mangle]
pub fn rust_main(_: usize) -> ! {
    utils::clear_bss();
    mem::init();
    task::init();
    test::main();
}
```

`test.rs`
```rust
use crate::task::*;

pub fn main() -> ! {
    macro_rules! spawn_all {
        ($($f:ident),*) => {$(spawn($f);)*};
    }
    spawn_all!(task1, task2, task3);
    exit();
}

fn task1() {
    kprintln!("[task1] Greet from before yield");
    yield_();
    kprintln!("[task1] Greet from after yield");
}

fn task2() {
    kprintln!("[task2] Greet from before yield");
    yield_();
    kprintln!("[task2] Greet from after yield (spawn task 3!)");
    spawn(task3);
    yield_();
    kprintln!("[task2] Greet from after another yield");
}

fn task3() {
    kprintln!("[task3] Greeeeeet!");
}
```

输出...诶怎么死循环了！一直输出 `[task3] Greeeeeet!`！解决方法就是每个 task 最后加上 `exit()`。读者可以思考一下为什么会反复输出 `task3` 内容。

改完，输出

```txt
[task1] Greet from before yield
[task2] Greet from before yield
[task3] Greeeeeet!
[task1] Greet from after yield
[task2] Greet from after yield (spawn task 3!)
[task3] Greeeeeet!
[task2] Greet from after another yield
No more tasks to do, shutdowning...
```

## 后记

当然，目前设计还有不少问题
- OOM 时会 panic 而是非跳到下一个 yield 任务
- 栈空间为固定的 4k，而且没有检查 stack overflow，可能会写坏其他上下文
- 任务需要自行负责 `yield` 和 `exit`

