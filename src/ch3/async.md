# 异步逃课

在正式开始实现传统意义上基于上下文的任务管理系统之前，不妨用 Rust 提供的异步来搓一个普通的多任务系统。这对于操作系统来说有点简陋，但是对于单片机/作为引入来说刚刚好。

对 Rust 异步模型不太熟悉的可以看看 [course.rs](https://course.rs/advance/async/intro.html)，或者直接跳过本节；反正本节内容在后面完全不会用到。

我们用 [pasts](https://docs.rs/pasts/latest/pasts/index.html) 作为异步执行器。

## 目标

最终我们希望下面的代码能够运行：

```rust
// task interface
/// spawn task, add task to task pool
pub fn spawn(task: fn());
/// yield task, give up cpu to other tasks
pub fn yield_();
/// exit task, giving up all context
pub fn exit()->!;

pub fn main() {
    macro_rules! spawn_all {
        ($($t:ident),*) => {
            $(spawn($t());)*
        };
    }
    spawn_all!(task1, task2);
}

pub fn task1() {
    kprintln!("Hello from task 1!");
    yield_();
    kprintln!("Hello from task 1 after spawn!");
}

pub fn task2() {
    kprintln!("Hello from task 2!");
}
```

每个接口的内容都写在注释中了。`main` 函数吧所有 task spawn 了；task1 内会通过一次 `yield` 让渡 cpu 给其他 task。

我们期望的输出是：

```txt
Hello from task 1!
Hello from task 2!
Hello from task 1 after spawn!
```

## 实现

`Cargo.toml`
```toml
[dependencies]
pasts = { version = "0.14", default-features = false }
```
`task.rs`
```rust
use core::{future::Future, mem::MaybeUninit};
use pasts::Executor;

static mut EXE: MaybeUninit<Executor> = MaybeUninit::zeroed();

pub fn init() {
    // SAFETY: single core
    unsafe{
        EXE = MaybeUninit::new(Executor::default());
    }
}

fn exe<'a>()->&'a mut Executor {
    // SAFETY: single core && assume init
    unsafe{EXE.assume_init_mut()}
}

pub fn spawn(task: impl Future<Output = ()> + 'static) {
    exe().spawn_boxed(task);
}

pub fn yield_()->impl Future<Output = ()> + 'static {
    struct X(bool);
    impl Future for X {
        type Output = ();
        fn poll(mut self: core::pin::Pin<&mut Self>, _: &mut core::task::Context<'_>) -> core::task::Poll<Self::Output> {
            use core::task::Poll::*;
            if self.0 {
                Ready(())
            } else {
                self.0 = true;
                Pending
            }
        }
    }
    X(false)
}

pub fn run(main: impl Future<Output = ()> + 'static) {
    exe().clone().block_on(main);
}
```

这里用了一个 `MaybeUninit` 来实现动态初始化。这在内核初始的单核下是安全而零开销的，后面会多多使用；唯一的缺陷就是不能用到 Rust 的 RAII 了，但本来就是内核，为了性能而做的一点点代码妥协还是很值得的...（OnceCell 什么的不要啊...）

`yield_` 通过维护一个执行过的标记实现了单次 `Pending`，从而可以让异步 task 被单次 schedule。

`run` 和 `spawn` 都是直接包装的 `pasts` 接口。

## 使用

`test.rs`
```rust
use crate::task::*;

pub async fn main() {
    macro_rules! spawn_all {
        ($($t:ident),*) => {
            $(spawn($t());)*
        };
    }
    spawn_all!(task1, task2);
}

pub async fn task1() {
    kprintln!("Hello from task 1!");
    yield_().await;
    kprintln!("Hello from task 1 after spawn!");
}

pub async fn task2() {
    kprintln!("Hello from task 2!");
}
```

加上了 `async`，就可以做一些异步活了，例如把一些串口驱动改成异步的，或者做异步定时器。

`main.rs`

```rust
#[no_mangle]
pub fn rust_main(_: usize) -> ! {
    ...
    task::init();
    task::run(test::main());
    shutdown();
}
```

成功输出！

## 后记

本节实现了以异步为基础的多任务管理；本节的存在主要是为多任务单片机程序提供新思路。下一节，向上下文前进！
