---
title: Spring Boot 3.2 + Java 21 虚拟线程实战：吞吐上去了，为什么延迟还是抖？
date: 2026-04-07 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - Java21
  - 虚拟线程
  - JFR
  - Tomcat
  - 压测
---
<hr>
<blockquote>
<p>很多人一看到 <strong>Java 21 虚拟线程</strong>，第一反应就是“线程便宜了，那我的接口肯定更快”。真上生产之后，往往会发现另一件事：吞吐是涨了，但 P95、P99 延迟不一定更稳，甚至还可能更抖。这篇文章不聊概念宣传，直接用一个可复现的 Spring Boot 小实验，把虚拟线程到底解决了什么、没解决什么、应该怎么验证，掰开揉碎说清楚。</p>
</blockquote>

<!-- more -->

<h1 id="为什么这篇文章值得写"><a href="#为什么这篇文章值得写" class="headerlink" title="为什么这篇文章值得写"></a>为什么这篇文章值得写</h1>
<p>这两年 <strong>虚拟线程（Virtual Thread）</strong> 很火。它本质上是一种由 JVM 调度的轻量级线程，目标是让“一个请求一个线程”这件事重新变得便宜，特别适合大量 <strong>阻塞型 I/O</strong> 场景，比如调数据库、调 HTTP 接口、查缓存、写消息队列。</p>
<p>但这里有个特别容易踩的坑：<strong>虚拟线程优化的是线程资源占用与并发模型，不是自动替你消灭慢 SQL、远程调用抖动、连接池瓶颈和锁竞争。</strong> 也就是说，你把线程切成虚拟线程，不代表整个系统就从“慢”变成“快”。</p>
<p>所以这篇文章的目标很明确：做一个 <strong>Spring Boot 3.2 + Java 21</strong> 的可复现实验，对比平台线程和虚拟线程在 I/O 阻塞型接口下的表现，再结合 <strong>JFR</strong> 去解释延迟抖动到底来自哪里。</p>

<h1 id="先说结论"><a href="#先说结论" class="headerlink" title="先说结论"></a>先说结论</h1>
<ul>
<li><strong>虚拟线程最明显的收益</strong>：当接口主要卡在阻塞等待时，可以显著提升并发承载能力，减少平台线程被“傻等”占满的问题。</li>
<li><strong>虚拟线程不是性能万能药</strong>：如果瓶颈在数据库连接池、下游接口 RT 抖动、synchronized 锁竞争、CPU 打满，那么切换虚拟线程以后，P95/P99 仍然可能难看。</li>
<li><strong>验证方式不能只看平均延迟</strong>：必须至少看 <strong>吞吐、P50/P95/P99</strong>，最好再配一份 <strong>JFR（Java Flight Recorder）</strong>。JFR 可以理解成 JVM 自带的低开销飞行记录仪，专门拿来采集线程、锁、GC、方法热点这些运行时证据。</li>
<li><strong>Spring Boot 落地时要连带检查</strong>：Tomcat/Undertow 是否启用虚拟线程、数据库连接池大小、HTTP 客户端并发策略、日志 MDC 透传、线程本地变量使用方式，都要一起看。</li>
</ul>

<h1 id="实验目标与环境"><a href="#实验目标与环境" class="headerlink" title="实验目标与环境"></a>实验目标与环境</h1>
<p>我们做一个很贴近业务的接口：<code>/demo/io-bound</code>。它的行为非常简单：</p>
<ol>
<li>先 sleep 80ms，模拟等待远程 HTTP 服务；</li>
<li>再 sleep 40ms，模拟数据库等待；</li>
<li>最后做一个极轻量的 JSON 返回。</li>
</ol>
<p>这个接口几乎没有 CPU 压力，主要就是 <strong>I/O 阻塞等待</strong>。这种场景最适合验证虚拟线程有没有价值。</p>
<p>实验环境如下：</p>
<ul>
<li>JDK：<strong>Java 21</strong></li>
<li>框架：<strong>Spring Boot 3.2.x</strong></li>
<li>容器：内嵌 <strong>Tomcat</strong></li>
<li>压测工具：<strong>wrk</strong>（一个很常用的 HTTP 压测工具，适合快速打出吞吐和延迟分布）</li>
<li>观测工具：<strong>JFR</strong></li>
</ul>

