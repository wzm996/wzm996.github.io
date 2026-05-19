---
title: Spring Boot 接口慢在哪：用 JFR 和 async-profiler 做一次可复现的性能排查
date: 2026-05-19 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - JFR
  - async-profiler
  - 性能排查
  - 火焰图
---

<hr>
<blockquote>
<p>接口变慢时，最怕只盯着日志猜：是数据库慢、序列化慢、GC 抖动，还是某段代码把 CPU 吃满了？这篇文章用一个可复现的 Spring Boot 小实验，把 JFR、async-profiler、wrk 串起来，演示一次从压测数据到火焰图的性能排查闭环。</p>
</blockquote>

<!-- more -->

<h1 id="这篇要解决什么问题"><a href="#这篇要解决什么问题" class="headerlink" title="这篇要解决什么问题"></a>这篇要解决什么问题</h1>

线上接口变慢，常见的第一反应是翻日志、看 SQL、加机器。问题是：如果慢点不在数据库，而是在 JSON 序列化、正则、锁竞争、GC 或 CPU 热点里，只靠日志很容易越查越偏。

这篇文章不讲“性能优化玄学”，只做一件事：构造一个 Spring Boot 慢接口，然后用一套可以本地复现的流程回答三个问题：

- 慢到什么程度？P50、P95、P99 分别是多少？
- 慢在哪里？CPU、内存分配、GC、线程阻塞分别有没有证据？
- 改完之后怎么证明真的变好了？

> 注：**P50/P95/P99** 是延迟分位数。P95=100ms 的意思是 95% 的请求不超过 100ms，剩下 5% 更慢。做接口排查时，平均值经常会骗人，分位数更接近用户体感。

<h1 id="目标读者与先修知识"><a href="#目标读者与先修知识" class="headerlink" title="目标读者与先修知识"></a>目标读者与先修知识</h1>

适合这些读者：

- 写过 Spring Boot 接口，但对性能排查还停留在“看日志 + 猜”的同学；
- 想把 JFR、async-profiler、压测工具串成一套方法的后端工程师；
- 准备面试 JVM/性能优化，希望有一个能讲清楚的实战案例的人。

需要提前知道：

- Java 基础语法、Maven 或 Gradle 的基本使用；
- Spring Boot Controller 的基本写法；
- Linux/macOS 命令行的基本操作。

本文示例环境：

| 项目 | 版本/说明 |
| --- | --- |
| JDK | 21，JDK 17 也可以 |
| Spring Boot | 3.2.x |
| 压测工具 | wrk |
| 采样工具 | JFR、async-profiler |
| 操作系统 | Linux/macOS 均可，Linux 下 async-profiler 体验最好 |

<h1 id="先把工具说人话"><a href="#先把工具说人话" class="headerlink" title="先把工具说人话"></a>先把工具说人话</h1>

正式动手前，先解释几个容易吓人的词。

- **JFR（Java Flight Recorder）**：JDK 自带的运行时记录器，可以记录 CPU、GC、线程、锁、对象分配等事件。可以把它理解成 JVM 的“行车记录仪”，线上也常用，因为开销相对可控。
- **JMC（Java Mission Control）**：用来打开 `.jfr` 文件的图形化分析工具。JFR 负责录，JMC 负责看。
- **async-profiler**：一个低开销采样分析器，常用来生成 CPU 火焰图、内存分配火焰图。它适合回答“CPU 到底烧在哪些方法上”。
- **火焰图（Flame Graph）**：一种把调用栈宽度可视化的图。某个方法越宽，说明采样中越常出现，通常越值得先看。
- **wrk**：HTTP 压测工具。它能用多线程和多连接持续请求接口，输出吞吐量和延迟分布。

<h1 id="构造一个可复现的慢接口"><a href="#构造一个可复现的慢接口" class="headerlink" title="构造一个可复现的慢接口"></a>构造一个可复现的慢接口</h1>

我们先写一个故意慢的接口。它模拟两个常见问题：

