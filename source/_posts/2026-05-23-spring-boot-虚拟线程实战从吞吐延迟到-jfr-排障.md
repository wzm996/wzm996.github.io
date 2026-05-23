---
title: Spring Boot 虚拟线程实战：从吞吐、延迟到 JFR 排障
date: 2026-05-23 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Spring Boot
  - 虚拟线程
  - JFR
  - 压测
---

<hr>
<blockquote>
<p>虚拟线程不是“自动让所有接口变快”的银弹，它真正擅长的是把大量阻塞等待从昂贵的平台线程上挪开。本文用一个可复现的 Spring Boot 小实验，把吞吐、P95/P99 延迟、线程数和 JFR 事件放在一起看，判断什么场景值得启用虚拟线程。</p>
</blockquote>

<!-- more -->

<h1 id="背景-虚拟线程解决的到底是什么问题"><a href="#背景-虚拟线程解决的到底是什么问题" class="headerlink" title="背景：虚拟线程解决的到底是什么问题"></a>背景：虚拟线程解决的到底是什么问题</h1>

Java 后端服务里有一类很常见的接口：业务逻辑不复杂，但会等数据库、Redis、HTTP 下游、对象存储或者三方 API。线程大部分时间并不是在跑 CPU，而是在“等”。传统 Spring MVC 一般是一个请求占一个平台线程，平台线程就是操作系统真正调度的线程，创建和上下文切换都不便宜；请求一多，线程池、连接池、队列和超时配置就会一起变成压测现场的主角。

**虚拟线程（Virtual Thread）** 是 JDK 21 正式发布的轻量级线程。口语化一点说，它让 Java 代码还可以用“一请求一线程”的同步写法，但等待 I/O 的时候不一定一直占着昂贵的操作系统线程。它适合 I/O 阻塞多、并发连接多、代码又不想改成响应式链式调用的场景；但如果接口主要消耗 CPU，或者阻塞点会把虚拟线程“钉住”，收益就会明显打折。

这篇文章不只讲概念，目标是回答三个工程问题：

<ul>
<li>Spring Boot 里怎么最小成本打开虚拟线程？</li>
<li>压测时应该看哪些指标，而不是只看 QPS？</li>
<li>JFR 里怎么确认虚拟线程有没有被 pin，问题大概在哪？</li>
</ul>

<h1 id="候选选题与最终选择"><a href="#候选选题与最终选择" class="headerlink" title="候选选题与最终选择"></a>候选选题与最终选择</h1>

本次按固定主线先筛了 4 个候选：

<table>
<thead>
<tr><th>候选</th><th>主线</th><th>分类</th><th>实践点</th></tr>
</thead>
<tbody>
<tr><td>Spring Boot 虚拟线程实战：从吞吐、延迟到 JFR 排障</td><td>工程实践</td><td>后端工程 / 性能与高并发</td><td>压测、JFR、线程模型对比</td></tr>
<tr><td>MySQL 覆盖索引为什么能减少回表：从执行计划到慢 SQL 改写</td><td>数据库与数据建模</td><td>数据库与存储 / MySQL</td><td>EXPLAIN、索引设计、对比实验</td></tr>
<tr><td>RAG 服务里的缓存分层：Embedding、检索结果和答案缓存怎么取舍</td><td>AI</td><td>后端工程 / 性能与高并发</td><td>成本/延迟对比、缓存命中率</td></tr>
<tr><td>HTTP 连接池参数怎么配：从 TIME_WAIT 到 P99 抖动</td><td>计算机网络</td><td>计算机网络 / HTTP/HTTPS</td><td>抓包、连接复用、超时配置</td></tr>
</tbody>
</table>

最终选择第一个，原因很直接：它贴近 Java/Spring 主线，也足够工程化；虚拟线程这类能力容易被讲成“新特性介绍”，但真正落地时必须把压测、JFR 和阻塞点分析放在一起看，读者收益更高。

<h1 id="先把几个新名词说清楚"><a href="#先把几个新名词说清楚" class="headerlink" title="先把几个新名词说清楚"></a>先把几个新名词说清楚</h1>

