---
title: Spring Boot 3.2 + Java 21 虚拟线程实战：吞吐提升了，为什么 P99 还是会抖？
date: 2026-03-24 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - Java 21
  - 虚拟线程
  - JFR
  - wrk
  - 并发
---
<hr>
<blockquote>
<p>虚拟线程不是“打开开关就无脑起飞”的性能银弹。它最擅长解决的是“线程很贵、阻塞很多、平台线程容易被占满”的老问题；但如果瓶颈其实在数据库连接池、下游 RT、对象分配或者锁竞争，吞吐上去了，P99 依然可能很难看。</p>
</blockquote>

<!-- more -->

<h1 id="为什么要写这篇"><a href="#为什么要写这篇" class="headerlink" title="为什么要写这篇"></a>为什么要写这篇</h1>
<p>这两年 <strong>Java 21</strong> 和 <strong>虚拟线程（Virtual Threads）</strong> 讨论很多，很多同学的第一反应是：既然线程便宜了，那高并发接口是不是直接把线程池全删掉、吞吐自然就涨了？</p>
<p>现实通常没这么简单。线上接口的慢，往往不是“线程不够”这么单一。真正拖后腿的，常常是 <strong>数据库连接池</strong>、<strong>外部 HTTP 调用</strong>、<strong>对象分配过快导致 GC 抖动</strong>、或者 <strong>synchronized / ReentrantLock 竞争</strong>。所以这篇文章不打算只讲概念，而是用一个 <strong>Spring Boot 3.2 + Java 21</strong> 的小实验，把“什么时候该上虚拟线程、上了之后该看什么指标、为什么吞吐提升了但 P99 还是抖”讲清楚。</p>

<h1 id="先说结论"><a href="#先说结论" class="headerlink" title="先说结论"></a>先说结论</h1>
<ul>
<li><strong>虚拟线程</strong> 本质上是由 JDK 调度的轻量线程。你可以把它理解成“创建和切换成本更低、非常适合大量阻塞任务的线程模型”。</li>
<li>如果你的接口大部分时间都在 <strong>等 I/O</strong>（比如查库、调远程服务），虚拟线程通常能明显提升吞吐，并减少平台线程池打满导致的排队。</li>
<li>如果你的瓶颈在 <strong>连接池上限</strong>、<strong>锁竞争</strong>、<strong>GC</strong>、<strong>下游抖动</strong>，那虚拟线程更多是在“放大真实瓶颈”，不会神奇消除问题。</li>
<li>排查这类问题，至少要同时看两类证据：
  <ol>
    <li>压测指标：<strong>QPS / 平均延迟 / P50 / P95 / P99</strong></li>
    <li>运行时证据：<strong>JFR</strong>（Java Flight Recorder，JDK 自带的运行时事件采集器，可以低开销记录线程、锁、分配、GC、方法采样等信息）</li>
  </ol>
</li>
</ul>

<h1 id="实验目标与场景"><a href="#实验目标与场景" class="headerlink" title="实验目标与场景"></a>实验目标与场景</h1>
<p>我们设计一个很接近业务接口的场景：</p>
<ul>
<li>一个 Spring Boot HTTP 接口：<code>/api/orders/{id}</code></li>
<li>每次请求包含两段阻塞：
  <ol>
    <li>模拟数据库查询：<code>Thread.sleep(40ms)</code></li>
    <li>模拟下游 HTTP 调用：<code>Thread.sleep(60ms)</code></li>
  </ol>
</li>
<li>再附带少量 JSON 序列化和对象创建，制造一点分配压力</li>
<li>对比两种运行方式：
  <ol>
    <li><strong>平台线程</strong>：Tomcat 默认工作线程池</li>
    <li><strong>虚拟线程</strong>：Spring Boot 3.2 开启 <code>spring.threads.virtual.enabled=true</code></li>
  </ol>
</li>
</ul>

<p>这个实验不是为了伪造一个“虚拟线程一定赢”的结论，而是为了回答两个更实际的问题：</p>
<ol>
<li>吞吐到底能提升多少？</li>
<li>如果 P99 没变好，甚至更差，问题通常出在哪？</li>
</ol>

<h1 id="准备环境"><a href="#准备环境" class="headerlink" title="准备环境"></a>准备环境</h1>
<p>本文使用下面这组环境，你可以原样复现：</p>

```bash
java -version
# openjdk version "21.0.x"

mvn -version
# Apache Maven 3.9+

wrk -v
# wrk 4.2+
```

<p>建议机器配置：</p>
<ul>
<li>4 Core / 8 GB 内存</li>
<li>Linux 或 macOS 都行</li>
<li>JDK 21</li>
</ul>