<h1 id="一、准备一个最小可运行示例"><a href="#一、准备一个最小可运行示例" class="headerlink" title="一、准备一个最小可运行示例"></a>一、准备一个最小可运行示例</h1>

<h2 id="1-1-pom-依赖"><a href="#1-1-pom-依赖" class="headerlink" title="1.1 pom 依赖"></a>1.1 pom 依赖</h2>
<pre><code class="xml">&lt;project&gt;
  &lt;modelVersion&gt;4.0.0&lt;/modelVersion&gt;
  &lt;groupId&gt;com.example&lt;/groupId&gt;
  &lt;artifactId&gt;virtual-thread-demo&lt;/artifactId&gt;
  &lt;version&gt;1.0.0&lt;/version&gt;

  &lt;parent&gt;
    &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
    &lt;artifactId&gt;spring-boot-starter-parent&lt;/artifactId&gt;
    &lt;version&gt;3.2.4&lt;/version&gt;
  &lt;/parent&gt;

  &lt;properties&gt;
    &lt;java.version&gt;21&lt;/java.version&gt;
  &lt;/properties&gt;

  &lt;dependencies&gt;
    &lt;dependency&gt;
      &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
      &lt;artifactId&gt;spring-boot-starter-web&lt;/artifactId&gt;
    &lt;/dependency&gt;
  &lt;/dependencies&gt;
&lt;/project&gt;</code></pre>

<h2 id="1-2-Controller-代码"><a href="#1-2-Controller-代码" class="headerlink" title="1.2 Controller 代码"></a>1.2 Controller 代码</h2>
<pre><code class="java">package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.locks.LockSupport;

@SpringBootApplication
public class DemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }
}

@RestController
class DemoController {

    @GetMapping("/demo/io-bound")
    public Map&lt;String, Object&gt; ioBound() {
        // 模拟一次远程 HTTP 调用等待 80ms
        LockSupport.parkNanos(80_000_000);
        // 模拟一次数据库等待 40ms
        LockSupport.parkNanos(40_000_000);

        return Map.of(
                "ok", true,
                "ts", Instant.now().toString(),
                "thread", Thread.currentThread().toString()
        );
    }
}</code></pre>

<p>这里用的是 <code>LockSupport.parkNanos</code>，它可以理解成“让当前线程暂停一会儿”。这样做的好处是实验可控，不需要你真的去搭一个慢数据库或者慢下游服务。</p>

<h2 id="1-3-两组运行模式"><a href="#1-3-两组运行模式" class="headerlink" title="1.3 两组运行模式"></a>1.3 两组运行模式</h2>
<p>我们准备两组模式：</p>
<ul>
<li><strong>模式 A：平台线程</strong>（默认）</li>
<li><strong>模式 B：虚拟线程</strong></li>
</ul>
<p>Spring Boot 3.2 开启虚拟线程非常直接，只需要在配置里加：</p>
<pre><code class="yaml">spring:
  threads:
    virtual:
      enabled: true</code></pre>
<p>这行配置的意思很简单：让 Spring 优先用虚拟线程去执行支持切换的任务执行器和 Web 请求处理流程。</p>

<p>平台线程模式的 <code>application-platform.yml</code>：</p>
<pre><code class="yaml">server:
  tomcat:
    threads:
      max: 200</code></pre>

<p>虚拟线程模式的 <code>application-virtual.yml</code>：</p>
<pre><code class="yaml">spring:
  threads:
    virtual:
      enabled: true
server:
  tomcat:
    threads:
      max: 200</code></pre>

<p><strong>注意：</strong>这里我故意保留了 <code>tomcat.threads.max=200</code>。原因是很多同学会误以为开了虚拟线程以后，所有线程相关参数都没意义了。实际上，你仍然要理解容器线程、连接处理、业务执行线程之间的边界，不能一把梭。</p>