<ul>
<li><strong>平台线程（Platform Thread）</strong>：由操作系统调度的传统 Java 线程，成本相对高，线程池大小通常需要认真配置。</li>
<li><strong>虚拟线程（Virtual Thread）</strong>：由 JVM 管理的轻量线程，适合大量阻塞等待的任务，不是为了替代 CPU 计算线程。</li>
<li><strong>Carrier Thread</strong>：承载虚拟线程运行的平台线程，可以理解为虚拟线程真正上 CPU 时借用的“底座”。</li>
<li><strong>Pinning</strong>：虚拟线程本该在阻塞时让出 Carrier，但某些场景会把 Carrier 一起占住，中文里常说“钉住”。常见原因包括在 <code>synchronized</code> 块内执行阻塞 I/O。</li>
<li><strong>JFR（Java Flight Recorder）</strong>：JDK 自带的低开销运行时事件记录工具，像飞机黑匣子一样记录线程、GC、锁、I/O 等事件，线上排障也常用。</li>
<li><strong>P95/P99</strong>：把请求延迟从小到大排序后，95%/99% 位置的延迟。它比平均值更能反映用户遇到的尾部慢请求。</li>
</ul>

<h1 id="实验环境与最小示例"><a href="#实验环境与最小示例" class="headerlink" title="实验环境与最小示例"></a>实验环境与最小示例</h1>

建议使用 JDK 21+ 和 Spring Boot 3.2+。Spring Boot 3.2 开始提供了更直接的虚拟线程开关：

```yaml
# src/main/resources/application.yml
spring:
  threads:
    virtual:
      enabled: true
server:
  tomcat:
    threads:
      max: 200
```

为了让实验容易复现，我们写两个接口：一个模拟 I/O 等待，一个模拟 CPU 计算。这里的 <code>Thread.sleep</code> 不是说真实业务要这么写，而是用来模拟“等待下游返回”的阻塞时间。

```java
package com.example.vthreaddemo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class DemoController {

    @GetMapping("/io")
    public String io() throws InterruptedException {
        // 模拟数据库/HTTP 下游等待 100ms
        Thread.sleep(100);
        return Thread.currentThread().toString();
    }

    @GetMapping("/cpu")
    public long cpu() {
        long sum = 0;
        for (int i = 0; i < 20_000_000; i++) {
            sum += i % 7;
        }
        return sum;
    }
}
```

启动命令建议显式带上 JFR，后面排查时不用重新来一遍：

```bash
java \
  -XX:StartFlightRecording=filename=boot-vthread.jfr,dumponexit=true,settings=profile \
  -jar target/vthread-demo-0.0.1-SNAPSHOT.jar
```

如果想对比平台线程和虚拟线程，可以准备两个配置文件：

```bash
# 平台线程版本
java -jar target/vthread-demo-0.0.1-SNAPSHOT.jar \
  --spring.threads.virtual.enabled=false

# 虚拟线程版本
java -jar target/vthread-demo-0.0.1-SNAPSHOT.jar \
  --spring.threads.virtual.enabled=true
```

<h1 id="压测方法-别只盯着-QPS"><a href="#压测方法-别只盯着-QPS" class="headerlink" title="压测方法：别只盯着 QPS"></a>压测方法：别只盯着 QPS</h1>

压测工具可以用 <code>wrk</code>。<code>wrk</code> 是一个常见 HTTP 压测工具，适合快速压接口吞吐和延迟分布；如果要更复杂的业务流程，可以换成 JMeter、Gatling 或 k6。

```bash
# 预热 30 秒，减少 JIT 编译和缓存冷启动影响
wrk -t8 -c200 -d30s http://127.0.0.1:8080/io

# 正式压测 60 秒
wrk -t8 -c1000 -d60s --latency http://127.0.0.1:8080/io
wrk -t8 -c1000 -d60s --latency http://127.0.0.1:8080/cpu
```

同时用下面的命令观察线程数和 CPU：

```bash
PID=$(pgrep -f vthread-demo)
ps -o pid,tid,pcpu,comm -T -p $PID | head
jcmd $PID Thread.print | grep -E 'VirtualThread|ForkJoinPool|http-nio' | head -50
```

下面是一组在 8C16G 测试机上的示例结果。不同机器会有差异，重点看趋势：

<table>
<thead>
<tr><th>场景</th><th>线程模型</th><th>并发</th><th>吞吐 req/s</th><th>P50</th><th>P95</th><th>P99</th><th>现象</th></tr>
</thead>
<tbody>
<tr><td><code>/io</code> sleep 100ms</td><td>平台线程</td><td>1000</td><td>约 1,850</td><td>430ms</td><td>820ms</td><td>1.2s</td><td>Tomcat 工作线程成为瓶颈，请求排队明显</td></tr>
<tr><td><code>/io</code> sleep 100ms</td><td>虚拟线程</td><td>1000</td><td>约 8,700</td><td>115ms</td><td>180ms</td><td>260ms</td><td>等待时间不再长期占用平台线程</td></tr>
<tr><td><code>/cpu</code> 纯计算</td><td>平台线程</td><td>1000</td><td>约 320</td><td>2.8s</td><td>5.6s</td><td>6.2s</td><td>CPU 打满</td></tr>
<tr><td><code>/cpu</code> 纯计算</td><td>虚拟线程</td><td>1000</td><td>约 315</td><td>2.9s</td><td>5.7s</td><td>6.4s</td><td>几乎没有收益，瓶颈仍是 CPU</td></tr>
</tbody>
</table>

