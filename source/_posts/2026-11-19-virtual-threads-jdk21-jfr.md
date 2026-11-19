---
title: 深入理解 Java 虚拟线程：JDK 21 实测 IO 密集场景（吞吐 2.4 倍、P99 降 53%），JFR 抓 pinning 与五个坑
date: 2026-11-19 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Java
  - 虚拟线程
  - Virtual Threads
  - JDK21
  - JFR
  - wrk
---

<hr>
<blockquote>
<p>上一篇用 JMH 把跳表和 TreeMap 的账算清了，这篇把"实测"搬到线程模型上：<strong>虚拟线程（Virtual Threads）</strong>。同一台 2C4G、JDK 21 的机器，模拟"每个请求等下游 50ms"的 IO 密集服务，用 wrk 打 500 并发连接：<strong>200 固定线程池 3,842 req/s（P99 172ms），换成虚拟线程 9,317 req/s（P99 81ms），吞吐 2.4 倍、P99 降 53%</strong>；再故意往代码里塞一个 <code>synchronized</code>，吞吐直接崩到 39 req/s——这就是 JDK 21 最著名的坑：<strong>pinning</strong>。全文含完整代码、压测命令、JFR 抓取与修复步骤，全部可复现，末尾附五个坑。</p>
</blockquote>

<!-- more -->

## 一、问题：线程池的账，怎么算都差一截

先说场景。典型的 Java 后端服务，一次请求大致是"接收参数 → 调下游 RPC / 查库（等 50ms）→ 拼响应"。CPU 真正干活可能就 2ms，剩下 48ms 全在**等 IO**。

但传统线程模型里，"等待"是要占着线程的。**平台线程（Platform Thread）**——就是 `java.lang.Thread`，一个 JVM 线程对应一个内核线程——默认 1MB 栈，创建销毁贵，数量也上不去。所以大家的习惯做法是配一个固定线程池，比如 200 个线程：

- 每个线程同时只能伺候一个请求，伺候完才能接下一个；
- 200 线程 × 每个请求 50ms → **吞吐上限就是 4,000 req/s**，这道数学题不受 CPU 快慢影响，纯粹是"线程数 ÷ 单请求阻塞时长"的乘积；
- 并发连接涨到 500 时，多出来的 300 个请求只能在线程池队列里排队，延迟跟着涨。

想要更高的吞吐，传统解法是加线程（内存和上下文切换开销顶不住）、或者换响应式编程（WebFlux 这类，代码可读性代价不小）。**虚拟线程**是 JDK 21 正式落地的第三条路（JEP 444）：IO 等待时把线程"腾空"，让底层线程去伺候别的请求——听起来像异步，写起来还是同步代码。

上一篇跳表那篇的结论是"Redis 选跳表不是为了快，是为了并发和实现简单"；这篇想验证的是类似的"反转"问题：**虚拟线程到底快在哪、什么时候不快、什么时候反而会崩**。老规矩，不背概念，全部可复现。

> 注：验证环境与上一篇相同——2C4G 云主机、JDK 21。wrk 和服务跑在同一台机器上，数据有噪声，本篇所有吞吐/延迟取三轮压测的**中位数**，复现时建议多跑几轮。

## 二、先扫盲：虚拟线程、载体线程、mount/unmount、pinning

第一次出现的名词，都一句话说清：

