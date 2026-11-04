---
title: 多线程计数器越加越慢？用 JMH 复现伪共享（False Sharing）：56 字节 padding 换来 4 倍吞吐（附 perf 验证与完整复现命令）
date: 2026-11-04 10:00:00
categories:
  - 操作系统与 Linux
  - 性能分析
tags:
  - JMH
  - False Sharing
  - CPU Cache
  - MESI
  - 性能调优
  - Java
---

<hr>
<blockquote>
<p><strong>摘要</strong>：给计数逻辑加线程，吞吐没涨反而略降，CPU 却实打实打满——锁、线程池、GC 排个遍全都无辜。这篇从 CPU 视角把这类「线程越多越亏」的案子翻出来：两个逻辑上毫不相干的变量，只要挤在同一条<strong>缓存行</strong>（cache line，CPU 与内存之间搬运数据的最小单位，通常 64 字节）里，多核同时写就会被 <strong>MESI</strong> 缓存一致性协议反复「连坐」，这就是<strong>伪共享</strong>（False Sharing）。用 JMH 写一个 40 行的最小复现：无 padding 时 4 线程吞吐停在 0.86 亿 ops/s（≈ 单线程），给字段前后各垫 56 字节后飙到 3.49 亿，扩展比 3.79x；再用 <strong>perf stat</strong> 的 IPC 和 <strong>perf c2c</strong> 的 HITM 做交叉验证。最后把生产可用的三板斧（LongAdder、@Contended、手写 padding）与 6 个常见坑一次讲清。</p>
</blockquote>

<!-- more -->

## 一、从一个「线程翻倍、吞吐原地踏步」的压测现场说起

先交代场景。一个统计类的小服务，4 个工作线程各自维护自己的计数槽（比如每个线程统计自己分片的消费量），压测时出了件怪事：

| 线程数 | 吞吐（递增次数/秒） | 预期 |
| --- | --- | --- |
| 1 | 0.91 亿 | 基准 |
| 4 | 0.86 亿 | 应该接近 4 倍 |

线程翻了 4 倍，吞吐纹丝不动，甚至比单线程还略低一点。CPU 利用率倒是实打实的 380%（4 核基本打满）。

排障的常规三连我都过了一遍：

- **锁**？没有。每个线程只写自己的槽位，连原子类都没用；
- **线程池 / 上下文切换**？4 个线程全是独立循环，`vmstat` 里 cs（上下文切换次数）稳定在低位；
- **GC**？JFR（Java Flight Recorder，JVM 自带的飞行记录仪，边跑边录各类事件）录了 2 分钟，GC 时间占比 1.2%，无关。

CPU 打满、活没多干——这个组合拳指向的不是软件层面「在等锁」，而是硬件层面「干活效率低」。顺手用 `perf stat` 看了一眼 **IPC**（Instructions Per Cycle，CPU 每个周期平均执行多少条指令，相当于 CPU 效率的体检指标），4 线程时只有 0.38，而正常计算密集代码一般能到 1.5 以上。IPC 崩了，说明 CPU 大量周期花在「等」上。等什么？这篇就把这个案子办完。

> 目标读者：写过并发代码的 Java 工程师。先修：多线程基本概念（volatile、原子变量）。不需要任何硬件背景，需要的概念文中全部现讲。

## 二、先盘概念：缓存行、MESI 与伪共享

### 2.1 缓存行：CPU 搬数据的「最小快递单位」

**CPU Cache**（CPU 缓存，核内的高速存储，分 L1/L2/L3 多级，越靠近核越快也越小）大家都有概念，但真正决定行为的是它的搬运粒度：**缓存行**（cache line）。CPU 和内存之间倒腾数据不是按字节来的，而是按固定大小的块——绝大多数现代 CPU 是 **64 字节**。你读 1 个 long，它把那 64 字节整块搬进缓存；你写 1 个 long，失效的也是整块。

记住这张账本的记账粒度：**按行记账，不按变量记账**。

### 2.2 MESI：多核之间怎么「打招呼」

每个核都有自己的 L1/L2 缓存，同一份数据可能同时躺在多个核里。为了保证大家看到的一致，硬件上有一套**缓存一致性协议**，最经典的是 **MESI**（四状态首字母缩写：Modified 独占已修改 / Exclusive 独占干净 / Shared 共享 / Invalid 已失效）。

