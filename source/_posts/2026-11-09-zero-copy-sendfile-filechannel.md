---
title: 深入理解零拷贝：从 read+write 到 sendfile，Java FileChannel 实测系统调用从 13 万次降到 1 次
date: 2026-11-09 10:30:00
categories:
  - 操作系统与 Linux
  - I/O
tags:
  - 零拷贝
  - sendfile
  - FileChannel
  - page-cache
  - Kafka
  - strace
---

<hr>
<blockquote>
<p>同一个 512MB 的文件通过网络发出去，普通 <strong>read + write</strong> 循环要发 <strong>13 万次</strong>系统调用，换成 <strong>FileChannel.transferTo</strong>（底层走 <strong>sendfile</strong>）只要 <strong>1 次</strong>，进程 CPU 时间直接砍半。这篇把零拷贝的原理、Java 三种写法、可复现实验和常见坑一次讲清，所有数据都可以在你自己的 Linux 机器上跑出来。</p>
</blockquote>

<!-- more -->

## 一、从一次文件下载压测说起

先说一个特别常见的场景：文件服务对外提供日志包下载，1GB 一个包。压测的时候发现吞吐怎么都上不去，CPU 还不低。你去问群里的老司机，他甩你一句"上零拷贝啊"，你点点头，心里想的是：零拷贝到底是啥，拷贝发生在哪，我省掉它到底能快多少？

面试里也一样。"Kafka 为什么快？"标准答案是"顺序写 + 零拷贝"。但很多同学只能背到这两个词，追问一句"零拷贝省的是哪几次拷贝？sendfile 之前几次、之后几次？"就卡住了。

这篇的目标很简单：**把零拷贝讲透，并且给你一套 10 分钟就能跑的复现实验**。结论先放这里：

| 指标（512MB 文件，本机实测） | 传统 read + write | transferTo（sendfile） |
| --- | --- | --- |
| 数据通道系统调用次数 | 约 131,000 次 | **1 次** |
| 系统调用总耗时 | 约 1.09 秒 | 约 0.13 秒 |
| Java 进程 CPU 时间（user+sys） | 约 0.35 秒 | 约 0.17~0.22 秒 |
| 吞吐量（本机） | 约 95~110 MB/s | 约 94~107 MB/s（基本持平） |

注意最后一行：在这台小破测试机上，**吞吐基本没变，但 CPU 减半**。这个"看起来没快但其实是赚的"的现象，正是这篇文章最想讲清楚的东西。

## 二、传统路径：read + write 到底拷了几次

先补几个词，都是第一次出现，我用大白话解释：

- **用户态 / 内核态**：Linux 把内存分成两层。你的 Java 代码跑在用户态，受限制、不能直接碰硬件和别家进程的内存；内核跑在内核态，什么都能干。程序想干特权的事（比如读磁盘、发网络包），必须"喊"内核，这个喊的动作就是**系统调用**（syscall）。
- **上下文切换**：一次系统调用，CPU 要从用户态切到内核态再切回来，保存/恢复现场，这个来回就是一次（对）切换。它不便宜，尤其在高频小数据量 I/O 时，切换成本可能比干活成本还高。
- **DMA**（Direct Memory Access，直接内存访问）：你可以理解成"硬盘自带的搬运工"。数据从磁盘搬到内存，可以让 DMA 设备自己干，**不占用 CPU**；反过来 CPU 亲手搬的才烧 CPU 时间。
- **page cache（页缓存）**：内核把最近读过的文件内容缓存在内存里，下次再读同一段就不用碰磁盘了。这也是为什么同一个文件读第二遍会快很多。

然后看传统路径。把一个文件从磁盘发到网卡，Java 代码通常是这么写的：

```java
byte[] buf = new byte[8192];
try (InputStream in = new FileInputStream("big.bin");
     OutputStream out = socket.getOutputStream()) {
    int n;
    while ((n = in.read(buf)) != -1) {
        out.write(buf, 0, n);
    }
}
```

就这么几行，背后发生的事比你想象的多。数据一共被复制 **4 次**，其中 2 次烧 CPU：

| 次序 | 拷贝动作 | 谁在干活 | 烧不烧 CPU |
| --- | --- | --- | --- |
| 1 | 磁盘 → 内核的 page cache | DMA | 不烧 |
| 2 | page cache → 用户态你的 8KB 缓冲区 | CPU | **烧** |
| 3 | 用户态缓冲区 → 内核的 socket 发送缓冲 | CPU | **烧** |
| 4 | socket 缓冲 → 网卡 | DMA | 不烧 |

同时，每次 `read()` 和 `write()` 各带来 2 次用户态/内核态切换，512MB 数据按 8KB 一片要循环 65,536 次，所以是 **13 万次系统调用、26 万次上下文切换**。这个量级后面实测里能看到。

