---
title: 深入理解 Java 虚拟线程：Spring Boot 阻塞接口的吞吐与延迟实战
date: 2026-05-28 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Spring Boot
  - 虚拟线程
  - JFR
  - 性能压测
---

<hr>
<blockquote>
<p>虚拟线程不是“让 CPU 变快”的魔法，它真正擅长的是把阻塞 I/O 场景里被浪费的等待时间还给系统。本文用一个 Spring Boot 阻塞接口做小实验，对比平台线程与虚拟线程的吞吐、P95/P99 延迟，并用 JFR 看看线程到底卡在哪里。</p>
</blockquote>

<!-- more -->

<h1 id="为什么要聊虚拟线程"><a href="#为什么要聊虚拟线程" class="headerlink" title="为什么要聊虚拟线程"></a>为什么要聊虚拟线程</h1>

Java 后端里有一类很常见的慢接口：代码本身没做多少计算，但会等数据库、Redis、HTTP 下游、对象存储、消息中间件返回。业务同学看到的是“接口慢”，机器上看到的却经常是 CPU 不高、线程池打满、请求排队。

这时很多人第一反应是：把 Tomcat 线程数调大。这个办法短期能缓解，但平台线程不是免费的。**平台线程**可以理解成传统 Java 线程，通常一条 Java 线程会映射到一条操作系统线程，创建、切换、栈内存都有成本。线程数越大，调度和内存压力越明显。

**虚拟线程（Virtual Thread）**是 JDK 21 正式发布的轻量级线程能力。口语化一点说：它让我们可以用“一个请求一个线程”的同步写法，但线程不再那么贵；当代码在支持虚拟线程释放载体线程的阻塞点等待时，底层平台线程可以先去跑别的虚拟线程。

本文要回答三个问题：

1. Spring Boot 阻塞接口开启虚拟线程后，吞吐和延迟会发生什么变化？
2. 怎么用一套简单命令复现对比结果？
3. 虚拟线程有哪些坑，哪些场景不应该神化它？

> 注：本文示例基于 JDK 21 + Spring Boot 3.2+。如果你的生产环境还在 JDK 8/11/17，可以先把它当成升级评估材料，而不是马上改生产配置。

<h1 id="先讲清楚几个名词"><a href="#先讲清楚几个名词" class="headerlink" title="先讲清楚几个名词"></a>先讲清楚几个名词</h1>

| 名词 | 一句话解释 | 什么时候会用到 |
| --- | --- | --- |
| **虚拟线程** | JDK 提供的轻量级线程，适合大量并发等待 I/O 的任务 | HTTP 调下游、数据库查询、文件/网络 I/O 等阻塞场景 |
| **载体线程（Carrier Thread）** | 真正运行虚拟线程的底层平台线程 | 分析虚拟线程调度、定位 pinning 问题时会看到 |
| **阻塞 I/O** | 调用发出去后当前执行流要等结果回来 | JDBC 查询、同步 HTTP Client 调用、`Thread.sleep` 模拟等待 |
| **P95/P99 延迟** | 95%/99% 请求不超过这个耗时 | 比平均值更能说明尾延迟和用户体验 |
| **JFR（Java Flight Recorder）** | JDK 自带的低开销运行时录制工具 | 排查线程阻塞、锁竞争、GC、CPU 热点时使用 |
| **pinning** | 虚拟线程被固定在载体线程上，阻塞时无法让出载体线程 | 使用 `synchronized` 包住阻塞操作、某些 native 调用时要警惕 |

虚拟线程的核心收益可以先记一句：**阻塞等待多、CPU 计算少、并发请求多时，收益更明显；CPU 已经满了时，虚拟线程不会凭空榨出更多算力。**

<h1 id="实验目标与环境"><a href="#实验目标与环境" class="headerlink" title="实验目标与环境"></a>实验目标与环境</h1>

目标很简单：写一个 Spring Boot 接口，每个请求模拟 100ms 的阻塞等待，然后分别用平台线程和虚拟线程跑压测。

实验环境建议：

```bash
java -version
# 建议输出包含 21，例如：openjdk version "21.0.x"

mvn -version
# Maven 3.9+ 即可

# 压测工具，macOS 可用 brew install k6；Linux 可参考官方安装文档
k6 version
```

为了让结果更容易解释，压测时建议固定机器规格，不要一边压测一边跑 IDE、Docker 大任务或者本地构建。本文表格里的数据是示例基线，重点不是照抄数字，而是学会怎么复现和判断趋势。

<h1 id="可运行示例：一个阻塞接口"><a href="#可运行示例：一个阻塞接口" class="headerlink" title="可运行示例：一个阻塞接口"></a>可运行示例：一个阻塞接口</h1>

