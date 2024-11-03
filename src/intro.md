# rCore-OS 笔记

本书为个人的 [rCore-OS](https://rcore-os.cn) 完整实现笔记。相较于
[原教程](https://rcore-os.cn/rCore-Tutorial-Book-v3/)，本书补充了一些我初看本书时感到困惑之处，
并对系统的迭代做了适当的精简和细化。

原 rCore-OS 强依赖于 risc-v 架构，本书将会提供包装实现一定的可移植性。

本书环境为 `Linux 5.10.16.3-microsoft-standard-WSL2, x86_64`。

本书会假定读者已经有了丰富的 Rust 开发经验，并学习了数据结构和计算机组成。 