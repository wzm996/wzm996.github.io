---
title: 伪共享（False Sharing）实战：两个线程各写各的变量，为什么慢了一个数量级？
date: 2026-09-25 10:00:00
categories:
  - 操作系统与 Linux
  - 性能分析
tags:
  - CPU缓存
  - False Sharing
  - JMH
  - Java并发
  - perf
  - JOL
---

<hr>

<blockquote>
<p>两个线程各自累加两个<strong>毫无关系</strong>的 long 字段，没有锁、没有竞争，吞吐却比单线程还差一个数量级——这不是玄学，是<strong>伪共享（False Sharing）</strong>。CPU 在缓存与内存之间搬数据的最小单位不是 8 字节的 long，而是 64 字节的<strong>缓存行（Cache Line）</strong>。本文用 JMH 压测、JOL 对象布局、perf c2c 三个可复现实验，把伪共享从原理、定位到治理一次讲透。</p>
</blockquote>

<!-- more -->

## 一、从一个"反直觉"的压测说起

先说结论数据（怎么跑出来的见第四节，量级示意，绝对值以你的机器实测为准）：

| 基准版本 | 线程模型 | 典型吞吐（ops/µs） |
| --- | --- | --- |
| 单线程写 1 个 long（基线） | 1 线程 | ~250 |
| `unpadded`：两个线程各写各的字段 | 2 线程 | ~15 |
| `padded`：两个字段手工隔开 | 2 线程 | ~380 |
| `contended`：`@Contended` 自动隔离 | 2 线程 | ~350 |

注意第二行：**两个线程，各写各的变量，没有任何锁、没有任何逻辑上的数据竞争，吞吐反而不到单线程的十分之一**。加了几行"看起来毫无意义"的占位字段之后，吞吐翻了几十倍。

这就是伪共享：**逻辑上无共享，物理上被迫共享**。今天这篇就把"为什么"和"怎么办"拆开讲清楚。目标读者：写 Java 并发代码、关心性能的工程师；先修知识：知道 volatile 和原子变量的作用即可，硬件部分会从零讲起。

## 二、原理：缓存行与 MESI，5 分钟版

### 2.1 数据在 CPU 眼里不是按字节存的

先补一块背景板——**存储器层次结构**（就是寄存器、缓存、内存这套金字塔）。CPU 跑得比内存快太多，所以中间垫了几层缓存。各层的访问延迟大致是这个量级：

| 层级 | 典型延迟（量级） | 说明 |
| --- | --- | --- |
| L1 缓存 | ~1 ns | 每个核私有 |
| L2 缓存 | ~4 ns | 一般每核私有 |
| L3 缓存 | ~40 ns | 全核共享 |
| 内存 | ~100 ns | 全体共享 |

关键规则：**CPU 缓存和内存之间搬数据，最小单位是缓存行（Cache Line），x86 上通常是 64 字节**。你哪怕只想读 1 个 byte，硬件也会把它所在的整条 64 字节缓存行搬进 L1。你哪怕只想改 8 字节的 long，改完后同步给其他核时，同步的也是整条缓存行。

这条规则平时是好事（程序有局部性，多搬点数据在旁边备用），但它埋了一个雷——见 2.3。

### 2.2 MESI：多核之间怎么保证数据一致

**MESI** 是缓存一致性协议（协议的四个状态名缩写，**M**odified / **E**xclusive / **S**hared / **I**nvalid），它是多核 CPU 保证"每个核看到的同一份数据是一致的"的底层机制。口语化描述一下：

- 一个核想**读**数据：如果别的核有，大家把这条缓存行标记为 **S（共享）**，随便读，互不影响；
- 一个核想**写**数据：必须先把其他核手里的这条缓存行作废（标记为 **I，无效**），自己独占后才能改。这个"把数据所有权要过来"的过程叫 **RFO（Read For Ownership，读并获取所有权）**，是一次跨核的通信往返。

重点来了：**一致性协议的粒度是缓存行，不是变量**。它根本不知道你的 `a` 和 `b` 是两个八竿子打不着的字段，它只看"这条 64 字节的行被谁改了"。

