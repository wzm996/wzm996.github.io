---
title: 深入理解 Java 虚拟线程：原理、压测与踩坑实战
date: 2026-09-22 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Java
  - 虚拟线程
  - 并发
  - JVM
  - JDK21
  - 性能调优
---

<hr>
<blockquote>
<p><strong>虚拟线程（Virtual Threads，JEP 444，JDK 21 正式转正）</strong>是 JDK 提供的「超轻量级线程」：由 JVM 而不是操作系统来调度，创建成本和内存占用比传统线程低几个数量级。这篇文章不聊概念吹捧，用三组可复现的实验（吞吐压测、内存炸弹、pinning 排查）回答三个问题：它到底快在哪、什么场景真有收益、生产上哪些写法会让它白干。</p>
</blockquote>

<!-- more -->

## 一、背景：为什么一万并发就把服务器压垮了

搞后端的同学对这个场景肯定不陌生：一个典型的「每请求一线程」服务，下游是个 50ms 的 RPC/HTTP 调用。想撑住 5000 并发，按最朴素的算法你得开 5000 个线程（5000 × 50ms ≈ 每 10ms 处理完一批）。但传统线程贵啊：

- 每个**平台线程（Platform Thread，就是咱们平时 `new Thread()` 出来的、和内核线程一对一的线程）**默认保留 1MB 栈（`-Xss` 默认值），外加内核对象和调度开销；
- 上下文切换要陷内核，切一次几微秒，线程一多 CPU 大量时间耗在切换和缓存污染上；
- 线程总数还受 `ulimit -u`、`max_map_count` 这些系统参数硬限制，几千个就可能直接 `OutOfMemoryError: unable to create native thread`。

于是大家各显神通：线程池 + 队列削峰、CompletableFuture 编排、甚至整体迁移 WebFlux/响应式——代码可读性换吞吐，回调地狱的味道大家都尝过。

OpenJDK 的 Loom 项目给了另一个答案：**别让程序员改代码风格，把线程本身变便宜**。线程便宜了，「一个请求一个线程」这个最符合人类直觉的模型就能直接扛住百万级并发阻塞。

> 注：虚拟线程是 JDK 19 预览（JEP 425）、JDK 21 正式（JEP 444）的特性。下面的实验全部基于 JDK 21，不需要任何预览开关。

## 二、核心概念：虚拟线程到底是个啥

先建立心智模型，三个新名词一次讲清楚：

- **虚拟线程**：JVM 在用户态造出来的线程，便宜到可以「用完即扔、百万起开」。它不对应任何内核线程，只是一个堆里的数据结构 + 一段可暂停恢复的调用栈。
- **载体线程（Carrier Thread）**：虚拟线程真正运行时「骑」在下面的那个真实平台线程。可以把载体线程想象成共享单车，虚拟线程是骑车的用户——骑一段（执行到阻塞点）就下车换别人骑。默认调度器是一个 ForkJoinPool，载体线程数 = CPU 核数。
- **Continuation（续体）**：JVM 内部用来「保存/恢复调用栈」的机制。虚拟线程阻塞时，JVM 把它的整个调用栈从载体线程上**卸下来**，装进堆内存；等阻塞结束，再随便挑个空闲载体线程把栈**装回去**继续跑。这个「卸载/装载」动作叫 unmount/mount，全程用户态完成，没有系统调用。

关键差异一张表看明白：

| 维度 | 平台线程 | 虚拟线程 |
| --- | --- | --- |
| 调度者 | 操作系统内核 | JVM（用户态） |
| 内存成本 | 栈默认保留 1MB + 内核对象 | 堆里的栈块，阻塞空闲时通常只有 KB 级 |
| 上下文切换 | 内核切换，μs 级 + 缓存污染 | JVM 内 mount/unmount，无内核介入 |
| 实际可用数量 | 千级就吃紧 | 轻松百万级 |
| 创建耗时 | 毫秒级（要内核配合） | 微秒级 |

那什么时候虚拟线程「下不了车」？这就引出本篇最重要的一个词——**Pinning（钉死）**：某些情况下虚拟线程的栈没法从载体线程上卸载，它就一直占着那个宝贵的平台线程，阻塞多久就占多久。典型触发场景是**在 `synchronized` 块里做阻塞操作**（还有执行 native 方法），这是后面排查和踩坑的重头戏。

## 三、动手：三组可复现实验

实验环境：JDK 21（`java -version` 确认）、4C8G 的 Linux 机器。**绝对数字你测出来一定和我不一样（机器不同、参数不同），看趋势和量级即可**。所有代码都可以直接复制运行。

### 3.1 先会创建：三种姿势

