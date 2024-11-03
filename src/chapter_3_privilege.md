# 特权级

现代的操作系统基本都是用户-内核设计，用户程序被认为不可信，他们通过系统调用通过鉴权经由内核进行操作。这就好比网站架构中的前后端一样，用户应尽量少地信任，其任何操作都要经过鉴权，经由可信的后端代理进行。权限的设计大大增强了现代操作系统的稳定性，让即使是恶意程序也难以做出破坏。

操作系统权限设计基于硬件特权级机制支持。所有现代 CPU 架构都实现了特权级机制和系统调用指令：
- x86: ring0（宿主/OS）和 ring3 （用户），syscall 指令
- arm：EL2/3（宿主）, EL1（OS）和 EL0（用户），swi 指令
- riscv：M（宿主），S（OS）和 U（用户），ecall 指令

（LoongArch? 不熟...）

特权特权，主要特殊在对硬件访问权限更高。低特权态需要利用/通过高特权态执行部分操作；实践中，用户态通过系统调用的方式触发内核态 trap，从而执行对应操作；执行完后再通过降权指令回到用户态。另一方面，当用户代码触发任何异常的时候，比如访存错误，

## ecall 和 sret

riscv 通过 ecall 和 sret 指令实现主动切换态。一个 ecall 会触发更高态 trap，并把 scause 设为 exception 中的 user call (exception code 8)；而 sret 是 supervisor 态特有指令，它会跳转到 `sepc` csr 处，并将模式切换为 `sstatus` csr 指定的。

我们之前就已经接触了很多 ecall 了：所有的 SBI 接口，比如 debug console, timer，就通过 ecall 实现。Supervisor 态执行的 ecall 会由 Machine 态的 trap handler 处理。同样地，用户态执行的 ecall 就会由 Supervisor 态的 trap handler 处理。

而高态的 trap handler 处理完毕后，一条 `sret` 指令就可以回到低态。

我们不妨先来进入用户态：

```rust
pub fn run_init(entry: fn()) -> ! { unsafe{
    TASK_STORAGE[0].occupied = true; // 分配第 0 块储存
    csr::sstatus::read_clearbit(1<<8); // 清除 sstatus 的 SPP 位，使 `sret` 进入用户态
    asm!(
        "mv sp, {}", // 分配栈内存
        "csrw sepc, {}", // 设置入口
        "sret", // 进入用户态
        in(reg) TASK_STORAGE[0].stack.stack_top(),
        in(reg) entry,
        options(noreturn)
    )
}}
```

但是进入用户态后，所有的 console 输出都没有了！这是因为我们前面写的 `println` 宏是基于 sbi call 的，然而用户态下，ecall 会进入 supervisor trap handler，而我们还没有实现对应的调用！现在让我们开始编写 trap handler 吧！

## 重写 Trap Handler

只要复用之前的 trap handler 就行...吗？出于安全考虑，不行的。之前在 trap handler 里我们会 sp 寄存器，即任务的栈；然而在分权的设计下，这会使得用户能够看到内核 trap handler 的部分栈内存，危险！我们需要在处理时切到内核栈。

同时，上下文也不能存在用户栈上，因为它可能会爆栈，但由于我们正在 trap handler 里爆栈就无法处理，导致内核崩溃。

还有，由于 callee saved register 可能会被内核使用，这样在切任务的时候会导致捕获的对应 register 并非原本值而变成了内核的对应值，我们需要在进入 rust 代码前把 callee saved register 也存下来；换而言之，x0-x31 每个寄存器都需要在进入 rust 代码前保存一份。

出于上述考虑，我们将在 trap_handler 里用内核栈保存所有寄存器然后再调用 rust 处理代码。

下面是具体实现：

```riscv
    .section .text
    .globl __handle_trap
    .align 2
__handle_trap:
    csrw sscratch, sp # 利用 `sscratch` csr 暂存用户栈
    la sp, kernel_stack_top # 切换到内核栈
    # 将所有寄存器存入内核栈
    addi sp, sp, -33*8
    sd x1, 1*8(sp)
    sd x3, 3*8(sp)
    sd x4, 4*8(sp)
    ...
    sd x30, 30*8(sp)
    sd x31, 31*8(sp)
    # 还有几个特殊的寄存器
    csrr t0, sscratch
    csrr t1, sepc
    csrr t2, sstatus
    sd t0, 2*8(sp)
    sd t1, 0*8(sp)
    sd t2, 32*8(sp)

    mv a0, sp # 设置 `&mut TrapContext` 参数
    jal trap_handler # 调用 Rust 处理函数

    # 恢复寄存器

    ld t0, 2*8(sp)
    ld t1, 0*8(sp)
    ld t2, 32*8(sp)
    csrw sscratch, t0
    csrw sepc, t1
    csrw sstatus, t2 
    ld x1, 1*8(sp)
    ld x3, 3*8(sp)
    ld x4, 4*8(sp)
    ...
    ld x30, 30*8(sp)
    ld x31, 31*8(sp)
    # 恢复用户栈
    csrr sp, sscratch
    # 返回到用户态
    sret
```