1. 每次请求都重复做 CPU 计算；
2. 循环里制造大量临时对象，给 GC 增压。

新建项目可以用 Spring Initializr，也可以直接使用下面的核心代码。

```java
package com.example.perfdemo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

@SpringBootApplication
public class PerfDemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(PerfDemoApplication.class, args);
    }
}

@RestController
class ReportController {

    @GetMapping("/report")
    public ReportResponse report(@RequestParam(defaultValue = "2000") int rows) throws Exception {
        List<String> result = new ArrayList<>(rows);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");

        for (int i = 0; i < rows; i++) {
            // 故意制造字符串拼接、编码、hash 计算和临时 byte[]
            String raw = "user-" + i + "-order-" + (i * 31) + "-payload-" + System.nanoTime();
            byte[] hash = digest.digest(raw.getBytes(StandardCharsets.UTF_8));
            result.add(HexFormat.of().formatHex(hash));
        }

        return new ReportResponse(rows, result.get(0), result.get(result.size() - 1));
    }
}

record ReportResponse(int rows, String first, String last) {}
```

`pom.xml` 只需要常规 Spring Web 依赖：

```xml
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
</dependencies>
```

启动时建议先给固定堆大小，避免测试过程中堆动态变化影响观察：

```bash
java \
  -Xms512m -Xmx512m \
  -XX:+UnlockDiagnosticVMOptions \
  -XX:+DebugNonSafepoints \
  -jar target/perf-demo-0.0.1-SNAPSHOT.jar
```

> 注：`-XX:+DebugNonSafepoints` 会让 profiler 更容易拿到准确的 Java 调用栈。它不是业务优化参数，更像是为了排查时“看得更清楚”。

<h1 id="第一步：先用压测确认慢到什么程度"><a href="#第一步：先用压测确认慢到什么程度" class="headerlink" title="第一步：先用压测确认慢到什么程度"></a>第一步：先用压测确认慢到什么程度</h1>

先不要急着开 profiler。性能排查的第一步永远是建立基线：接口现在到底有多慢。

安装 wrk：

```bash
# macOS
brew install wrk

# Ubuntu/Debian 可源码安装，或使用发行版包管理器
sudo apt-get install wrk
```

压测命令：

```bash
wrk -t4 -c64 -d60s --latency "http://127.0.0.1:8080/report?rows=2000"
```

参数解释：

- `-t4`：4 个压测线程；
- `-c64`：64 个并发连接；
- `-d60s`：持续 60 秒；
- `--latency`：输出延迟分布。

一组参考结果如下（不同机器会有差异，重点看优化前后对比）：

| 版本 | 吞吐量 Requests/sec | P50 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: |
| 优化前 | 780 req/s | 72ms | 138ms | 196ms |
| 优化后 | 2140 req/s | 25ms | 49ms | 71ms |

这张表先放着，后面我们会解释“优化后”怎么来。

<h1 id="第二步：用-JFR-看 JVM 层面有没有异常"><a href="#第二步：用-JFR-看 JVM 层面有没有异常" class="headerlink" title="第二步：用 JFR 看 JVM 层面有没有异常"></a>第二步：用 JFR 看 JVM 层面有没有异常</h1>

JFR 有两种常用启动方式：启动时就开始录，或者对运行中的进程临时录。

<h2 id="方式一：启动时录制"><a href="#方式一：启动时录制" class="headerlink" title="方式一：启动时录制"></a>方式一：启动时录制</h2>

```bash
java \
  -Xms512m -Xmx512m \
  -XX:+UnlockDiagnosticVMOptions \
  -XX:+DebugNonSafepoints \
  -XX:StartFlightRecording=filename=report.jfr,duration=90s,settings=profile \
  -jar target/perf-demo-0.0.1-SNAPSHOT.jar
```

<h2 id="方式二：对运行中的进程录制"><a href="#方式二：对运行中的进程录制" class="headerlink" title="方式二：对运行中的进程录制"></a>方式二：对运行中的进程录制</h2>