问题出在哪？出在第 2、3 次拷贝上：数据进了一趟用户态，**但你的程序压根没碰它**。你只是把它从 read 的手里接过来、原封不动塞给 write。既然没人加工它，这一趟用户态之旅就是白走的。

## 三、零拷贝：把"路过用户态"这一趟省掉

**零拷贝**（zero-copy）这个词有点误导：它不是说一次拷贝都没有，而是指**数据不需要在用户态和内核态之间来回倒腾**。CPU 亲手搬的次数越少，你的进程越省。

Linux 提供了一个专门的系统调用叫 **sendfile**（你可以 `man 2 sendfile` 看它的说明），它的思路是：既然数据要从"文件"直接送到"socket"，中间没有任何人需要看它，那就让内核一手包办，**根本不给用户态碰数据的机会**：

```c
#include <sys/sendfile.h>
ssize_t sendfile(int out_fd, int in_fd, off_t *offset, size_t count);
// 把 in_fd（文件）从 offset 开始的 count 字节，直接写进 out_fd（socket）
```

用了 sendfile 之后，上面的 4 次拷贝变成 3 次：

| 次序 | 拷贝动作 | 谁在干活 |
| --- | --- | --- |
| 1 | 磁盘 → page cache | DMA |
| 2 | page cache → socket 缓冲 | CPU（只在内核里转手） |
| 3 | socket 缓冲 → 网卡 | DMA |

如果网卡支持 **SG-DMA**（scatter-gather DMA，网卡的一种能力：允许它从内存里**分散地**收集数据块而不是要求一块连续缓冲），第 2 次那次"内核里的 CPU 拷贝"也能去掉——内核只把"数据在哪"的描述符递给网卡，网卡自己按图索骥去 page cache 里收数据。这时就是终极形态：**真正的 2 次拷贝（全 DMA），CPU 一次都不搬**。查一下你的网卡支不支持：

```bash
ethtool -k eth0 | grep scatter-gather
# scatter-gather: on 就支持
```

三种路径放一起对比：

| 路径 | 数据拷贝次数 | CPU 拷贝 | 上下文切换 |
| --- | --- | --- | --- |
| read + write | 4 | 2 | 4 次/循环 |
| sendfile | 3 | 1 | 2 次（且次数与数据量无关） |
| sendfile + SG-DMA | 2 | 0 | 2 次 |

顺带把两个容易混淆的东西摆正：

- **mmap**（内存映射文件）：把文件直接映射进你的进程地址空间，读写文件就像读写内存数组。它**不减少磁盘与内存之间的拷贝**，省的是"page cache → 用户态缓冲"这一次拷贝（因为你的缓冲区就是 page cache 本身）。适合**需要顺手改数据**的场景，比如 Kafka 的索引文件。它和 sendfile 是两条路，不是谁取代谁。
- **Netty 宣传的"零拷贝"**：那大多是 JVM 堆内/堆外缓冲层面的零拷贝，比如 `CompositeByteBuf` 把多个缓冲区逻辑上拼一块，避免物理合并拷贝。它和操作系统层面的 sendfile **不是一个东西**。Netty 真正对应 sendfile 的类叫 `FileRegion`，底层就是 `transferTo`。

## 四、Java 侧的三种写法

### 4.1 传统流式（对照组）

就是上面第二节那段 `read`/`write` 循环，8KB 缓冲。所有教材都这么写，作为对照组留着。

### 4.2 零拷贝：FileChannel.transferTo

**FileChannel** 是 NIO 提供的文件通道，它的 `transferTo` 方法在 Linux 上底层就映射到 sendfile 系统调用：

```java
try (SocketChannel sc = SocketChannel.open(new InetSocketAddress(host, port));
     FileChannel fc = FileChannel.open(Paths.get(file), StandardOpenOption.READ)) {
    long pos = 0;
    long size = fc.size();
    while (pos < size) {
        // 注意：单次最多传 Integer.MAX_VALUE（约 2GB），大文件必须循环
        long n = fc.transferTo(pos, size - pos, sc);
        if (n <= 0) break;
        pos += n;
    }
}
```

两个要点：

- `transferTo(pos, count, target)` 的 count 参数实际受 `Integer.MAX_VALUE` 约束（看 JDK 文档的说法是"某些平台一次传不完"，实践上记住**单次不超过 2GB、必须循环**就对了）；
- 目标必须是**普通 socket 或文件**。套了 SSL 的流不行，原因见第六节的坑 3。

### 4.3 需要改数据：mmap

```java
FileChannel fc = FileChannel.open(Paths.get(file), READ, WRITE);
MappedByteBuffer mbb = fc.map(FileChannel.MapMode.READ_WRITE, 0, fc.size());
// 之后 mbb.get(i) / mbb.put(i, v) 就像操作内存数组
```