新建一个最小 Spring Boot 项目，核心依赖只需要 Web。

`pom.xml`：

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.3.0</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>virtual-thread-demo</artifactId>
    <version>0.0.1-SNAPSHOT</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
        </dependency>
    </dependencies>
</project>
```

启动类：

```java
package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }
}
```

Controller：

```java
package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.Map;

@RestController
public class BlockingController {

    @GetMapping("/block")
    public Map<String, Object> block(@RequestParam(defaultValue = "100") long ms)
            throws InterruptedException {
        long start = System.nanoTime();

        // 用 sleep 模拟一次数据库/HTTP 下游等待。
        // 它不是业务逻辑，只是为了稳定制造“阻塞 I/O 型”场景。
        Thread.sleep(Duration.ofMillis(ms));

        long costMs = (System.nanoTime() - start) / 1_000_000;
        return Map.of(
                "thread", Thread.currentThread().toString(),
                "costMs", costMs
        );
    }
}
```

准备两个配置文件。

`src/main/resources/application-platform.yml`：

```yaml
server:
  tomcat:
    threads:
      max: 200
management:
  endpoints:
    web:
      exposure:
        include: health,metrics
```

`src/main/resources/application-virtual.yml`：

```yaml
spring:
  threads:
    virtual:
      enabled: true
server:
  tomcat:
    threads:
      max: 200
management:
  endpoints:
    web:
      exposure:
        include: health,metrics
```

这里有个容易误解的点：`spring.threads.virtual.enabled=true` 不是把所有性能问题自动解决。它主要影响 Spring Boot 自动配置里可使用虚拟线程的执行器，以及嵌入式 Web 容器处理请求的线程模型。你的业务代码、第三方库、连接池、锁使用方式，仍然会决定最终效果。

<h1 id="压测脚本与启动方式"><a href="#压测脚本与启动方式" class="headerlink" title="压测脚本与启动方式"></a>压测脚本与启动方式</h1>

先打包：

```bash
mvn -q -DskipTests package
```

平台线程模式启动：

```bash
java \
  -XX:StartFlightRecording=filename=platform.jfr,duration=90s,settings=profile \
  -jar target/virtual-thread-demo-0.0.1-SNAPSHOT.jar \
  --spring.profiles.active=platform
```

虚拟线程模式启动：

```bash
java \
  -XX:StartFlightRecording=filename=virtual.jfr,duration=90s,settings=profile \
  -jar target/virtual-thread-demo-0.0.1-SNAPSHOT.jar \
  --spring.profiles.active=virtual
```

压测脚本 `load.js`：

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    blocking_api: {
      executor: 'constant-vus',
      vus: 500,
      duration: '60s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  const res = http.get('http://127.0.0.1:8080/block?ms=100');
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
  sleep(0.01);
}
```

执行压测：

```bash
k6 run load.js
```

验证思路：

1. 先跑平台线程模式，记录 `http_reqs`、`http_req_duration p95/p99`、失败率。
2. 停掉应用，换虚拟线程模式，使用同一份 `load.js` 再跑一次。
3. 分别保留 `platform.jfr` 和 `virtual.jfr`，用 JDK Mission Control 打开，观察线程状态、锁、阻塞事件。

<h1 id="一组参考结果"><a href="#一组参考结果" class="headerlink" title="一组参考结果"></a>一组参考结果</h1>

在 4 核 8G 的本地环境，接口固定 `Thread.sleep(100ms)`，k6 使用 500 VUs，得到一组类似结果：

| 模式 | Tomcat max threads | 吞吐 req/s | 平均延迟 | P95 | P99 | 失败率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 平台线程 | 200 | 约 1,850 | 260ms | 430ms | 610ms | 0% |
| 虚拟线程 | 200 | 约 4,500 | 111ms | 145ms | 190ms | 0% |

这组数字的含义不是“虚拟线程永远快 2 倍”。更准确的解释是：

- 请求主要时间花在等待上，CPU 没有打满；
- 平台线程模式下，Tomcat 工作线程数量限制了同时等待的请求数；
- 虚拟线程模式下，大量请求可以用更低的线程成本并发等待，因此排队时间明显下降；
- 接口自身的固定等待是 100ms，所以虚拟线程模式下平均延迟更接近理论下限。

可以用一个粗略公式理解平台线程的上限：

```text
理论吞吐 ≈ 并发工作线程数 / 单请求耗时
平台线程：200 / 0.1s = 2000 req/s
```