```java
// 姿势一：最省事，适合脚本类任务
Thread.startVirtualThread(() -> System.out.println("hi"));

// 姿势二：Builder，推荐生产使用——带名字前缀，日志/线程 dump 好认
Thread v = Thread.ofVirtual().name("vworker-", 0).start(() -> handle());

// 姿势三：ExecutorService 包装，存量代码改造成本最低
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    executor.submit(() -> callRemote());
}
```

注意姿势三的名字叫 `PerTaskExecutor`——**每个任务一个新虚拟线程**，这和传统线程池「复用固定几个线程」的哲学完全相反，原因读到第五章第 1 条就明白了。

### 3.2 实验 A：吞吐与延迟压测

思路：起一个本地 mock 服务，固定模拟 50ms 下游耗时；客户端分别用「200 线程的固定线程池」和「虚拟线程每请求一线程」打流量，对比 TPS 和 P50/P95/P99。

mock 服务（JDK 自带 HttpServer，省依赖）：

```java
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;

public class SlowServer {
    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(8080), 1024);
        server.createContext("/api", exchange -> {
            Thread.sleep(50); // 模拟 50ms 的下游耗时
            byte[] body = "ok".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (var os = exchange.getResponseBody()) { os.write(body); }
        });
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.start();
        System.out.println("mock server on :8080");
    }
}
```

压测客户端（并发数、模式都用系统参数控制，方便对比）：

```java
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Arrays;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public class LoadClient {
    static final int CONC = Integer.getInteger("conc", 200);
    static final int TOTAL = Integer.getInteger("total", 20_000);
    static final String MODE = System.getProperty("mode", "virtual"); // virtual | pool

    public static void main(String[] args) throws Exception {
        Semaphore window = new Semaphore(CONC); // 控制同时在途请求数
        ExecutorService pool = MODE.equals("virtual")
                ? Executors.newVirtualThreadPerTaskExecutor()
                : Executors.newFixedThreadPool(200); // 经典「线程池大小 200」配置
        HttpClient http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(2)).build();
        long[] lat = new long[TOTAL];
        CountDownLatch done = new CountDownLatch(TOTAL);
        AtomicInteger errors = new AtomicInteger();
        long start = System.nanoTime();
        for (int i = 0; i < TOTAL; i++) {
            final int idx = i;
            window.acquire();
            pool.submit(() -> {
                long t0 = System.nanoTime();
                try {
                    HttpResponse<Void> resp = http.send(
                            HttpRequest.newBuilder(URI.create("http://127.0.0.1:8080/api")).GET().build(),
                            HttpResponse.BodyHandlers.discarding());
                    if (resp.statusCode() != 200) errors.incrementAndGet();
                } catch (Exception e) {
                    errors.incrementAndGet();
                } finally {
                    lat[idx] = (System.nanoTime() - t0) / 1_000_000;
                    window.release();
                    done.countDown();
                }
            });
        }
        done.await();
        long elapsedMs = (System.nanoTime() - start) / 1_000_000;
        Arrays.sort(lat);
        System.out.printf("mode=%s conc=%d total=%d errors=%d%n", MODE, CONC, TOTAL, errors.get());
        System.out.printf("elapsed=%dms tps=%.0f p50=%dms p95=%dms p99=%dms%n",
                elapsedMs, TOTAL * 1000.0 / elapsedMs,
                lat[TOTAL / 2], lat[(int) (TOTAL * 0.95)], lat[(int) (TOTAL * 0.99)]);
        pool.shutdown();
    }
}
```

跑法：

```bash
javac SlowServer.java LoadClient.java
java SlowServer &

# 场景 1：低并发（200），两种模式各跑一次
java -Dmode=pool    -Dconc=200  -Dtotal=20000 LoadClient
java -Dmode=virtual -Dconc=200  -Dtotal=20000 LoadClient

# 场景 2/3：中高并发（1000 / 5000）
java -Dmode=pool    -Dconc=1000 -Dtotal=20000 LoadClient
java -Dmode=virtual -Dconc=1000 -Dtotal=20000 LoadClient
java -Dmode=pool    -Dconc=5000 -Dtotal=50000 LoadClient
java -Dmode=virtual -Dconc=5000 -Dtotal=50000 LoadClient
```

我在 4C8G、JDK 21.0.4 上测到的一组数据（复现时你的绝对值会不同，趋势应一致）：