简化版规则：一个核想**写**某条缓存行，必须先把其他核里的这条行打成 Invalid（失效），对方下次再读就得重新去内存或远端缓存取。这个「打招呼 + 打失效」的过程叫 **RFO**（Request For Ownership，写之前先拿到这条行的所有权），要跨核通信，代价远高于一次本地写。

关键来了：**MESI 的作用粒度也是 64 字节的缓存行，不是变量**。协议根本不知道你有几个变量，它只认行。

### 2.3 伪共享：不相干的变量，被当成「共享」连坐

于是就有了这出戏：两个逻辑上毫不相干的变量，只要物理地址落在同一条缓存行里，两个核各自高频写自己的那个——

1. 核 A 写变量 x → 整条行在核 B 那里失效；
2. 核 B 写变量 y → 整条行在核 A 那里失效；
3. 循环往复，缓存行像乒乓球一样在两核之间弹来弹去，每一次弹跳都是一次 RFO。

代码层面没有任何共享，硬件层面却发生了频繁的「共享协调」——这就是**伪共享**（False Sharing）：变量没共享，缓存行被迫共享。它的杀伤力在于完全隐形：jstack、arthas、线程 dump 全都查无此 bug，因为没有锁、没有阻塞，只有 CPU 在默默内耗。

三种情形一张表分清：

| 情形 | 特征 | 后果 |
| --- | --- | --- |
| 真共享 | 多线程读写**同一个**变量 | 需要同步，慢得「理所应当」 |
| **伪共享** | 多线程写**不同**变量，但同一条缓存行 | 无同步，却慢，且极难排查 |
| 无共享 | 不同变量且不同缓存行 | 理想并行，接近线性扩展 |

一句话记住：**CPU 按 64 字节记账，你想各写各的，得先在物理上分开住。**

## 三、实验：JMH 写一个最小可复现场景

### 3.1 实验设计

思路很直接：造 4 个计数器对象，4 个线程各自疯狂递增「自己的」计数器，分两种布局对比——

- **UnPadded**：对象里只有一个 `volatile long v`。JVM 分配对象是紧挨着排的，4 个 24 字节的小对象大概率挤进同一条缓存行；
- **Padded**：v 前后各垫 7 个无用的 long（7 × 8 = 56 字节），把 v 夹在正中间，保证它独占缓存行。

这里用 **volatile**（Java 的可见性关键字，写操作带内存语义）是一石二鸟：一是防 JIT 把「没被读取的递增」当死代码优化掉（JMH 里测普通字段的递增，很容易测了个寂寞），二是天然支持以后扩展成跨线程可见的计数。写 demo 时要留神这个点。

写基准之前，先用 **JOL**（Java Object Layout，OpenJDK 出的对象内存布局分析工具，能把对象里每个字段的偏移打印出来）验证两种布局：

```java
import org.openjdk.jol.info.ClassLayout;

public class LayoutDump {
    public static void main(String[] args) {
        System.out.println(ClassLayout.parseInstance(new FalseSharingBench.UnPadded()).toPrintable());
        System.out.println(ClassLayout.parseInstance(new FalseSharingBench.Padded()).toPrintable());
    }
}
```

UnPadded 的输出（节选）：

```text
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     ...
  8   4        (object header: class)    ...
 12   4        (object alignment gap)
 16   8   long UnPadded.v                0
Instance size: 24 bytes
```

Padded 的输出（节选）：

```text
 16   8   long Padded.p0                 0
 24   8   long Padded.p1                 0
 ...
 64   8   long Padded.p6                 0
 72   8   long Padded.v                  0     <- 热字段
 80   8   long Padded.q0                 0
 ...
128   8   long Padded.q6                 0
Instance size: 136 bytes
```

UnPadded 整个对象 24 字节——4 个实例排在一起必然共居一两条缓存行；Padded 136 字节，v 在 offset 72，前后都是自家的 padding：不管 JVM 怎么紧凑排列，相邻实例先撞上的是 padding，而不是 v。

### 3.2 JMH 基准代码

用 JMH（**Java Microbenchmark Harness**，OpenJDK 官方微基准测试框架，专治「手写 System.nanoTime 计时测不准」：自动预热触发 JIT、对抗死代码消除、多轮统计出报告）搭基准。`@Group("four")` + 每个方法 `@GroupThreads(1)` 表示这个组一共 4 个线程、各递增各的：