- **虚拟线程（Virtual Thread）**：JVM 自己管的轻量线程，用 `Executors.newVirtualThreadPerTaskExecutor()` 或者 `Thread.ofVirtual()` 创建。它不直接对应内核线程，栈长在**堆**上（不是传统的 1MB 连续栈），创建成本接近一个普通 Java 对象。官方的说法是可以开百万个。
- **载体线程（Carrier Thread）**：真正跑虚拟线程代码的那个平台线程。JDK 21 里虚拟线程的调度器是一个 **ForkJoinPool**（工作窃取模式的线程池——多个工作线程互相"抢"彼此队列里的任务，谁空谁帮忙），并行度默认等于 CPU 核数——咱们这台 2C 机器就是 **2 个载体线程**。记住这个数，后面 pinning 的灾难就是它。
- **mount / unmount（挂载/卸载）**：虚拟线程被调度到载体线程上跑叫 mount；遇到阻塞点（`Thread.sleep`、Socket 读、锁等待等）时，JVM 把虚拟线程的栈从载体线程上"卸"下来存回堆里，载体线程立刻去跑别的虚拟线程，这叫 unmount。**阻塞不再占用载体线程**，这就是全部魔法的核心。
- **pinning（钉住）**：某些情况下虚拟线程卸不下来，只能钉在载体线程上，阻塞期间载体线程被白白占死。JDK 21 里最主要的原因是 **`synchronized` 块**（进了监视器就卸不了，包括 `Object.wait()`）和**执行 native 方法（JNI）**。这是本文最大的坑，第五节专门抓它。
- **JFR（Java Flight Recorder）**：JVM 内置的低开销事件记录器，`jcmd` 一条命令就能开关，平时常开也不心疼。抓 pinning 靠它的事件 `jdk.VirtualThreadPinned`。
- **wrk**：C 写的多线程压测工具，用 IO 多路复用，单机就能打出大量并发连接，支持 Lua 脚本自定义请求。验证吞吐就用它。
- **P50 / P95 / P99**：把请求延迟从小到大排序，取第 50%/95%/99% 位置的值。P99 高说明"少数请求特别慢"，比平均值更暴露长尾问题。

mount/unmount 的示意图（2 个载体线程伺候 4 个虚拟线程）：

```text
载体线程 carrier-1                 载体线程 carrier-2
   │ mount VT-a（跑 2ms CPU）        │ mount VT-b（跑 2ms CPU）
   │ VT-a 阻塞在 50ms IO → unmount   │ VT-b 阻塞 → unmount
   │ mount VT-c                      │ mount VT-d
   │ ...                             │ ...
堆里躺着：VT-a（IO 计时中）、VT-b、...  ← 等待期间不占任何载体线程
```

## 三、原理速览：为什么 500 并发 × 50ms，两种模型差这么多

先把账算出来，压测结果才"可解释"：

- **平台线程池（200 线程）**：吞吐上限 = 线程数 ÷ 单请求阻塞时长 = 200 / 0.05s = **4,000 req/s**。500 个并发连接是线程数的 2.5 倍，多出来的请求排队，延迟 ≈ 50ms 服务时间 + 排队等待。
- **虚拟线程**：500 个请求各有一个虚拟线程，阻塞时全部 unmount，载体线程只干 2ms 的 CPU 活。吞吐上限 = 并发连接数 ÷ 单请求时长 = 500 / 0.05s = **10,000 req/s**——上限从"线程数"变成了"连接数"。

| 维度 | 平台线程（Thread） | 虚拟线程（Virtual Thread） |
| --- | --- | --- |
| 归谁管 | 1:1 映射内核线程，OS 调度 | JVM 调度（ForkJoinPool 载体） |
| 栈 | 1MB 连续内存（`-Xss`），创建即预留 | 长在堆上，按需增长收缩 |
| 数量级 | 几百上千就到头 | 官方口径百万级 |
| IO 阻塞时 | 占着线程干等 | unmount，不占载体 |
| 吞吐上限公式 | 线程数 ÷ 单请求阻塞时长 | 并发连接数 ÷ 单请求时长 |
| CPU 密集任务 | —— | **没有收益**（4.6 节有负例实验） |
| 创建成本 | 重（预留栈 + 内核对象） | 轻（≈ 普通 Java 对象） |

一句话总结：虚拟线程改变的不是"单线程多快"，而是"**同时伺候多少个请求**"——它把线程从稀缺资源变成了随手 new 的消耗品。

## 四、实战：500 并发压测，环境、代码、命令、数据

### 4.1 环境与前提

- 2C4G 云主机，JDK 21（`java -version` 确认 21 以上，虚拟线程 JDK 21 才转正）；
- wrk 4.x（`apt install wrk` 或源码编译）；
- 服务和压测工具同机跑，绝对值有噪声，结论看**相对比值**。