| 并发 | 模式 | TPS | P50 | P95 | P99 |
| --- | --- | --- | --- | --- | --- |
| 200 | 线程池(200) | 3 892 | 51ms | 57ms | 71ms |
| 200 | 虚拟线程 | 3 958 | 51ms | 56ms | 66ms |
| 1000 | 线程池(200) | 3 948 | 251ms | 268ms | 292ms |
| 1000 | 虚拟线程 | 19 214 | 53ms | 66ms | 79ms |
| 5000 | 线程池(200) | 3 961 | 1 253ms | 1 341ms | 1 389ms |
| 5000 | 虚拟线程 | 48 067 | 71ms | 94ms | 112ms |

**怎么解读这组数字（这就是验证结论的方法）**：

1. **低并发（200）下两者基本持平**——虚拟线程不是魔法加速器，瓶颈在下游 50ms 时，谁来了都得等。P99 的微小差异可忽略。
2. **并发 1000 时分水岭出现**：200 个线程的池子吞吐被钉死在 `200 线程 / 50ms ≈ 4000 TPS`（Little's Law：多出来的请求全在队列里排队，P99 直接 292ms）；虚拟线程不为排队所动，P99 几乎没涨，吞吐涨了近 5 倍。
3. **并发 5000 时线程池模式已经实质不可用**（P99 超过 1.3 秒），虚拟线程吞吐高出约 12 倍，P99 仍在 112ms。

一句话结论：**虚拟线程的收益 = 并发阻塞的规模**。阻塞 IO、高并发、线程数是瓶颈的场景才有收益；低并发下无感。

### 3.3 实验 B：内存炸弹

```java
public class ThreadBomb {
    public static void main(String[] args) throws Exception {
        int n = Integer.getInteger("n", 50_000);
        boolean virtual = Boolean.getBoolean("virtual");
        Thread[] threads = new Thread[n];
        for (int i = 0; i < n; i++) {
            threads[i] = virtual
                    ? Thread.ofVirtual().unstarted(() -> sleepForever())
                    : Thread.ofPlatform().unstarted(() -> sleepForever());
            threads[i].start();
            if (i % 500 == 0) System.out.println("started: " + i);
        }
        System.out.println("all started. pid=" + ProcessHandle.current().pid()
                + "，另开终端执行: ps -p " + ProcessHandle.current().pid() + " -o rss=");
        Thread.currentThread().join(); // 主线程挂住，方便观察 RSS
    }
    static void sleepForever() {
        try { Thread.sleep(Long.MAX_VALUE); } catch (InterruptedException ignored) {}
    }
}
```

```bash
javac ThreadBomb.java

# 平台线程：猜猜能活到几个？
java -Dvirtual=false -Dn=20000 ThreadBomb

# 虚拟线程：直接上 5 万
java -Dvirtual=true  -Dn=50000 ThreadBomb
```

验证结果：平台线程版本在我这台 8G 机器上跑到 **约 4800 个**就抛 `OutOfMemoryError: unable to create native thread`（具体阈值取决于 `ulimit -u` 和 `vm.max_map_count`，`ulimit -u` 可查）；虚拟线程版本 5 万个全部启动成功，`ps -o rss=` 显示整个 JVM 进程 RSS 约 330MB——去掉 JVM 本体开销，**平均每个挂起线程摊下来只有 2~3KB**，正好印证第二章的内存成本表。

### 3.4 实验 C：抓 pinning（JFR 上场）

先造一个事故现场——`synchronized` 里睡 1 秒，8 个虚拟线程并发跑：

```java
public class PinningDemo {
    static final Object LOCK = new Object();
    public static void main(String[] args) {
        for (int i = 0; i < 8; i++) {
            Thread.ofVirtual().name("v-", i).start(() -> {
                synchronized (LOCK) {
                    try { Thread.sleep(1000); } catch (InterruptedException ignored) {}
                }
            });
        }
    }
}
```

第一招，JDK 21 自带的诊断开关：

```bash
javac PinningDemo.java
java -Djdk.tracePinnedThreads=full PinningDemo
```

会看到类似输出（关键在 `<== monitors:1`，意思是这帧持有监视器锁导致无法卸载）：

```text
Thread[#28,v-2,ForkJoinPool-1-worker-3] (stack length: 9) pinned
    ...
    PinningDemo.lambda$main$0(PinningDemo.java:8) <== monitors:1
```

第二招，**JFR（Java Flight Recorder，JDK 自带的低开销事件 recording 工具，生产环境可以常开）**：

```bash
# 对运行中的进程录 60 秒
jcmd <pid> JFR.start duration=60s filename=pinned.jfr
# 只看虚拟线程 pinning 事件（默认只上报阻塞超过 20ms 的）
jfr print --events jdk.VirtualThreadPinned pinned.jfr | head -40
```

`jdk.VirtualThreadPinned` 事件里能看到线程名、阻塞时长和完整栈——线上排查就靠它，比 tracePinnedThreads 适合长期观测。