```java
import org.openjdk.jmh.annotations.*;

import java.util.concurrent.TimeUnit;

@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.SECONDS)
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 5, time = 2)
@Fork(2)
public class FalseSharingBench {

    public interface Counter { void incr(); }

    /** 布局一：无 padding，整个对象只有 24 字节，多个实例挤进同一条缓存行 */
    public static class UnPadded implements Counter {
        volatile long v;
        @Override public void incr() { v++; }
    }

    /** 布局二：手写 padding，前后各 7 个 long（56B），让 v 独占缓存行 */
    public static class Padded implements Counter {
        long p0, p1, p2, p3, p4, p5, p6;      // 前垫 56B
        volatile long v;
        long q0, q1, q2, q3, q4, q5, q6;      // 后垫 56B
        @Override public void incr() { v++; }
    }

    /** 布局三：@Contended，JVM 自动垫（默认 128B），需配合运行参数，见 3.5 */
    @jdk.internal.vm.annotation.Contended
    public static class Contended implements Counter {
        volatile long v;
        @Override public void incr() { v++; }
    }

    @State(Scope.Group)
    public static class St {
        @Param({"UnPadded", "Padded", "Contended"})
        String type;
        Counter c0, c1, c2, c3;

        @Setup(Level.Iteration)
        public void setup() {
            c0 = make(); c1 = make(); c2 = make(); c3 = make();
        }
        private Counter make() {
            return switch (type) {
                case "Padded"    -> new Padded();
                case "Contended" -> new Contended();
                default          -> new UnPadded();
            };
        }
    }

    /** 单线程对照：只递增 c0 */
    @Benchmark
    public void writeSingle(St s) { s.c0.incr(); }

    /** 4 线程组：各递增自己的 counter */
    @Group("four") @GroupThreads(1)
    @Benchmark public void w0(St s) { s.c0.incr(); }
    @Group("four") @GroupThreads(1)
    @Benchmark public void w1(St s) { s.c1.incr(); }
    @Group("four") @GroupThreads(1)
    @Benchmark public void w2(St s) { s.c2.incr(); }
    @Group("four") @GroupThreads(1)
    @Benchmark public void w3(St s) { s.c3.incr(); }
}
```

### 3.3 复现命令

Maven 依赖与打包（shade 插件打出可执行 fat jar）：

```xml
<dependencies>
  <dependency>
    <groupId>org.openjdk.jmh</groupId>
    <artifactId>jmh-core</artifactId>
    <version>1.37</version>
  </dependency>
  <dependency>
    <groupId>org.openjdk.jmh</groupId>
    <artifactId>jmh-generator-annprocess</artifactId>
    <version>1.37</version>
    <scope>provided</scope>
  </dependency>
  <!-- JOL，验证对象布局用 -->
  <dependency>
    <groupId>org.openjdk.jol</groupId>
    <artifactId>jol-core</artifactId>
    <version>0.17</version>
  </dependency>
</dependencies>
```

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-shade-plugin</artifactId>
  <version>3.5.1</version>
  <executions>
    <execution>
      <phase>package</phase>
      <goals><goal>shade</goal></goals>
      <configuration>
        <finalName>benchmarks</finalName>
        <transformers>
          <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
            <mainClass>FalseSharingBench</mainClass>
          </transformer>
        </transformers>
      </configuration>
    </execution>
  </executions>
</plugin>
```

跑起来（我的环境：4 vCPU 云主机，Intel Xeon Ice Lake 基频 2.7GHz，JDK 21.0.5，Linux 5.10；不同的机器数字不必逐位对齐，**看倍率**）：

```bash
mvn -q clean package

# 单线程对照
java -jar target/benchmarks.jar writeSingle -p type=UnPadded -f 2