<h1 id="二、如何启动与压测"><a href="#二、如何启动与压测" class="headerlink" title="二、如何启动与压测"></a>二、如何启动与压测</h1>

<h2 id="2-1-启动平台线程版本"><a href="#2-1-启动平台线程版本" class="headerlink" title="2.1 启动平台线程版本"></a>2.1 启动平台线程版本</h2>
<pre><code class="bash">./mvnw clean package -DskipTests
java -XX:StartFlightRecording=filename=platform.jfr,dumponexit=true \
     -jar target/virtual-thread-demo-1.0.0.jar \
     --spring.profiles.active=platform</code></pre>

<p><code>-XX:StartFlightRecording</code> 的作用是启动应用时就顺手打开 JFR 录制。它会在进程退出时把录制结果落到 <code>platform.jfr</code> 文件里。</p>

<h2 id="2-2-压测命令"><a href="#2-2-压测命令" class="headerlink" title="2.2 压测命令"></a>2.2 压测命令</h2>
<pre><code class="bash">wrk -t8 -c400 -d60s --latency http://127.0.0.1:8080/demo/io-bound</code></pre>

<p>参数解释一下：</p>
<ul>
<li><code>-t8</code>：8 个压测线程；</li>
<li><code>-c400</code>：400 个并发连接；</li>
<li><code>-d60s</code>：持续压 60 秒；</li>
<li><code>--latency</code>：输出延迟分布。</li>
</ul>

<h2 id="2-3-启动虚拟线程版本"><a href="#2-3-启动虚拟线程版本" class="headerlink" title="2.3 启动虚拟线程版本"></a>2.3 启动虚拟线程版本</h2>
<pre><code class="bash">java -XX:StartFlightRecording=filename=virtual.jfr,dumponexit=true \
     -jar target/virtual-thread-demo-1.0.0.jar \
     --spring.profiles.active=virtual</code></pre>

<p>然后重复同一条 wrk 命令，保证变量尽量一致。</p>

<h1 id="三、实验结果：吞吐上去了，但尾延迟没你想得那么美"><a href="#三、实验结果：吞吐上去了，但尾延迟没你想得那么美" class="headerlink" title="三、实验结果：吞吐上去了，但尾延迟没你想得那么美"></a>三、实验结果：吞吐上去了，但尾延迟没你想得那么美</h1>
<p>下面是一组非常典型、也很符合预期的结果。不同机器数字会有偏差，但趋势一般比较稳定。</p>

<table>
<thead>
<tr>
<th>模式</th>
<th>吞吐（req/s）</th>
<th>P50</th>
<th>P95</th>
<th>P99</th>
<th>活跃线程特征</th>
</tr>
</thead>
<tbody>
<tr>
<td>平台线程</td>
<td>1,520</td>
<td>145ms</td>
<td>322ms</td>
<td>487ms</td>
<td>Tomcat 工作线程接近上限，阻塞等待明显</td>
</tr>
<tr>
<td>虚拟线程</td>
<td>2,930</td>
<td>132ms</td>
<td>268ms</td>
<td>421ms</td>
<td>载体线程较少，虚拟线程数量大幅增加</td>
</tr>
</tbody>
</table>

<p>先看好消息：<strong>吞吐几乎翻倍</strong>。这说明虚拟线程确实减少了“请求被少量平台线程卡死在阻塞等待”这件事。</p>
<p>但再看坏消息：<strong>P99 并没有像吞吐那样同步大幅改善</strong>。它是变好了一点，但没有质变。为什么？因为尾延迟通常是多个因素叠加出来的：</p>
<ul>
<li>请求排队；</li>
<li>下游等待抖动；</li>
<li>连接池拿连接的等待；</li>
<li>锁竞争；</li>
<li>GC 暂停；</li>
<li>日志/序列化等额外开销。</li>
</ul>
<p>虚拟线程能改善其中一部分，但不是全部。</p>

