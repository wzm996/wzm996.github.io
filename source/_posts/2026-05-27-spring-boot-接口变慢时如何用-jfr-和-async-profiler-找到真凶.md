---
title: Spring Boot 接口变慢时，如何用 JFR 和 async-profiler 找到真凶
date: 2026-05-27 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - JFR
  - async-profiler
  - JVM
  - 性能优化
---

<hr>
<blockquote>
<p>接口变慢时，最怕的不是慢，而是不知道慢在哪里。本文用一个可复现的 Spring Boot 小实验，把压测、JFR、async-profiler 和火焰图串起来：先确认 P95/P99 延迟，再定位 CPU 热点，最后验证优化是否真的有效。</p>
</blockquote>

<!-- more -->

<h1 id="为什么不要一上来就改代码"><a href="#为什么不要一上来就改代码" class="headerlink" title="为什么不要一上来就改代码"></a>为什么不要一上来就改代码</h1>

线上接口突然变慢，很多同学的第一反应是：是不是数据库慢？是不是 Redis 慢？是不是 GC 了？是不是线程池满了？这些猜测都可能对，但如果没有数据，很容易变成“玄学调参”。

这篇文章想解决一个很具体的问题：**一个 Spring Boot 接口 P95/P99 延迟变高时，如何用可复现的方式找到主要瓶颈，并证明优化有效**。

先解释几个后面会频繁出现的词：

- **P95/P99 延迟**：把请求耗时从小到大排序，排在 95% / 99% 位置的耗时；它比平均值更能反映用户遇到的“长尾慢请求”。
- **JFR（Java Flight Recorder）**：JDK 自带的低开销运行时记录器，可以记录线程、锁、GC、方法采样等事件，适合在线上或预发环境做诊断。
- **async-profiler**：一个 JVM 性能分析工具，常用来采样 CPU、分配、锁等热点；它能生成火焰图，帮助我们快速看出时间花在哪些调用栈上。
- **火焰图（Flame Graph）**：一种把调用栈按耗时宽度画出来的图，越宽说明采样次数越多，也就是越值得关注。

目标读者：写过 Spring Boot 接口、了解基本 JVM 概念、希望掌握“慢接口定位闭环”的后端开发同学。

<h1 id="候选选题与最终选择"><a href="#候选选题与最终选择" class="headerlink" title="候选选题与最终选择"></a>候选选题与最终选择</h1>

本次按专栏要求先给出 4 个候选：

| 候选 | 主线 | 分类 | 亮点 |
| --- | --- | --- | --- |
| Spring Boot 接口变慢时，如何用 JFR 和 async-profiler 找到真凶 | 工程实践 | 后端工程 / 性能与高并发 | 压测 + JFR + 火焰图 + 优化前后对比 |
| Redis 缓存击穿不是加个锁就完事：从单机锁到逻辑过期 | 数据库与数据建模 | 数据库与存储 / Redis | 可复现并发实验、成本/一致性权衡 |
| RAG 召回质量怎么评估：用 Java 做一个最小评测集 | AI | 后端工程 / 可观测性 | Java × AI，召回率、成本、延迟对比 |
| HTTP 连接池为什么会把接口拖慢：从 TIME_WAIT 到连接复用 | 计算机网络 | 计算机网络 / HTTP/HTTPS | curl/wrk/netstat 复现，网络排障闭环 |

最终选择第一题。理由很简单：它最贴近 Java 后端日常排障，能把“压测指标”和“JVM 诊断工具”放到一个闭环里，读者照着做能马上复用到自己的项目里。

<h1 id="实验目标与环境"><a href="#实验目标与环境" class="headerlink" title="实验目标与环境"></a>实验目标与环境</h1>

我们会构造一个看起来很普通、但 CPU 消耗偏高的接口：请求进来后做一段 JSON 拼装、排序和哈希计算。这个例子不是为了模拟某个真实业务，而是为了制造一个稳定的 CPU 热点，方便观察工具效果。

实验环境建议：

| 项目 | 版本 / 说明 |
| --- | --- |
| JDK | 17+，因为 JFR 已经内置且体验比较稳定 |
| Spring Boot | 3.x |
| 压测工具 | wrk 或 hey，本文用 wrk 举例 |
| 诊断工具 | JFR、async-profiler 3.x |
| 操作系统 | Linux/macOS 均可；Linux 下 async-profiler 信息更完整 |

> 注：如果你在容器里跑实验，记得给容器足够 CPU 配额，否则看到的瓶颈可能是 cgroup 限制，不是应用本身。

<h1 id="准备一个可复现的慢接口"><a href="#准备一个可复现的慢接口" class="headerlink" title="准备一个可复现的慢接口"></a>准备一个可复现的慢接口</h1>