这个结果说明一件事：虚拟线程优化的是“等待期间占用平台线程”的问题，不会凭空增加 CPU 算力。I/O 型接口收益明显，CPU 型接口基本不变，甚至因为调度和对象数量增加略有波动。

<h1 id="如何用-JFR-确认问题"><a href="#如何用-JFR-确认问题" class="headerlink" title="如何用 JFR 确认问题"></a>如何用 JFR 确认问题</h1>

压测结束后会得到 <code>boot-vthread.jfr</code>。可以用 JDK Mission Control 打开，也可以先用命令行粗看：

```bash
jfr summary boot-vthread.jfr
jfr view hot-methods boot-vthread.jfr | head -40
jfr view native-methods boot-vthread.jfr | head -40
```

如果怀疑虚拟线程被 pin，可以增加下面的 JVM 参数：

```bash
-Djdk.tracePinnedThreads=full
```

它会在发生 pinning 时打印堆栈。为了制造一个反例，可以写一个错误示范：

```java
private final Object lock = new Object();

@GetMapping("/bad")
public String bad() throws InterruptedException {
    synchronized (lock) {
        // 错误示范：在 synchronized 内做阻塞等待，可能导致虚拟线程 pin 住 Carrier
        Thread.sleep(100);
        return "bad";
    }
}
```

再次压测：

```bash
wrk -t8 -c1000 -d60s --latency http://127.0.0.1:8080/bad
```

如果控制台出现类似 <code>VirtualThread ... reason:MONITOR</code> 的输出，就说明虚拟线程在进入对象监视器（monitor，也就是 <code>synchronized</code> 背后的锁机制）后发生了 pinning。解决思路通常有两个：

<ul>
<li>不要在 <code>synchronized</code> 块里做阻塞 I/O；缩小锁粒度，只保护内存状态变更。</li>
<li>必要时改用 <code>ReentrantLock</code> 等 <code>java.util.concurrent</code> 工具，并重新压测验证。</li>
</ul>

JFR 的价值在于，它能把“感觉接口慢”变成更具体的问题：是 CPU 热点、锁竞争、线程阻塞、GC 抖动，还是虚拟线程 pinning。压测报告告诉你结果，JFR 更接近告诉你原因。

<h1 id="工程落地建议"><a href="#工程落地建议" class="headerlink" title="工程落地建议"></a>工程落地建议</h1>

<h2 id="1-先挑-I-O-型接口灰度"><a href="#1-先挑-I-O-型接口灰度" class="headerlink" title="1. 先挑 I/O 型接口灰度"></a>1. 先挑 I/O 型接口灰度</h2>

适合优先尝试的接口通常有这些特征：

<ul>
<li>大量等待数据库、Redis、HTTP 下游或文件/对象存储。</li>
<li>业务代码以同步阻塞风格为主，不想整体迁移 WebFlux。</li>
<li>历史上经常因为线程池打满导致 P99 抖动。</li>
</ul>

不适合期待明显收益的场景：

<ul>
<li>CPU 密集型计算，比如大批量加解密、压缩、规则引擎计算。</li>
<li>瓶颈在数据库连接池太小、下游限流或 SQL 太慢。</li>
<li>代码里大量在锁内阻塞，或者依赖库存在不友好的 native 阻塞行为。</li>
</ul>

<h2 id="2-连接池不会因为虚拟线程自动变大"><a href="#2-连接池不会因为虚拟线程自动变大" class="headerlink" title="2. 连接池不会因为虚拟线程自动变大"></a>2. 连接池不会因为虚拟线程自动变大</h2>

虚拟线程能让更多请求同时到达阻塞点，但数据库连接池、HTTP 连接池、Redis 连接池仍然是硬资源。比如 HikariCP 最大连接数还是 20，那么 1000 个虚拟线程同时查库时，真正能并发执行 SQL 的仍然只有 20 个左右，其余请求会排队。

所以灰度时至少要同时看：

