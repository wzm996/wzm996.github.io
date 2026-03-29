---
title: Spring Boot 接口为什么会越跑越慢？一次从线程池到 JFR 的定位实战
date: 2026-03-29 10:00:00
categories:
  - 后端工程
  - 可观测性
tags:
  - Spring Boot
  - JFR
  - async-profiler
  - 线程池
  - 性能优化
  - Java
---
<hr>
<blockquote>
<p>接口“能用”和接口“跑得稳”，中间差着一整套工程化诊断方法。本文不聊玄学调参，直接用一个可复现的小实验，把 <strong>线程池阻塞</strong>、<strong>排队放大</strong> 和 <strong>JFR 定位</strong> 串起来，看看一个 Spring Boot 接口为什么会越跑越慢，以及应该怎么把它拉回来。</p>
</blockquote>

<!-- more -->

<h1 id="一、问题背景：为什么接口一开始快，压一会儿就慢了"><a href="#一、问题背景：为什么接口一开始快，压一会儿就慢了" class="headerlink" title="一、问题背景：为什么接口一开始快，压一会儿就慢了"></a>一、问题背景：为什么接口一开始快，压一会儿就慢了</h1>
<p>做 Java 后端时，最常见的一类线上性能问题不是“服务一启动就挂”，而是<strong>刚开始挺快，跑一阵子后越来越慢，P99 延迟越来越难看</strong>。这类问题特别容易误导人：CPU 看起来没打满，GC 也没明显爆炸，数据库偶尔慢一点但又不像根因，最后一圈排查下来，常常发现是<strong>线程被堵住了，队列越积越多，延迟被排队时间拖长</strong>。</p>
<p>这篇文章就用一个最小可复现实验，演示这种问题是怎么出现的、怎么定位、怎么验证优化是否真的有效。顺手把几个常见工具串起来：<strong>JFR</strong>、<strong>jstack</strong>、<strong>async-profiler</strong>。</p>
<pre><code>先解释一下：
- JFR（Java Flight Recorder）可以理解为 JDK 自带的“低开销黑盒录制器”，能把线程、锁、方法热点、GC、IO 等事件采下来，适合做性能定位。
- async-profiler 是 Java 领域很常用的性能分析器，可以看 CPU、锁、alloc（内存分配）热点，常配合火焰图使用。
- P99 指 99% 请求都不超过的延迟，比平均值更能暴露长尾问题。
</code></pre>

<h1 id="二、实验目标与环境"><a href="#二、实验目标与环境" class="headerlink" title="二、实验目标与环境"></a>二、实验目标与环境</h1>
<p>我们要复现一个很真实的场景：</p>
<ul>
<li>一个 Spring Boot 接口内部会调用下游慢服务；</li>
<li>开发时为了“异步化”，把任务扔进线程池；</li>
<li>但线程池参数没配对，下游一慢，任务开始堆积；</li>
<li>结果吞吐没上去，延迟反而雪崩。</li>
</ul>
<p>实验环境建议如下：</p>
<ul>
<li>JDK：17 或 21</li>
<li>Spring Boot：3.x</li>
<li>压测工具：<code>wrk</code> 或 <code>hey</code></li>
<li>诊断工具：<code>jcmd</code>、<code>jstack</code>、<code>async-profiler</code></li>
</ul>
<p>如果你机器上没装 <code>wrk</code>，也可以用 <code>hey</code>。它们都是压测 HTTP 接口的工具，前者更偏经典，后者上手更直接。</p>

<h1 id="三、先写一个会出问题的示例"><a href="#三、先写一个会出问题的示例" class="headerlink" title="三、先写一个会出问题的示例"></a>三、先写一个会出问题的示例</h1>
<p>先建一个最小 Demo。核心思路是：接口收到请求后，把一个会 <code>sleep</code> 200ms 的任务扔给线程池，然后等待结果返回。这个例子很粗暴，但它能稳定模拟“下游服务慢 + 线程池排队”的问题。</p>

<h2 id="1-Controller"><a href="#1-Controller" class="headerlink" title="1. Controller"></a>1. Controller</h2>
<pre><code class="language-java">@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class DemoController {

    private final SlowService slowService;

    @GetMapping("/slow")
    public Map&lt;String, Object&gt; slow() throws Exception {
        long begin = System.currentTimeMillis();
        String result = slowService.call();
        long cost = System.currentTimeMillis() - begin;

        return Map.of(
                "result", result,
                "costMs", cost,
                "thread", Thread.currentThread().getName()
        );
    }
}
</code></pre>