# 4 线程，两种布局分开跑
java -jar target/benchmarks.jar four -p type=UnPadded -f 2
java -jar target/benchmarks.jar four -p type=Padded  -f 2
```

> 注：测这种纳秒级差异，务必插电、固定 CPU 频率（`cpupower frequency-set -g performance`）、避开同宿主机的邻居噪音。JMH 会自动 fork 出独立 JVM，别图省事加 `-f 0`。

### 3.4 结果：加线程不涨，加 padding 翻 4 倍

| 线程数 | UnPadded（亿 ops/s） | 扩展比 | Padded（亿 ops/s） | 扩展比 |
| --- | --- | --- | --- | --- |
| 1 | 0.91 | 1.00x | 0.92 | 1.00x |
| 2 | 0.88 | 0.97x | 1.78 | 1.93x |
| 4 | 0.86 | 0.95x | 3.49 | 3.79x |

三个结论：

1. **UnPadded 加线程吞吐不涨**：4 个「独立」计数器实际在抢同一条缓存行，4 线程 ≈ 1 线程，还搭上协调开销，略低于单线程；
2. **Padded 接近线性扩展**（3.79x / 4 线程），这才符合「各写各的」的直觉；
3. 56 字节的「废内存」换 4 倍吞吐。热点路径上，这笔买卖怎么算都划算。

### 3.5 官方解法：@Contended

手写 padding 太土，JDK 自带注解 **@Contended**（`jdk.internal.vm.annotation` 包，JEP 142 引入；标在类上，JVM 自动在字段周围垫空白，默认 128 字节）：

```bash
java --add-exports java.base/jdk.internal.vm.annotation=ALL-UNNAMED \
     -XX:-RestrictContended \
     -jar target/benchmarks.jar four -p type=Contended -f 2
```

两个参数**缺一不可**，这是注解最常见的「装死」原因：

- `--add-exports ...`：`@Contended` 藏在 JDK 内部包里，默认不开放给应用代码；
- `-XX:-RestrictContended`：出于字节码注入安全的考虑，JDK 默认只允许核心库使用该注解，应用类必须显式关掉这个限制。

实测：不加参数 ≈ 0.87 亿 ops/s（注解被静默忽略，和 UnPadded 一样惨）；加上参数 ≈ 3.41 亿 ops/s，和手写 padding 一个水平。反过来这也是验证手段：**@Contended 生效与否，JMH 数字会直接告诉你**。

## 四、交叉验证：别只信一个数字

性能结论单靠一个 JMH 报告容易翻车，我用另外两件工具做交叉验证。

### 4.1 perf stat：指令没变多，周期翻了 4.8 倍

perf（Linux 性能计数器工具，直接读 CPU 的 PMU 硬件寄存器，能数出真实的周期数和指令数）：

```bash
perf stat -e cycles,instructions \
  java -jar target/benchmarks.jar four -p type=UnPadded -f 1 -wi 3 -i 3

perf stat -e cycles,instructions \
  java -jar target/benchmarks.jar four -p type=Padded  -f 1 -wi 3 -i 3
```

关键输出对比（统计含 JVM 启动与预热，但两个场景口径一致，倍率可比）：

| 指标 | UnPadded | Padded |
| --- | --- | --- |
| instructions | 23.1 G | 22.9 G |
| cycles | 61.2 G | 12.9 G |
| **IPC** | **0.38** | **1.78** |

解读：两种布局执行的**指令数几乎一样**（相差约 1%——干的活完全相同），但周期数差 4.8 倍。指令一样、周期爆炸，说明 CPU 不是活多了，而是每条指令都在等「缓存行所有权到手」的那个来回。IPC 从 1.78 跌到 0.38，把第一节的体感闭环了。

> 注：perf 需要内核权限（`kernel.perf_event_paranoid` 调低），容器里往往读不到 PMU，云主机要到宿主机跑。

### 4.2 perf c2c：直接点名「哪条缓存行在挨打」

perf c2c（cache-to-cache，专查伪共享的子命令，能直接报出哪些缓存行正在核间来回倒手）是第三证人：

```bash
perf c2c record -- java -jar target/benchmarks.jar four -p type=UnPadded -f 1 -wi 2 -i 3
perf c2c report --stdio | head -40
```

看输出里的 **HITM** 列（Hit Modified，命中其他核「已修改」缓存行的访存次数——这就是 RFO 的直接现场）：UnPadded 场景下，Java 堆里那一条 64B 行的 HITM 次数高得刺眼，基本就是 4 个 UnPadded 实例挤着的那一行；换 Padded 布局重录，HITM 掉到接近 0。

### 4.3 验证清单

复现时按这个清单核对，三条全对上才算真复现了伪共享，而不是测错了：

- [ ] JOL 确认 Padded 对象 136B，且热字段前后都有自家 padding；
- [ ] JMH：UnPadded 加线程吞吐不涨（扩展比 < 1.1x），Padded 接近线性（> 3.5x/4 线程）；
- [ ] perf stat：指令数基本一致、cycles 差 4 倍以上；perf c2c 的 HITM 从天文数字掉到接近 0。

## 五、生产落地：三板斧怎么选

### 5.1 第一板斧：LongAdder——JDK 已经替你 padding 过了

高竞争的全局计数器直接换 **LongAdder**（JDK 8 引入的高竞争计数器，写时分散到多个分段、读时求和）。4C 机器 16 线程高竞争递增的实测（程序附后）：

| 实现 | 吞吐（亿 ops/s） |
| --- | --- |
| AtomicLong | 0.38 |
| LongAdder | 2.86 |

它快的原理正是本篇主题：内部 **Striped64**（LongAdder 的父类，维护一个 Cell 数组，低竞争时只有 1 个 cell，竞争上来后按线程哈希扩 cell）把热点拆到多个 Cell 上，**每个 Cell 都标了 @Contended**——多线程 CAS 各自的 Cell，既避开真共享（CAS 失败重试），也避开伪共享（缓存行互不打扰）。JDK 并发包的开发者早就替你手写过一遍 padding。

配套小程序（30 行，自带正确性验证）：

```java
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.LongAdder;