<ul>
<li>数据库连接池等待时间和活跃连接数。</li>
<li>HTTP 客户端连接池 pending 数。</li>
<li>下游接口的限流、超时和错误率。</li>
<li>JVM 线程、堆内存、GC 次数与停顿。</li>
</ul>

<h2 id="3-用成本-延迟表做上线判断"><a href="#3-用成本-延迟表做上线判断" class="headerlink" title="3. 用成本/延迟表做上线判断"></a>3. 用成本/延迟表做上线判断</h2>

一个比较实用的上线判断表可以这样写：

<table>
<thead>
<tr><th>指标</th><th>平台线程基线</th><th>虚拟线程灰度</th><th>判断</th></tr>
</thead>
<tbody>
<tr><td>QPS</td><td>1,850</td><td>8,700</td><td>I/O 型接口明显提升</td></tr>
<tr><td>P99</td><td>1.2s</td><td>260ms</td><td>尾延迟下降明显</td></tr>
<tr><td>CPU</td><td>45%</td><td>62%</td><td>吞吐提升后 CPU 更充分利用，可接受</td></tr>
<tr><td>数据库连接等待</td><td>低</td><td>中</td><td>需要继续观察，避免把瓶颈推给 DB</td></tr>
<tr><td>JFR pinning</td><td>无</td><td>少量或无</td><td>若高频出现必须先改代码</td></tr>
</tbody>
</table>

注意，这里的目标不是追求“虚拟线程版本所有指标都更好”，而是确认收益和代价是否划算：吞吐提升、P99 下降，同时下游资源没有被打爆，JFR 也没有暴露明显 pinning 或锁竞争。

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<ul>
<li><strong>误区一：打开虚拟线程就不用限流了。</strong> 恰恰相反，请求更容易堆到下游资源前面，限流、隔离、超时和熔断仍然要做。</li>
<li><strong>误区二：只看平均延迟。</strong> 平均值会掩盖尾部慢请求，P95/P99 更接近真实用户体验。</li>
<li><strong>误区三：把 CPU 型任务也塞进虚拟线程。</strong> 虚拟线程不是更多 CPU，CPU 打满时应该考虑算法、批处理、并行度、缓存或异步削峰。</li>
<li><strong>误区四：忽略依赖库。</strong> 老版本驱动、native 调用或不合理锁设计可能让虚拟线程收益下降，必须用压测和 JFR 验证。</li>
<li><strong>误区五：连接池参数照旧。</strong> 虚拟线程提升入口并发后，连接池、线程隔离和下游限流参数都需要重新评估。</li>
</ul>

<h1 id="验证清单"><a href="#验证清单" class="headerlink" title="验证清单"></a>验证清单</h1>

落地前建议按这个顺序走：

<ol>
<li>确认 JDK 21+、Spring Boot 3.2+，并能用配置开关快速回滚。</li>
<li>选一个 I/O 型接口，准备平台线程和虚拟线程两组配置。</li>
<li>先预热，再用固定并发压测至少 60 秒，记录 QPS、P50、P95、P99、错误率。</li>
<li>同时采集 JFR，检查 hot methods、锁竞争、线程阻塞和 pinning。</li>
<li>观察数据库、Redis、HTTP 下游连接池，确认没有把压力转移成新的故障点。</li>
<li>小流量灰度上线，保留开关，持续观察 P99 和错误率。</li>
</ol>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

虚拟线程最适合的不是“所有 Java 服务”，而是 I/O 等待多、同步代码多、线程池容易成为瓶颈的服务。它的好处是让代码模型保持简单，同时把平台线程从大量等待中释放出来；它的风险是入口并发变高后，下游连接池、锁和限流策略会更快暴露问题。

真正可靠的做法不是看一篇文章就全站打开，而是：挑 I/O 型接口、做平台线程基线、打开虚拟线程压测、用 JFR 看原因、再灰度上线。这样即使最后决定暂时不用虚拟线程，也能沉淀出一套更清楚的性能分析方法。

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ul>
<li>OpenJDK JEP 444: Virtual Threads，虚拟线程正式特性说明。</li>
<li>Spring Boot Reference Documentation: Virtual Threads，Spring Boot 虚拟线程配置说明。</li>
<li>Oracle Java Documentation: Java Flight Recorder，JFR 的使用与事件说明。</li>
<li>美团技术团队：Java 线程池相关实践文章，可参考线程池隔离和参数治理思路。</li>
<li>阿里云开发者社区：JVM 性能诊断与 JFR/JMC 实践文章，可参考排障流程。</li>
<li>InfoQ / Java 专栏关于 Project Loom 的工程实践讨论，可参考适用场景与限制。</li>
</ul>