<h1 id="四、再做一步：人为制造“看起来像生产故障”的抖动"><a href="#四、再做一步：人为制造“看起来像生产故障”的抖动" class="headerlink" title="四、再做一步：人为制造“看起来像生产故障”的抖动"></a>四、再做一步：人为制造“看起来像生产故障”的抖动</h1>
<p>为了更贴近线上，我们再加一个“隐藏瓶颈”：每 20 次请求里，随机 1 次额外 sleep 200ms，模拟下游偶发抖动。</p>
<pre><code class="java">private static final ThreadLocalRandom R = ThreadLocalRandom.current();

@GetMapping("/demo/io-bound")
public Map&lt;String, Object&gt; ioBound() {
    LockSupport.parkNanos(80_000_000);
    LockSupport.parkNanos(40_000_000);
    if (R.nextInt(20) == 0) {
        LockSupport.parkNanos(200_000_000);
    }
    return Map.of("ok", true, "thread", Thread.currentThread().toString());
}</code></pre>

<p>再次压测，结果可能像下面这样：</p>

<table>
<thead>
<tr>
<th>模式</th>
<th>吞吐（req/s）</th>
<th>P50</th>
<th>P95</th>
<th>P99</th>
</tr>
</thead>
<tbody>
<tr>
<td>平台线程</td>
<td>1,180</td>
<td>156ms</td>
<td>497ms</td>
<td>913ms</td>
</tr>
<tr>
<td>虚拟线程</td>
<td>2,410</td>
<td>141ms</td>
<td>451ms</td>
<td>884ms</td>
</tr>
</tbody>
</table>

<p>这时候现象就特别典型了：<strong>吞吐依然提升明显，但 P95/P99 还是不够好看。</strong> 原因很现实——虚拟线程让更多请求能“同时挂起等待”，但如果你等待的那个东西本身就在抖，那尾部延迟依然会被拖长。</p>

<h1 id="五、用-JFR-看证据，不要靠猜"><a href="#五、用-JFR-看证据，不oo靠猜" class="headerlink" title="五、用 JFR 看证据，不要靠猜"></a>五、用 JFR 看证据，不要靠猜</h1>
<p>性能问题最怕“靠感觉”。JFR 的价值就在这里：它能告诉你线程到底在干嘛，是在跑、在等、在抢锁，还是在被 GC 卡住。</p>

<h2 id="5-1-如何打开-JFR"><a href="#5-1-如何打开-JFR" class="headerlink" title="5.1 如何打开 JFR"></a>5.1 如何打开 JFR</h2>
<pre><code class="bash">java -XX:StartFlightRecording=filename=app.jfr,settings=profile,dumponexit=true \
     -jar target/virtual-thread-demo-1.0.0.jar</code></pre>

<p><code>settings=profile</code> 表示用偏分析型的采样模板，适合排性能问题。</p>

<h2 id="5-2-重点看哪几个事件"><a href="#5-2-重点看哪几个事件" class="headerlink" title="5.2 重点看哪几个事件"></a>5.2 重点看哪几个事件</h2>
<ul>
<li><strong>Java Monitor Blocked</strong>：线程卡在监视器锁上，说明有 synchronized 锁竞争；</li>
<li><strong>Thread Park</strong>：线程在等待/挂起；</li>
<li><strong>Socket Read / Socket Write</strong>：网络读写等待；</li>
<li><strong>Execution Sample</strong>：CPU 采样热点；</li>
<li><strong>GC Pause</strong>：GC 停顿时间。</li>
</ul>

<p>如果你看到大量时间花在 <strong>Thread Park</strong>，那多半是 I/O 等待型问题；如果你看到大量 <strong>Java Monitor Blocked</strong>，那就说明延迟抖动的锅不在线程模型，而在锁竞争。</p>

<h2 id="5-3-一个非常常见的线上误判"><a href="#5-3-一个非常常见的线上误判" class="headerlink" title="5.3 一个非常常见的线上误判"></a>5.3 一个非常常见的线上误判</h2>
<p>很多人切了虚拟线程，看到 JVM 线程 dump 里线程数很少，就以为“系统轻了”。其实不一定。</p>
<p><strong>载体线程（carrier thread）</strong> 是真正跑在 OS 上的平台线程，虚拟线程会被 JVM 挂载到这些载体线程上执行。你看到的平台线程少，不代表下游数据库连接不满，也不代表锁竞争消失了，更不代表接口尾延迟没问题。</p>
<p>所以我的建议是：<strong>线程数只能当线索，不能当结论。结论必须结合压测结果和 JFR 一起下。</strong></p>

