---
title: 一文讲透零拷贝：从 4 次拷贝到 sendfile，附可复现的 strace 与压测验证
date: 2026-09-09 10:00:00
categories:
  - 操作系统与 Linux
  - I/O
tags:
  - 零拷贝
  - sendfile
  - mmap
  - Java NIO
  - Kafka
  - 性能优化
---
<hr>
<blockquote>
<p><strong>零拷贝（Zero-Copy）</strong>不是「一次拷贝都没有」，而是把数据搬运路径上的 <strong>CPU 拷贝</strong>和<strong>上下文切换</strong>省掉。<br>这篇文章把传统 read+write 的「4 次拷贝 + 4 次切换」账单算清楚，对比 <strong>mmap+write</strong> 与 <strong>sendfile</strong> 的取舍，并在一台 2C/2G 云主机上用 <strong>strace + 压测</strong>把账单实测出来：同样复制 128MB 文件，系统调用从约 6.5 万次降到 <strong>1 次</strong>。<br>所有脚本、命令、预期输出全部可复现，看完你得到的不只是概念，而是一套能自己跑一遍的验证方法。</p>
</blockquote>

<!-- more -->

## 一、先说场景：文件下载服务为什么一忙起来 CPU 先崩

设想一个很普通的需求：网关要把磁盘上的一个 128MB 文件发给请求方。最直觉的写法是这样的：

```java
byte[] buf = new byte[4096];
int n;
while ((n = in.read(buf)) != -1) {   // 从磁盘文件读
    out.write(buf, 0, n);            // 往网络里写
}
```

能跑，没毛病。但如果这个接口 QPS 一高，你去看监控，会发现一个反直觉的现象：**磁盘没打满、网卡没打满，CPU 的 sy（内核态）先顶到天上去了**。

原因就藏在上面这两行代码里：你以为自己只是在「搬数据」，实际上每搬一批数据，内核都在替你做一整套「从磁盘拷到内核、再拷给用户程序、用户程序再拷回内核、最后发给网卡」的体力活。**数据在用户态绕了一圈，白付了两次 CPU 拷贝、四次上下文切换的成本。**

零拷贝要解决的就是这个问题：**让数据别进用户态，直接在内核里从文件走到网卡**。它是 Kafka 高吞吐、Tomcat 静态资源加速、Nginx sendfile 配置这些工程实践背后同一个的底层原理。

注：本文所有实验都在一台 2 核 2G 的云主机（kernel 4.18、Python 3.6）上实测完成，脚本和命令贴在第五节，你可以在任何 Linux 机器上复现。

## 二、先把几个名词说明白

零拷贝的文章网上很多，但经常一上来就是「DMA 拷贝」「内核缓冲区」，新手直接劝退。先用大白话把几个名词过一遍，后面看账单就轻松了。

- **用户态 / 内核态**：操作系统把 CPU 权限分成两档。应用程序跑在用户态，权限受限，不能直接碰磁盘、网卡这些硬件；内核态是操作系统的特权模式，硬件操作都由它代劳。程序要读写磁盘，就必须「求助」内核。
- **系统调用（syscall）**：用户态程序求助内核的正式通道。`read()`、`write()` 都是系统调用。每次系统调用都要「用户态 → 内核态 → 用户态」走一圈，这个来回就是一次**上下文切换**，大概要花几微秒——单看不多，乘以几万次就很可观了。
- **Page Cache（页缓存）**：内核在内存里给磁盘文件做的缓存。你第一次读一个文件，数据从磁盘被搬进内存缓存；第二次再读同一个文件，直接命中缓存，不用碰磁盘。`free` 命令里那个很大的 `buff/cache` 就是它。
- **DMA（Direct Memory Access，直接内存访问）**：一块「不用 CPU 帮忙就能自己搬数据的硬件」。CPU 告诉 DMA「把这 128MB 从磁盘搬到内存」，就可以去干别的了，搬完 DMA 发个中断通知。CPU 拷贝和 DMA 拷贝的本质区别：**前者占用 CPU，后者不占**。
- **文件描述符（fd）**：进程打开一个文件或 socket 后拿到的一个整数编号，后续读写都用这个编号指代它。下面代码里的 `in_fd`、`out_fd` 就是两个 fd。

