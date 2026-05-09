---
title: Spring Boot 虚拟线程实战：从吞吐、P95 延迟到 JFR 观测
date: 2026-05-09 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Spring Boot
  - 虚拟线程
  - JFR
  - 性能测试
---

<hr>
<blockquote>
<p>虚拟线程不是“让 CPU 代码变快”的银弹，它真正擅长的是把大量阻塞等待从昂贵的平台线程上挪开。本文用一个可复现的 Spring Boot 小实验，把吞吐、P95/P99 延迟、线程数、JFR 观测和常见坑串起来，看看它到底适合放在哪些接口上。</p>
</blockquote>

<!-- more -->

<h1 id="为什么要关心虚拟线程"><a href="#为什么要关心虚拟线程" class="headerlink" title="为什么要关心虚拟线程"></a>为什么要关心虚拟线程</h1>

很多 Java Web 服务的性能瓶颈，不是 CPU 算不动，而是线程在等：等数据库、等 Redis、等下游 HTTP、等磁盘 I/O。传统 Spring MVC 模型里，一个请求通常占住一个平台线程。**平台线程**可以简单理解为和操作系统线程一一映射的 Java 线程，创建和切换成本都不低，所以线程池不能无限加。

JDK 21 正式引入的 **虚拟线程（Virtual Thread）**，目标就是让“阻塞式写法”也能承载更高并发。它仍然写同步代码，但等待 I/O 时可以把底层平台线程让出来。换句话说，它不是把业务逻辑变成魔法，而是把“等”的成本降下来。

这篇文章面向已经写过 Spring Boot 接口、了解基本压测概念的读者。我们会做三件事：

1. 用同一个接口对比传统线程池与虚拟线程；
2. 用 `wrk` 看吞吐、P95/P99 延迟；
3. 用 JFR 看线程与阻塞事件，判断结论是否站得住。

> 注：**JFR（Java Flight Recorder）** 是 JDK 自带的低开销运行时记录器，可以记录线程、锁、GC、方法采样等事件，适合在线下或低风险生产场景定位性能问题。

<h1 id="先给结论：适合-I-O-密集，不适合替代所有线程池"><a href="#先给结论：适合-I-O-密集，不适合替代所有线程池" class="headerlink" title="先给结论：适合 I/O 密集，不适合替代所有线程池"></a>先给结论：适合 I/O 密集，不适合替代所有线程池</h1>

虚拟线程最适合这类场景：

- 接口里有大量阻塞等待，例如 JDBC、HTTP Client、文件 I/O；
- 代码主体仍然是同步调用，不想为了并发把链路改成全响应式；
- 请求之间相对独立，没有大量长时间持有锁的共享状态。

它不适合这类场景：

- CPU 密集型计算，例如大循环、压缩、加密、图片处理；
- 依赖大量 `synchronized` 包住阻塞 I/O 的老代码；
- 期望“开了虚拟线程，数据库连接池也自动无限大”。

**核心判断标准很简单：瓶颈在等待，虚拟线程通常有收益；瓶颈在 CPU、锁、连接池，虚拟线程只会把瓶颈更快暴露出来。**

<h1 id="实验环境与示例项目"><a href="#实验环境与示例项目" class="headerlink" title="实验环境与示例项目"></a>实验环境与示例项目</h1>

建议使用下面环境复现：

| 项目 | 建议版本 | 说明 |
| --- | --- | --- |
| JDK | 21+ | 虚拟线程在 JDK 21 正式可用 |
| Spring Boot | 3.2+ | 内置 `spring.threads.virtual.enabled` 配置 |
| 压测工具 | wrk 或 hey | 本文以 `wrk` 为例 |
| 观测工具 | JFR / JDK Mission Control | JDK 自带 JFR，JMC 用来看图形化结果 |

先创建一个最小 Spring Boot 项目，只保留 Web 依赖即可。核心接口如下：

