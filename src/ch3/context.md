# 任务，跳转和上下文

## 任务

所谓任务，其实就是一段可执行代码；上一章我们实现的一个 Hello World 系统可以说就是一个单独的任务。

当有很多任务要交给机器执行时，最朴素的做法就是依次执行；对于很多场景这已经是很不错的策略了，比如多个连续的计算任务，打印机等。但很多时候，我们期望任务之间能“并行”，例如一个单片机同时监视、控制多台外设。

我们当然可以通过手搓状态机实现多任务伪并行，单片机的教材大多数也是这么教的。但是不妨考虑另一种实现：每一个任务都有自己的栈空间，这样任务可以随时被打断、相互切换；一个任务只要管自己就行；换而言之，这样实现了一种“相互隔离”。

不过我们的任务并不像真实操作系统中的线程一样可以完全不管内核实现；目前我们的任务需要在可以暂停的时候（例如阻塞 io，等待事件）主动通过 `yield` 函数将 cpu 让给其他任务。

在目前的设计里，任务不需要自备栈，栈由内核自动分配。

## 指令流跳转

跳转是一个图灵机必要的功能。在常规处理器架构中有 `jmp`, `call`, `ret` 等各种丰富的指令，尤其是对于“函数”这种常用的抽象有相当多的约定和支持。

作为的精简指令集，ARM 无条件跳转只有两个指令： `b` 和 `br` （加上 "link" flag 排列组合一下是四个）；前者跳转到一个 (20bit) 有符号立即数相对地址（相对下一条指令）；函数调用和 if-else 之类都会编译成这个指令。后者跳转到一个以指定寄存器值 (64bit) 的绝对地址，并把下条指令地址存到指定寄存器；jump table 和函数返回等会编译成这条指令。

link flag 决定了要不要把跳转前的地址（PC+4）写入 x30。与 RISC-V 可指定存入寄存器不同，ARM 只支持写入 x30 与否。

例如， `call some_fn` 会编译成 `bl some_fn`，跳转到 `some_fn` 处把 PC+4 存入 `x30` 寄存器；`ret` 会编译成 `br x30`，跳转到 `x30` 处。

## 上下文

引用 rCore 文档的解释：

> 一旦一条控制流需要支持“暂停-继续”，就需要提供一种控制流切换的机制，而且需要保证程序执行的控制流被切换出去之前和切换回来之后，能够继续正确执行。这需要让程序执行的状态（也称上下文），即在执行过程中同步变化的资源（如寄存器、栈等）保持不变，或者变化在它的预期之内。不是所有的资源都需要被保存，事实上只有那些对于程序接下来的正确执行仍然有用，且在它被切换出去的时候有被覆盖风险的那些资源才有被保存的价值。这些需要保存与恢复的资源被称为 **任务上下文 (Task Context)** 。

实践上，我们需要保存的上下文包括整个栈和一些约定的 [Callee saved registers](https://developer.arm.com/documentation/102374/0102/Procedure-Call-Standard) （由于我们正在使用的 Rust 编译器就遵循这些约定，我们也要遵循他）。因此上应包括整个栈和 sp, x19-x30。

定义寄存器上下文结构体如下：

```rust
#[repr(C)]
pub struct TaskContext {
    x: [usize;12], // x19-x30
    sp: usize,
}
```

其中 `x30` 和 `sp` 寄存器最为特殊：`x30` 要储存返回地址；而 `sp` 寄存器是栈地址，它要储存函数的局部变量。二者共同保存了一个函数式执行环境。

## 任务切换

任务切换过程做的事情很简单，很 hack。简单来说，它将上个任务（当前）的上下文储存下来，并加载下个任务的上下文。

实现一个 `fn __switch(current: *mut TaskContext, other: *const TaskContext);`:

```arm
    .section .text
    .globl __switch
__switch:
    str x19, x20, [x0, #0]
    str x21, x22, [x0, #16]
    str x23, x24, [x0, #32]
    str x25, x26, [x0, #48]
    str x27, x28, [x0, #64]
    str x29, x30, [x0, #80]
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
```


然后在 Rust 代码里导入
```rust
extern "C" { fn __switch(current: *mut TaskContext, other: *const TaskContext); }
```

暴力而简单！riscv 调用约定要求 a0 和 a1 分别为第 1, 2 个参数，在这里是 `TaskContext` 指针类型；我们先把 `x19`-`x30` 和 `sp` 存到参数1里，然后从参数2加载这些寄存器。这里注意 aarch64 内 `sp` 并非通用寄存器，只能通过 `mov` 操作修改，因此需要倒腾一下。

这个 `__switch` 最巧妙的地方在于，由于 `x30` 寄存器被换掉了，`ret` 指令会直接跳转到新的地址，从而执行新任务的代码。这是我们成功实现“切换”效果的关键。

至此，理论准备工作已经结束，下一节我们将会基于此实现一个任务切换系统！

p.s. 真实的操作系统中可能还会加上浮点寄存器，我们这里就暂时忽略了。