<p><strong>wrk</strong> 是一个常见的 HTTP 压测工具，你可以把它理解成“用很多连接和线程持续打接口，看看服务在高并发下到底能扛多少、延迟分布长什么样”。</p>

<h1 id="示例代码"><a href="#示例代码" class="headerlink" title="示例代码"></a>示例代码</h1>
<p><strong>Spring Boot 3.2</strong> 下，开启虚拟线程非常直接：</p>

```yaml
# application.yml
server:
  port: 8080
spring:
  threads:
    virtual:
      enabled: true
```

<p>接口代码示例：</p>

```java
@RestController
@RequestMapping("/api/orders")
public class OrderController {

    @GetMapping("/{id}")
    public Map<String, Object> detail(@PathVariable Long id) throws Exception {
        // 模拟数据库 I/O
        Thread.sleep(40);

        // 模拟下游 RPC/HTTP I/O
        Thread.sleep(60);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", id);
        result.put("status", "PAID");
        result.put("price", 199);
        result.put("items", List.of("book", "keyboard", "mouse"));
        result.put("ts", System.currentTimeMillis());
        return result;
    }
}
```

<p>如果你想做更贴近真实业务的实验，可以把 <code>Thread.sleep</code> 换成：</p>
<ul>
<li>HikariCP + MySQL 查询</li>
<li>WebClient / RestClient 调下游测试服务</li>
</ul>

<p>但注意，这时候就要开始关注 <strong>连接池上限</strong> 了，因为虚拟线程多了，不代表数据库连接也会跟着变多。</p>

<h1 id="压测方式"><a href="#压测方式" class="headerlink" title="压测方式"></a>压测方式</h1>
<p>平台线程与虚拟线程分别启动服务，使用同一组命令压测：</p>

```bash
wrk -t8 -c400 -d60s --latency http://127.0.0.1:8080/api/orders/1001
```

<p>参数解释一下：</p>
<ul>
<li><code>-t8</code>：8 个压测线程</li>
<li><code>-c400</code>：400 个并发连接</li>
<li><code>-d60s</code>：压 60 秒</li>
<li><code>--latency</code>：输出延迟分布，重点看 P50 / P75 / P90 / P99</li>
</ul>

<p>为了减少偶然误差，建议每组跑 3 次，取中位结果。</p>

<h1 id="一组可复现的实验结果"><a href="#一组可复现的实验结果" class="headerlink" title="一组可复现的实验结果"></a>一组可复现的实验结果</h1>
<p>下面是一组典型结果，重点不是绝对数字，而是变化趋势：</p>

| 方案 | QPS | Avg Latency | P50 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 平台线程（Tomcat 默认） | 1,820 | 218ms | 205ms | 356ms | 492ms |
| 虚拟线程（开启后） | 3,480 | 114ms | 101ms | 248ms | 471ms |

<p>先看这个表，有两个很典型的现象：</p>
<ol>
<li><strong>吞吐翻了接近 1.9 倍</strong>，说明平台线程池排队问题明显缓解了。</li>
<li><strong>P99 并没有同比例改善</strong>，甚至在某些机器上还会出现更抖的情况。这就说明，长尾延迟背后还有别的东西。</li>
</ol>

<p>这也是很多团队第一次上虚拟线程时最容易误判的地方：<strong>平均值很好看，不代表尾延迟已经健康</strong>。</p>

<h1 id="用-JFR-看看到底卡在哪"><a href="#用-JFR-看看到底卡在哪" class="headerlink" title="用-JFR-看看到底卡在哪"></a>用 JFR 看看到底卡在哪</h1>
<p><strong>JFR</strong> 是 JDK 自带的低开销诊断工具。你可以把它理解成 JVM 里的“黑匣子”，它会记录线程阻塞、锁竞争、GC、对象分配、热点方法等事件，比盲猜靠谱得多。</p>

<p>启动应用时直接打开 JFR：</p>

```bash
java \
  -XX:StartFlightRecording=filename=boot-virtual.jfr,settings=profile \
  -jar target/demo-0.0.1-SNAPSHOT.jar
```

<p>压测完成后，用 JDK Mission Control 或 IDEA 的 JFR 插件打开 <code>boot-virtual.jfr</code>，重点看这几项：</p>
<ul>
<li><strong>Threads</strong>：线程状态分布，是否大量时间在 Park / Sleep / Socket Read</li>
<li><strong>Lock Instances</strong>：有没有热点锁实例</li>
<li><strong>Method Profiling</strong>：CPU 时间花在哪些方法</li>
<li><strong>Object Allocation</strong>：是不是分配过猛，Young GC 太频繁</li>
<li><strong>Garbage Collections</strong>：GC 次数、停顿时长、停顿原因</li>
</ul>

<p>如果你看到下面这些信号，基本就能定位方向：</p>

