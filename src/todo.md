- 设备树 （DTB, ACPI, PCIE, USB）
- 位置无关 entry (fast enable mmu)
- ch1 添加学习资料

```asm
// enable el1 fpu
mrs x1, cpacr_el1
orr x1, x1, #(3<<20)
msr cpacr_el1, x1
isb
```

```bash
rustc --target=aarch64-unknown-none-softfloat --emit asm lib.rs -Copt-level=z -Cpanic=abort
```

```bash
qemu-system-aarch64 -M virt-8.1,dumpdtb=virt.dtb -cpu cortex-a53 -nographic
dtc -I dtb -O dts virt.dtb -o virt.dts
```

## 碎碎念

一个好的操作系统应当实现强大而简洁，功能开放而安全，接口灵活而直观。这看似矛盾，而在仔细的实现和老祖宗的智慧下是能够实现的。本书最核心的知识就是这些老祖宗的智慧。

内核里各部分可能会强耦合在一起，有着相当复杂的交互和依赖关系。例如 open 调用会“打开”一个文件；这似乎只牵涉文件操作；然而考虑 fork 调用，它应创建一个当前进程的拷贝进程；而对于一个真正的拷贝进程，父进程中的文件描述符也必须可用。因此，fork 调用需要访问 open 调用相关的信息。fork 和 open 就这样耦合在了一起。

好在上面的图片已经给出了一个不错的领域抽象，我们可以在进程管理器里储存 file descriptor 相关信息，在 open 时修改它，在 fork 时复制它。

在这个例子中，我们用了一些抽象（文件系统和进程管理器）让两个调用间解耦合。"All problems in computer science can be solved by another level of indirection"，当我们的实现看起来过于复杂时，不妨想想多一层包装，简化我们的实现。

碎碎念就这么多，话不多说，直接开始正题！