### 2.3 伪共享：行在核之间"打乒乓"

现在把 2.1 和 2.2 拼起来。假设一个对象里有两个相邻的 long 字段：

```java
class Counter {
    long a;   // 线程 1 拼命 ++
    long b;   // 线程 2 拼命 ++
}
```

`a` 在偏移 16，`b` 在偏移 24——**落在同一条缓存行（0~63 字节）里**。于是：

1. 线程 1（核 0）写 `a` → 先 RFO 把行要过来，核 1 上的这行变 Invalid；
2. 线程 2（核 1）写 `b` → 这行在核 1 上已经失效了，只能再来一次 RFO 要回去，核 0 上的行变 Invalid；
3. 循环往复，**这条缓存行在两个核之间来回"打乒乓"**，每回合一次跨核通信，几十到上百纳秒。

而一次 `a++` 本身只要 1ns 上下。也就是说，绝大部分时间都花在"把行要回来"上，真正干活的指令占比极低——这就是表里那个"2 线程还不如 1 线程"的真相。

**伪共享的正式定义**：多个线程高频**写**不同的变量，但这些变量落在同一条缓存行上，导致缓存行在核间反复失效——虽然程序语义上没有共享任何数据，性能上却表现出严重的共享竞争。

顺带把三种情况摆在一起对比：

| 场景 | 多线程访问的是什么 | 缓存行的遭遇 | 性能表现 |
| --- | --- | --- | --- |
| 真共享 | 同一个变量 | 行反复失效 + 还需要锁/原子操作保证正确性 | 最差（但有正确性要求，没办法） |
| 伪共享 | 不同变量、同一缓存行 | 行反复失效，纯粹白浪费 | 差，常见 5~30 倍劣化 |
| 无共享 | 不同变量、不同缓存行 | 各自稳定待在各自的 L1 里 | 接近线性扩展 |

判断口诀：**写 + 跨核 + 同一行**，三个条件同时满足才是伪共享。只读不写的共享不会触发（S 状态大家随便读），单线程更不用管。

## 三、治理思路一览

| 方案 | 做法 | 优点 | 代价 / 适用场景 |
| --- | --- | --- | --- |
| 手工 padding（填充） | 在热点字段之间塞 7 个无意义的 long 占位 | 零参数依赖，任何 JDK 都行 | 代码丑；字段布局由 JVM 决定，继承场景可能失效；对象膨胀 |
| `@Contended` 注解 | 让 JVM 自动在每个字段组周围挖 128 字节隔离带 | 声明式、可靠，JDK 自己也在用 | 需要额外 VM 参数；仅值得用在确认的热点上 |
| 结构性拆分 | LongAdder、按线程分段计数、聚合后再合并 | 顺带把原子竞争也解决了 | 要改设计，不是所有场景能拆 |
| 什么都不做 | 保持现状 | 零成本 | **大多数场景的正确答案**：读多写少、单核、低频写根本不用治 |

一句话：**先定位、再治理，别上来就给所有类加 padding**——缓存行是 64 字节，你多塞 56 字节占位符，等于让 L1 里能放的有效数据变少，局部性变差，可能捡了芝麻丢了西瓜。

## 四、实战：三步跑通"发现 → 确认 → 治理"

### 4.1 环境与工程搭建

实验环境：JDK 21（LTS）、Linux x86_64、多核。先解释两个新工具：

- **JMH**（Java Microbenchmark Harness）：OpenJDK 官方的微基准测试框架。为什么不用 `System.nanoTime()` 手搓计时？因为 JIT 会做死代码消除、方法内联、循环展开，手搓基准几乎必然测出假数据，JMH 就是专门对付这些坑的。
- **JOL**（Java Object Layout）：OpenJDK 官方的对象布局工具，能打印"这个对象的每个字段到底放在第几个字节"，后面用它验证 padding 是否真的生效。

用 JMH 的 Maven 原型一键生成工程：

