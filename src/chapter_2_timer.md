# 定时器和中断

本节是本书中我们第一次接触中断。

## Exceptions, Traps, and Interrupts

[官方文档](https://github.com/riscv-non-isa/riscv-trace-spec/blob/main/introduction.adoc) 如此解释：
- exception: an unusual condition occurring at run time associated with an instruction in a RISC-V hart
- interrupt: an external asynchronous event that may cause a RISC-V hart to experience an unexpected transfer of control
- trap: the transfer of control to a trap handler caused by either an exception or an interrupt

可以看到，异常是 runtime 发生的，源自于 CPU 自身执行的异常指令；而中断是外源的，它异步于 CPU 执行流程发生。他们都可能导致 trap，即通过一个 handler 来处理它。

trap handler 通过 csr(Control and Status Register) 设置。csr 是 riscv 定义的扩展寄存器，可以通过读写他们来控制 cpu 的行为；这是很危险的行为，所以不同模式对 csr 的权限不同，如用户态只有寥寥几个 csr 可读。

由于 `riscv` crate 看起来太重了，本书自己包装了一个 `riscv-csr` crate。

<details>
<summary>代码</summary>

```rust
/// control/status register
/// 
/// ref: https://soc.ustc.edu.cn/CECS/lab4/priv/
pub trait CSR {
    /// CSR address
    const ADDR: u16; // 0-4095
    
    /// Read
    #[inline(always)]
    fn read() -> u64 {
        Self::read_setbit_imm::<0>()
    }

    /// Read from csr and write
    #[inline(always)]
    fn read_write(val: u64) -> u64 {
        let ret;
        unsafe{asm!("csrrw {}, {}, {}", out(reg) ret, const Self::ADDR, in(reg) val)};
        ret
    }
    
    /// Read csr and write `csr | newval` to csr. It sets `1` bit in `val` of csr to 1.
    #[inline(always)]
    fn read_setbit(val: u64) -> u64 {
        let ret;
        unsafe{asm!("csrrs {}, {}, {}", out(reg) ret, const Self::ADDR, in(reg) val)};
        ret
    }
    
    /// Read and write `csr & !newval` to csr. It sets `1` bit in `val` of csr to 0.
    #[inline(always)]
    fn read_clearbit(val: u64) -> u64 {
        let ret;
        unsafe{asm!("csrrc {}, {}, {}", out(reg) ret, const Self::ADDR, in(reg) val)};
        ret
    }

    /// Read and write immediate number. The imm number must less than 32.
    #[inline(always)]
    fn read_write_imm<const IMM:u8>() -> u64 {
        let ret;
        unsafe{asm!("csrrwi {}, {}, {}", out(reg) ret, const Self::ADDR, const IMM)};
        ret
    }

    /// Read and write `csr | IMM` to csr. The imm number must less than 32.
    #[inline(always)]
    fn read_setbit_imm<const IMM: u8>() -> u64 {
        let ret;
        unsafe{asm!("csrrsi {}, {}, {}", out(reg) ret, const Self::ADDR, const IMM)};
        ret
    }
    
    /// Read and write `csr & !IMM` to csr. The imm number must less than 32.
    #[inline(always)]
    fn read_clearbit_imm<const IMM: u8>() -> u64 {
        let ret;
        unsafe{asm!("csrrci {}, {}, {}", out(reg) ret, const Self::ADDR, const IMM)};
        ret
    }
}

macro_rules! def_csr {($csr:ident, $addr:literal) => {
    #[allow(non_camel_case_types)]
    pub struct $csr;
    impl $crate::CSR for $csr {
        const ADDR: u16 = $addr;
    }
};}
```
</details>

由于我们需要的定时器 stimer 工作在 Supervisor 态，所以我们要设置 stval 变量。只要把 handler 直接写到 csr 里就行。剩下的工作就是疯狂查文档了... (RISC-V Privileged ISA Specification, Chapter 3.1)

```rust
pub const CLOCK_FREQ: u64= 10000000;
const INTERVAL: u64 = CLOCK_FREQ/4;

pub fn forward_timer() {
    set_timer(get_timer()+INTERVAL);
}

fn set_timer(t: u64) {
    sbi_rt::set_timer(t).unwrap();
    csr::sstatus::read_setbit(1<<1); // enable supervisor interrupt
}

fn get_timer() -> u64 {
    csr::time::read() as u64
}
```

其中一行 `sstatus::setbit` 是现阶段的补丁，因为正常情况下 stimer 不应中断 supervisor 本身，而我们全程其实都工作在 supervisor 模式下，需要被中断；下一章就不需要了。

然后写 `trap::init`

```rust
pub fn init() {
    // set trap handler
    csr::stvec::write(__alltraps as usize);
    // enable supervisor timer
    csr::sie::read_setbit(1<<5);
    forward_timer();
}

fn trap_handler() {
    let cause = csr::scause::read();
    let (interrupt, cause) = (cause & 1<<63, cause & !(1<<63));
    if interrupt != 0 { // interrupt
        match cause {
            5 => { // supervisor timer interrupt
                print!("\r[kernel] Timer interrupt!");
                forward_timer();
            },
            _ => panic!("Unknown interrupt {:#x}", cause)
        };
    } else {
        panic!("Unknown exception {:#x}", cause)
    }
}
```

加到 `kernel::init` 里，改改 task3

```rust
fn task3() {
    println!("[task3] Greeeeeet!");
    loop {
        print!("\r[task3] current time: {}", csr::time::read());
    }
    // task_exit();
}
```

开机试试：

```txt
[task3] Greeeeeet!
[kernel] Timer interrupt![kernel-panic] Panicked at kernel/src/console.rs:22 called `Result::unwrap()` on an `Err` value: Error
```

很奇怪，崩溃了！这是因为 trap handler 实际上会动寄存器，这样在 trap 结束的时候，被中断的函数还以为自己没被中断过，沿用了寄存器，读到的却是被 trap handler 改过的值，因此会崩溃。

## Yet Another Context Saving

因此我们需要保存上下文；与之前 task switch 相反，我们要保存所有 Caller saved registers；而且由于栈还在，我们可以直接用这个栈而非外部的储存空间储存。本质上，我们就是帮 interruption 做了一次函数调用前后的工作，只不过不像编译器可以只存用到的寄存器，我们需要存所有寄存器。

```riscv
    .section .text
    .globl __alltraps
    .align 2
__alltraps:
    addi sp, sp, -17*8
    # callee saved registers
    sd ra, 0*8(sp)
    sd t0, 1*8(sp)
    sd t1, 2*8(sp)
    sd t2, 3*8(sp)
    sd t3, 4*8(sp)
    sd t4, 5*8(sp)
    sd t5, 6*8(sp)
    sd t6, 7*8(sp)
    sd a0, 8*8(sp)
    sd a1, 9*8(sp)
    sd a2, 10*8(sp)
    sd a3, 11*8(sp)
    sd a4, 12*8(sp)
    sd a5, 13*8(sp)
    sd a6, 14*8(sp)
    sd a7, 15*8(sp)
    csrr t0, sepc
    sd t0, 16*8(sp)
    call trap_handler
    # restore
    ld t0, 16*8(sp)
    csrw sepc, t0
    ld ra, 0*8(sp)
    ld t0, 1*8(sp)
    ld t1, 2*8(sp)
    ld t2, 3*8(sp)
    ld t3, 4*8(sp)
    ld t4, 5*8(sp)
    ld t5, 6*8(sp)
    ld t6, 7*8(sp)
    ld a0, 8*8(sp)
    ld a1, 9*8(sp)
    ld a2, 10*8(sp)
    ld a3, 11*8(sp)
    ld a4, 12*8(sp)
    ld a5, 13*8(sp)
    ld a6, 14*8(sp)
    ld a7, 15*8(sp)
    addi sp, sp, 17*8
    ret
```

选择合适的 interval 后，运行成功！

```txt
[task3] Greeeeeet!
[task3] current time: [kernel] Timer interrupt!
[task3] current time: [kernel] Timer interrupt!
[task3] current time: [kernel] Timer interrupt!
[task3] current time: 51167659[kernel] Timer interrupt!
[task3] current time: [kernel] Timer interrupt!
[task3] current time: [kernel] Timer interrupt!
[task3] current time: [kernel] Timer interrupt!
```

在 `trap::trap_handler` 的 time interrupt 部分加上 `task::task_yield()`，把三个任务都改成死循环

```rust
use kernel::task::*;

fn task1() -> ! {
    loop { print!("\r[task 1] loop!") }
}

fn task2() -> ! {
    task_spawn(task3);
    loop { print!("\r[task 2] loop and loop!") }
}

fn task3() -> ! {
    loop { print!("\r[task 3] loop and loop and loop!") }
}

pub fn register_tasks() {
    for f in [task1, task2] {
        task_spawn(f);
    }
}
```

输出

```txt
[task 1] loop!
[task 2] loop and loop!
[task 1] loop!
[task 3] loop and loop and loop!
[task 2] loop and loop!
[task 1] loop!
[task 3] loop and loop and loop!
[task 2] loop and loop!
[task 1] loop!
[task 3] loop and loop and loop!
[task 2] loop and loop!
[task 1] loop!
[task 3] loop and loop and loop!
[task 2] loop and loop!
[task 1] loop!
[task 3] loop and loop and loop!
[task 2] loop and loop!
[task 1] loop!
[task 3] loop and loop and loop!
[task 2] loop and loop!
[task 1] loop!
[task 3] loop and loop and loop!
```

可以看到，三个任务切换自如！

## 后记

至此，本章基本完结了。我们仍可以做更多改进，比如实现 sleep。但在当前较为简单的系统上过分追求细节没有益处。

下一章开始，我们将再次颠覆已有的设计，向“线程”前进！