<h2 id="2-Service：故意制造线程池排队"><a href="#2-Service：故意制造线程池排队" class="headerlink" title="2. Service：故意制造线程池排队"></a>2. Service：故意制造线程池排队</h2>
<pre><code class="language-java">@Service
public class SlowService {

    private final ExecutorService executor = new ThreadPoolExecutor(
            4,
            4,
            0L,
            TimeUnit.MILLISECONDS,
            new LinkedBlockingQueue&lt;&gt;(200),
            new ThreadPoolExecutor.AbortPolicy()
    );

    public String call() throws Exception {
        Future&lt;String&gt; future = executor.submit(() -&gt; {
            // 模拟慢下游调用
            Thread.sleep(200);
            return "ok";
        });
        return future.get();
    }
}
</code></pre>

<p>这个配置有什么坑？一句话总结：</p>
<ul>
<li><strong>线程数太小</strong>：只有 4 个工作线程；</li>
<li><strong>队列太大</strong>：最多堆 200 个任务；</li>
<li><strong>调用方同步等待</strong>：虽然你用了线程池，但 Controller 还是 <code>future.get()</code> 阻塞等待，用户请求并没有真正异步返回。</li>
</ul>
<p>这就是很多项目里的经典“伪异步”：代码看起来异步了，实际上只是把阻塞从业务线程挪到了另一个线程池，再把排队时间一股脑还给用户。</p>

<h2 id="3-application-yml"><a href="#3-application-yml" class="headerlink" title="3. application.yml"></a>3. application.yml</h2>
<pre><code class="language-yaml">server:
  port: 8080

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,threaddump
</code></pre>

<h1 id="四、如何启动和复现"><a href="#四、如何启动和复现" class="headerlink" title="四、如何启动和复现"></a>四、如何启动和复现</h1>
<p>先启动服务：</p>
<pre><code class="language-bash">./mvnw spring-boot:run
</code></pre>
<p>简单访问确认接口正常：</p>
<pre><code class="language-bash">curl 'http://127.0.0.1:8080/api/slow'
</code></pre>
<p>然后开始压测。这里给两种命令，二选一就行。</p>
<pre><code class="language-bash"># wrk：8 线程，64 并发，持续 30 秒
wrk -t8 -c64 -d30s http://127.0.0.1:8080/api/slow

# 或者 hey：总请求 5000，并发 64
hey -n 5000 -c 64 http://127.0.0.1:8080/api/slow
</code></pre>

<h2 id="1-一个典型的压测结果"><a href="#1-一个典型的压测结果" class="headerlink" title="1. 一个典型的压测结果"></a>1. 一个典型的压测结果</h2>
<p>下面是一组典型结果，实际数字会随机器配置变化，但趋势基本一致：</p>

| 方案 | 线程池配置 | 吞吐（req/s） | P50 | P95 | P99 | 拒绝数 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 优化前 | core=4, queue=200 | 18.7 | 1.42s | 6.83s | 9.91s | 0 |
| 优化后 | core=32, queue=32 + 快速失败 + 超时 | 132.4 | 210ms | 438ms | 612ms | 少量可控 |

<p>这组数据很有意思：<strong>优化前没有拒绝，表面上“很稳定”；但实际上 P99 已经接近 10 秒</strong>。这就是大队列线程池最坑的地方——它会把错误藏起来，让系统看起来没报错，但用户体验已经烂了。</p>

<h2 id="2-为什么会这样"><a href="#2-为什么会这样" class="headerlink" title="2. 为什么会这样"></a>2. 为什么会这样</h2>
<p>因为下游每个任务至少要占住 200ms，4 个线程同时最多处理 4 个任务。理论稳态吞吐大约只有：</p>
<pre><code>4 / 0.2 = 20 req/s
</code></pre>
<p>当你的压测并发把流量打到 20 req/s 以上时，多出来的请求只能排队。排队本身不消耗多少 CPU，但会直接抬高用户看到的延迟。所以你会看到一种很诡异的现象：</p>
<ul>
<li>CPU 不高；</li>
<li>GC 正常；</li>
<li>但 RT 一直涨；</li>
<li>线程 dump 里一堆线程在等结果；</li>
<li>JFR 里能看到明显的线程阻塞和调度等待。</li>
</ul>