```bash
mvn archetype:generate -DinteractiveMode=false \
  -DarchetypeGroupId=org.openjdk.jmh \
  -DarchetypeArtifactId=jmh-simple-benchmark-archetype \
  -DgroupId=dev.wzm -DartifactId=false-sharing-demo -Dversion=1.0
cd false-sharing-demo
# 把 src/main/java/dev/wzm/MyBenchmark.java 替换为 4.2 的代码
```

如果要用 `@Contended`（版本 C），需要在 `pom.xml` 的 `maven-compiler-plugin` 里加一段参数（原因见第五节的坑 1）：

```xml
<configuration>
  <compilerArgs>
    <arg>--add-exports</arg>
    <arg>java.base/jdk.internal.vm.annotation=ALL-UNNAMED</arg>
  </compilerArgs>
</configuration>
```

### 4.2 基准代码：同一件事的三种写法

```java
package dev.wzm;

import org.openjdk.jmh.annotations.*;
// 版本 C 需要这一行 import；不写版本 C 就删掉它
import jdk.internal.vm.annotation.Contended;

import java.util.concurrent.TimeUnit;

@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.MICROSECONDS)
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 5, time = 1)
@Fork(value = 2, jvmArgsAppend = {"-XX:-RestrictContended"})
public class FalseSharingBench {

    // ---------- 版本 A：a、b 相邻，大概率同一条缓存行 ----------
    @State(Scope.Group)
    public static class UnPaddedState {
        long a;
        long b;
    }

    @Benchmark @Group("unpadded") @GroupThreads(1)
    public long ua(UnPaddedState s) { return s.a++; }

    @Benchmark @Group("unpadded") @GroupThreads(1)
    public long ub(UnPaddedState s) { return s.b++; }

    // ---------- 版本 B：手工 padding，各占一条缓存行 ----------
    @State(Scope.Group)
    public static class PaddedState {
        long a;
        long p1, p2, p3, p4, p5, p6, p7;   // 左边垫 56 字节
        long b;
        long q1, q2, q3, q4, q5, q6, q7;   // 右边垫 56 字节
    }

    @Benchmark @Group("padded") @GroupThreads(1)
    public long pa(PaddedState s) { return s.a++; }

    @Benchmark @Group("padded") @GroupThreads(1)
    public long pb(PaddedState s) { return s.b++; }

    // ---------- 版本 C：@Contended，让 JVM 挖隔离带 ----------
    @State(Scope.Group)
    @Contended
    public static class ContendedState {
        @Contended("g1") long a;
        @Contended("g2") long b;
    }

    @Benchmark @Group("contended") @GroupThreads(1)
    public long ca(ContendedState s) { return s.a++; }

    @Benchmark @Group("contended") @GroupThreads(1)
    public long cb(ContendedState s) { return s.b++; }
}
```

几个写法要点：

- `@Group` + `@GroupThreads(1)`：让同一个 group 里的两个基准方法**各带 1 个线程、并发跑在同一个状态对象上**——这正是伪共享的触发条件；
- 字段不加 volatile：硬件层的写操作本来就要拿缓存行所有权（见 2.2），普通写一样会乒乓，官方样例也是这么写的；
- 基准方法**返回了修改值**：防止 JIT 认为计算结果没人用、直接把代码优化掉（死代码消除）。

编译打包并运行：

```bash
mvn clean package
java -jar target/benchmarks.jar
# 输出里找 unpadded / padded / contended 三行结果
```

### 4.3 压测结果与解读

一次典型的输出（节选，**量级示意**，绝对值因机器而异，请以自己环境实测为准）：

```
Benchmark                    Mode  Cnt     Score     Error  Units
FalseSharingBench.unpadded  thrpt   10    15.3xx ±  1.2xx  ops/us
FalseSharingBench.padded    thrpt   10   385.xxx ± 15.xxx  ops/us
FalseSharingBench.contended thrpt   10   352.xxx ± 12.xxx  ops/us
```

解读三个点：