先创建一个最小 Spring Boot 项目，核心依赖只需要 Web：

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-web</artifactId>
</dependency>
```

然后写一个接口：

```java
package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;

@RestController
public class ProfileController {

    @GetMapping("/api/profile")
    public String profile(@RequestParam(defaultValue = "800") int size) throws Exception {
        List<String> rows = new ArrayList<>(size);
        for (int i = 0; i < size; i++) {
            rows.add(expensiveBuild(i));
        }
        rows.sort(Comparator.naturalOrder());
        return rows.get(rows.size() / 2);
    }

    private String expensiveBuild(int i) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        String payload = "user-" + i + "-" + System.nanoTime();
        for (int j = 0; j < 80; j++) {
            byte[] bytes = digest.digest(payload.getBytes(StandardCharsets.UTF_8));
            payload = HexFormat.of().formatHex(bytes);
        }
        return payload;
    }
}
```

这里故意留下两个“味道不太好”的点：

1. 每次调用 `expensiveBuild` 都创建 `MessageDigest`，对象创建和安全 provider 查找有额外成本。
2. 循环里反复做字符串与字节数组转换，CPU 和分配压力都会偏高。

启动服务：

```bash
./mvnw spring-boot:run
```

本地确认接口可访问：

```bash
curl 'http://127.0.0.1:8080/api/profile?size=800'
```

如果能返回一串 SHA-256 风格的十六进制字符串，就可以开始压测。

<h1 id="第一步：先用压测确认问题"><a href="#第一步：先用压测确认问题" class="headerlink" title="第一步：先用压测确认问题"></a>第一步：先用压测确认问题</h1>

不要直接开 profiler。第一步应该先回答：**它到底有多慢？慢在平均值，还是慢在长尾？**

使用 wrk 压测 60 秒：

```bash
wrk -t4 -c64 -d60s --latency 'http://127.0.0.1:8080/api/profile?size=800'
```

示例结果如下（不同机器数值会不同，但趋势类似）：

| 版本 | QPS | Avg | P50 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 初始版本 | 118 req/s | 541 ms | 506 ms | 892 ms | 1240 ms |

这个结果说明两件事：

- 平均延迟已经不低，说明整体处理成本偏高。
- P99 明显高于 P50，说明长尾请求更严重，可能有 CPU 排队、GC、锁竞争或偶发慢路径。

接下来才进入诊断阶段。

<h1 id="第二步：用-JFR-看全局画像"><a href="#第二步：用-JFR-看全局画像" class="headerlink" title="第二步：用 JFR 看全局画像"></a>第二步：用 JFR 看全局画像</h1>

JFR 适合先看全局：线程是不是都在跑？GC 有没有异常？锁竞争是否明显？CPU 热点大概在哪里？

先找到 Java 进程 PID：

```bash
jcmd | grep demo
```

启动一次 60 秒的 JFR 记录：

```bash
jcmd <PID> JFR.start \
  name=slow-api \
  settings=profile \
  duration=60s \
  filename=/tmp/slow-api.jfr
```

同时再跑一轮压测：

```bash
wrk -t4 -c64 -d60s --latency 'http://127.0.0.1:8080/api/profile?size=800'
```

JFR 结束后，可以用 JDK Mission Control 打开 `/tmp/slow-api.jfr`，重点看四块：

| 面板 | 重点观察 | 怎么判断 |
| --- | --- | --- |
| Threads | 请求线程是否长期 RUNNABLE | RUNNABLE 多通常表示 CPU 忙，BLOCKED 多要怀疑锁 |
| Garbage Collections | GC 次数和暂停时间 | 如果暂停长、频率高，优先看分配和堆 |
| Method Profiling | 热点方法 | 宽度靠前的方法通常是优化入口 |
| Socket / File I/O | 是否有外部 I/O 等待 | 如果 I/O 等待高，别先优化 CPU |

在这个实验里，通常会看到请求线程大多处于 RUNNABLE，GC 暂停不是主因，热点集中在摘要计算、字符串编码和十六进制转换附近。也就是说：**这更像 CPU 型慢接口，不是数据库或网络慢**。

<h1 id="第三步：用-async-profiler-生成火焰图"><a href="#第三步：用-async-profiler-生成火焰图" class="headerlink" title="第三步：用 async-profiler 生成火焰图"></a>第三步：用 async-profiler 生成火焰图</h1>

JFR 已经给了方向，但要看调用栈宽度，火焰图更直观。

安装 async-profiler 后执行：

```bash
./profiler.sh -e cpu -d 60 -f /tmp/slow-api-cpu.html <PID>
```

参数解释一下：

- `-e cpu`：采样 CPU 事件，适合定位 CPU 热点。
- `-d 60`：采样 60 秒，最好覆盖一轮稳定压测。
- `-f`：输出火焰图 HTML。

采样期间继续压测：

```bash
wrk -t4 -c64 -d60s --latency 'http://127.0.0.1:8080/api/profile?size=800'
```

打开 `/tmp/slow-api-cpu.html` 后，如果看到类似这些调用栈很宽，就说明它们是主要耗时：

```text
ProfileController.expensiveBuild
  MessageDigest.getInstance
  String.getBytes
  HexFormat.formatHex
  DigestBase.engineDigest