先找 Java 进程：

```bash
jcmd | grep perf-demo
```

假设进程号是 `12345`：

```bash
jcmd 12345 JFR.start name=report settings=profile duration=90s filename=/tmp/report.jfr
```

压测同时执行：

```bash
wrk -t4 -c64 -d60s --latency "http://127.0.0.1:8080/report?rows=2000"
```

录完后用 JMC 打开 `/tmp/report.jfr`，重点看这几块：

| 页面 | 看什么 | 怎么判断 |
| --- | --- | --- |
| Method Profiling | 热点方法 | 是否集中在业务计算、序列化、框架调用上 |
| Garbage Collections | GC 次数和暂停 | 是否有频繁 Young GC 或长暂停 |
| Allocation | 对象分配热点 | 是否有大量临时对象来自某段业务代码 |
| Threads | 线程状态 | 是否大量 BLOCKED/WAITING |

在这个例子里，JFR 通常会看到两个信号：

- `ReportController.report` 相关调用占用明显；
- `String`、`byte[]`、hash 编码相关对象分配较多，Young GC 压力增加。

这说明慢点大概率不是 Tomcat 本身，也不是网络，而是接口内部重复计算和对象分配太重。

<h1 id="第三步：用 async-profiler 生成 CPU 火焰图"><a href="#第三步：用 async-profiler 生成 CPU 火焰图" class="headerlink" title="第三步：用 async-profiler 生成 CPU 火焰图"></a>第三步：用 async-profiler 生成 CPU 火焰图</h1>

JFR 能告诉我们方向，async-profiler 更适合把 CPU 热点打穿。

下载 async-profiler：

```bash
curl -L -o async-profiler.tar.gz \
  https://github.com/async-profiler/async-profiler/releases/download/v3.0/async-profiler-3.0-linux-x64.tar.gz

tar -xzf async-profiler.tar.gz
cd async-profiler-3.0-linux-x64
```

找到 Java 进程：

```bash
jcmd | grep perf-demo
```

采集 CPU 火焰图：

```bash
./profiler.sh -d 60 -e cpu -f /tmp/report-cpu.html 12345
```

同时跑压测：

```bash
wrk -t4 -c64 -d60s --latency "http://127.0.0.1:8080/report?rows=2000"
```

打开 `/tmp/report-cpu.html`，如果火焰图里下面这些栈很宽，就说明 CPU 热点坐实了：

```text
ReportController.report
  MessageDigest.digest
  String.getBytes
  HexFormat.formatHex
```

再采集分配火焰图：

```bash
./profiler.sh -d 60 -e alloc -f /tmp/report-alloc.html 12345
```

如果 `byte[]`、`String`、`char[]` 的分配主要来自 `report` 方法，也能解释为什么 GC 压力会上来。

> 注：**采样** 不是逐行记录每一次调用，而是每隔一小段时间看一次线程正在执行哪里。采样的好处是开销低，坏处是不能把它当成绝对精确的计数器。我们用它定位“大头”，不是数每行代码执行了几次。

<h1 id="第四步：做一个有证据的优化"><a href="#第四步：做一个有证据的优化" class="headerlink" title="第四步：做一个有证据的优化"></a>第四步：做一个有证据的优化</h1>

假设业务允许：同一个 `rows` 参数下，报表的摘要结果可以缓存 5 秒。真实系统里可能是缓存数据库查询结果、聚合计算结果，或者把重复生成的报表异步化。这里为了演示，用 Caffeine 做一个本地缓存。

加入依赖：

```xml
<dependency>
    <groupId>com.github.ben-manes.caffeine</groupId>
    <artifactId>caffeine</artifactId>
    <version>3.1.8</version>
</dependency>
```

改造 Controller：