还是熟悉的暴力味道！既然在汇编部分已经保存信息到内核栈了，那么在 `task_yield` 等函数里就不需要再 switch context 了；一切修改都可以基于传入的 `&mut TrapContext` 进行。

`TrapContext` 定义如下：

```rust
#[derive(Clone)]
#[repr(C)]
/// trap context
pub struct TrapContext {
    pub sepc: usize,
    pub ra: usize,
    ...
    pub sstatus: usize,
}
```

包括全部 33 个在汇编代码里储存的寄存器。

这里有一个略微有些 hack 的操作：把 sp 赋值给 a0，然后 `fn trap_handler(ctx: &mut TrapContext)` 就能收到正确的参数了！这是因为 riscv 调用约定中，a0..a7 是参数寄存器，分别对应第 0..7 个参数。

最后是 Rust 部分：

```rust
pub fn handle_syscall(ctx: &mut TrapContext) {...}

#[no_mangle]
pub fn trap_handler(ctx: &mut TrapContext) {
    // 参考 riscv privileged architecture
    const EXCP_UCALL: usize = 8;
    const INTR_MASK: usize = 1<<63; // 此位为 中断/异常判定位
    const INTR_STIMER: usize = INTR_MASK | 5;
    let cause = csr::scause::read(); // trap 原因
    let val = csr::stval::read(); // 异常地址
    match cause {
        EXCP_UCALL => { // 用户 ecall
            handle_syscall(ctx);
        },
        i if i<INTR_MASK => { // 其他异常
            log::error!("Got unhandled exception {:#x} on address {:#x}, exiting...", cause, val);
            crate::task::task_exit(ctx);
        }
        INTR_STIMER => { // supervisor timer interrupt
            step_timer();
            crate::task::task_yield(ctx);
        }
        _ => { // 其他中断
            log::error!("Got unhandled interrupt {:#x}, exiting...", cause&(!INTR_MASK));
            crate::task::task_exit(ctx);
        }
    }
}
```

这里所有的 `task_xxx` 函数都被修改成了接受一个 `TrapContext` 参数的形式；画风从之前的
```rust
__switch(current_context, next_context);
```
变成了 
```rust
TASK_STORAGE[current_id].context = ctx.clone();
*ctx = TASK_STORAGE[next_id].context.clone();
```

略暴力，但是够简洁！

## syscall

如何通过 ecall 传参给 trap handler 从而处理？一般大家会要求调用者沿用调用约定，把有限参数放在寄存器里，然后执行 `syscall` 指令；这个指令在跳转到 trap handler 之后对应寄存器仍保持原样，我们就可以从对应寄存器里读参数；同时，大家不约而同地占用第一个参数作为“调用编号”，从而实现多种功能的 syscall。

对于 riscv，我们以 `a0`, `a1`, `a2`, `a3` 作为参数，这样在 `syscall_handler` 里就可以读 `ctx.a0` 之类的参数执行。

这需要分用户和内核两方面实现。

用户代码：

```rust
use core::arch::asm;

pub fn syscall_0(id: usize) -> usize {
    let rcode;
    unsafe{asm!("ecall", inlateout("a0") id=>rcode)}
    rcode
}

pub fn syscall_1(id: usize, arg0: usize) -> usize {
    let rcode;
    unsafe{asm!("ecall", inlateout("a0") id=>rcode, in("a1") arg0)}
    rcode
}

pub fn syscall_2(id: usize, arg0:usize, arg1: usize) -> usize {
    let rcode;
    unsafe{asm!("ecall", inlateout("a0") id=>rcode, in("a1") arg0, in("a2") arg1)}
    rcode
}

pub fn syscall_3(id: usize, arg0:usize, arg1: usize, arg2: usize) -> usize {
    let rcode;
    unsafe{asm!("ecall", inlateout("a0") id=>rcode, in("a1") arg0, in("a2") arg1, in("a3") arg2)}
    rcode
}
```

内核代码：

```rust
pub fn handle_syscall(ctx: &mut TrapContext) {
    ctx.sepc += 4; // jump to next instruction anyway
    match ctx.a0 {
        _ => {
            log::error!("unimplemented syscall {:#x}", ctx.a0);
            task_exit(ctx);
        }
    }
}
```