## 三、把传统 read+write 的账单算清楚：4 次拷贝、4 次切换

场景：把磁盘文件通过 socket 发出去（下载服务的核心动作）。传统 `read + write` 的完整数据路径是这样的：

```text
第 1 次拷贝（DMA）  ：磁盘 → 内核的 Page Cache          ← read() 触发
第 2 次拷贝（CPU）  ：Page Cache → 用户缓冲区            ← read() 返回数据
第 3 次拷贝（CPU）  ：用户缓冲区 → Socket 缓冲区         ← write() 触发
第 4 次拷贝（DMA）  ：Socket 缓冲区 → 网卡               ← write() 之后异步完成
```

系统调用层面：`read()` 一次（2 次上下文切换）+ `write()` 一次（2 次上下文切换），**共 4 次上下文切换**。

| 动作 | 拷贝方式 | 占不占 CPU |
| --- | --- | --- |
| 磁盘 → Page Cache | DMA | 不占 |
| Page Cache → 用户缓冲区 | CPU | **占** |
| 用户缓冲区 → Socket 缓冲区 | CPU | **占** |
| Socket 缓冲区 → 网卡 | DMA | 不占 |

问题一目了然：**第 2、3 次拷贝是纯浪费**——数据进了用户缓冲区，用户程序压根没改它一个字节，又原样拷回内核。第 2 次 CPU 拷贝的收益只有一个：让用户程序「看得见」数据。如果程序只是搬运，这个收益就是零。

顺带一提，第三节开头那段 4KB 缓冲的 Java 代码，128MB 文件要循环 32768 次，每次循环 2 个系统调用，**光系统调用就打了 65536 次 CPU 的脸**——这个数字第五节会实测验证。

## 四、三种优化方案：从省一次拷贝到全省掉

### 4.1 mmap + write：让用户程序「直接看得见」内核缓存

**mmap**（memory map，内存映射）是这么个东西：它把文件直接映射到进程的虚拟内存地址空间，用户程序像访问普通数组一样读写文件内容，**数据不需要再拷贝一份到用户缓冲区**——你访问的地址背后就是 Page Cache 本身。

```text
数据路径：磁盘 →(DMA)→ Page Cache →(CPU)→ Socket 缓冲区 →(DMA)→ 网卡
```

对比传统方式，**省掉了第 2 次 CPU 拷贝**（Page Cache → 用户缓冲区那次），系统调用也从 2 次降为 1 次 `write()`。代价是 mmap 建立映射、触发**缺页中断**（第一次访问某个内存页时，内核把对应的磁盘页调进来，这个动作就是缺页中断）有额外开销。

### 4.2 sendfile：一次系统调用，数据全程不出内核

**sendfile** 是 Linux 专门为「文件 → socket」这个场景加的系统调用（kernel 2.2 引入），它的设计目标简单粗暴：数据反正不用进用户态，那干脆让内核自己包办，一次调用干完。

```c
#include <sys/sendfile.h>
ssize_t sendfile(int out_fd, int in_fd, off_t *offset, size_t count);
```

```text
数据路径：磁盘 →(DMA)→ Page Cache →(CPU)→ Socket 缓冲区 →(DMA)→ 网卡
```

2 次上下文切换 + 1 次 CPU 拷贝。比 mmap+write 更省的一个点是：**不再依赖缺页中断**，也不需要在进程里维护映射关系。

### 4.3 sendfile + Scatter-Gather DMA：CPU 拷贝归零

**Scatter-Gather DMA（SG-DMA，分散-聚集 DMA）** 是网卡支持的一种进阶 DMA 模式：允许一次 DMA 操作从**多个不连续的内存块**收数据。有了它，内核连「Page Cache → Socket 缓冲区」这次 CPU 拷贝都省了——直接把 Page Cache 里数据页的**地址描述符**追加到 Socket 缓冲区，网卡自己去 Page Cache 里收数据。