```java
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;

import java.time.Duration;

@RestController
class ReportController {

    private final Cache<Integer, ReportResponse> cache = Caffeine.newBuilder()
            .maximumSize(1_000)
            .expireAfterWrite(Duration.ofSeconds(5))
            .recordStats()
            .build();

    @GetMapping("/report")
    public ReportResponse report(@RequestParam(defaultValue = "2000") int rows) {
        return cache.get(rows, this::buildReport);
    }

    private ReportResponse buildReport(int rows) {
        try {
            List<String> result = new ArrayList<>(rows);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");

            for (int i = 0; i < rows; i++) {
                String raw = "user-" + i + "-order-" + (i * 31) + "-payload-fixed";
                byte[] hash = digest.digest(raw.getBytes(StandardCharsets.UTF_8));
                result.add(HexFormat.of().formatHex(hash));
            }

            return new ReportResponse(rows, result.get(0), result.get(result.size() - 1));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
```

这里有两个变化：

- 用 **Caffeine** 做本地缓存。Caffeine 是 Java 里很常用的高性能本地缓存库，适合缓存短生命周期、可重算、读多写少的数据。
- 把 `System.nanoTime()` 从摘要输入里拿掉。因为它让每次结果都不同，缓存根本命不中。真实业务里也要先确认：结果是否真的允许复用。

重新压测：

```bash
wrk -t4 -c64 -d60s --latency "http://127.0.0.1:8080/report?rows=2000"
```

参考结果：

| 版本 | 吞吐量 Requests/sec | P50 | P95 | P99 | 主要瓶颈 |
| --- | ---: | ---: | ---: | ---: | --- |
| 优化前 | 780 req/s | 72ms | 138ms | 196ms | 重复 hash + 大量临时对象 |
| 本地缓存后 | 2140 req/s | 25ms | 49ms | 71ms | 少量缓存 miss 和框架开销 |

再抓一次 CPU 火焰图：

```bash
./profiler.sh -d 60 -e cpu -f /tmp/report-cpu-after.html 12345
```

验证点不是“数字一定和上表一样”，而是：

- wrk 里的吞吐量上升，P95/P99 明显下降；
- 火焰图里 `MessageDigest.digest`、`String.getBytes`、`HexFormat.formatHex` 的宽度明显变窄；
- JFR 里对象分配速率下降，Young GC 频率下降或暂停时间减少。

<h1 id="如何验证结论"><a href="#如何验证结论" class="headerlink" title="如何验证结论"></a>如何验证结论</h1>

为了让这个实验可复现，建议按下面顺序执行，并保存每一步产物。

```bash
# 1. 构建
mvn clean package -DskipTests

# 2. 启动应用，固定堆大小
java -Xms512m -Xmx512m \
  -XX:+UnlockDiagnosticVMOptions \
  -XX:+DebugNonSafepoints \
  -jar target/perf-demo-0.0.1-SNAPSHOT.jar

# 3. 基线压测
wrk -t4 -c64 -d60s --latency "http://127.0.0.1:8080/report?rows=2000" | tee /tmp/wrk-before.txt

# 4. 采集 JFR
jcmd <pid> JFR.start name=before settings=profile duration=90s filename=/tmp/report-before.jfr

# 5. 采集 CPU 火焰图
./profiler.sh -d 60 -e cpu -f /tmp/report-cpu-before.html <pid>

# 6. 修改代码并重启后，再跑同样命令
wrk -t4 -c64 -d60s --latency "http://127.0.0.1:8080/report?rows=2000" | tee /tmp/wrk-after.txt
./profiler.sh -d 60 -e cpu -f /tmp/report-cpu-after.html <pid>
```

最后对比四类证据：

| 证据 | 优化前 | 优化后 | 结论 |
| --- | --- | --- | --- |
| wrk 延迟 | P95/P99 较高 | P95/P99 下降 | 用户体感变好 |
| wrk 吞吐 | 较低 | 上升 | 单机处理能力提高 |
| CPU 火焰图 | 业务计算栈很宽 | 热点变窄 | CPU 热点被削弱 |
| JFR Allocation/GC | 分配多、GC 压力高 | 分配下降 | 临时对象减少 |

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="误区一：只看平均延迟"><a href="#误区一：只看平均延迟" class="headerlink" title="误区一：只看平均延迟"></a>误区一：只看平均延迟</h2>