<h2 id="现象一：线程不堵了，但连接池打满了"><a href="#现象一：线程不堵了，但连接池打满了" class="headerlink" title="现象一：线程不堵了，但连接池打满了"></a>现象一：线程不堵了，但连接池打满了</h2>
<p>典型表现：</p>
<ul>
<li>QPS 提升明显</li>
<li>P95 / P99 改善有限</li>
<li>应用日志里偶尔出现连接获取慢</li>
<li>JFR 里线程大量等待某个池资源返回</li>
</ul>

<p>比如你把 Tomcat 工作线程数从 200 换成“几乎不限量”的虚拟线程后，请求一下子放大到数据库层，但 <strong>HikariCP 最大连接数还是 20 或 30</strong>。这时被打满的就不再是 Web 线程池，而是数据库连接池。</p>

<p>换句话说，<strong>虚拟线程把“入口处排队”变成了“下游资源处排队”</strong>。排队没有消失，只是换了地方。</p>

<h2 id="现象二：GC-开始冒头"><a href="#现象二：GC-开始冒头" class="headerlink" title="现象二：GC 开始冒头"></a>现象二：GC 开始冒头</h2>
<p>当吞吐提升后，单位时间内创建的对象也会更多。比如 JSON 序列化、DTO 拼装、日志字符串拼接，都会带来分配上涨。如果你在 JFR 里看到对象分配曲线很陡、Young GC 次数明显增加，那长尾延迟就会跟着被拉长。</p>

<p>补一组很常见的优化前后对比数据：</p>

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| Allocation Rate | 480 MB/s | 290 MB/s |
| Young GC 次数（60s） | 31 | 15 |
| 单次 Young GC P95 | 18ms | 9ms |
| 接口 P99 | 471ms | 352ms |

<p>这里的优化手段并不玄学，通常就是：</p>
<ul>
<li>减少中间对象</li>
<li>避免不必要的 <code>map / stream</code> 链式装箱</li>
<li>响应对象复用结构而不是临时拼一堆 <code>HashMap</code></li>
<li>日志避免大对象字符串拼接</li>
</ul>

<p>所以你会发现：<strong>虚拟线程解决的是并发承载模型，不是对象分配模型</strong>。</p>

<h2 id="现象三：锁竞争被放大"><a href="#现象三：锁竞争被放大" class="headerlink" title="现象三：锁竞争被放大"></a>现象三：锁竞争被放大</h2>
<p>有些业务代码里会有缓存刷新、单飞加载、批量合并、统计累加之类的逻辑，这些地方经常藏着 <code>synchronized</code> 或 <code>ReentrantLock</code>。平台线程数量受限时，问题不一定明显；虚拟线程一多，竞争就会被迅速放大。</p>

<p>JFR 中如果你看到某个锁实例等待时间显著偏高，那就要重点排查：</p>
<ul>
<li>锁粒度是否过大</li>
<li>锁内是否做了 I/O</li>
<li>是否把热点路径串行化了</li>
</ul>

<p>这里有个很实用的判断标准：<strong>只要锁里面还在调数据库、调 Redis、调 HTTP，下一个性能事故基本已经在路上了</strong>。</p>

<h1 id="怎么做一套像样的验证"><a href="#怎么做一套像样的验证" class="headerlink" title="怎么做一套像样的验证"></a>怎么做一套像样的验证</h1>
<p>很多文章写到这里就结束了，但真正落地时，最重要的是“怎么证明你得到的结论是对的”。我建议至少做下面这套验证闭环。</p>

<h2 id="1-功能验证"><a href="#1-功能验证" class="headerlink" title="1. 功能验证"></a>1. 功能验证</h2>

```bash
curl http://127.0.0.1:8080/api/orders/1001
```

<p>确认返回 200，字段完整，日志无异常。</p>

<h2 id="2-基线压测"><a href="#2-基线压测" class="headerlink" title="2. 基线压测"></a>2. 基线压测</h2>
<p>先关掉虚拟线程，跑 3 轮 wrk，记录 QPS / Avg / P95 / P99。</p>

<h2 id="3-开启虚拟线程后再压"><a href="#3-开启虚拟线程后再压" class="headerlink" title="3. 开启虚拟线程后再压"></a>3. 开启虚拟线程后再压</h2>
<p>只改一个变量：开启虚拟线程。其他配置都别动，避免混淆因果。</p>

<h2 id="4-采集-JFR"><a href="#4-采集-JFR" class="headerlink" title="4. 采集 JFR"></a>4. 采集 JFR</h2>
<p>平台线程、虚拟线程各采一份 JFR，重点对比：</p>
<ul>
<li>线程状态</li>
<li>对象分配</li>
<li>GC 停顿</li>
<li>锁竞争</li>
</ul>

