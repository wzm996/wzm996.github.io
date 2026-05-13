---
title: Java 虚拟线程实战：用 JFR 看懂吞吐、延迟与 pinning
date: 2026-05-13 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Java
  - 虚拟线程
  - JFR
  - 性能调优
  - 并发
---

<hr>
<blockquote>
<p><strong>虚拟线程</strong> 不是“让 CPU 变多”的魔法，它解决的是阻塞式 I/O 场景下线程太贵、线程池太容易被占满的问题。本文用一个可运行的 Java 21 小实验，把平台线程池、虚拟线程、连接池限制和 JFR 里的 pinning 事件串起来看一遍。</p>
</blockquote>

<!-- more -->

<h1 id="为什么要认真看虚拟线程"><a href="#为什么要认真看虚拟线程" class="headerlink" title="为什么要认真看虚拟线程"></a>为什么要认真看虚拟线程</h1>

很多 Java 后端服务的并发瓶颈，不是 CPU 算不过来，而是线程在等：等数据库、等 Redis、等 HTTP 下游、等磁盘 I/O。传统做法是上线程池：Tomcat 一批线程、业务线程池一批线程、异步回调再来一批线程。问题是，平台线程背后通常对应操作系统线程，创建和上下文切换都不便宜，线程池大小一旦估错，要么吞吐上不去，要么把机器拖到疯狂切换。

Java 21 正式引入的 **虚拟线程（Virtual Thread）** 给了另一条路：继续写直观的同步阻塞代码，但阻塞时让 JVM 把虚拟线程从承载它的平台线程上“卸下来”，平台线程可以去跑别的虚拟线程。口语化一点说：以前一个服务员等一桌菜就站着不动，现在他可以把等待中的桌号挂墙上，先去服务下一桌。

不过虚拟线程也有边界。它适合 **I/O 密集型** 场景，不会让 CPU 密集计算凭空变快；它也会受数据库连接池、下游限流、锁竞争影响。更麻烦的是，有些代码会导致虚拟线程被 **pinning（钉住）**：虚拟线程阻塞时没法从平台线程上卸下来，相当于把服务员钉在原地等菜，这会明显削弱虚拟线程的收益。

<h1 id="目标读者与先修知识"><a href="#目标读者与先修知识" class="headerlink" title="目标读者与先修知识"></a>目标读者与先修知识</h1>

本文适合已经写过 Java Web 服务、用过线程池或连接池的同学。你最好知道：

- **平台线程（Platform Thread）**：传统 Java 线程，通常映射到操作系统线程。
- **线程池**：复用有限线程处理任务，避免无限创建线程。
- **JFR（Java Flight Recorder）**：JDK 自带的低开销运行时诊断工具，可以记录线程、GC、锁、I/O 等事件，常用于线上性能分析。
- **P95/P99 延迟**：把请求耗时从小到大排序，95%/99% 请求能落在这个耗时以内；它比平均值更能暴露长尾问题。

<h1 id="先给结论"><a href="#先给结论" class="headerlink" title="先给结论"></a>先给结论</h1>

| 场景 | 虚拟线程是否有帮助 | 关键原因 |
| --- | --- | --- |
| 大量阻塞式 HTTP/RPC/数据库调用 | 通常明显有帮助 | 阻塞时可释放承载线程，降低线程池排队 |
| CPU 密集计算 | 基本没帮助 | CPU 就那么多核，虚拟线程不能增加算力 |
| 数据库连接池很小 | 有帮助但会被连接池封顶 | 并发入口多了，瓶颈转移到连接数 |
| 大量 synchronized 包住阻塞调用 | 可能变差 | 容易出现 virtual thread pinned |
| ThreadLocal 滥用 | 风险上升 | 虚拟线程数量巨大时，每个线程的本地对象都可能放大内存压力 |

一句话：**虚拟线程提升的是“等待型并发”的承载能力，不是替代容量规划、连接池治理和性能剖析。**

