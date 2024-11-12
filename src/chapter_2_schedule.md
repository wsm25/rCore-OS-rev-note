# 任务切换

我们来着手实现一个支持 `spawn`, `yield` 和 `exit` 的多任务系统。

## 结构定义和内存管理

一个任务需要哪些内存？一个正在执行或者 yield 的任务需要一个栈空间，还有一份上下文；而尚未执行的任务只需要其入口。

初步定义 Task 如下：

```rust
pub enum Task {
    Pending{ entry: fn() },
    Yield{ id: usize },
}
```

我们用一个循环队列来储存任务列表。

```rust
const MAX_TASKS: usize = 64;
static mut TASK_SCHEDULE: heapless::Deque<Task, MAX_TASKS> = heapless::Deque::new();
```

> 这里用到了 [`heapless`](https://crates.io/crates/heapless) 库。它是一个静态分配空间的容器 (collection) 库。由于动态分配的容器在生命周期管理上十分令人头痛，因此我们采用不需要动态初始化、不需要销毁的静态容器。

上面任务定义中的 `id` 唯一对应一个静态的 Task Storage 块：

```rust
pub struct TaskStorage {
    occupied: bool,
    context: TaskContext,
    stack: Stack<STACK_SIZE>,
}
#[repr(align(16))]
pub struct Stack<const N: usize> ([u8;N]);
impl<const N: usize> Stack<N> {
    pub fn stack_top(&self)->usize {
        unsafe{self.0.as_ptr().add(N) as usize}
    }
}

const MAX_RUNNING_TASKS: usize = 4;
const STACK_SIZE: usize = 0x2000-0x80; // 8k storage block

static mut TASK_STORAGE: [TaskStorage; MAX_RUNNING_TASKS] = unsafe{core::mem::zeroed()};
```

对于分配到 `id` 的任务，其对应储存为 `TASK_STORAGE[id]`。我们通过 `occupied` field 来确定哪些块被使用了。

最后，还需要一个记录当前任务的变量，为了方便切入切出。

```rust
static mut CURRENT_ID: usize = 0;
```

万事俱备，只需开始实现！

（p.s. 由于我们用的全是 `static mut` 变量所以会显得很多 unsafe；但其实在单核下超级 safe）

## 实现 spawn

spawn 是多任务的开始。它的功能是把一个任务插入任务列表中。

```rust
pub fn task_spawn(entry: fn()) {
    unsafe {
        TASK_SCHEDULE.push_back(Task::Pending { entry })
            .unwrap_or_else(|_|panic!("Task list full!"));
    }
}
```

轻松写意！

## 实现 yield

yield 是本章节最核心的功能。它的功能就是让目前的任务暂停，把 cpu 让给其他任务。具体流程就是把当前上下文和下个任务的上下文互换。

上一章分析过，“切任务”关键在于上下文尤其是 `ra` 寄存器；我们的实现要非常仔细地处理它，并时刻提醒自己：`__switch` 之后的上下文完全不同了，此后的代码会在再次切回来时才会执行到。

让我们逐步实现它。

```rust
pub fn task_yield() { unsafe {
    use Task::*;
    match TASK_SCHEDULE.pop_front() { 
        None => {
            core::hint::spin_loop();
            return;
        }
        Some(Pending { entry }) => {
            unimplemented!()
        },
        Some(Yield { id }) => {
            unimplemented!()
        }
    }
}}
```

这里为了 ~~偷懒~~ 简洁用 unsafe 把整个函数包了起来。

我们从队列中取一个任务，匹配他，然后做不同的处理。

这里已经处理了没有其他任务的情况——啥都不做！当然为了允许一些情况用户利用 `yield` 做自旋，我们用了 `core::hint::spin_loop` 来稍微暂停一下（如停）。

接下来都是未实现的部分了。不妨先来看较为容易的 yield task。由于它同属于 yield 暂停的任务，只要简单切换一下上下文就行了。

```rust
let current_id = CURRENT_ID;
let current_context = &mut TASK_STORAGE[current_id].context as *mut _;
// safety: has poped a some
TASK_SCHEDULE.push_back_unchecked(Yield { id: current_id });
CURRENT_ID = next_id;
let next_context = &mut TASK_STORAGE[next_id].context as *mut _;
__switch(current_context, next_context);
```

浅显易懂！

最后是较为麻烦的 pending task：它还没有上下文！我们得造一个上下文出来切到它。

首先得找到一个合适的 `id`。

```rust
let next_id = TASK_STORAGE.iter().position(|t| !t.occupied).unwrap();
```

然后需要初始化上下文

```rust
TASK_STORAGE[next_id].occupied = true;
TASK_STORAGE[next_id].context.sp = TASK_STORAGE[next_id].stack.stack_top();
TASK_STORAGE[next_id].context.ra = entry as usize;
```

这里最值得深思的是 `ra` 寄存器：对于一个 yield context，到这里 `ra` 应该是 `task_yield` 函数本身 `call __switch` 下一条指令地址，这样切换回来时可以执行完 `task_yield` 函数内剩余的指令；而我们新建的上下文却是直接把 `ra` 设为 entry，看起来有点不对称；读者可以思考有没有更优美的做法。

其他流程就和 yield task 一样啦。

最终完整实现如下：

```rust
pub fn task_yield() { unsafe {
    use Task::*;
    let next_id = match TASK_SCHEDULE.pop_front() { 
        None => { // spin rather than switch context
            core::hint::spin_loop();
            return;
        } 
        Some(Pending { entry }) => {
            let next_id = TASK_STORAGE.iter().position(|t| !t.occupied).unwrap();
            TASK_STORAGE[next_id].occupied = true;
            TASK_STORAGE[next_id].context.sp = TASK_STORAGE[next_id].stack.stack_top();
            TASK_STORAGE[next_id].context.ra = entry as usize;
            next_id
        },
        Some(Yield { id }) => id
    };
    let current_id = CURRENT_ID;
    CURRENT_ID = next_id;
    let current_context = &mut TASK_STORAGE[current_id].context as *mut _;
    // safety: has poped a some
    TASK_SCHEDULE.push_back_unchecked(Yield { id: current_id });
    let next_context = &mut TASK_STORAGE[next_id].context as *mut _;
    __switch(current_context, next_context);
}}
```

不算太难！

## 实现 exit

exit 其实和 yield 差不多，就是当前任务的上下文直接不要了，切到下一个任务。

由于栈内存很宝贵，我们用一个静态变量来当“垃圾桶”（如果沿用 `TASK_STORAGE[CURRENT_ID].context` 会发生什么？）

```rust
static mut DUMMY_CONTEXT: TaskContext = unsafe{core::mem::zeroed()};
```

然后就是实现

```rust
pub fn task_exit() -> ! { unsafe {
    use Task::*;
    debug!("exiting task {CURRENT_ID}");
    TASK_STORAGE[CURRENT_ID].occupied = false;
    let next_id = match TASK_SCHEDULE.pop_front() { 
        None => { // no more tasks to do
            info!("No more tasks to do, shutdowning...");
            crate::machine::shutdown(false);
        }
        Some(Pending { entry }) => {
            let next_id = TASK_STORAGE.iter().position(|t| !t.occupied).unwrap();
            TASK_STORAGE[next_id].occupied = true;
            TASK_STORAGE[next_id].context.sp = TASK_STORAGE[next_id].stack.stack_top();
            TASK_STORAGE[next_id].context.ra = entry as usize;
            next_id
        },
        Some(Yield { id }) => id
    };
    CURRENT_ID = next_id;
    let next_context = &mut TASK_STORAGE[next_id].context as *mut _;
    __switch(core::ptr::addr_of_mut!(DUMMY_CONTEXT), next_context);
    unreachable!()
}}
```

其中的 shutdown 是在第一章实现的，抄过来了。

## 测试

写完了！Rust 代码加起来都没超过 100 行。短小精悍！

我们沿用第一章的 rust_main

```rust
use kernel::task::*;

#[no_mangle]
pub fn rust_main() -> ! {
    clear_bss();
    kernel::init();
    register_tasks();
    kernel::task::task_exit();
}

pub fn register_tasks() {
    for f in [task1, task2] {
        task_spawn(f);
    }
}

fn task1() {
    println!("[task1] Greet from before yield");
    task_yield();
    println!("[task1] Greet from after yield");
    task_exit();
}

fn task2() {
    println!("[task2] Greet from before yield");
    task_yield();
    println!("[task2] Greet from after yield (spawn task 3!)");
    task_spawn(task3);
    task_yield();
    println!("[task2] Greet from after another yield");
    task_exit();
}

fn task3() {
    println!("[task3] Greeeeeet!");
    task_exit();
}
```

运行

```txt
[task1] Greet from before yield
[task2] Greet from before yield
[task1] Greet from after yield
[task2] Greet from after yield (spawn task 3!)
[task3] Greeeeeet!
[task2] Greet from after another yield
```

## 后记

当然，设计还有不少优化空间
- 在没有多余空间时不直接 unwrap 而是跳到下一个 yield 任务
- 栈空间为固定的 8k，而且没有检查 stack overflow，可能会写坏其他上下文
- 若一个任务真·阻塞住了，就卡在一个任务上了（当然这是任务实现的问题不是系统的问题）
- 任务数有上限

下一节，我们将引入定时器，来实现抢占式调度