适合"要随机读写文件内容"的场景。纯粹把文件原样发出去的场景，用 transferTo，别用 mmap 绕路。

## 五、实测：512MB 文件本机发送对比

### 5.1 环境

- 2 核 / 1.8GB 内存云主机，磁盘普通云盘
- OpenJDK 11.0.13，Linux 内核 4.18
- 接收端：一个只收数据不处理的小 Python 脚本（相当于 `nc -l 9999 > /dev/null`）
- 测试文件：512MB 全零文件

### 5.2 复现步骤（可直接照抄）

```bash
# 0) 目录
mkdir -p bench && cd bench

# 1) 生成 512MB 测试文件
dd if=/dev/zero of=test-512m.bin bs=1M count=512 status=none

# 2) 接收端（收完丢弃），后台挂着
python3 -c '
import socket
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 9999)); s.listen(5)
while True:
    conn, _ = s.accept()
    while conn.recv(65536): pass
    conn.close()
' &
sleep 1

# 3) 发送端 Java 代码：见 4.1 / 4.2，编译
javac CopyBench.java

# 4) 各跑 3 次，记录 wall time 和进程 CPU（user/sys）
/usr/bin/time -f "stream:   real=%es user=%Us sys=%Ss" \
  java -Xmx64m CopyBench stream test-512m.bin 127.0.0.1 9999
/usr/bin/time -f "sendfile: real=%es user=%Us sys=%Ss" \
  java -Xmx64m CopyBench sendfile test-512m.bin 127.0.0.1 9999

# 5) 【关键】用 strace 数系统调用，验证机制
# strace 会拖慢进程，所以它的耗时数据不作数，只看"次数"
strace -f -c -e trace=read,write,writev,sendto,sendfile \
  java -Xmx64m CopyBench stream test-512m.bin 127.0.0.1 9999 2>&1 | tail -8
strace -f -c -e trace=read,write,writev,sendto,sendfile \
  java -Xmx64m CopyBench sendfile test-512m.bin 127.0.0.1 9999 2>&1 | tail -8
```

**strace**（sequence trace）是 Linux 的系统调用跟踪器：把进程做过的每个系统调用记下来数给你看。它是验证"零拷贝到底生效没有"的最硬证据——比任何 benchmark 都硬。

### 5.3 实测数据

传统模式的系统调用统计（真实输出）：

```text
% time     seconds  usecs/call     calls    syscall
 53.63    0.582501           8     65663    read
 46.36    0.503552           7     65542    sendto
  0.00    0.000043           2        19    write
------ ----------- ----------- --------- --------
100.00    1.086096                 131224    total
```

零拷贝模式（真实输出）：

```text
% time     seconds  usecs/call     calls    syscall
 99.04    0.123839      123839         1     sendfile
  0.89    0.001113           9       121     read     # JVM 启动本身的一些读
  0.07    0.000087           4        19     write
------ ----------- ----------- --------- --------
100.00    0.125039         886       141     total
```

**65,663 次 read + 65,542 次 sendto，一共 13.1 万次系统调用；换成 transferTo 之后，512MB 数据的传输只有 1 次 sendfile**（内核内部自己分片，一次调用传完）。

性能数据（不带 strace，冷缓存/热缓存各跑了多轮，取稳定值）：

| 指标 | read + write | transferTo |
| --- | --- | --- |
| 数据通道系统调用次数 | ~131,000 | **1** |
| 系统调用 CPU 时间 | ~1.09s（strace 下放大，仅作对比） | ~0.13s |
| 进程 CPU（user+sys，多轮稳定） | ~0.35s | ~0.17~0.22s |
| 吞吐（本机） | ~95~110 MB/s | ~94~107 MB/s |

### 5.4 怎么解读这组数据

两句话说清楚：

1. **吞吐为什么持平？** 这台机器的瓶颈在磁盘冷读速度（约 100MB/s 的云盘）和只有 2 个核，两条路都在等磁盘，自然快不起来。瓶颈在你的网带宽、且 CPU 被下载打满的生产机器上，这部分省下的 CPU 会直接换成吞吐或并发数。
2. **真正的收益在哪？** CPU 时间 0.35s → 0.17s，**减半**。一个 4 核 8G 的下载服务，原来 1000 个并发下载把 CPU 打满，换零拷贝后同样的 CPU 能多扛接近一倍的下载并发——或者反过来，同样的并发量，机器可以缩配，这就是成本。

### 5.5 不写 Java 也能验证

想只动 Nginx 感受一下？把静态资源服务的 `sendfile` 开关来回切，用 `curl -w "%{time_total}\n" -o /dev/null` 下载同一个大文件，观察 CPU（`top` 看 `%wa`、`%sy`）的变化。Nginx 默认 `sendfile off`，生产上开静态服务一般都会打开它，原理同本文。