这里值得注意的是 `ctx.sepc += 4`，它将 sret 跳转点手动 +4，以指向 ecall 点的下一条指令；这是因为它实现上与 exception 一致，处理 exception 时通常需要处理完跳转回去后重新执行指令，因此 `ecall` 默认行为与 `jal` 之类的函数调用不同，会将返回地址指向当前指令而非下一条。

在此之后，就是约定调用编号和实现具体调用了，这还是比较简单的。我们以 `puts` 调用为例：

用户：
```rust
pub const SYSCALL_PUTS: usize = 0x20;
/// output to console
pub fn puts(s: &str) -> core::fmt::Result {
    match syscall_2(SYSCALL_PUTS, s.as_ptr() as usize, s.len()) {
        0 => Ok(()),
        _ => Err(core::fmt::Error)
    }
}
```

内核：

```rust
pub fn handle_syscall(ctx: &mut TrapContext) {
    ctx.sepc += 4; // jump to next instruction anyway
    match ctx.a0 {
        SYSCALL_PUTS => {
            match crate::console::puts(t!((ctx.a1, ctx.a2))){
                Ok(_) => {ctx.a0 = 0;}
                Err(_) => {ctx.a0 = usize::MAX;}
            }
        },
        _ => {
            log::error!("unimplemented syscall {:#x}", ctx.a0);
            task_exit(ctx);
        }
    }
}
```

这样用户态也可以 print 了！

其他 syscall 包装不再赘述。目前实现了以下 syscall：

```rust
pub const SYSCALL_YIELD: usize = 0;
pub const SYSCALL_EXIT: usize = 1;
pub const SYSCALL_SPAWN: usize = 2;

pub const SYSCALL_PUTS: usize = 0x20;
```

包装完后沿用上一章的 task，成功复现输出！

## 内核与用户分离

到目前为止，很多功能都是坏的，尤其是用户和内核有相同功能的不同实现时，尤其是跨作为 rust predule 的那些，例如
- console 和 log
- global_allocator
- panic_handler

究其原因，一个 Rust 产物所包含的 rlib 中某些 predule symbol 是共享的，需要在最终链接时唯一。为了绕过这个限制，我们需要让内核和用户各自产生一个产物。

我们让内核和用户各自生成一个静态库，然后链接起来。然而由于 Rust 自身的 [奇妙 symbol](https://internals.rust-lang.org/t/linking-errors-when-the-c-standard-library-itself-contains-rust-code-using-std-redox)，直接链接会导致 duplicate symbol。我们需要开启 `lto` 选项。

把文件整理成如此：

```bash
.
├── Cargo.toml
├── build.rs
├── xrun.sh # 一键编译执行脚本
├── common # 内核和用户共用部分
│   ├── Cargo.toml
│   └── src
│       ├── csr.rs
│       ├── lib.rs
│       ├── mod.rs
│       └── syscall
│           ├── id.rs
│           ├── mod.rs
│           └── syscall.rs
├── link-qemu.ld # 链接脚本
├── src # 内核
│   ├── console.rs
│   ├── entry.s
│   ├── main.rs
│   ├── syscall.rs
│   ├── task.rs
│   ├── timer.rs
│   ├── trap.rs
│   └── trap.s
└── user # 用户
    ├── Cargo.toml
    ├── kernel-api # 用户态的内核 api
    │   ├── Cargo.toml
    │   └── src
    │       ├── alloc.rs
    │       ├── console.rs
    │       └── lib.rs
    └── src
        └── lib.rs # 用户入口
```

内核编译脚本 `build.rs`：

```rust
use std::process::Command;

fn main() {
    println!("cargo::rerun-if-changed=user");
    if cfg!(debug_assertions) {
        let code = Command::new("cargo")
            .arg("build")
            .current_dir("user")
            .status().unwrap();
        assert!(code.success());
        println!("cargo::rustc-link-search=user/target/riscv64gc-unknown-none-elf/debug");
    } else {
        let code = Command::new("cargo")
            .arg("build").arg("-r")
            .current_dir("user")
            .status().unwrap();
        assert!(code.success());
        println!("cargo::rustc-link-search=user/target/riscv64gc-unknown-none-elf/release");
    }
}
```

其实就是编译了 user 作为静态链接库，然后链接到内核上（主要是需要一个入口符号）

注意 user 文件夹不能作为 kernel workspace 中的一员，否则会由于锁文件的存在在 `cargo build` 时卡住，死锁了！