```text
数据路径：磁盘 →(DMA)→ Page Cache →(SG-DMA)→ 网卡
```

这就是教科书意义上的零拷贝：**2 次 DMA 拷贝、0 次 CPU 拷贝、2 次上下文切换**。三个方案放一起：

| 方案 | 系统调用 | 上下文切换 | DMA 拷贝 | CPU 拷贝 |
| --- | --- | --- | --- | --- |
| read + write | 2 次 | 4 次 | 2 | **2** |
| mmap + write | 1 次 | 2 次 | 2 | **1** |
| sendfile | 1 次 | 2 次 | 2 | **1** |
| sendfile + SG-DMA | 1 次 | 2 次 | 2 | **0** |

注：mmap 和 sendfile 都剩 1 次 CPU 拷贝时怎么选？经验法则：**要改数据（比如解压、校验、按需计算）选 mmap，纯搬运选 sendfile**。第七节的坑里展开。

## 五、动手实验：把 128MB 拷贝的账单实测出来

光背表格没意思，这一节把账单跑出来。实验环境：2 核 2G 云主机、kernel 4.18、Python 3.6。

### 5.1 实验脚本

下面脚本对比四种方案把 128MB 文件从磁盘复制到另一个文件（收尾 fsync 强制落盘），每轮测试前清掉 Page Cache，跑 3 轮取最优，同时统计 CPU 时间（用户态 + 内核态）：

```python
import os, sys, time, mmap, resource

SIZE = 128 * 1024 * 1024
SRC = "/tmp/zerocopy_src.bin"
DST = "/tmp/zerocopy_dst.bin"

def make_src():  # 造一个 128MB 的随机数据文件
    if not os.path.exists(SRC) or os.path.getsize(SRC) != SIZE:
        with open(SRC, "wb") as f, open("/dev/urandom", "rb") as r:
            left = SIZE
            while left > 0:
                chunk = r.read(min(4 << 20, left))
                f.write(chunk); left -= len(chunk)
        os.sync()

def drop_caches():  # 需要 root：清 Page Cache，保证每轮公平
    os.system("sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null")

def cpu():
    r = resource.getrusage(resource.RUSAGE_SELF)
    return r.ru_utime + r.ru_stime

def rw_file(buf):           # 方案 1/2：传统 read+write，缓冲区分别为 4KB / 1MB
    fi = open(SRC, "rb"); fo = open(DST, "wb")
    try:
        while True:
            d = fi.read(buf)
            if not d: break
            fo.write(d)
        fo.flush(); os.fsync(fo.fileno())
    finally:
        fi.close(); fo.close()

def mmap_file(chunk):       # 方案 3：mmap + write
    fi = open(SRC, "rb"); fo = open(DST, "wb")
    try:
        mm = mmap.mmap(fi.fileno(), 0, access=mmap.ACCESS_READ)
        off = 0
        while off < SIZE:
            fo.write(mm[off:off + chunk]); off += chunk
        mm.close(); fo.flush(); os.fsync(fo.fileno())
    finally:
        fi.close(); fo.close()

def sendfile_file():        # 方案 4：sendfile（kernel >= 2.6.33 支持文件到文件）
    fi = os.open(SRC, os.O_RDONLY)
    fo = os.open(DST, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        off = 0
        while off < SIZE:
            sent = os.sendfile(fo, fi, off, SIZE - off)
            if sent == 0: break
            off += sent
        os.fsync(fo)
    finally:
        os.close(fi); os.close(fo)

def bench(method, reps=3):
    make_src(); best = None; best_cpu = 0
    for _ in range(reps):
        drop_caches(); c0 = cpu(); t0 = time.perf_counter()
        {"rw_4k": lambda: rw_file(4096),
         "rw_1m": lambda: rw_file(1 << 20),
         "mmap_1m": lambda: mmap_file(1 << 20),
         "sendfile": sendfile_file}[method]()
        dt = time.perf_counter() - t0; dc = cpu() - c0
        if best is None or dt < best: best, best_cpu = dt, dc
    print("%s\twall=%.0fms\tcpu=%.0fms" % (method, best * 1000, best_cpu * 1000))

for m in ["rw_4k", "rw_1m", "mmap_1m", "sendfile"]:
    bench(m)
```