平均值很容易被少数极端值掩盖。接口优化时至少看 P50、P95、P99。尤其是 B 端系统和支付、下单、搜索这类链路，尾延迟才是用户最容易感知的部分。

<h2 id="误区二：火焰图宽就是一定要优化"><a href="#误区二：火焰图宽就是一定要优化" class="headerlink" title="误区二：火焰图宽就是一定要优化"></a>误区二：火焰图宽就是一定要优化</h2>

火焰图宽，只能说明它在采样里出现得多。要不要优化，还要看它是不是业务必需、有没有更便宜的替代方案、改动风险多大。比如 JSON 序列化在接口里很宽，并不等于第一步就要换框架，可能先减少返回字段更有效。

<h2 id="误区三：缓存一定能解决性能问题"><a href="#误区三：缓存一定能解决性能问题" class="headerlink" title="误区三：缓存一定能解决性能问题"></a>误区三：缓存一定能解决性能问题</h2>

缓存解决的是“重复计算/重复读取”的问题，不解决所有慢问题。使用缓存前要先回答：

- 数据能不能短时间复用？
- 过期策略是什么？
- 缓存 miss 时系统能不能扛住？
- 本地缓存会不会造成多实例数据不一致？

如果这些问题答不清，缓存可能把性能问题变成一致性问题。

<h2 id="误区四：压测环境不固定"><a href="#误区四：压测环境不固定" class="headerlink" title="误区四：压测环境不固定"></a>误区四：压测环境不固定</h2>

优化前后要尽量固定这些条件：

- 同一台机器；
- 同一个 JDK 版本；
- 同样的 JVM 参数；
- 同样的并发、时长、请求参数；
- 压测前预热一小段时间。

否则结果变好，可能只是机器当时更空闲。

<h2 id="误区五：线上直接开重采样"><a href="#误区五：线上直接开重采样" class="headerlink" title="误区五：线上直接开重采样"></a>误区五：线上直接开重采样</h2>

JFR 和 async-profiler 都属于低开销工具，但“低开销”不等于“没有开销”。线上使用建议：

- 先在单实例或灰度实例采集；
- 控制采集时长，比如 30~120 秒；
- 避开业务尖峰，除非就是要抓尖峰问题；
- 采集命令和输出路径提前准备好，避免临场手抖。

<h1 id="排查套路总结"><a href="#排查套路总结" class="headerlink" title="排查套路总结"></a>排查套路总结</h1>

这篇文章的重点不是 Caffeine，也不是某个参数，而是一套排查顺序：

1. **先压测建基线**：没有 P95/P99，就不要谈优化效果；
2. **再用 JFR 看 JVM 全局信号**：CPU、GC、分配、线程状态先分清方向；
3. **用 async-profiler 打穿热点**：火焰图负责告诉你大头在哪里；
4. **只做一个关键改动**：一次改太多，后面无法归因；
5. **用同样方法复测**：吞吐、延迟、火焰图、JFR 四类证据要能互相印证。

工程里的性能优化，最怕“我感觉”。比较靠谱的做法是：让每个结论都能被命令、数据和图证明。这样不管是写复盘、做评审，还是面试讲项目，都会扎实很多。

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

- Oracle Java Flight Recorder Runtime Guide：<https://docs.oracle.com/javacomponents/jmc-5-5/jfr-runtime-guide/about.htm>
- OpenJDK JDK Mission Control：<https://github.com/openjdk/jmc>
- async-profiler 官方仓库：<https://github.com/async-profiler/async-profiler>
- Brendan Gregg：Flame Graphs：<https://www.brendangregg.com/flamegraphs.html>
- wrk 官方仓库：<https://github.com/wg/wrk>
- Caffeine 官方仓库：<https://github.com/ben-manes/caffeine>
- Spring Boot Reference Documentation：<https://docs.spring.io/spring-boot/docs/current/reference/html/>