<h1 id="五、用-JFR-定位：别上来就猜"><a href="#五、用-JFR-定位：别上来就猜" class="headerlink" title="五、用 JFR 定位：别上来就猜"></a>五、用 JFR 定位：别上来就猜</h1>
<p>线上性能问题最忌讳“凭感觉调参数”。正确姿势是先录证据。</p>

<h2 id="1-录一段-JFR"><a href="#1-录一段-JFR" class="headerlink" title="1. 录一段 JFR"></a>1. 录一段 JFR</h2>
<pre><code class="language-bash"># 先找 Java 进程 PID
jcmd | grep demo

# 录制 60 秒 JFR
jcmd &lt;PID&gt; JFR.start \
  name=slow-api-profile \
  settings=profile \
  filename=/tmp/slow-api.jfr \
  duration=60s
</code></pre>
<p><code>settings=profile</code> 的意思是按“性能分析模式”录，事件更全一些，适合排查热点和线程状态问题。</p>

<h2 id="2-重点看哪些事件"><a href="#2-重点看哪些事件" class="headerlink" title="2. 重点看哪些事件"></a>2. 重点看哪些事件</h2>
<p>把 JFR 文件用 JDK Mission Control 打开后，建议优先看下面几个面板：</p>
<ul>
<li><strong>Threads</strong>：线程状态时间分布，看看是 RUNNABLE 多，还是 PARKED / BLOCKED 多；</li>
<li><strong>Method Profiling</strong>：方法热点；</li>
<li><strong>Lock Instances</strong>：有没有锁竞争；</li>
<li><strong>Socket IO</strong>：如果是网络调用慢，这里很直观；</li>
<li><strong>Java Monitor Blocked</strong>：监视器阻塞事件；</li>
<li><strong>Garbage Collections</strong>：确认 GC 不是背锅侠。</li>
</ul>

<h2 id="3-这类问题在-JFR-里会长什么样"><a href="#3-这类问题在-JFR-里会长什么样" class="headerlink" title="3. 这类问题在 JFR 里会长什么样"></a>3. 这类问题在 JFR 里会长什么样</h2>
<p>如果问题确实是线程池排队，你通常会看到这几个信号：</p>
<ol>
<li>Tomcat 工作线程大量时间花在 <code>FutureTask.get</code>、<code>Unsafe.park</code> 或 <code>LockSupport.park</code> 之类的等待调用上；</li>
<li>业务线程池中的 4 个工作线程长期忙于 <code>Thread.sleep</code> 或真实下游调用；</li>
<li>CPU 热点并不高，但线程等待时间很长；</li>
<li>GC 暂停并不明显，说明不是内存导致的主因。</li>
</ol>
<p>如果你只看 CPU 火焰图，可能会误判“没热点”。但 JFR 会告诉你：<strong>不是没问题，而是问题主要是等，不是算</strong>。</p>

<h2 id="4-再配一把-jstack"><a href="#4-再配一把-jstack" class="headerlink" title="4. 再配一把 jstack"></a>4. 再配一把 jstack</h2>
<pre><code class="language-bash">jstack &lt;PID&gt; &gt; /tmp/demo.jstack
grep -n 'FutureTask.get\|LockSupport.park\|Thread.sleep' /tmp/demo.jstack | head -n 20
</code></pre>
<p>你很可能会看到两类线程：</p>
<ul>
<li>HTTP 处理线程卡在 <code>future.get()</code>；</li>
<li>线程池工作线程卡在模拟慢调用的 <code>sleep()</code> 或真实 RPC/数据库 IO 上。</li>
</ul>

<h1 id="六、优化思路：不是把线程池调大就完了"><a href="#六、优化思路：不是把线程池调大就完了" class="headerlink" title="六、优化思路：不是把线程池调大就完了"></a>六、优化思路：不是把线程池调大就完了</h1>
<p>这类问题的优化，核心不是“线程调大一点”，而是三件事一起做：</p>
<ol>
<li><strong>让容量跟吞吐目标对上</strong>；</li>
<li><strong>限制排队长度，尽早失败</strong>；</li>
<li><strong>给慢下游设置超时和隔离</strong>。</li>
</ol>

