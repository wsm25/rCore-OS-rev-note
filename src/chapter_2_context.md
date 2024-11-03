# 任务和上下文

## 任务

所谓任务，其实就是一段可执行代码；第一章我们实现的一个 Hello World 系统可以说就是一个单独的任务。

当有很多任务要交给机器执行时，最朴素的做法就是依次执行；对于很多场景这已经是很不错的策略了，比如多个连续的计算任务，打印机等。但很多时候，我们期望任务之间能“并行”，例如一个单片机同时监视、控制多台外设。

我们当然可以通过手搓状态机/异步函数调用实现多任务伪并行，单片机的教材大多数也是这么教的。但是不妨考虑另一种实现：每一个任务都有自己的栈空间，这样任务可以随时被打断、相互切换；一个任务只要管自己就行；换而言之，这样实现了一种“相互隔离”。

不过我们的任务并不像真实操作系统中的线程一样可以完全不管内核实现；目前我们的任务需要
- 在可以暂停的时候（例如阻塞 io，等待事件）主动通过 `yield` 函数将 cpu 让给其他任务
- 在任务结束的时候主动调用 `exit` 函数结束任务

当然这些问题都会在后面解决。

在目前的设计里，任务不需要自备栈，栈由内核自动分配。

## 上下文

引用 rCore 文档的解释：

> 一旦一条控制流需要支持“暂停-继续”，就需要提供一种控制流切换的机制，而且需要保证程序执行的控制流被切换出去之前和切换回来之后，能够继续正确执行。这需要让程序执行的状态（也称上下文），即在执行过程中同步变化的资源（如寄存器、栈等）保持不变，或者变化在它的预期之内。不是所有的资源都需要被保存，事实上只有那些对于程序接下来的正确执行仍然有用，且在它被切换出去的时候有被覆盖风险的那些资源才有被保存的价值。这些需要保存与恢复的资源被称为 **任务上下文 (Task Context)** 。

实践上，我们需要保存的上下文包括整个栈和一些约定的 [Callee saved registers](https://msyksphinz-self.github.io/riscv-isadoc/html/regs.html) （由于我们正在使用的 Rust 编译器就遵循这些约定，我们也要遵循他）

定义寄存器上下文结构体如下：

```rust
#[repr(C)]
pub struct TaskContext {
    ra: usize,
    sp: usize,
    s: [usize; 12],
}
```

其中 `ra` 和 `sp` 寄存器最为特殊：`ra` 决定了返回地址（不像 x86 存在栈上，riscv 用寄存器储存返回地址），它可以通过 `ret` 命令间接修改 pc；而 `sp` 寄存器是栈地址，它决定了函数的局部变量。二者共同保存了一个函数式执行环境。

## 任务切换

任务切换过程做的事情很简单，很 hack。简单来说，它将上个任务（当前）的上下文储存下来，并加载下个任务的上下文。

实现一个 `fn __switch(current: *mut TaskContext, other: *const TaskContext);`:

`task/switch.s`
```riscv
# fn __switch(current: *mut TaskContext, other: *const TaskContext);
    .section .text
    .globl __switch
__switch:
    # save current context / callee-saved registers
    sd  ra, 0(a0)
    sd  sp, 8(a0)
    sd  s0, 16(a0)
    sd  s1, 24(a0)
    sd  s2, 32(a0)
    sd  s3, 40(a0)
    sd  s4, 48(a0)
    sd  s5, 56(a0)
    sd  s6, 64(a0)
    sd  s7, 72(a0)
    sd  s8, 80(a0)
    sd  s9, 88(a0)
    sd  s10, 96(a0)
    sd  s11, 104(a0)
    # restore next context / callee-saved registers
    ld  ra, 0(a1)
    ld  sp, 8(a1)
    ld  s0, 16(a1)
    ld  s1, 24(a1)
    ld  s2, 32(a1)
    ld  s3, 40(a1)
    ld  s4, 48(a1)
    ld  s5, 56(a1)
    ld  s6, 64(a1)
    ld  s7, 72(a1)
    ld  s8, 80(a1)
    ld  s9, 88(a1)
    ld  s10, 96(a1)
    ld  s11, 104(a1)
    ret
```

然后在 Rust 代码里导入
`task/mod.rs`
```rust
core::arch::global_asm!(include_str!("switch.s"));
extern "C" { fn __switch(current: *mut TaskContext, other: *const TaskContext); }
```

暴力而简单！riscv 调用约定要求 a0 和 a1 分别为第 1, 2 个参数，在这里是 `TaskContext` 指针类型；我们先把 `sp`, `ra`, `s0`-`s11` 存到参数1里，然后从参数2加载这些寄存器。

这个 `__switch` 最巧妙的地方在于，由于 `ra` 寄存器被换掉了，`ret` 指令会直接跳转到新的地址，从而执行新任务的代码。这是我们成功实现“切换”效果的关键。

至此，理论准备工作已经结束，下一节我们将会基于此实现一个任务切换系统！

p.s. 真实的操作系统中可能还会加上浮点寄存器，我们这里就暂时忽略了。