1. `unpadded` 惨不忍睹：两个线程合计还不如单线程写一个字段（对照第一节基线 ~250 ops/µs），RFO 往返的开销远超并行收益；
2. `padded` / `contended` 恢复到接近 2 倍单线程——这才是并行该有的样子；
3. 在多物理核的机器上，这个差距通常在 **5~30 倍**之间，核越多、写越频繁差距越大。

### 4.4 用 JOL 验证：padding 到底有没有生效

"我垫了字段"和"垫成功了"是两回事，JOL 直接把对象布局打给你看：

```bash
# 下载 jol-cli：https://openjdk.org/projects/code-tools/jol/
java -cp target/classes:jol-cli.jar org.openjdk.jol.Main \
  internals 'dev.wzm.FalseSharingBench$UnPaddedState'
```

版本 A 的典型输出（节选）：

```
 OFFSET  SIZE   TYPE DESCRIPTION               VALUE
      0    12        (object header)            N/A
     16     8   long UnPaddedState.a            N/A
     24     8   long UnPaddedState.b            N/A
```

`a` 在第 16 字节、`b` 在第 24 字节——**同一条 64 字节缓存行**，伪共享条件成立。

再看加了 `-XX:-RestrictContended` 的版本 C：

```bash
java -XX:-RestrictContended -cp target/classes:jol-cli.jar org.openjdk.jol.Main \
  internals 'dev.wzm.FalseSharingBench$ContendedState'
```

典型输出（节选）：

```
 OFFSET  SIZE   TYPE DESCRIPTION               VALUE
      0    12        (object header)            N/A
     12   116        (alignment padding gap)    ← @Contended 挖的隔离带
    128     8   long ContendedState.a           N/A
    136   120        (alignment padding gap)    ← 隔离带
    256     8   long ContendedState.b           N/A
```

`a` 和 `b` 分别落在 128 和 256 两个独立的隔离区，**无论如何不可能共享缓存行**。这一步就是把"我以为"变成"我确认了"。

### 4.5 用 perf c2c 定位线上/压测中的伪共享

前面是我们"故意制造"的伪共享，真实世界里怎么发现它？答案是 **perf c2c**：Linux perf 工具链里的一个子命令，专门回答"哪些缓存行正在被多个核来回打"。它的原理是采样"在别的核修改后我才命中"（HITM，Hit Modified，即命中了另一个核已修改的行）的内存访问，伪共享热点行会直接浮出水面。要求：Intel CPU、内核 4.2+、安装了带 c2c 支持的 perf。

```bash
# 终端 1：把基准跑起来（选 unpadded 版本）
java -jar target/benchmarks.jar unpadded

# 终端 2：采集 20 秒后出报告
sudo perf c2c record -a -- sleep 20
sudo perf c2c report --stdio | head -40
```

报告里重点看 **HITM 列**：排在最前面的缓存行如果对应 `UnPaddedState` 的字段地址（Data address / Offset 一列），且来自多个不同的线程（TID 列），就是伪共享实锤。把基准换成 `padded` 再采一次，同一位置的 HITM 应该大幅下降甚至消失——这就构成了"问题存在 → 治理有效"的完整证据链。

**如何验证本文结论（三步清单）**：① 跑 4.3 的三组基准，确认 unpadded 与 padded 的倍数差；② 用 4.4 的 JOL 确认三个版本的布局与预期一致；③ 用 4.5 的 perf c2c 对比治理前后的 HITM。三步都对上了，结论就是你的了。

### 4.6 番外：LongAdder 为什么快

JDK 8 的 **LongAdder**（并发计数器，把一个计数拆成多个 Cell 分摊竞争，取值时再求和）在高并发写场景下碾压 AtomicLong，很多人以为只是"分段降低了 CAS 竞争"，其实它还有一手：Cell 内部用了 `@sun.misc.Contended`（JDK 内部类不受 RestrictContended 限制），**每个 Cell 天然独占缓存行**。也就是说，LongAdder 是"结构拆分 + Contended 隔离"的组合拳。统计 QPS、监控计数这类允许瞬时误差的场景，优先用它，而不是自己手搓 padding。