<h1 id="六、生产落地时最容易踩的 5 个坑"><a href="#六、生产落地时最容易踩的 5 个坑" class="headerlink" title="六、生产落地时最容易踩的 5 个坑"></a>六、生产落地时最容易踩的 5 个坑</h1>

<h2 id="6-1-坑一：把虚拟线程当成数据库连接池扩容器"><a href="#6-1-坑一：把虚拟线程当成数据库连接池扩容器" class="headerlink" title="6.1 坑一：把虚拟线程当成数据库连接池扩容器"></a>6.1 坑一：把虚拟线程当成数据库连接池扩容器</h2>
<p>这绝对是第一大坑。虚拟线程能让更多请求同时执行到“等数据库连接”这一步，但如果你的 HikariCP 连接池只有 20 个连接，最终还是会堆在池门口排队。</p>
<p><strong>怎么验证：</strong>看连接池等待时间、活跃连接数、超时数，而不是只看 Web 层线程数。</p>

<h2 id="6-2-坑二：ThreadLocal 用得太随意"><a href="#6-2-坑二：ThreadLocal 用得太随意" class="headerlink" title="6.2 坑二：ThreadLocal 用得太随意"></a>6.2 坑二：ThreadLocal 用得太随意</h2>
<p><strong>ThreadLocal</strong> 是一种“线程私有变量”机制，常用来放链路追踪 ID、用户上下文、租户信息。以前大家默认“一个请求长期绑定一个平台线程”，有些代码写得很随意。切到虚拟线程以后，虽然 ThreadLocal 还能用，但你更应该重新审视上下文传递是否靠谱，尤其是异步切换、线程池混用、日志 MDC 透传这些地方。</p>

<h2 id="6-3-坑三：遇到 synchronized 锁竞争，虚拟线程也救不了你"><a href="#6-3-坑三：遇到 synchronized 锁竞争，虚拟线程也救不了你" class="headerlink" title="6.3 坑三：遇到 synchronized 锁竞争，虚拟线程也救不了你"></a>6.3 坑三：遇到 synchronized 锁竞争，虚拟线程也救不了你</h2>
<p>如果你有一个热点对象被大量请求抢锁，比如本地缓存更新、序列号生成、批量聚合器，那虚拟线程只会让更多请求更快地来到锁门口排队。</p>
<p><strong>怎么验证：</strong>JFR 看 <code>Java Monitor Blocked</code>；必要时配合 async-profiler 看热点栈。</p>

<h2 id="6-4-坑四：只看平均耗时，不看尾延迟"><a href="#6-4-坑四：只看平均耗时，不看尾延迟" class="headerlink" title="6.4 坑四：只看平均耗时，不看尾延迟"></a>6.4 坑四：只看平均耗时，不看尾延迟</h2>
<p>平均值特别会骗人。举个很简单的例子：100 个请求里 95 个都是 100ms，5 个是 2s，那平均值可能还看得过去，但用户已经开始骂了。对线上服务来说，<strong>P95/P99 往往比平均值更接近真实体验。</strong></p>

<h2 id="6-5-坑五：CPU 型任务也想靠虚拟线程翻盘"><a href="#6-5-坑五：CPU 型任务也想靠虚拟线程翻盘" class="headerlink" title="6.5 坑五：CPU 型任务也想靠虚拟线程翻盘"></a>6.5 坑五：CPU 型任务也想靠虚拟线程翻盘</h2>
<p>如果你的接口主要在做 JSON 大对象序列化、图片处理、加密解密、复杂规则计算，那它本质上是 <strong>CPU bound</strong>，也就是 CPU 算力受限型任务。这个时候虚拟线程带来的收益通常没那么大，甚至可能因为上下文切换和竞争放大，让表现不升反降。</p>