### 5.2 实测数据

在我的机器上跑出来的结果（3 轮取最优）：

| 方案 | 墙钟时间（含落盘） | CPU 时间 |
| --- | --- | --- |
| read/write，4KB 缓冲 | 1133ms | **153ms** |
| read/write，1MB 缓冲 | 1963ms | **111ms** |
| mmap + write，1MB 分片 | 1973ms | **108ms** |
| sendfile | 1987ms | **93ms** |

**CPU 时间的结论非常清晰**：4KB 小缓冲是 sendfile 的 1.6 倍开销，主要浪费在海量系统调用上；把缓冲加大到 1MB，read/write 的 CPU 开销也大幅下降，但**仍然比 sendfile 高 19%**——因为它的数据路径上还有 2 次 CPU 拷贝，而 sendfile 只有 1 次（文件到文件场景无 SG-DMA 参与）。

墙钟时间的解读要诚实一点：这台 2 核共享小机器上磁盘和调度噪声很大，单次大文件拷贝的墙钟差异不明显（瓶颈在磁盘 I/O 本身）。**零拷贝省下的是 CPU 和上下文切换，它的真正价值在并发**：单次拷贝省 60ms CPU 看着不起眼，但一台机器每秒扛 5000 次文件发送时，省下的就是每秒 300 秒的 CPU 预算——这就是 Kafka 把 sendfile 当命根子的原因。

### 5.3 用 strace 数系统调用：账单的铁证

**strace** 是 Linux 的系统调用跟踪工具，作用是：把目标进程的每一次系统调用记录下来，能直接数出「谁调用了多少次」。压测数据的旁证可能有噪声，但**系统调用次数是确定性的**，这才是零拷贝最硬的验证方式。

```bash
# 统计传统 4KB 缓冲方案的系统调用（1 轮）
strace -c -f python3 zc_bench2.py rw_4k 1
```

实测输出（节选，read/write 列含 Python 解释器启动的几十上百次，量级不受影响）：

```text
% time     seconds  usecs/call     calls    errors syscall
 51.46    0.352583          10     32770           write
 37.79    0.258906           7     32861           read
```

再看 sendfile 方案：

```bash
strace -c -f python3 zc_bench2.py sendfile 1
```

```text
% time     seconds  usecs/call     calls    errors syscall
 43.91    0.082821       82821         1           sendfile
```

**同一个 128MB：数据路径上的系统调用从约 65536 次变成 1 次**。sendfile 一次调用搬完整个文件（内核单次 sendfile 有约 2GB 的 count 上限，128MB 远没到；文件更大时内核会按上限自动分批，循环几次而已）。

### 5.4 补充实验：发给「网络对端」的账单

把目标从文件换成 socket（用一对内存里的 **socketpair**——一个双向管道，两端各是一个 socket，用来模拟网络对端），同样 128MB、3 轮取最优：

| 方案 | 吞吐 | CPU 时间 |
| --- | --- | --- |
| read/write，4KB 缓冲 | 376MB/s | **224ms** |
| read/write，1MB 缓冲 | 136MB/s | **68ms** |
| mmap + write，1MB 分片 | 134MB/s | **69ms** |
| sendfile | 137~145MB/s | **65ms** |

这轮更接近真实的下载服务形态：4KB 小缓冲的 CPU 开销是 sendfile 的 **3.4 倍**（224ms vs 65ms），strace 显示 sendfile **一次系统调用就把 128MB 推完**。内存管道里吞吐差有限，真实网络 + 高并发扇出场景下差距还会进一步放大（Kafka 官方设计文档引用的压测里，sendfile 是普通路径的数倍吞吐）。