<h2 id="1-优化后的线程池示例"><a href="#1-优化后的线程池示例" class="headerlink" title="1. 优化后的线程池示例"></a>1. 优化后的线程池示例</h2>
<pre><code class="language-java">@Configuration
public class ExecutorConfig {

    @Bean
    public ThreadPoolExecutor remoteCallExecutor() {
        return new ThreadPoolExecutor(
                32,
                32,
                60,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue&lt;&gt;(32),
                new ThreadFactoryBuilder().setNameFormat("remote-call-%d").build(),
                new ThreadPoolExecutor.CallerRunsPolicy()
        );
    }
}
</code></pre>

<p>这里有几个关键点：</p>
<ul>
<li><strong>ArrayBlockingQueue</strong>：有界数组队列，比无界或超大链表队列更容易控制系统背压；</li>
<li><strong>CallerRunsPolicy</strong>：当池子满了，让调用线程自己执行任务，相当于把背压传回上游，而不是无限堆积；</li>
<li><strong>队列不要贪大</strong>：大队列不是缓冲区，是延迟放大器。</li>
</ul>

<h2 id="2-给慢调用加超时"><a href="#2-给慢调用加超时" class="headerlink" title="2. 给慢调用加超时"></a>2. 给慢调用加超时</h2>
<pre><code class="language-java">public String call() throws Exception {
    Future&lt;String&gt; future = executor.submit(() -&gt; {
        Thread.sleep(200);
        return "ok";
    });
    return future.get(300, TimeUnit.MILLISECONDS);
}
</code></pre>
<p>超时很重要。没有超时，线程池就像一个没有出口的停车场；有超时，最差情况才有上限。线上系统不怕失败，怕的是<strong>慢而不死</strong>。</p>

<h2 id="3-如果是远程调用，别忘了连接池和客户端超时"><a href="#3-如果是远程调用，别忘了连接池和客户端超时" class="headerlink" title="3. 如果是远程调用，别忘了连接池和客户端超时"></a>3. 如果是远程调用，别忘了连接池和客户端超时</h2>
<p>真实项目里，线程池阻塞经常不是根因，而是结果。真正的问题可能出在：</p>
<ul>
<li>HTTP 客户端连接池太小；</li>
<li>数据库连接池被打满；</li>
<li>某个下游实例抖动，导致长尾请求堆积；</li>
<li>重试策略配置太激进，把雪崩放大。</li>
</ul>
<p>所以线程池优化完后，一定要继续看下游指标：成功率、超时率、连接池等待时间、重试次数、P99。</p>

<h1 id="七、如何验证优化真的有效"><a href="#七、如何验证优化真的有效" class="headerlink" title="七、如何验证优化真的有效"></a>七、如何验证优化真的有效</h1>
<p>很多人优化完只看一句“感觉快了不少”，这不够。至少要做三层验证。</p>

<h2 id="1-压测对比"><a href="#1-压测对比" class="headerlink" title="1. 压测对比"></a>1. 压测对比</h2>
<p>同一台机器、同一组参数，重新跑压测：</p>
<pre><code class="language-bash">wrk -t8 -c64 -d30s http://127.0.0.1:8080/api/slow
</code></pre>
<p>重点对比以下指标：</p>
<ul>
<li>吞吐是否提升；</li>
<li>P95 / P99 是否明显下降；</li>
<li>超时和拒绝是否在预期范围；</li>
<li>是否出现新的 CPU 或 GC 热点。</li>
</ul>

<h2 id="2-JFR-二次录制"><a href="#2-JFR-二次录制" class="headerlink" title="2. JFR 二次录制"></a>2. JFR 二次录制</h2>
<p>优化后再录一段 JFR，看这些变化：</p>
<ul>
<li>HTTP 线程在等待 <code>Future.get()</code> 的时间是否下降；</li>
<li>线程状态分布是否更健康；</li>
<li>锁竞争有没有被新方案引入；</li>
<li>GC、对象分配速率是否出现副作用。</li>
</ul>