```java
package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;

@SpringBootApplication
public class VirtualThreadDemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(VirtualThreadDemoApplication.class, args);
    }
}

@RestController
class DemoController {

    @GetMapping("/io")
    public String io() throws InterruptedException {
        // 模拟一次下游调用：比如查数据库、调 Redis、调 HTTP 服务。
        // 这里用 sleep 是为了让实验稳定复现“阻塞等待”。
        int cost = ThreadLocalRandom.current().nextInt(40, 80);
        Thread.sleep(Duration.ofMillis(cost));
        return "ok:" + cost;
    }

    @GetMapping("/cpu")
    public long cpu() {
        // 模拟 CPU 密集型计算：虚拟线程对这类接口不会有明显收益。
        long result = 0;
        for (int i = 0; i < 20_000_000; i++) {
            result += i % 17;
        }
        return result;
    }
}
```

准备两个配置文件。

传统平台线程版本：

```yaml
# application-platform.yml
server:
  tomcat:
    threads:
      max: 200
spring:
  threads:
    virtual:
      enabled: false
```

虚拟线程版本：

```yaml
# application-virtual.yml
spring:
  threads:
    virtual:
      enabled: true
```

> 注：`spring.threads.virtual.enabled=true` 会让 Spring Boot 在支持的执行器上优先使用虚拟线程。它不是改写你的业务代码，而是改变请求处理等任务的线程承载方式。

<h1 id="压测方法：别只看-QPS，要看尾延迟"><a href="#压测方法：别只看-QPS，要看尾延迟" class="headerlink" title="压测方法：别只看 QPS，要看尾延迟"></a>压测方法：别只看 QPS，要看尾延迟</h1>

先打包：

```bash
./mvnw clean package -DskipTests
```

启动平台线程版本：

```bash
java -jar target/demo-0.0.1-SNAPSHOT.jar \
  --spring.profiles.active=platform
```

压测 I/O 接口：

```bash
wrk -t8 -c800 -d60s --latency http://127.0.0.1:8080/io
```

再启动虚拟线程版本：

```bash
java -jar target/demo-0.0.1-SNAPSHOT.jar \
  --spring.profiles.active=virtual
```

执行同样压测：

```bash
wrk -t8 -c800 -d60s --latency http://127.0.0.1:8080/io
```

下面是一组示例结果，机器、JDK 小版本、容器限制不同都会影响绝对值，重点看趋势：

| 模式 | 并发连接 | 吞吐量 req/s | 平均延迟 | P95 | P99 | 进程线程数观察 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 平台线程，Tomcat max=200 | 800 | 约 3,100 | 245ms | 420ms | 610ms | 约 230 |
| 虚拟线程 | 800 | 约 10,800 | 72ms | 116ms | 158ms | 平台线程约几十个，虚拟线程按请求快速创建/结束 |

为什么差距明显？因为 `/io` 大部分时间都在 `Thread.sleep` 模拟的阻塞等待里。平台线程版本最多只有 200 个请求能同时占住工作线程；虚拟线程版本里，请求阻塞时不会一直霸占昂贵的平台线程，所以能承载更多等待中的请求。

再压测 CPU 接口：

```bash
wrk -t8 -c200 -d60s --latency http://127.0.0.1:8080/cpu
```

典型现象会变成这样：

| 模式 | 接口类型 | 吞吐趋势 | 延迟趋势 | 解释 |
| --- | --- | --- | --- | --- |
| 平台线程 | CPU 密集 | 接近 CPU 上限 | 尾延迟随 CPU 饱和升高 | 线程模型不是主要瓶颈 |
| 虚拟线程 | CPU 密集 | 通常无明显提升 | 可能持平或略差 | CPU 核数才是硬上限 |

这一步很关键：**虚拟线程提高的是阻塞等待场景的承载能力，不是突破 CPU 物理上限。**

<h1 id="用-JFR-验证：到底是不是线程等待少拖了后腿"><a href="#用-JFR-验证：到底是不是线程等待少拖了后腿" class="headerlink" title="用 JFR 验证：到底是不是线程等待少拖了后腿"></a>用 JFR 验证：到底是不是线程等待少拖了后腿</h1>