```

火焰图阅读有个朴素原则：**先看宽的，再看自己能改的**。JDK 内部方法很宽不代表一定要改 JDK，通常要回到自己的调用方式上：是不是重复初始化？是不是可以复用？是不是可以减少转换？

<h1 id="优化方案：少创建、少转换、控制工作量"><a href="#优化方案：少创建、少转换、控制工作量" class="headerlink" title="优化方案：少创建、少转换、控制工作量"></a>优化方案：少创建、少转换、控制工作量</h1>

针对火焰图暴露的问题，我们做三类优化：

1. **复用 MessageDigest**：它不是线程安全的，所以不能用一个全局实例；可以用 `ThreadLocal` 给每个线程一个实例。
2. **减少中间字符串转换**：循环里尽量用 byte[] 传递，最后一步再转 hex。
3. **限制请求参数**：`size` 不能无限大，否则一个请求就能吃满 CPU。

优化后的代码示例：

```java
package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;

@RestController
public class ProfileControllerV2 {

    private static final ThreadLocal<MessageDigest> SHA256 = ThreadLocal.withInitial(() -> {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    });

    @GetMapping("/api/profile-v2")
    public String profile(@RequestParam(defaultValue = "800") int size) {
        int safeSize = Math.min(Math.max(size, 1), 1000);
        List<String> rows = new ArrayList<>(safeSize);
        for (int i = 0; i < safeSize; i++) {
            rows.add(expensiveBuild(i));
        }
        rows.sort(Comparator.naturalOrder());
        return rows.get(rows.size() / 2);
    }