<h1 id="实验环境"><a href="#实验环境" class="headerlink" title="实验环境"></a>实验环境</h1>

本文实验只依赖 JDK 21，不需要 Spring Boot。为了让复现足够轻量，我们用 `Thread.sleep` 模拟一个 100ms 的下游 I/O 等待。

> 注：`Thread.sleep` 在这里不是为了模拟 CPU 工作，而是模拟“线程正在等外部系统返回”。真实服务里可能是 JDBC 查询、HTTP 调用、Redis 请求或文件 I/O。

建议环境：

```bash
java -version
# openjdk version "21.x" 或更高
```

保存下面这个文件为 `VirtualThreadLab.java`：

```java
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

public class VirtualThreadLab {
    static final int REQUESTS = Integer.getInteger("requests", 20_000);
    static final int IO_MS = Integer.getInteger("ioMs", 100);
    static final int POOL_SIZE = Integer.getInteger("poolSize", 200);
    static final int DB_POOL = Integer.getInteger("dbPool", 10_000);
    static final boolean PINNED = Boolean.getBoolean("pinned");
    static final Object LOCK = new Object();

    public static void main(String[] args) throws Exception {
        String mode = args.length == 0 ? "virtual" : args[0];
        ExecutorService executor = switch (mode) {
            case "fixed" -> Executors.newFixedThreadPool(POOL_SIZE);
            case "virtual" -> Executors.newVirtualThreadPerTaskExecutor();
            default -> throw new IllegalArgumentException("mode must be fixed or virtual");
        };

        Semaphore db = new Semaphore(DB_POOL);
        List<Long> latencies = Collections.synchronizedList(new ArrayList<>(REQUESTS));

        long start = System.nanoTime();
        List<Future<Void>> futures = new ArrayList<>(REQUESTS);
        for (int i = 0; i < REQUESTS; i++) {
            futures.add(executor.submit(new Task(db, latencies)));
        }
        for (Future<Void> future : futures) {
            future.get();
        }
        long costNs = System.nanoTime() - start;

        executor.shutdown();
        executor.awaitTermination(1, TimeUnit.MINUTES);

        latencies.sort(Long::compareTo);
        double seconds = costNs / 1_000_000_000.0;
        System.out.printf("mode=%s pinned=%s requests=%d ioMs=%d poolSize=%d dbPool=%d%n",
                mode, PINNED, REQUESTS, IO_MS, POOL_SIZE, DB_POOL);
        System.out.printf("total=%.2fs throughput=%.0f req/s p50=%dms p95=%dms p99=%dms%n",
                seconds,
                REQUESTS / seconds,
                percentile(latencies, 0.50),
                percentile(latencies, 0.95),
                percentile(latencies, 0.99));
    }

    static class Task implements Callable<Void> {
        private final Semaphore db;
        private final List<Long> latencies;

        Task(Semaphore db, List<Long> latencies) {
            this.db = db;
            this.latencies = latencies;
        }

        @Override
        public Void call() throws Exception {
            long start = System.nanoTime();
            db.acquire();
            try {
                if (PINNED) {
                    synchronized (LOCK) {
                        fakeRemoteCall();
                    }
                } else {
                    fakeRemoteCall();
                }
            } finally {
                db.release();
                latencies.add(Duration.ofNanos(System.nanoTime() - start).toMillis());
            }
            return null;
        }
    }

    static void fakeRemoteCall() throws InterruptedException {
        Thread.sleep(IO_MS);
    }

    static long percentile(List<Long> sorted, double p) {
        int index = (int) Math.ceil(sorted.size() * p) - 1;
        return sorted.get(Math.max(0, Math.min(index, sorted.size() - 1)));
    }
}
```

编译：

```bash
javac VirtualThreadLab.java
```

<h1 id="第一组：平台线程池-vs-虚拟线程"><a href="#第一组：平台线程池-vs-虚拟线程" class="headerlink" title="第一组：平台线程池 vs 虚拟线程"></a>第一组：平台线程池 vs 虚拟线程</h1>