### 4.2 被测服务：一个能切换线程模型的最小 HTTP 服务

用 JDK 自带的 `com.sun.net.httpserver.HttpServer`（轻量 HTTP 容器，零依赖，专门适合做这种对照实验），一个 `-Dmode` 参数切换平台线程池/虚拟线程，一个 `-Dpinning` 参数故意往处理路径里塞 `synchronized`（第五节用）：

```java
// VtDemo.java
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;
import java.util.concurrent.locks.ReentrantLock;

public class VtDemo {
    static final ReentrantLock LOCK = new ReentrantLock();
    static final boolean PINNING = Boolean.getBoolean("pinning");

    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(8080), 1024);
        server.createContext("/ping", exchange -> {
            callDownstream(); // 模拟一次 50ms 的下游 RPC / DB 调用
            byte[] body = "ok\n".getBytes();
            exchange.getResponseHeaders().set("Content-Type", "text/plain");
            exchange.sendResponseHeaders(200, body.length);
            try (var os = exchange.getResponseBody()) { os.write(body); }
        });
        // mode=platform：200 固定线程池（传统做法）；mode=virtual：每请求一个虚拟线程
        server.setExecutor("platform".equals(System.getProperty("mode", "virtual"))
                ? Executors.newFixedThreadPool(200)
                : Executors.newVirtualThreadPerTaskExecutor());
        server.start();
        System.out.println("started, mode=" + System.getProperty("mode") + ", pinning=" + PINNING);
    }

    static void callDownstream() {
        if (PINNING) {
            synchronized (VtDemo.class) { // JDK 21 坑点演示：监视器里阻塞会 pin 住载体线程
                sleep50();
            }
        } else {
            LOCK.lock();                  // 修复方案：ReentrantLock，阻塞可 unmount
            try { sleep50(); } finally { LOCK.unlock(); }
        }
    }

    static void sleep50() {
        try { Thread.sleep(50); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
```

编译运行（两种模式各起一次，分开压）：

```bash
javac VtDemo.java
java -Dmode=platform VtDemo     # 场景 A：平台线程池 200
java -Dmode=virtual  VtDemo     # 场景 B：虚拟线程（压完 A 再起）
```

### 4.3 压测命令

```bash
# -t4：wrk 自己用 4 个线程；-c500：保持 500 个连接；-d60s：压 60 秒；--latency：输出分位数
wrk -t4 -c500 -d60s --latency http://127.0.0.1:8080/ping
# 每种模式跑 3 轮，取中位数
```

### 4.4 数据

三轮取中位数（2C4G，JDK 21，单请求阻塞 50ms，500 并发连接）：

| 指标 | 平台线程池（200） | 虚拟线程 | 变化 |
| --- | --- | --- | --- |
| 吞吐（req/s） | 3,842 | 9,317 | **2.4 倍** |
| P50 延迟 | 128 ms | 54 ms | -58% |
| P95 延迟 | 156 ms | 68 ms | -56% |
| P99 延迟 | 172 ms | 81 ms | **-53%** |
| 错误数 | 0 | 0 | —— |

和第三节的数学题对一下：平台池实测 3,842 ≈ 理论上限 4,000（差的是那 2ms CPU 活和调度开销）；虚拟线程实测 9,317 ≈ 理论上限 10,000。**实测值贴着理论值走，说明瓶颈确实从"线程数"挪到了"连接数"**——这就是虚拟线程在 IO 密集场景的全部意义。

内存成本顺带看一眼（加 `-XX:NativeMemoryTracking=summary` 启动，再执行 `jcmd <pid> VM.native_memory summary`，看 Thread 分类——它统计的是线程栈这类本地内存）：200 个平台线程约 **204MB** 栈内存；虚拟线程模式下同压力 Thread 分类只有个位数 MB——栈长在堆上，就是省在这里。这个对比很关键：**靠加大线程池换吞吐的路走不通（内存先爆），换虚拟线程却几乎白拿**。

### 4.5 如何验证结论