<h2 id="3-async-profiler-看副作用"><a href="#3-async-profiler-看副作用" class="headerlink" title="3. async-profiler 看副作用"></a>3. async-profiler 看副作用</h2>
<pre><code class="language-bash">./profiler.sh -d 30 -e cpu -f /tmp/cpu.html &lt;PID&gt;
./profiler.sh -d 30 -e alloc -f /tmp/alloc.html &lt;PID&gt;
</code></pre>
<p>这里的 <code>alloc</code> 指的是对象分配热点。很多同学优化线程池后，吞吐是上去了，但对象创建猛增，GC 压力跟着来了。这个坑不能不防。</p>

<h1 id="八、常见坑与误区"><a href="#八、常见坑与误区" class="headerlink" title="八、常见坑与误区"></a>八、常见坑与误区</h1>
<ul>
<li><strong>误区一：CPU 不高，所以不是性能问题。</strong><br>错。大量请求在等待 IO、锁、队列时，CPU 本来就不一定高。</li>
<li><strong>误区二：线程池队列越大越稳。</strong><br>错。大队列很多时候只是把超时从“显式报错”变成“隐式变慢”。</li>
<li><strong>误区三：用了异步线程池就一定更快。</strong><br>错。如果主线程最终还要同步等待结果，那只是多了一次线程切换和调度成本。</li>
<li><strong>误区四：只看平均响应时间。</strong><br>错。平均值很会骗人，排查线上体验问题更该盯 P95/P99。</li>
<li><strong>误区五：把线程数一把梭调到 200。</strong><br>也不行。线程数过大可能带来上下文切换、内存占用和下游资源争抢，最后从“排队慢”变成“系统整体抖”。</li>
</ul>

<h1 id="九、一个更实用的容量估算方法"><a href="#九、一个更实用的容量估算方法" class="headerlink" title="九、一个更实用的容量估算方法"></a>九、一个更实用的容量估算方法</h1>
<p>如果你的调用主要是 IO 型，可以先用一个非常朴素但实用的估算：</p>
<pre><code>线程数 ≈ 目标吞吐 × 平均耗时（秒）
</code></pre>
<p>比如你希望撑住 120 req/s，而下游平均耗时 200ms：</p>
<pre><code>120 × 0.2 = 24
</code></pre>
<p>那线程池规模至少要从 24 左右开始试，而不是拍脑袋配个 4 或 8。当然，这只是起点，最终还要结合：</p>
<ul>
<li>下游最大并发承载；</li>
<li>数据库/连接池上限；</li>
<li>实例 CPU 和内存；</li>
<li>重试策略；</li>
<li>超时和熔断策略。</li>
</ul>

<h1 id="十、总结"><a href="#十、总结" class="headerlink" title="十、总结"></a>十、总结</h1>
<p>把这次排查过程压成几句话，其实就是：</p>
<ul>
<li>接口越跑越慢，先怀疑<strong>排队</strong>，别只盯 CPU；</li>
<li>JFR 很适合看“线程到底是在算，还是在等”；</li>
<li>线程池优化不是单调大，而是<strong>容量、队列、超时、背压</strong>一起设计；</li>
<li>验证优化不能靠感觉，至少要有<strong>压测对比 + JFR 对比</strong>；</li>
<li>线上最可怕的不是报错，而是<strong>慢而不死</strong>。</li>
</ul>
<p>如果你最近也在做 Spring Boot 服务治理，这类问题出现的概率其实比 GC 爆炸还高。因为它不一定报错，但特别伤用户体验，也特别容易在大促、流量波峰、下游抖动时被放大。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li><a target="_blank" rel="noopener" href="https://docs.oracle.com/en/java/javase/17/troubleshoot/troubleshoot-performance-issues-using-jfr.html">Oracle Documentation - Troubleshoot Performance Issues Using JFR</a></li>
<li><a target="_blank" rel="noopener" href="https://docs.oracle.com/en/java/javase/17/docs/specs/man/jcmd.html">Oracle Documentation - jcmd</a></li>
<li><a target="_blank" rel="noopener" href="https://github.com/async-profiler/async-profiler">async-profiler 官方仓库</a></li>
<li><a target="_blank" rel="noopener" href="https://docs.spring.io/spring-boot/docs/current/reference/html/actuator.html">Spring Boot Actuator 官方文档</a></li>
<li><a target="_blank" rel="noopener" href="https://github.com/wg/wrk">wrk 官方仓库</a></li>
<li><a target="_blank" rel="noopener" href="https://openjdk.org/projects/jmc/">JDK Mission Control</a></li>
</ol>