先跑传统固定线程池，200 个平台线程处理 2 万个请求，每个请求等待 100ms：

```bash
java -Drequests=20000 -DioMs=100 -DpoolSize=200 VirtualThreadLab fixed
```

再跑虚拟线程版本：

```bash
java -Drequests=20000 -DioMs=100 VirtualThreadLab virtual
```

一台 8C/16G 开发机上的样例结果如下，数字不用照抄，重点看趋势：

| 模式 | 总耗时 | 吞吐 | P50 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 固定线程池 200 | 10.18s | 1965 req/s | 100ms | 101ms | 106ms |
| 虚拟线程 | 0.41s | 48780 req/s | 100ms | 118ms | 141ms |

这里固定线程池的吞吐很好理解：200 个线程，每个请求等 100ms，理想吞吐约等于 `200 / 0.1 = 2000 req/s`。虚拟线程版本可以一次性创建大量轻量任务，阻塞时不长期占住平台线程，所以总耗时接近单次 I/O 的耗时加少量调度开销。

> 注：虚拟线程不是没有成本。创建 2 万个虚拟线程仍然要分配对象、调度任务、记录栈片段。只是相比创建 2 万个平台线程，它便宜很多。

<h1 id="第二组：加上数据库连接池限制"><a href="#第二组：加上数据库连接池限制" class="headerlink" title="第二组：加上数据库连接池限制"></a>第二组：加上数据库连接池限制</h1>

真实服务不会因为使用虚拟线程就能无限访问数据库。连接池、下游 QPS、队列长度都会把并发压回来。

用信号量模拟数据库连接池只有 200 个连接：

```bash
java -Drequests=20000 -DioMs=100 -DdbPool=200 VirtualThreadLab virtual
```

样例结果：

| 模式 | dbPool | 总耗时 | 吞吐 | P50 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 虚拟线程 | 10000 | 0.41s | 48780 req/s | 100ms | 118ms | 141ms |
| 虚拟线程 | 200 | 10.11s | 1978 req/s | 5090ms | 9610ms | 10015ms |

这组结果最值得看的是 P95/P99。单个“数据库调用”仍然只睡 100ms，但大量请求在等连接池许可，所以端到端延迟被排队时间拉爆了。

这也是生产上引入虚拟线程时最容易踩的坑：**入口并发能力变强之后，瓶颈会更快暴露在连接池、下游限流、行锁、慢 SQL 上。** 如果只看应用线程数下降，会误以为服务更健康；但用户实际看到的可能是长尾延迟更差。

<h1 id="第三组：用-JFR-观察-pinning"><a href="#第三组：用-JFR-观察-pinning" class="headerlink" title="第三组：用 JFR 观察 pinning"></a>第三组：用 JFR 观察 pinning</h1>

**Pinning** 可以理解为“虚拟线程被钉在承载线程上”。虚拟线程执行到某些阻塞点时，本来应该让出承载线程；但如果它在 `synchronized` 临界区里阻塞，或者遇到部分 native/foreign 调用，JVM 可能没法把它卸下来。

我们打开 `-Dpinned=true`，让所有任务在 `synchronized` 里 sleep：

```bash
java \
  -XX:StartFlightRecording=filename=vt-pinned.jfr,settings=profile,dumponexit=true \
  -Djdk.tracePinnedThreads=full \
  -Drequests=2000 \
  -DioMs=100 \
  -Dpinned=true \
  VirtualThreadLab virtual
```

这里有两个参数需要解释：

- `-XX:StartFlightRecording=...`：启动时开启 JFR 录制，程序退出时把诊断数据写到 `vt-pinned.jfr`。
- `-Djdk.tracePinnedThreads=full`：当虚拟线程被 pin 住时，把相关栈打印出来，方便快速定位是哪段代码导致的。

可以用 JDK 自带的 `jfr` 命令查看事件：

```bash
jfr summary vt-pinned.jfr | grep -i VirtualThread
jfr view jdk.VirtualThreadPinned vt-pinned.jfr
```