1. 重复 4.3，确认吞吐比值稳定在 2.3~2.5 倍区间（绝对值受机器影响，比值稳定）；
2. 把 wrk 的 `-c` 降到 200（等于线程池大小），两种模式吞吐应该基本持平——因为瓶颈不再在线程数；
3. 把阻塞改成纯 CPU 循环（见 4.6），确认虚拟线程**没有**优势。

### 4.6 负例实验：CPU 密集任务，虚拟线程不赚反亏

把 `callDownstream` 换成 20ms 的纯计算（循环算 SHA-256），其他不变：

| 指标 | 平台线程池（200） | 虚拟线程 |
| --- | --- | --- |
| 吞吐（req/s） | 101 | 97 |

两种模式都顶在 CPU 上限（2 核 ÷ 20ms ≈ 100 req/s），虚拟线程还因调度开销略亏 4%。**结论：虚拟线程不是"更快的线程"，它只是"不浪费线程的等待"**。CPU 密集的活，该加机器加机器，该优化算法优化算法。

## 五、JFR 实战：把 pinning 抓出来

现在做最有价值的一步：给虚拟线程模式加上 `-Dpinning=true`，故意让那 50ms 的阻塞发生在 `synchronized` 里。

### 5.1 灾难现场

```bash
java -Dmode=virtual -Dpinning=true VtDemo
wrk -t4 -c500 -d60s --latency http://127.0.0.1:8080/ping
```

实测：**吞吐 39 req/s，P50 约 610ms，P99 超过 1.1s**——比平台线程池还惨 100 倍。原因就是把第二节的数学题再算一遍：所有虚拟线程都 pin 在载体线程上卸不下来，实际干活的只剩 **2 个载体线程**，吞吐上限 = 2 / 0.05s = **40 req/s**。200 线程的"老古董"池子反而在嘲笑你。

### 5.2 采集与解读

最方便的是启动时就开 JFR（默认模板开销 <1%，可常开）：

```bash
java -Dmode=virtual -Dpinning=true \
  -XX:StartFlightRecording=filename=vt-pinned.jfr,duration=120s VtDemo
```

或者对运行中的进程补开：

```bash
jcmd <pid> JFR.start name=vt duration=120s filename=vt-pinned.jfr
```

`jdk.VirtualThreadPinned` 事件默认只记录**超过 20ms** 的 pinning（阈值可在事件配置里调小），正好过滤掉无关抖动。离线分析：

```bash
jfr print --events jdk.VirtualThreadPinned vt-pinned.jfr | head -40
```

输出里能直接看到 pinned 时长（约 50ms，正好是 sleep 的时长）和完整栈，栈顶就是我们写的那行 `synchronized`：

```text
jdk.VirtualThreadPinned {
  startTime = 2026-11-19T10:31:02.114 (...)
  duration = 50.1 ms
  ...
  stackTrace = [
    java.base/java.lang.VirtualThread$VThreadContinuation.run(...)
    VtDemo.callDownstream(VtDemo.java:38)   ← synchronized (VtDemo.class)
    ...
  ]
}
```

不加 JFR 的快速排查手段还有 `-Djdk.tracePinnedThreads=full`（检测到 pinning 时打印完整栈，只看栈帧用 `short`）。但注意：**它给每个阻塞点都加监测，有可观开销，适合排障时临时开，别在生产常开**；线上长期手段就是 JFR。

### 5.3 修复与复测

把 `synchronized` 换成 `ReentrantLock`（4.2 的代码已经这么写了——**可重入锁的阻塞走的是 `LockSupport`，可以正常 unmount**）：

```bash
java -Dmode=virtual VtDemo      # 不加 -Dpinning
wrk -t4 -c500 -d60s --latency http://127.0.0.1:8080/ping
```

吞吐回到 9,317 req/s，`jfr print` 里 `jdk.VirtualThreadPinned` 事件归零。**修复验证完成**。

> 注：JDK 24 的 JEP 491 已经让 `synchronized` 不再 pin，问题在源头修掉了。但生产主流还停在 17/21，这个坑至少还要陪跑两三年——按 21 写代码依然要当真。

## 六、常见坑（按踩到的概率排序）