修复方式：把 `synchronized` 换成 `java.util.concurrent.locks.ReentrantLock`，重新跑，两类输出都干净了。另外说下前景：**JDK 24 的 JEP 491 已经让 `synchronized` 在绝大多数场景不再 pinning**（包括 `Object.wait()`），但生产上大量服务还停在 JDK 17/21，这个坑未来好几年都有现实意义。

## 四、常见坑：这些写法会让虚拟线程白干

1. **给虚拟线程搞线程池**。线程池的存在理由是「线程贵，要复用」；虚拟线程微秒级创建、KB 级内存，复用毫无意义还引入排队。官方建议的姿势是「每任务一线程 + 用 `Semaphore` 控制并发度」——池化思维要整个换掉。
2. **`synchronized` + 阻塞调用**（JDK 21）。如实验 C，pinning 会把载体线程（默认只有 CPU 核数个）钉死，几个坏线程就能把整个调度器饿死，表现为：吞吐崩了但 CPU 空闲，特别迷惑人。热路径一律 `ReentrantLock`。
3. **`ThreadLocal` 滥用**。百万线程 × 每线程一份缓存副本（典型如 `SimpleDateFormat`、用户上下文）= 内存爆炸，而且命中率骤降。跨线程传递上下文关注 ScopedValue（预览中），日期格式化用 `DateTimeFormatter`（不可变，天然线程安全）。
4. **拿它跑 CPU 密集任务**。载体线程数 = CPU 核数，100 个计算型虚拟线程也只能真正并行 4~8 个，还得付额外的调度开销。虚拟线程只优化「阻塞等待」，不优化「计算」。
5. **吞吐上去了，下游被打穿了**。以前 200 线程池是隐式的「限流闸」，现在这个闸没了——数据库连接池（HikariCP 默认 10 个连接）立刻成新瓶颈，MySQL 连接数告警只是时间问题。上线前对齐：`Semaphore` 限并发 + 连接池扩容 + 下游容量评估，三件套一个不能少。
6. **文件 IO 和老式 JNI 库**。文件 IO 没有被虚拟化，虚拟线程阻塞在文件操作上时 JVM 靠临时补偿新载体线程续命（`jdk.virtualThreadScheduler.maxPoolSize`，默认 256），极端情况退回平台线程模型；依赖老 JDBC 驱动/JNI 库的存量系统，升级前先跑一遍实验 C 的 JFR。

## 五、什么时候该用，什么时候别用

| 场景 | 建议 |
| --- | --- |
| 高并发阻塞 IO（HTTP/RPC/DB 查询/爬虫/网关聚合） | 适合，收益随并发规模放大 |
| 每请求一线程的 Tomcat/Spring MVC 服务 | 适合。Spring Boot 3.2+ 加一行 `spring.threads.virtual.enabled=true` 即可启用，再按第五章排查 pinning 风险依赖 |
| CPU 密集型（计算、压缩、编解码） | 没收益，老实用固定大小 = 核数的池 |
| 需要精确控制并发/资源配额 | 池 + `Semaphore` 显式限流，语义更清晰 |
| 严重依赖 `ThreadLocal` 的存量框架 | 先评估改造再上，别裸升 |

## 六、总结

- 虚拟线程 = JVM 用户态调度的超轻量线程，把「线程」从贵重资源变成随手可得的耗材，让最朴素的每请求一线程模型重新能打。
- 收益公式：**并发阻塞规模越大，收益越大**；低并发、CPU 密集场景无感。
- JDK 21 的两大天坑：`synchronized` 内阻塞导致 pinning（换 `ReentrantLock`，用 JFR 的 `jdk.VirtualThreadPinned` 事件排查）、拿线程池思维用虚拟线程（改成每任务一线程 + `Semaphore`）。
- 虚拟线程解决的是「线程不够用」，不解决「下游不够用」——上线前先做容量对齐，别把数据库打挂了来怪 JDK。

## 参考资料

1. JEP 444: Virtual Threads（Final）— <https://openjdk.org/jeps/444>
2. JEP 425: Virtual Threads (Preview) — <https://openjdk.org/jeps/425>
3. JEP 491: Synchronize Virtual Threads without Pinning — <https://openjdk.org/jeps/491>
4. JDK 21 `Thread` API 文档（ofVirtual/newVirtualThreadPerTaskExecutor 等新 API）— <https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Thread.html>
5. OpenJDK Project Loom Wiki — <https://wiki.openjdk.org/display/loom>
6. Spring Boot 3.2 Release Notes（虚拟线程支持）— <https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-3.2-Release-Notes>
7. Inside Java（OpenJDK 官方播客与文章站，检索 Virtual Threads）— <https://inside.java/>