只看压测结果还不够，最好用 JFR 做一次旁证。

启动时打开 JFR：

```bash
java \
  -XX:StartFlightRecording=filename=virtual-thread-demo.jfr,duration=90s,settings=profile \
  -jar target/demo-0.0.1-SNAPSHOT.jar \
  --spring.profiles.active=virtual
```

然后在 90 秒内执行压测：

```bash
wrk -t8 -c800 -d60s --latency http://127.0.0.1:8080/io
```

也可以对已运行进程临时开启：

```bash
jcmd <pid> JFR.start name=vt-demo settings=profile duration=90s filename=vt-demo.jfr
```

看 JFR 时重点关注这些事件：

| 观察项 | 看什么 | 期望现象 |
| --- | --- | --- |
| Java Thread Statistics | 平台线程数量是否暴涨 | 虚拟线程模式下平台线程不应随请求并发等比例暴涨 |
| VirtualThreadStart / VirtualThreadEnd | 虚拟线程创建和结束是否频繁 | I/O 接口下会看到大量短生命周期虚拟线程 |
| VirtualThreadPinned | 是否出现 pinned | 如果很多，说明虚拟线程被“钉住”，收益会下降 |
| Socket Read / Sleep / Park | 阻塞等待分布 | I/O 场景会有明显等待事件 |
| CPU Load | CPU 是否打满 | 如果 CPU 没打满但延迟高，多半是等待、锁或连接池问题 |

> 注：**Pinned（钉住）** 指虚拟线程因为某些原因无法从承载它的平台线程上卸载下来，常见原因是进入 `synchronized` 临界区后又发生阻塞。它会让虚拟线程退化得更像平台线程。

可以加一个参数让 pinned 现象更容易暴露：

```bash
-Djdk.tracePinnedThreads=full
```

如果日志里出现大量类似信息，就要回头查是否在 `synchronized`、本地方法、老驱动或阻塞调用之间形成了组合问题。

<h1 id="连接池才是真正的闸门"><a href="#连接池才是真正的闸门" class="headerlink" title="连接池才是真正的闸门"></a>连接池才是真正的闸门</h1>

虚拟线程容易让人产生一个误解：既然线程便宜了，那并发就可以无限放大。现实不是这样。

假设接口里查 MySQL，HikariCP 最大连接数是 50。即使来了 2,000 个虚拟线程，也最多只有 50 个请求能同时拿到数据库连接，剩下的会排队等连接。这个时候尾延迟照样会飙升。