    private String expensiveBuild(int i) {
        MessageDigest digest = SHA256.get();
        digest.reset();

        byte[] payload = ByteBuffer.allocate(Long.BYTES + Integer.BYTES)
                .putLong(System.nanoTime())
                .putInt(i)
                .array();

        for (int j = 0; j < 80; j++) {
            payload = digest.digest(payload);
            digest.reset();
        }
        return HexFormat.of().formatHex(payload);
    }
}
```

这里需要注意：`ThreadLocal` 不是银弹。它适合线程数量相对稳定的服务端线程池；如果你在大量创建短生命周期线程，或者在线程池中保存了大对象，就要特别小心内存占用和清理问题。

<h1 id="再次压测：验证优化是否有效"><a href="#再次压测：验证优化是否有效" class="headerlink" title="再次压测：验证优化是否有效"></a>再次压测：验证优化是否有效</h1>

同样的机器、同样的并发、同样的时长压测新接口：

```bash
wrk -t4 -c64 -d60s --latency 'http://127.0.0.1:8080/api/profile-v2?size=800'
```

示例结果：

| 版本 | QPS | Avg | P50 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 初始版本 | 118 req/s | 541 ms | 506 ms | 892 ms | 1240 ms |
| 优化版本 | 263 req/s | 243 ms | 218 ms | 411 ms | 608 ms |
| 变化 | +123% | -55% | -57% | -54% | -51% |

这个表比“我感觉快了”可靠得多。它说明优化不是只改善了平均值，P95/P99 长尾也明显下降。

再跑一次 async-profiler：

```bash
./profiler.sh -e cpu -d 60 -f /tmp/slow-api-v2-cpu.html <PID>
```

如果优化有效，火焰图应该会出现两个变化：

1. `MessageDigest.getInstance` 的宽度明显缩小，甚至从热点里消失。
2. `String.getBytes` 和 `HexFormat.formatHex` 的总体占比下降，剩下的主要成本集中在不可避免的 SHA-256 计算上。

这就是一个完整闭环：**压测发现问题 → JFR 判断大方向 → 火焰图定位热点 → 修改代码 → 用相同压测和火焰图验证**。

<h1 id="如果瓶颈不是-CPU，该怎么看"><a href="#如果瓶颈不是-CPU，该怎么看" class="headerlink" title="如果瓶颈不是 CPU，该怎么看"></a>如果瓶颈不是 CPU，该怎么看</h1>

真实项目里，慢接口未必都是 CPU。可以按下面这个顺序快速分流：

| 现象 | 优先怀疑 | 建议工具 |
| --- | --- | --- |
| RUNNABLE 线程多，CPU 高 | 计算热点、序列化、正则、加解密 | JFR、async-profiler CPU 火焰图 |
| BLOCKED / WAITING 多 | 锁竞争、线程池等待、连接池等待 | JFR Locks、线程 dump |
| GC 暂停频繁 | 对象分配过多、堆太小、晋升失败 | JFR GC、GC 日志、async-profiler alloc |
| CPU 不高但延迟高 | 数据库、Redis、HTTP 下游慢 | APM、链路追踪、慢 SQL、tcpdump |
| 只有 P99 抖动 | 队列堆积、偶发 STW、下游毛刺 | 延迟直方图、JFR、链路追踪 |

其中 **STW（Stop-The-World）** 指 JVM 暂停所有业务线程来完成某些运行时工作，比如部分 GC 阶段；它会直接影响长尾延迟。

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="只看平均延迟"><a href="#只看平均延迟" class="headerlink" title="只看平均延迟"></a>只看平均延迟</h2>

平均值会掩盖长尾。一个接口平均 100ms，不代表用户体验稳定；如果 P99 是 2s，仍然会有一批用户明显感知到卡顿。

<h2 id="压测环境不固定"><a href="#压测环境不固定" class="headerlink" title="压测环境不固定"></a>压测环境不固定</h2>

优化前后必须尽量保持环境一致：机器、JDK、参数、并发数、压测时长、数据规模都要一致。否则结果很容易没有可比性。

<h2 id="采样时间太短"><a href="#采样时间太短" class="headerlink" title="采样时间太短"></a>采样时间太短</h2>

采样 3 秒就下结论很危险。建议至少覆盖 30~60 秒稳定压测窗口，必要时多跑几次取趋势。

<h2 id="把火焰图宽度等同于 bug"><a href="#把火焰图宽度等同于 bug" class="headerlink" title="把火焰图宽度等同于 bug"></a>把火焰图宽度等同于 bug</h2>

火焰图宽，只能说明“时间花在这里”，不等于这里一定写错了。比如加密计算本来就耗 CPU，真正该优化的可能是调用次数、缓存策略、任务拆分或异步化。

<h2 id="ThreadLocal-乱用"><a href="#ThreadLocal-乱用" class="headerlink" title="ThreadLocal 乱用"></a>ThreadLocal 乱用</h2>

`ThreadLocal` 可以减少重复创建，但也可能带来内存保留问题。在线程池场景下，线程活得很久，里面放大对象要谨慎；用完是否需要 `remove()`，要看对象生命周期和框架模型。

<h1 id="生产环境落地建议"><a href="#生产环境落地建议" class="headerlink" title="生产环境落地建议"></a>生产环境落地建议</h1>

如果要把这套方法用到生产环境，我建议保持克制：

1. **先看监控，再开诊断**：确认慢的是哪个接口、哪个实例、哪个时间段。
2. **优先在预发复现**：能复现就别直接在线上折腾。
3. **线上 JFR 控制时长**：JFR 开销低，但不是零；建议短时间采样，记录好开始和结束时间。
4. **async-profiler 注意权限**：Linux 上可能需要 perf_event 权限，容器里还要额外配置能力。
5. **优化必须回归指标**：至少比较吞吐、P95/P99、错误率、CPU、GC，不要只看单点。

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

这篇文章的核心不是某个具体工具，而是一套排障顺序：

- 先用压测把问题量化，尤其关注 P95/P99。
- 用 JFR 看全局画像，判断是 CPU、GC、锁还是 I/O。
- 用 async-profiler 和火焰图定位具体调用栈热点。
- 优化后必须用同样方法复测，证明指标真的改善。
- 慢接口排查不要靠猜，靠可重复的证据链。

对 Java 后端来说，JFR 和 async-profiler 是非常值得熟练掌握的两把刀：一个看全局，一个看热点。用好了，很多“玄学慢接口”都会变成可解释、可验证、可优化的问题。

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

1. Oracle Documentation：Java Flight Recorder Runtime Guide，https://docs.oracle.com/javacomponents/jmc-5-4/jfr-runtime-guide/
2. OpenJDK Mission Control：JDK Mission Control Project，https://openjdk.org/projects/jmc/
3. async-profiler GitHub：async-profiler 使用说明，https://github.com/async-profiler/async-profiler
4. Brendan Gregg：Flame Graphs，https://www.brendangregg.com/flamegraphs.html
5. Spring Boot Reference Documentation：Actuator 与生产可观测性，https://docs.spring.io/spring-boot/reference/actuator/index.html
6. wrk GitHub：HTTP benchmarking tool，https://github.com/wg/wrk