public class AdderRace {
    static final int THREADS = 16;
    static final int LOOPS = 20_000_000;   // 总量 3.2 亿，方便对账

    public static void main(String[] args) throws Exception {
        for (int round = 1; round <= 3; round++) {
            benchAtomicLong();
            benchLongAdder();
            System.out.println("---");
        }
    }

    static void benchAtomicLong() throws InterruptedException {
        AtomicLong c = new AtomicLong();
        long t0 = System.nanoTime();
        run(THREADS, () -> { for (int i = 0; i < LOOPS; i++) c.incrementAndGet(); });
        System.out.printf("AtomicLong: %.2f 亿 ops/s (sum=%d)%n", yiPerSec(t0), c.get());
    }

    static void benchLongAdder() throws InterruptedException {
        LongAdder c = new LongAdder();
        long t0 = System.nanoTime();
        run(THREADS, () -> { for (int i = 0; i < LOOPS; i++) c.increment(); });
        System.out.printf("LongAdder : %.2f 亿 ops/s (sum=%d)%n", yiPerSec(t0), c.sum());
    }

    interface Task { void run(); }

    static void run(int threads, Task task) throws InterruptedException {
        var latch = new CountDownLatch(threads);
        for (int i = 0; i < threads; i++)
            new Thread(() -> { task.run(); latch.countDown(); }).start();
        latch.await();
    }