可以用下面方式观察连接池等待：

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus
```

重点看这些指标：

```bash
curl 'http://127.0.0.1:8080/actuator/metrics/hikaricp.connections.active'
curl 'http://127.0.0.1:8080/actuator/metrics/hikaricp.connections.pending'
curl 'http://127.0.0.1:8080/actuator/metrics/http.server.requests'
```

如果 `hikaricp.connections.pending` 长时间大于 0，说明请求已经堵在连接池门口了。这时候继续增加虚拟线程没有意义，更应该检查 SQL、索引、连接池大小、数据库负载和限流策略。

一个更贴近生产的权衡表如下：

| 调整项 | 可能收益 | 代价 / 风险 | 适合什么时候做 |
| --- | --- | --- | --- |
| 开启虚拟线程 | 降低阻塞等待下的平台线程压力 | 暴露下游瓶颈；pinned 代码收益变低 | I/O 密集接口多，线程池排队明显 |
| 增大数据库连接池 | 降低连接等待 | 数据库压力上升，可能放大慢 SQL | DB 仍有余量，等待主要在连接池 |
| 加缓存 | 降低下游调用次数 | 一致性、过期、击穿问题 | 读多写少、热点明显 |
| 限流/舱壁 | 保护下游 | 拒绝部分请求 | 下游容量有限且不可无限扩容 |

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="误区一：虚拟线程越多越好"><a href="#误区一：虚拟线程越多越好" class="headerlink" title="误区一：虚拟线程越多越好"></a>误区一：虚拟线程越多越好</h2>

虚拟线程便宜，但请求对象、栈帧、上下文、日志 MDC、业务中间对象都要占内存。流量入口仍然要配合限流、超时和熔断。否则它只是让更多请求一起冲到数据库或下游服务。

<h2 id="误区二：所有线程池都可以删掉"><a href="#误区二：所有线程池都可以删掉" class="headerlink" title="误区二：所有线程池都可以删掉"></a>误区二：所有线程池都可以删掉</h2>

CPU 密集任务仍然应该被限制并发。比如报表计算、图片处理、批量加解密，最好使用固定大小线程池或任务队列，避免把 CPU 打满后拖垮普通请求。

<h2 id="误区三：只看平均延迟"><a href="#误区三：只看平均延迟" class="headerlink" title="误区三：只看平均延迟"></a>误区三：只看平均延迟</h2>

平均延迟很容易骗人。线上用户更容易感受到 P95/P99。虚拟线程改造前后，至少要同时看：吞吐、平均延迟、P95、P99、错误率、CPU、内存、GC、下游连接池等待。

<h2 id="误区四：忽略超时"><a href="#误区四：忽略超时" class="headerlink" title="误区四：忽略超时"></a>误区四：忽略超时</h2>

虚拟线程让阻塞等待更便宜，但不代表可以无限等。HTTP Client、JDBC、Redis Client 都应该设置明确超时。否则下游慢的时候，系统会积累大量等待中的请求，最后一起超时或耗尽内存。

<h1 id="落地建议：先挑一条低风险链路试"><a href="#落地建议：先挑一条低风险链路试" class="headerlink" title="落地建议：先挑一条低风险链路试"></a>落地建议：先挑一条低风险链路试</h1>

如果要在已有 Spring Boot 项目里引入虚拟线程，可以按这个顺序：

1. 升级到 JDK 21 和 Spring Boot 3.2+；
2. 选择 I/O 密集、状态较少、下游容量清晰的接口；
3. 开启 `spring.threads.virtual.enabled=true` 做灰度；
4. 压测时记录吞吐、P95/P99、错误率、CPU、内存、GC、连接池 pending；
5. 用 JFR 检查 pinned、线程、锁和阻塞事件；
6. 保留回滚开关，不要一次性覆盖所有服务。

对于大多数后端系统，我更推荐把虚拟线程当作“同步阻塞架构的并发能力增强器”，而不是一次架构革命。它能让代码保持可读，也能改善 I/O 密集接口的资源利用率，但容量治理、超时、连接池、限流这些老问题一个都不会消失。

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

- 虚拟线程适合 I/O 密集接口，尤其是大量请求在等数据库、HTTP、Redis 等下游时；
- 它不能让 CPU 密集代码变快，也不能突破数据库连接池和下游容量；
- 压测时不要只看 QPS，要同时看 P95/P99、错误率、CPU、内存、GC 和连接池等待；
- JFR 是验证虚拟线程收益的重要工具，重点关注虚拟线程生命周期、pinned、锁和阻塞事件；
- 生产落地建议灰度推进，并配套超时、限流、监控和回滚开关。

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

1. OpenJDK：JEP 444: Virtual Threads，https://openjdk.org/jeps/444
2. Spring Boot Reference Documentation：Virtual Threads，https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.spring-application.virtual-threads
3. Oracle Java Documentation：Java Flight Recorder Runtime Guide，https://docs.oracle.com/javacomponents/jmc-5-4/jfr-runtime-guide/
4. JDK Mission Control Documentation，https://docs.oracle.com/en/java/java-components/jdk-mission-control/
5. HikariCP GitHub：Configuration，https://github.com/brettwooldridge/HikariCP#configuration-knobs-baby
6. wrk GitHub：HTTP benchmarking tool，https://github.com/wg/wrk