如果本机支持该事件，你会看到类似信息：

```text
jdk.VirtualThreadPinned {
  startTime = 10:02:11.123
  duration = 100 ms
  eventThread = "" (javaThreadId = 42, virtual)
  stackTrace = [
    java.lang.VirtualThread.parkOnCarrierThread(...)
    java.lang.Thread.sleep(...)
    VirtualThreadLab.fakeRemoteCall(...)
    VirtualThreadLab$Task.call(...)
  ]
}
```

样例压测数据：

| 模式 | pinned | 请求数 | 总耗时 | 吞吐 | P95 | 现象 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| virtual | false | 2000 | 0.18s | 11111 req/s | 113ms | 大量 sleep 可并发等待 |
| virtual | true | 2000 | 200.9s | 10 req/s | 190900ms | synchronized 串行化，JFR 出现 pinned 事件 |

这个极端例子不是说 `synchronized` 不能用，而是提醒：**不要把可能阻塞的 I/O 调用放在 synchronized 临界区里。** 如果只是短时间保护内存状态，`synchronized` 仍然很正常；如果里面有 HTTP、JDBC、文件读写，就要认真审视。

<h1 id="如何验证结论"><a href="#如何验证结论" class="headerlink" title="如何验证结论"></a>如何验证结论</h1>

建议按下面顺序复现：

```bash
# 1. 编译
javac VirtualThreadLab.java

# 2. 固定线程池：吞吐大约受 poolSize / ioMs 限制
java -Drequests=20000 -DioMs=100 -DpoolSize=200 VirtualThreadLab fixed

# 3. 虚拟线程：阻塞等待型任务总耗时明显下降
java -Drequests=20000 -DioMs=100 VirtualThreadLab virtual

# 4. 连接池封顶：吞吐回到 dbPool / ioMs，长尾延迟变高
java -Drequests=20000 -DioMs=100 -DdbPool=200 VirtualThreadLab virtual

# 5. pinning：生成 JFR，并查看 pinned 事件
java \
  -XX:StartFlightRecording=filename=vt-pinned.jfr,settings=profile,dumponexit=true \
  -Djdk.tracePinnedThreads=full \
  -Drequests=2000 \
  -DioMs=100 \
  -Dpinned=true \
  VirtualThreadLab virtual
jfr view jdk.VirtualThreadPinned vt-pinned.jfr
```

验证时重点看三件事：

1. 固定线程池吞吐是否接近 `poolSize / (ioMs / 1000)`。
2. 虚拟线程在无下游限制时，总耗时是否明显接近单次 I/O 等待时间。
3. 加 `dbPool` 或 `pinned` 后，瓶颈是否从“线程数量”转移到“连接池/锁”。

<h1 id="放到-Spring-Boot-里怎么想"><a href="#放到-Spring-Boot-里怎么想" class="headerlink" title="放到 Spring Boot 里怎么想"></a>放到 Spring Boot 里怎么想</h1>

如果是 Spring Boot 3.2+，可以通过配置启用虚拟线程：

```yaml
spring:
  threads:
    virtual:
      enabled: true
```

它的意义是让应用在合适位置使用虚拟线程执行任务。这个开关不是“性能自动优化”按钮，上线前至少要检查：

- JDBC 驱动、HTTP 客户端、Redis 客户端在当前版本下的阻塞行为是否符合预期。
- HikariCP 这类连接池大小是否合理，是否有连接泄漏监控。
- 关键路径里有没有把远程调用包进 `synchronized` 的代码。
- ThreadLocal 是否塞了大对象，比如用户上下文、临时缓存、大 Map。
- 压测报告是否同时看吞吐、P95/P99、错误率、下游 QPS，而不只看平均耗时。

一个更稳的落地策略是：先选 I/O 密集、状态相对简单的内部接口灰度；用 JFR、Micrometer、日志把长尾延迟和连接池等待时间看清楚；确认瓶颈没有转移成下游雪崩，再逐步扩大范围。

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="误区一：虚拟线程越多越好"><a href="#误区一：虚拟线程越多越好" class="headerlink" title="误区一：虚拟线程越多越好"></a>误区一：虚拟线程越多越好</h2>

