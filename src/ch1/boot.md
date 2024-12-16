# 启动流程

一个硬件系统是如何从上电到进入操作系统的呢？

## STM32

文档如是说：

> 在 STM32F10xxx 里，可以通过 BOOT[1:0] 引脚选择三种不同启动模式：主闪存存储器，系统存储器，内置SRAM。
> 
> 在启动延迟之后，CPU从地址 0x0000 0000 获取堆栈顶的地址，并从启动存储器的 0x0000 0004 指示的地址开始执行代码。
> 
> 根据选定的启动模式，主闪存存储器、系统存储器或SRAM可以按照以下方式访问：
> - 从主闪存存储器启动：主闪存存储器被映射到启动空间 (0x0000 0000)，但仍然能够在它原有的地址 (0x0800 0000) 访问它，即闪存存储器的内容可以在两个地址区域访问，0x0000 0000 或 0x0800 0000
> - 从系统存储器启动：系统存储器被映射到启动空间 (0x0000 0000)，但仍然能够在它原有的地址 (0x1FFF F000) 访问它
> - 从内置SRAM启动：只能在 0x2000 0000 开始的地址区访问SRAM
>   
> 内嵌的自举程序存放在系统存储区，由 ST 在生产线上写入，用于通过可用的串行接口对闪存存储器进行重新编程。

可见通常情况下 stm32 通常直接从 flash 加载程序并运行。我们编译出单片机代码后只需裁剪成要求格式的代码块，并烧录到单片机 flash 上即可，十分简单。

## 台式机+Linux

台式机的启动流程大体涉及三个程序： Basic I/O System (BIOS), bootloader 和 kernel。

BIOS 写在主板 flash 上，和 stm32 类似的上电即加载；它需要事先知道主板上的所有硬件（至少是类型），例如 CPU、内存、PCIE 接口、USB 控制器、SATA 控制器等等。它首先对所有硬件做最基本的检测（自检），初始化一些重要的设备（比如 CPU 内存控制器，IO 设备，视频输出等等），然后通过事先配置在 BIOS 里的启动设备/EFI 文件逐个尝试启动。

BIOS 如其名已经是一个完整的操作系统了，它可以接收系统调用，执行基本的 IO （例如屏幕输出，键盘输入）。bootloader 可以依赖 bios 提供的标准接口进行操作。

大体上，bootloader 从 bios 手中接过一些硬件信息 (legacy: acpi table, uefi: efi system table)，然后根据 bootloader 的配置把内核从硬盘设备加载到内存，按内核要求对硬件略做配置，把内核需要的信息传给内核，然后跳转到内核启动。

对于 aarch64 Linux bootloader，它需要 [^1]
- 使所有支持 DMA 的设备，MMU，中断响应处于关闭状态（防止干扰内核）
- 把 CPU 设为 EL1 或 EL2 (recommended)
- 把 x0 设为 dtb 地址，x1-x3 置零（reserved）
...

在没有 bootloader 的年代，kernel 要自己负责 bootloader，正如中文内核入门流行的 Linux 0.11 那样。但这样有一个重大的缺陷：难以支持多系统，一个 bios 启动项/一块硬盘只能装一个操作系统/内核。当然现代 UEFI 支持以 EFI 文件为启动项，其实已经解决了这个问题；不过 bootloader - kernel 分离的设计可以减少 kernel 负担，况且有一个可以自定义的 os 选择界面，谁不爱呢！

即使有 bootloader 分担，内核要做的事还是很多。

1. 启动所有 CPU 核心
2. 通过 bootloader 传递的 acpi table 和 dtb 解析设备树，获得最基本的硬件信息（主要是 CPU 和内存）
3. 初始化内核各个部分，包括内存分配器、中断向量表、调度器
4. 通过设备树加载设备驱动，初始化设备
5. 初始化文件系统
6. 启动一些重要的内核线程（例如 kworker, ksoftirqd）
7. 启动 init 进程

真复杂！

btw acpi 怎么传递的？通过查 EFI system tables。legacy 方式大概只支持 dtb 吧...

## Qemu virt aarch64

这是本书依赖的硬件系统。有一个不幸的消息：它没有 bios；为了不引入额外的复杂度，本书也不使用额外的 bios。因此我们只能手动 IO 了。不过好在 Qemu 有一个默认输入输出设备，我们前期可以硬编码地使用它。

Qemu 相当于把 bootloader 的事做了，它会提供一个 device tree blob 用来解析设备树。

## Reference

[^1]: [Booting AArch64 Linux — The Linux Kernel documentation](https://www.kernel.org/doc/html/v5.6/arm64/booting.html)