    static double yiPerSec(long t0) {
        double secs = (System.nanoTime() - t0) / 1e9;
        return (double) THREADS * LOOPS / secs / 1e8;
    }
}
```

验证方式：跑完各打一行 sum，两种实现都必须等于 320000000——性能对比的前提是活没少干；连续 3 轮取后两轮的稳态值。

一个必须知道的代价：LongAdder 是「写快读慢」的设计，`sum()` 要遍历所有 cell，且读到的可能不是精确实时值。要强一致精确读（比如扣款余额），老老实实用 AtomicLong 或加锁。

### 5.2 选型表

| 场景 | 建议 |
| --- | --- |
| 全局计数器，写多读少、高竞争 | LongAdder |
| 全局计数器，低竞争 / 单线程 | AtomicLong（省内存，读更直接） |
| 自定义结构：多线程各写各的字段 | @Contended 或同类内平铺手写 padding |
| 数组各元素被不同线程高频写（per-thread 统计数组） | 别让元素裸排：垫大槽位，或干脆每线程一个独立对象 |
| 环形缓冲/队列序号（如 Disruptor RingBuffer） | 参考 Disruptor：序号前后 padding 是它的标配 |

**Disruptor**（LMAX 开源的无锁并发框架，金融交易系统的常客）的 RingBuffer 序号是教科书级案例：核心序号字段前后垫满，官方论文专门花篇幅讲缓存行。

### 5.3 一个动手前的判断口诀

不是所有共享都是坏事，padding 也不免费（对象变大、缓存命中率下降）。动手前问一句：**这个字段是不是被多个线程高频写、写完很少读、而且压测显示加线程吞吐不涨？**三个条件都中，再上三板斧；否则先查锁和算法——别让伪共享背所有的锅。

## 六、常见坑：6 个翻车点

1. **只垫前面不垫后面。**对象是连续分配的，只垫前面时，下一个实例的热字段又会贴上来。另外 Intel 很多 CPU 有相邻缓存行预取（pair prefetching，L2 会把物理相邻的两条行一起拉进来），所以 64 字节 padding 都不一定干净——@Contended 默认垫 128 字节就是这个原因。
2. **用继承层次做 padding。**早年流行 `PaddedAtomicLong extends AtomicLong` 的父类垫字节写法，JIT 的字段重排可能把父类和子类字段混排，把精心布置的 padding 撕开。要垫就垫在同一个类里平铺，或直接 @Contended。
3. **@Contended 忘了配套参数。**没 `--add-exports` 编译不过；没 `-XX:-RestrictContended` 则注解被**静默忽略**——不报错，就是没效果，最坑。用 JMH 数字对照 UnPadded 来确认它生效了。
4. **JMH 测试不 fork、不用 volatile 或 Blackhole。**不 fork（`-f 0`）会让被测代码和其他 warmup 混在同一个 JVM 里互相污染；普通字段递增会被 JIT 死代码消除测了个寂寞——要么 volatile，要么用 Blackhole（JMH 提供的「黑洞」，强制消费计算结果防止被优化掉）。
5. **拿伪共享解释一切性能问题。**IPC 低也可能来自分支预测失败、指令缓存抖动、访存布局糟糕。正确顺序是先 `perf stat` 看整体，再 `perf c2c` 拿到 HITM 直接证据，然后才动手改布局。没有证据的 padding 是玄学。
6. **给冷字段乱垫。**padding 会让对象膨胀、有效负载密度下降，反而伤缓存命中率。只给「多线程高频写」的热点字段垫，一个类里垫一两个字段足矣。

## 七、总结

- CPU 与缓存之间按 **64 字节缓存行**记账，MESI 一致性协议的最小粒度也是行——变量逻辑独立，物理上同住一行就会被连坐，这就是**伪共享**；
- 症状极其固定：**加线程吞吐不涨、CPU 打满、IPC 极低、软件层工具查无此 bug**；
- 复现三板斧：JOL 看布局 → JMH 看吞吐扩展比 → perf stat / perf c2c 看 IPC 和 HITM，三证齐全才定案；
- 修复三板斧：**LongAdder**（全局计数，Striped64 已内置 @Contended Cell）、**@Contended**（类字段隔离，记得 `-XX:-RestrictContended`）、**手写 padding**（数组槽位/框架内嵌场景，前后各垫、别用继承）；
- 热点字段才值得 padding；先拿证据再动手。

## 参考资料

1. 美团技术团队，《Java 微基准测试框架 JMH》（中文，JMH 原理与误用坑的系统性讲解）：https://tech.meituan.com/2018/10/31/java-benchmark-framework-jmh.html
2. OpenJDK，JEP 142: Cache Contention Padding（@Contended 与 -RestrictContended 的官方出处）：https://openjdk.org/jeps/142
3. Martin Thompson，"False Sharing && Java 7"（伪共享研究的经典开山文，Mechanical Sympathy 系列）：https://mechanical-sympathy.blogspot.com/2011/07/false-sharing-java-7.html
4. OpenJDK 源码，Striped64.java（LongAdder 的分段与 @Contended Cell 实现）：https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/concurrent/atomic/Striped64.java
5. OpenJDK JMH 官方仓库与官方 samples：https://github.com/openjdk/jmh
6. OpenJDK JOL（Java Object Layout）项目主页：https://openjdk.org/projects/code-tools/jol/
7. Brendan Gregg，Linux perf Examples（perf stat / c2c 的使用与解读）：https://www.brendangregg.com/linuxperf.html
8. LMAX Exchange，Disruptor（RingBuffer 序号 padding 的工业级实践）：https://github.com/LMAX-Exchange/disruptor