虚拟线程便宜，不代表可以无限创建。每个虚拟线程仍然有对象、栈片段、调度成本。如果你的服务能瞬间放进来 100 万个请求，但数据库只能处理 500 个连接，结果通常不是吞吐起飞，而是排队、超时、重试风暴。

<h2 id="误区二：用了虚拟线程就不需要连接池"><a href="#误区二：用了虚拟线程就不需要连接池" class="headerlink" title="误区二：用了虚拟线程就不需要连接池"></a>误区二：用了虚拟线程就不需要连接池</h2>

连接池限制的是下游资源，不只是应用线程。数据库连接、Redis 连接、HTTP 连接都代表真实资源。虚拟线程让应用侧等待更便宜，但不能让 MySQL 多出无限连接。

<h2 id="误区三：CPU-密集任务也交给虚拟线程"><a href="#误区三：CPU-密集任务也交给虚拟线程" class="headerlink" title="误区三：CPU 密集任务也交给虚拟线程"></a>误区三：CPU 密集任务也交给虚拟线程</h2>

CPU 密集任务的瓶颈是核心数。比如压缩、加密、大 JSON 序列化、复杂规则计算，虚拟线程只会增加调度对象，不会让 CPU 变多。此时更应该控制并行度，必要时拆分批处理或做算法优化。

<h2 id="误区四：忽略-pinning"><a href="#误区四：忽略-pinning" class="headerlink" title="误区四：忽略 pinning"></a>误区四：忽略 pinning</h2>

如果压测时发现虚拟线程吞吐没上去，先别急着怀疑 JVM。用 JFR 看看有没有 `jdk.VirtualThreadPinned`，再检查阻塞调用是否在 `synchronized`、native 调用或某些老旧库里。

<h1 id="上线前自检清单"><a href="#上线前自检清单" class="headerlink" title="上线前自检清单"></a>上线前自检清单</h1>

- [ ] JDK 版本至少是 21，框架版本明确支持虚拟线程。
- [ ] 核心接口做过压测，报告包含吞吐、P50/P95/P99、错误率。
- [ ] 连接池等待时间、下游 QPS、超时和重试次数都有监控。
- [ ] JFR 检查过 `VirtualThreadPinned`、锁竞争、异常分配热点。
- [ ] 没有把阻塞 I/O 放进大范围 `synchronized` 临界区。
- [ ] ThreadLocal 使用可控，没有在线程本地缓存大对象。
- [ ] 有灰度开关和回滚方案。

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

虚拟线程的价值，在于让 Java 服务用更低的线程成本承载更多阻塞式 I/O。它保留了同步代码的可读性，又把过去“线程池排队”的一部分压力交给 JVM 调度。

但工程上不能只看“虚拟线程很轻”。真正上线时，瓶颈会沿着调用链移动：连接池、下游限流、锁竞争、ThreadLocal、pinning 都可能成为新的问题。比较稳的姿势是：用小实验建立直觉，用压测确认收益，用 JFR 找证据，再灰度进生产。

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

1. OpenJDK JEP 444: Virtual Threads — https://openjdk.org/jeps/444
2. Java SE 21 API: `Executors.newVirtualThreadPerTaskExecutor` — https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/Executors.html
3. Java Flight Recorder Runtime Guide — https://docs.oracle.com/javacomponents/jmc-5-4/jfr-runtime-guide/about.htm
4. Spring Boot Reference: Virtual Threads — https://docs.spring.io/spring-boot/reference/features/spring-application.html#features.spring-application.virtual-threads
5. HikariCP GitHub Documentation — https://github.com/brettwooldridge/HikariCP
6. 美团技术团队：Java 线程池实现原理及其在美团业务中的实践 — https://tech.meituan.com/2020/04/02/java-pooling-pratice-in-meituan.html