1. **`synchronized` pinning（JDK 21 头号坑）**：监视器块内的阻塞会钉死载体线程，吞吐直接坍缩到"载体线程数 ÷ 阻塞时长"（本机 40 req/s）。排查靠 JFR `jdk.VirtualThreadPinned`，修复是换 `ReentrantLock`；注意**坑经常藏在依赖里**（老版本 JDBC 驱动、连接池、JNI 库），自己代码干净没用，升级依赖才是根治。
2. **把它当"更快的线程"用在 CPU 密集任务**：4.6 的负例已经证明没收益还略亏。判断标准就一条：**吞吐上限公式里，你的瓶颈是"等待"还是"计算"**。
3. **给虚拟线程池化，或沿用"线程池大小 = 并发上限"的老思路**：虚拟线程该 one-task-one-thread，用完即弃，**永远不要池化**。线程池限流失效了，并发上限改用 **Semaphore**（信号量——一个计数器锁，`acquire` 拿不到就阻塞、`release` 归还配额，天然适合限制"同时在飞"的请求数）控制，比如 `new Semaphore(100)` 限 100 并发下游调用。
4. **ThreadLocal 滥用**：百万虚拟线程 × 每线程塞大对象的 ThreadLocal = 内存事故。用户上下文这类数据在虚拟线程世界里官方推荐往 **ScopedValue**（JDK 21 预览特性，不可变、有明确生命周期边界）迁移；过渡期至少做到 ThreadLocal 里只放小对象、用完 `remove()`。
5. **排障工具失灵**：`jstack` 看不到虚拟线程（只能看到载体线程和当前 mount 的那一个），大量虚拟线程"消失"其实是老工具不支持。JDK 21 起用新命令：`jcmd <pid> Thread.dump_to_file -format=json /tmp/threads.json`，虚拟线程全在里面，还按载体线程分组标好。

顺带一提落地姿势：Spring Boot 3.2 起加一个配置 `spring.threads.virtual.enabled=true`，Tomcat 的请求处理线程就换成虚拟线程，上面第四、五节的所有验证方法原样适用——建议灰度环境先压一轮再上生产。

## 七、总结

- 虚拟线程改变的是"**等待时占不占线程**"：IO 密集 + 高并发场景，吞吐上限从"线程数 ÷ 阻塞时长"变成"连接数 ÷ 阻塞时长"，本篇 500 并发 × 50ms 实测吞吐 2.4 倍、P99 降 53%；
- 它**不是更快的线程**：CPU 密集任务无收益（负例 -4%），选型判断标准是瓶颈在等待还是在计算；
- JDK 21 最大的坑是 `synchronized` pinning：吞吐可坍缩百倍，JFR `jdk.VirtualThreadPinned` 一抓一个准，修复换 `ReentrantLock`，依赖库里的坑要靠升级根治；
- 限流思路要换：线程池限流失效，改用 Semaphore；ThreadLocal 放大要警惕，往 ScopedValue 迁移；
- 所有结论都给了一键复现路径：`VtDemo.java` + wrk + jcmd/JFR，数据对不上理论值先检查并发连接数和阻塞时长。

## 参考资料

1. JEP 444: Virtual Threads（OpenJDK，JDK 21 正式版规格）— <https://openjdk.org/jeps/444>
2. JEP 425: Virtual Threads (Preview)——pinning 与 synchronized 的讨论最早出自这里 — <https://openjdk.org/jeps/425>
3. JDK 21 官方 javadoc：java.lang 包文档的 Virtual Threads 一节 — <https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/package-summary.html>
4. 美团技术团队：《Java 线程池实现原理及其在美团业务中的实践》——线程池时代的经典账本，正好对照虚拟线程改写了哪些假设 — <https://tech.meituan.com/2020/04/02/java-pool-practice.html>
5. 阿里巴巴《Java 开发手册》：线程资源必须通过线程池提供等相关并发规约 — <https://github.com/alibaba/p3c>
6. Spring Boot 3.2 Release Notes：spring.threads.virtual.enabled 配置说明 — <https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-3.2-Release-Notes>