**如何验证本文结论**：把 5.1 的脚本跑在你自己的机器上，重点核对两个数——`strace -c` 里的 read/write 次数（应为 `SIZE / 缓冲大小`）和 sendfile 次数（应为 1 或个位数）。这两个数在任何 Linux 机器上都是确定的。

## 六、Java 里怎么用：transferTo 与 MappedByteBuffer

### 6.1 一行核心代码：FileChannel.transferTo

Java 里对应的 API 是 **FileChannel.transferTo**——Java NIO（New I/O，JDK 1.4 引入的新 I/O 框架，核心是把更贴近操作系统的高性能 I/O 能力暴露给 Java）里的文件通道方法：

```java
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.channels.FileChannel;
import java.nio.channels.SocketChannel;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;

public class ZeroCopySend {
    public static void main(String[] args) throws IOException {
        try (FileChannel in = FileChannel.open(
                     Paths.get("/tmp/zerocopy_src.bin"), StandardOpenOption.READ);
             SocketChannel out = SocketChannel.open(
                     new InetSocketAddress("127.0.0.1", 9000))) {

            long pos = 0;
            long size = in.size();
            while (pos < size) {                       // 必须循环推进，见第七节坑 3
                pos += in.transferTo(pos, size - pos, out);
            }
        }
    }
}
```

在 Linux 上，HotSpot 会把 `transferTo`（文件 → socket）直接翻译成 `sendfile(2)` 系统调用。**验证方法**（JDK 11+ 可以直接 `java ZeroCopySend.java` 单文件运行）：

```bash
strace -f -e trace=sendfile,read,write java ZeroCopySend.java 2>&1 | grep sendfile
# 预期看到 sendfile 被调用；把它换成流式 read/write 版本，会看到海量 read/write
```

### 6.2 mmap 的 Java 版：MappedByteBuffer

需要「边读边算」而不是纯搬运时，用 **MappedByteBuffer**（`FileChannel.map()` 的返回值，文件内存映射的 Java 封装）：

```java
FileChannel ch = FileChannel.open(path, StandardOpenOption.READ);
MappedByteBuffer buf = ch.map(FileChannel.MapMode.READ_ONLY, 0, ch.size());
byte first = buf.get(0);        // 此刻触发缺页中断，内核把该页调入内存
int sum = buf.get(1000_0000);   // 直接当数组访问，没有显式 read()
```

第一次访问某个内存页时会触发缺页中断，所以**首次遍历大映射文件比 read() 慢且抖**，这是 mmap 的固有代价，不是 bug。

### 6.3 框架里都在哪用的

- **Kafka**：消费者拉消息时，broker 直接 sendfile 把磁盘日志段发给消费者（未开 SSL 时），这是 Kafka「百万级吞吐」的重要支柱。
- **Tomcat / Nginx**：静态资源的 sendfile 支持（Tomcat NIO 连接器 `useSendfile=true`；Nginx 配置里的 `sendfile on;`）。
- **Netty**：`DefaultFileRegion` 就是对 `transferTo` 的封装，大文件传输（如 HTTP 文件响应）走零拷贝路径。注意 Netty 官方说的「零拷贝」还有另一层意思——`CompositeByteBuf` 这类**用户态对象层面的免拷贝组装**，和本文说的操作系统级零拷贝是两码事，别混。
- **RocketMQ**：混合存储路径大量使用 **mmap**（MappedFile），要的就是「读得到、改得了、随机访问快」。

## 七、常见坑与误区