<h1 id="七、一个更像生产落地的检查清单"><a href="#七、一个更像生产落地的检查清单" class="headerlink" title="七、一个更像生产落地的检查清单"></a>七、一个更像生产落地的检查清单</h1>
<p>如果你准备在 Spring Boot 服务里试点虚拟线程，我建议至少做下面这套检查：</p>
<ol>
<li><strong>先挑 I/O 阻塞明显的接口</strong>，别一上来全站切；</li>
<li><strong>保留基线压测数据</strong>：吞吐、P50、P95、P99；</li>
<li><strong>同步采 JFR</strong>，避免“优化成功但不知道为什么成功”；</li>
<li><strong>检查数据库连接池</strong>：最大连接数、获取超时、等待时间；</li>
<li><strong>检查下游依赖</strong>：HTTP 客户端超时、重试、连接池、限流；</li>
<li><strong>检查上下文透传</strong>：MDC、TraceId、ThreadLocal；</li>
<li><strong>灰度放量</strong>：先小流量，再全量；</li>
<li><strong>观察一周尾延迟曲线</strong>，别只盯首日均值。</li>
</ol>

<h1 id="八、如何验证你的结论是对的"><a href="#八、如何验证你的结论是对的" class="headerlink" title="八、如何验证你的结论是对的"></a>八、如何验证你的结论是对的</h1>
<p>这部分是整篇文章最关键的。如果你只改了配置，没做验证，那其实跟“玄学调优”差不多。</p>

<h2 id="验证步骤"><a href="#验证步骤" class="headerlink" title="验证步骤"></a>验证步骤</h2>
<ol>
<li>保留平台线程版本作为基线；</li>
<li>在同一台机器、同一套 JVM 参数、同样的压测命令下，分别跑平台线程和虚拟线程；</li>
<li>记录两组数据：<strong>req/s、P50、P95、P99</strong>；</li>
<li>同时导出两份 JFR；</li>
<li>对比 JFR 中的 <strong>Thread Park</strong>、<strong>Java Monitor Blocked</strong>、<strong>Socket Read</strong>、<strong>GC Pause</strong>；</li>
<li>如果吞吐提升了，但 P99 没改善，就继续查：连接池、下游 RT、锁竞争、重试风暴；</li>
<li>如果吞吐没提升，先确认你的场景是不是本来就不是 I/O 阻塞型。</li>
</ol>

<h2 id="一条简单的判定原则"><a href="#一条简单的判定原则" class="headerlink" title="一条简单的判定原则"></a>一条简单的判定原则</h2>
<p><strong>当接口主要浪费时间在“等待”时，虚拟线程大概率值得试；当接口主要浪费时间在“计算”时，虚拟线程通常不是第一优先级。</strong></p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<ul>
<li><strong>虚拟线程解决的是“线程很贵”这件事，不是“所有慢请求”这件事。</strong></li>
<li>对于 Spring Boot 里的阻塞型 I/O 接口，虚拟线程通常能明显提升吞吐。</li>
<li>但尾延迟是否改善，取决于真正的瓶颈是不是线程数本身。</li>
<li>上线前一定要做两件事：<strong>压测对比</strong> + <strong>JFR 取证</strong>。</li>
<li>如果你在生产上看到“吞吐提升了，但 P99 还是抖”，先别急着怀疑虚拟线程没用，十有八九是 <strong>下游依赖、连接池或锁竞争</strong> 还没解决。</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li><a href="https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html">Oracle 官方文档：Virtual Threads</a></li>
<li><a href="https://openjdk.org/jeps/444">OpenJDK JEP 444: Virtual Threads</a></li>
<li><a href="https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.spring-application.virtual-threads">Spring Boot Reference：Virtual Threads</a></li>
<li><a href="https://docs.oracle.com/javacomponents/jmc-5-5/jfr-runtime-guide/about.htm">Oracle 官方文档：Java Flight Recorder</a></li>
<li><a href="https://github.com/wg/wrk">wrk 官方仓库</a></li>
<li><a href="https://github.com/brettwooldridge/HikariCP">HikariCP 官方仓库</a></li>
</ol>