## 五、常见坑与误区

1. **`@Contended` 加了却完全不生效。** 三个检查点：JVM 参数里有没有 `-XX:-RestrictContended`（默认该注解只对 JDK 内部类生效，业务类会被直接忽略）；编译能不能过（JDK 9+ 的注解在 `jdk.internal.vm.annotation` 包里，模块系统不导出，需要 4.1 里的 `--add-exports`）；改完参数有没有重新 fork 基准/重启进程。三个都过一遍，再用 JOL 确认布局，别靠猜。
2. **手工 padding 在继承场景翻车。** JVM 对字段重排的规范是"未定义"——父类字段和子类字段的相对位置由实现自行决定，你在子类里垫的占位字段未必夹在两个热点字段中间。稳妥做法：把热点字段包成独立的小对象（LongAdder 的 Cell 就是这么干的），或者直接用 `@Contended`，最后用 JOL 验证。
3. **一刀切给所有字段加隔离带。** 每个字段组被挖 128 字节隔离带，对象内存直接膨胀数倍，L1 能容纳的有效数据变少、GC 压力上升。只治理"多核 + 高频写 + 相邻字段"的确认热点，其余不动。
4. **JMH 使用姿势错误导致假数据。** 常见三种：`fork = 0` 让多次测量共享同一 JIT 状态；返回值没交给 JMH（或 Blackhole）导致整个计算被死代码消除干掉；预热次数太少，前几轮 JIT 编译期的抖动污染数据。照抄 4.2 的注解配置即可绕开。
5. **把读共享误判成伪共享。** MESI 的 Shared 状态下多核随便读，不会乒乓；只有跨核高频**写**才值得怀疑。动手优化前先用 perf c2c 拿证据，别对着读多写少的类猛加 padding。
6. **忽略机器拓扑。** 开了超线程（SMT）的机器上，同一物理核的两个逻辑核共享 L1/L2，伪共享的表现和物理核间完全不同；容器里还可能被绑核。压测前用 `lscpu -e` 看一眼拓扑，解读数据时把拓扑因素算进去。

## 六、总结

- CPU 搬数据的最小单位是 **64 字节缓存行**；一致性协议（**MESI**）的粒度也是缓存行——这是伪共享存在的根源。
- 伪共享 = **写 + 跨核 + 同一行**，逻辑上无共享、物理上被迫共享，常见 5~30 倍性能劣化，甚至比单线程还差。
- 定位三件套：**JMH** 压测量化差距、**JOL** 确认字段布局、**perf c2c** 抓 HITM 热点行，全部可复现。
- 治理优先级：结构性拆分（LongAdder/分段）> `@Contended`（记得 `-XX:-RestrictContended`）> 手工 padding（小心继承失效）；读多写少就**什么都不做**。
- 所有 padding/注解改完，必须用 JOL 或 perf 复验生效，"我以为隔离了"不算数。

## 参考资料

1. JEP 142: Reduce Cache-Based Contentions（`@Contended` 的官方动机与设计）— <https://openjdk.org/jeps/142>
2. JMH 官方样例 JMHSample_22_FalseSharing（本文基准写法的原型）— <https://github.com/openjdk/jmh>
3. JOL: Java Object Layout 官方项目页 — <https://openjdk.org/projects/code-tools/jol/>
4. Martin Thompson, False Sharing && Java 7（Mechanical Sympathy 经典文章）— <https://mechanical-sympathy.blogspot.com/2011/07/false-sharing-java-7.html>
5. Brendan Gregg, perf Examples（含 perf c2c 用法）— <https://www.brendangregg.com/perf.html>
6. Intel® 64 and IA-32 Architectures Optimization Reference Manual（缓存层次与优化章节）
7. 方腾飞、魏鹏、程晓明，《Java 并发编程的艺术》，第 2 章"并发机制的底层实现"（缓存行与伪共享）
8. JDK 源码：`java.util.concurrent.atomic.LongAdder` / `Striped64`（Cell 的 Contended 隔离实践）