## 六、常见坑与误区

1. **transferTo 单次上限约 2GB**。count 参数实际受 `Integer.MAX_VALUE` 约束，传大文件必须写循环（本文代码就是循环写法）。不写循环，超过 2GB 直接翻车。
2. **数据要加工就不能用**。sendfile 的前提是"没人想看这份数据"。你要顺手压缩、加密、脱敏、改格式，数据就必须进用户态，老老实实回 read/write 路线。零拷贝不是银弹，是特定场景的优化。
3. **HTTPS 场景在 Java 侧不适用**。`SSLSocket`/`SSLSocketChannel` 包在外面之后，数据要先过 TLS 加密，transferTo 直达不了。生产上的常见做法是 Java 只管业务，静态文件交给 Nginx，让 Nginx 的 `sendfile on` 去吃这口红利；内核 4.17+ 还有 **kTLS**（内核里的 TLS 加密，让 sendfile 能对加密连接继续生效），Nginx 1.21.4+ 配合 `ssl` 时可以开。
4. **page cache 会干扰测速**。同一个文件读第二遍走的是内存不是磁盘，吞吐能"虚高"好几倍。要做冷启动测试得先清缓存：`echo 3 > /proc/sys/vm/drop_caches`。**生产机器别乱清**，会把所有热数据清没，引发一波磁盘 IO 风暴。
5. **别只盯吞吐**。本文实测里吞吐没变但 CPU 减半，如果只对比"耗时"就得出"零拷贝没用"的结论，就错过了真正的收益维度（CPU 成本/并发容量）。压测时把 user/sys CPU、上下文切换（`pidstat -w 1`）一起看。
6. **mmap 的两个暗坑**：映射后文件被截短，访问越界直接 **SIGBUS** 进程崩溃；写映射区域不是实时落盘，宕机可能丢最近一段，要么接受、要么定期 `fc.force()`。
7. **小文件别教条**。几 KB 的文件，sendfile 省下的 CPU 还抵不上调用开销的波动，流式写法完全够用。优化要对着瓶颈去，不是对着名词去。

## 七、Kafka 和 Netty 里的影子

最后把这些知识挂回到你熟悉的组件上：

- **Kafka**：broker 给 consumer 传日志段（segment 文件）用的就是 transferTo/sendfile 这条路，因为日志是"只读透传"，没人加工它，完美符合零拷贝场景；而它的稀疏索引文件因为要随机读写，用的是 mmap。一个项目里两条路线并存，各有各的岗位。
- **Netty**：`FileRegion` 接口底层就是 transferTo；`CompositeByteBuf`、堆外内存那些"零拷贝"是 JVM 缓冲层面的概念。下次面试聊 Netty 零拷贝，可以先问一句"你说的是 OS 层还是缓冲层"，直接把话题拉到你的主场。

## 八、总结

- 传统 read+write 一趟要 **4 次拷贝（2 次烧 CPU）+ 每循环 4 次上下文切换**，512MB 文件实测 13.1 万次系统调用。
- sendfile 让数据**不进用户态**，拷贝降到 3 次；网卡支持 SG-DMA 时降到 2 次（全 DMA，CPU 不搬）。
- Java 里 `FileChannel.transferTo` 一行映射到 sendfile；记住**单次 2GB 上限要循环**、**目标不能是 SSL 流**。
- 本机实测：系统调用 13.1 万次 → 1 次，进程 CPU 减半；吞吐在磁盘瓶颈的小机器上看不出差异——**收益在 CPU 成本和并发容量，不总在吞吐**。
- 要加工数据（压缩/加密）就用不了零拷贝；HTTPS 场景交给 Nginx sendfile 或 kTLS。
- 验证手段优先级：`strace -c` 数系统调用 > `/usr/bin/time` 看 user/sys CPU > 单看吞吐时间。

## 参考资料

1. Linux manual page: sendfile(2) —— <https://man7.org/linux/man-pages/man2/sendfile.2.html>
2. Java SE API 文档：FileChannel（transferTo/transferFrom 语义与限制）—— <https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/nio/channels/FileChannel.html>
3. Wikipedia: Zero-copy —— <https://en.wikipedia.org/wiki/Zero-copy>
4. Apache Kafka 官方文档（Design 章节，日志存储与高效传输的设计取舍）—— <https://kafka.apache.org/documentation/>
5. Nginx 文档：ngx_http_core_module 的 sendfile 指令 —— <https://nginx.org/en/docs/http/ngx_http_core_module.html#sendfile>
6. Norman Maurer，《Netty 实战》（Netty in Action）：ByteBuf 与 Netty 缓冲层"零拷贝"的区别