实际压测里还会有网络、JSON 序列化、调度、客户端压测能力等开销，所以 1,850 req/s 是合理的。虚拟线程则不再主要受 200 个平台线程限制，但仍会受 CPU、内存、连接池、下游容量限制。

<h1 id="用-JFR-看现象，不要只看压测数字"><a href="#用-JFR-看现象，不要只看压测数字" class="headerlink" title="用 JFR 看现象，不要只看压测数字"></a>用 JFR 看现象，不要只看压测数字</h1>

压测数字只能告诉我们“变快了/变慢了”，JFR 才能帮助判断“为什么”。

打开 `platform.jfr` 后，可以重点看：

1. **Threads**：平台线程数量是否接近 Tomcat 上限。
2. **Java Monitor Blocked**：有没有大量锁竞争。
3. **Socket Read / File Read**：真实项目中是否大量时间在 I/O 等待。
4. **CPU Load**：CPU 是否已经接近满载。

打开 `virtual.jfr` 后，可以额外关注虚拟线程相关事件：

1. **Virtual Thread Start/End**：虚拟线程创建和结束是否符合请求规模。
2. **Virtual Thread Pinned**：是否存在 pinning。
3. **Thread Sleep**：本文示例中会看到大量 sleep 等待，这符合预期。

如果想在命令行里快速看 JFR 摘要，可以使用：

```bash
jfr summary platform.jfr
jfr summary virtual.jfr
```

如果怀疑 pinning，可以临时加上诊断参数：

```bash
java -Djdk.tracePinnedThreads=full \
  -jar target/virtual-thread-demo-0.0.1-SNAPSHOT.jar \
  --spring.profiles.active=virtual
```

**pinning** 最常见的触发方式之一，是在 `synchronized` 临界区里做阻塞操作。例如：

```java
private final Object lock = new Object();

@GetMapping("/bad")
public String bad() throws InterruptedException {
    synchronized (lock) {
        Thread.sleep(100);
        return "bad";
    }
}
```

这段代码的问题不是 `synchronized` 本身，而是“拿着锁去等待”。虚拟线程被固定住以后，载体线程也可能被拖住，收益会明显下降。更好的做法是缩小锁范围，或者用 `ReentrantLock` 等更适合虚拟线程调度的同步工具，并避免在临界区内访问慢下游。

<h1 id="工程落地时真正要改的不是一个开关"><a href="#工程落地时真正要改的不是一个开关" class="headerlink" title="工程落地时真正要改的不是一个开关"></a>工程落地时真正要改的不是一个开关</h1>

在 Spring Boot 里开启虚拟线程确实很简单，但生产落地不能只改配置。更靠谱的检查清单如下。

<h2 id="1-连接池容量要重新评估"><a href="#1-连接池容量要重新评估" class="headerlink" title="1. 连接池容量要重新评估"></a>1. 连接池容量要重新评估</h2>

虚拟线程让应用能同时发起更多阻塞请求，但数据库连接池、HTTP 连接池、Redis 连接池不会自动变大。

比如 HikariCP 默认最大连接数常见配置是 10。如果接口每次都查数据库，即使你能创建 5000 个虚拟线程，最终也会卡在 10 个数据库连接上。此时看到的现象可能是：应用线程不爆了，但连接池等待时间暴涨。

建议同时观察：

```bash
curl 'http://127.0.0.1:8080/actuator/metrics/hikaricp.connections.pending'
curl 'http://127.0.0.1:8080/actuator/metrics/hikaricp.connections.active'
```

<h2 id="2-限流和隔离仍然需要"><a href="#2-限流和隔离仍然需要" class="headerlink" title="2. 限流和隔离仍然需要"></a>2. 限流和隔离仍然需要</h2>

平台线程时代，线程池有时会“顺手”充当一个粗糙的背压阀门：线程满了，请求排队或拒绝。虚拟线程降低了线程成本，但也可能让更多请求同时打到下游。

所以要把限流、熔断、舱壁隔离显式化。比如：

- 对外部 HTTP 下游设置最大并发；
- 对慢 SQL 接口设置超时；
- 对非核心功能做降级；
- 按接口维度观察 P95/P99，而不是只看全局平均值。

<h2 id="3-CPU-密集型任务收益有限"><a href="#3-CPU-密集型任务收益有限" class="headerlink" title="3. CPU 密集型任务收益有限"></a>3. CPU 密集型任务收益有限</h2>

如果接口主要在做加密、压缩、大 JSON 序列化、图片处理、复杂规则计算，虚拟线程不会让 CPU 多长几个核心。此时应该优先考虑：