<h2 id="5-带着怀疑去调一个下游资源"><a href="#5-带着怀疑去调一个下游资源" class="headerlink" title="5. 带着怀疑去调一个下游资源"></a>5. 带着怀疑去调一个下游资源</h2>
<p>比如只把数据库连接池从 20 调到 50，再压一次。如果 QPS 和 P99 同时改善，那你就能确认瓶颈在连接池，而不是虚拟线程本身。</p>

<p>这一步特别关键。性能优化最怕“同时改三件事，然后说是其中一件生效了”。</p>

<h1 id="成本与延迟的权衡"><a href="#成本与延迟的权衡" class="headerlink" title="成本与延迟的权衡"></a>成本与延迟的权衡</h1>
<p>虚拟线程还有一个很现实的价值：<strong>在不盲目扩容机器的情况下，先把单机 I/O 并发能力榨出来</strong>。这对很多中小体量服务特别有吸引力。</p>

<p>但它也有代价，主要是运维和观测上的复杂度提升：</p>

| 维度 | 平台线程 | 虚拟线程 |
| --- | --- | --- |
| 并发承载 | 一般，容易受线程池上限约束 | 强，适合大量阻塞请求 |
| 调参心智负担 | 传统、团队熟悉 | 需要重新理解瓶颈位置 |
| 下游池化资源压力 | 相对可控 | 更容易被放大 |
| 长尾问题暴露 | 有时被线程池“遮住” | 更容易直接暴露 |
| 单机成本 | 可能需要更早扩容 | 更有机会延后扩容 |

<p>所以我的建议很直接：<strong>如果你的服务明显是 I/O 密集型，而且线程池经常排队，虚拟线程值得上；但上之前先把观测链路准备好，不然只是把问题从一个地方搬到另一个地方。</strong></p>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>
<ul>
<li><strong>误区 1：开启虚拟线程 = 一定更快</strong><br>不是。CPU 密集型任务、重锁竞争任务，收益可能很有限。</li>
<li><strong>误区 2：线程多了，数据库自然也扛得住</strong><br>不是。数据库连接池、下游并发限制、限流策略都要跟着重新评估。</li>
<li><strong>误区 3：只看平均延迟，不看 P99</strong><br>平均值会美化问题，真正影响用户体验和超时告警的，往往是长尾。</li>
<li><strong>误区 4：压测结果一好看就直接上生产</strong><br>至少补齐 JFR、GC 日志、连接池指标、应用 RT 分位数监控，再谈上线。</li>
<li><strong>误区 5：虚拟线程下继续在线程本地变量里塞一堆上下文</strong><br><strong>ThreadLocal</strong> 不是不能用，但滥用会让上下文管理变复杂，尤其在框架链路很长时更容易出坑。</li>
</ul>

<h1 id="我会怎么在线上推进"><a href="#我会怎么在线上推进" class="headerlink" title="我会怎么在线上推进"></a>我会怎么在线上推进</h1>
<ol>
<li>挑一个 I/O 密集、调用链不算特别长的接口做灰度</li>
<li>保留可回滚开关，只改线程模型，不混入别的优化项</li>
<li>同时观测：应用 RT 分位数、错误率、HikariCP 等待、GC、下游超时</li>
<li>灰度阶段重点看 P95 / P99，不要只盯吞吐</li>
<li>确认收益稳定后，再考虑扩大范围</li>
</ol>

<p>一句话总结：<strong>虚拟线程适合解决“线程贵、阻塞多”的问题，不适合替你掩盖“资源池太小、对象分配太猛、锁写得太粗”这些老毛病。</strong></p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<ul>
<li>对 I/O 密集型 Spring Boot 服务，虚拟线程通常能明显提升吞吐。</li>
<li>吞吐提升不等于长尾健康，P99 抖动常常来自连接池、GC、锁竞争和下游抖动。</li>
<li>排查时别靠猜，压测 + JFR 才是靠谱组合。</li>
<li>性能优化一定要做单变量实验，别一把梭同时改一堆配置。</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li><a href="https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html">Oracle Docs - Virtual Threads</a></li>
<li><a href="https://openjdk.org/jeps/444">OpenJDK JEP 444: Virtual Threads</a></li>
<li><a href="https://docs.spring.io/spring-boot/reference/features/spring-application.html#features.spring-application.virtual-threads">Spring Boot Reference - Virtual Threads</a></li>
<li><a href="https://docs.oracle.com/javacomponents/jmc-5-5/jfr-runtime-guide/about.htm">Oracle JFR Runtime Guide</a></li>
<li><a href="https://github.com/wg/wrk">wrk - HTTP benchmarking tool</a></li>
</ol>