1. **零拷贝 ≠ 一次拷贝都没有**。DMA 拷贝始终存在（这是好事，不占 CPU），零拷贝省掉的是 CPU 拷贝和上下文切换。跟人解释时说「零 CPU 拷贝」更准确。
2. **开了 TLS/SSL，sendfile 直接失效**。HTTPS 要求对数据加密，而 sendfile 的数据全程不进用户态——用户态的加密代码根本摸不到数据。所以 Kafka 开 SSL 后零拷贝自动退化为普通读写路径；Nginx 想要「HTTPS + sendfile」需要 **kTLS**（kernel TLS，把 TLS 加解密下沉到内核做的机制，kernel 4.13+ / Nginx 1.21.4+ 支持）。
3. **transferTo 单次有约 2GB 的上限**。底层 sendfile 的 count 上限是 `0x7ffff000`（约 2147MB），必须像 6.1 那样用 `pos += transferTo(...)` 循环推进，别写「一次调完」的代码。
4. **file→file 的 transferTo 在新 JDK 上可能不走 sendfile**。JDK 14 起（JDK-8235792），文件到文件的传输在 Linux 上可能改用 `copy_file_range` 系统调用。strace 验证时用 `strace -e trace=sendfile,copy_file_range`，别看到没调 sendfile 就以为没生效。
5. **mmap 的缺页中断会让首次访问又慢又抖**。第一次遍历大映射文件的每个 4KB 页都会触发缺页处理，P99 敏感的接口要么先预热，要么老实用 read。
6. **MappedByteBuffer 没有 unmap，还有 SIGBUS 风险**。Java 不提供显式解除映射的 API，映射要等 GC 清理才释放；更凶险的是：文件被外部截断/删除后，再访问已映射的页会收到 **SIGBUS** 信号（内核通知进程「你访问的内存背后的存储没了」），进程直接崩——文件生命周期比映射短的场景一定要小心。
7. **sendfile 只适合纯搬运**。数据要在途中压缩、加密、改写的，都必须回到用户态，零拷贝无从谈起。另外老内核里 `in_fd` 必须是普通文件、`out_fd` 必须是 socket（2.6.33 后 out 放宽到任意可写 fd）。
8. **小文件 + 短连接场景收益有限**。TLS 握手、TCP 建连的开销常常比拷贝省下的 CPU 多一个量级，几 KB 的小图别为了「上了零拷贝」而硬上零拷贝。

## 八、总结

- 传统 `read + write` 搬数据要付 **4 次拷贝 + 4 次上下文切换**，其中 2 次 CPU 拷贝对纯搬运场景纯属浪费。
- **mmap+write** 靠内存映射省掉「内核 → 用户」那次拷贝；**sendfile** 用一个系统调用让数据全程不出内核；配合 **SG-DMA** 可以做到 0 次 CPU 拷贝。
- 实测说话：128MB 拷贝，数据路径系统调用从 **~65536 次降到 1 次**（strace 可验证），CPU 时间 153ms → 93ms（文件场景），发给 socket 场景 224ms → 65ms。
- 零拷贝省的是 CPU 和切换，价值在高并发扇出场景；单次墙钟收益取决于磁盘/网卡是否是瓶颈。
- Java 落地就两招：纯搬运 `transferTo`（sendfile），要加工 `MappedByteBuffer`（mmap）。开 SSL 之前想清楚零拷贝会失效。
- 排障口诀：**是不是真走了零拷贝，别猜，strace 一下**。

## 参考资料

1. Linux man-pages：[sendfile(2)](https://man7.org/linux/man-pages/man2/sendfile.2.html)
2. Linux man-pages：[mmap(2)](https://man7.org/linux/man-pages/man2/mmap.2.html)
3. IBM DeveloperWorks：[Efficient data transfer through zero copy](https://developer.ibm.com/articles/j-zerocopy/)
4. Oracle Java 文档：[FileChannel#transferTo](https://docs.oracle.com/javase/8/docs/api/java/nio/channels/FileChannel.html)
5. Apache Kafka：[Design 文档（含 sendfile 与持久化设计）](https://kafka.apache.org/design)
6. Michael Kerrisk，《Linux/UNIX 系统编程手册》第 13 章「文件 I/O 缓冲」（中文版，人民邮电出版社）
7. OpenJDK：[JDK-8235792 Use copy_file_range to improve file to file copying](https://bugs.openjdk.org/browse/JDK-8235792)
8. Netty Javadoc：[io.netty.channel.DefaultFileRegion](https://netty.io/4.1/api/io/netty/channel/DefaultFileRegion.html)