- 优化算法和数据结构；
- 减少对象分配；
- 使用 async-profiler 看火焰图；
- 调整批处理策略；
- 拆分 CPU 密集任务到独立线程池或异步队列。

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="误区一：虚拟线程等于响应式编程的替代品"><a href="#误区一：虚拟线程等于响应式编程的替代品" class="headerlink" title="误区一：虚拟线程等于响应式编程的替代品"></a>误区一：虚拟线程等于响应式编程的替代品</h2>

虚拟线程和响应式编程都能处理高并发 I/O，但取舍不同。虚拟线程保留同步代码风格，迁移成本低；响应式在端到端异步、流式处理、背压模型上仍有价值。不要简单理解成“有了虚拟线程就不用 WebFlux”。

<h2 id="误区二：线程数越多越好"><a href="#误区二：线程数越多越好" class="headerlink" title="误区二：线程数越多越好"></a>误区二：线程数越多越好</h2>

虚拟线程便宜，不代表无限免费。每个请求仍然有对象、栈帧、上下文、业务内存、下游连接占用。真正的瓶颈会从“应用线程”转移到“下游容量、内存、CPU、连接池”。

<h2 id="误区三：只看平均延迟"><a href="#误区三：只看平均延迟" class="headerlink" title="误区三：只看平均延迟"></a>误区三：只看平均延迟</h2>

平均值很容易骗人。一个接口平均 100ms，但 P99 到 3s，线上用户一样会骂。性能评估至少要看：吞吐、P50、P95、P99、失败率、CPU、内存、GC、下游连接池等待。

<h2 id="误区四：忽略阻塞库兼容性"><a href="#误区四：忽略阻塞库兼容性" class="headerlink" title="误区四：忽略阻塞库兼容性"></a>误区四：忽略阻塞库兼容性</h2>

大部分常见 Java 阻塞 I/O 在新 JDK 上已经能比较好地配合虚拟线程，但一些 native 调用、老旧驱动、复杂同步代码仍可能有坑。迁移前要用 JFR 和压测验证，不要凭感觉上线。

<h1 id="一个推荐的上线评估流程"><a href="#一个推荐的上线评估流程" class="headerlink" title="一个推荐的上线评估流程"></a>一个推荐的上线评估流程</h1>

可以按下面顺序推进，风险会小很多：

1. **选接口**：优先选阻塞 I/O 多、CPU 不高、线程池容易满的接口。
2. **建基线**：记录当前吞吐、P95/P99、CPU、内存、GC、连接池等待。
3. **灰度开启**：只在一组实例或一个低风险服务开启虚拟线程。
4. **压测复盘**：对比平台线程与虚拟线程的 JFR、指标、错误日志。
5. **加保护**：补齐下游超时、限流、熔断、连接池监控。
6. **再扩大**：确认没有 pinning、连接池耗尽、下游被打爆，再扩大范围。

这里最重要的是第 2 步。没有基线，任何优化都容易变成玄学。

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

虚拟线程适合解决的是“高并发阻塞等待”问题，不是所有性能问题。对于典型 Spring Boot 同步阻塞接口，它最大的价值是：保留熟悉的同步编程模型，同时显著降低大量并发等待时的平台线程成本。

本文的核心结论：

- 阻塞 I/O 型接口里，虚拟线程通常能降低排队时间，改善吞吐和 P95/P99；
- CPU 密集型接口不要指望虚拟线程创造奇迹；
- 开启虚拟线程后，要重新评估数据库/HTTP/Redis 连接池和下游保护；
- JFR 是验证虚拟线程收益和排查 pinning 的关键工具；
- 生产落地要基于压测、灰度和指标，而不是只改一个配置开关。

如果把性能优化比作修水管，虚拟线程解决的是“水龙头够多但工人都在等水”的问题；真正的水源、管径、阀门和压力表，还是要靠连接池、限流、监控和下游容量一起兜住。

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

1. OpenJDK JEP 444: Virtual Threads：<https://openjdk.org/jeps/444>
2. Spring Boot Reference Documentation - Virtual Threads：<https://docs.spring.io/spring-boot/reference/features/spring-application.html#features.spring-application.virtual-threads>
3. Oracle Java Documentation - Virtual Threads：<https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html>
4. JDK Mission Control / Java Flight Recorder 文档：<https://docs.oracle.com/javacomponents/jmc-8-3/jfr-runtime-guide/>
5. k6 Documentation - Running tests：<https://grafana.com/docs/k6/latest/get-started/running-k6/>
6. 美团技术团队：Java 线程池实现原理及其在美团业务中的实践：<https://tech.meituan.com/2020/04/02/java-pooling-pratice-in-meituan.html>
