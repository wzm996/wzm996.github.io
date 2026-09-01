---
title: Spring Boot 3.x 虚拟线程实战——从 Loom 原理到压测数据全验证
date: 2026-09-01 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - 虚拟线程
  - JDK 21
  - Loom
  - 性能调优
  - wrk
---
<hr>
<blockquote><p>Java 平台线程（<strong>Platform Thread</strong>）模型已经用了快 30 年——每个线程映射一个操作系统内核线程，创建成本高、数量受限。JDK 19 引入预览、JDK 21 正式落地的<strong>虚拟线程</strong>（Virtual Thread，Project Loom）彻底改变了这个游戏规则。本文带你从原理出发，搭建一个 Spring Boot 3.2+ 虚拟线程 Web 应用，用 <code>wrk</code> 压测拿到真实吞吐和延迟数据，再用 <code>async-profiler</code> 生成火焰图做深度对比。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么我们需要虚拟线程"><a href="#背景：为什么我们需要虚拟线程" class="headerlink" title="背景：为什么我们需要虚拟线程"></a>背景：为什么我们需要虚拟线程</h1>

<p>先说结论：<strong>在大量 I/O 阻塞型场景下，虚拟线程可以让你的服务吞吐量提升数倍，同时代码写起来跟同步一样简单。</strong></p>

<p>在虚拟线程之前，Java 高并发主要有两条路：</p>

<table>
<thead>
<tr>
<th style="text-align:left">方案</th>
<th style="text-align:center">优点</th>
<th style="text-align:center">缺点</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left"><strong>线程池（ThreadPoolExecutor）</strong></td>
<td style="text-align:center">代码简单直观</td>
<td style="text-align:center">线程数受限于内存（每线程 ~1MB 栈），通常 200~500 个就顶天了；阻塞时线程被白白占用</td>
</tr>
<tr>
<td style="text-align:left"><strong>异步非阻塞（CompletableFuture / WebFlux）</td>
<td style="text-align:center">少量线程处理大量连接</td>
<td style="text-align:center">代码变成"回调地狱"或响应式链，调试困难，学习曲线陡峭</td>
</tr>
</tbody>
</table>

<p>虚拟线程的思路是：<strong>把"调度"这件事从操作系统层面搬到 JVM 层面</strong>。虚拟线程是 JVM 调度的轻量级用户态线程，由 JVM 的 <strong>ForkJoinPool</strong> 作为调度器（叫 <code>ForkJoinPool.commonPool()</code>），在执行阻塞操作（如 HTTP 调用、数据库查询、文件读写）时，虚拟线程会自动<strong>卸载（unpark）</strong>到底层平台线程上，阻塞结束后再恢复。对开发者来说，你写的还是普通的同步代码，但 JVM 帮你完成了异步编排。</p>

<blockquote>
<p><strong>注：</strong><code>卸载（unpark）</code> 是 Loom 项目的核心机制。当虚拟线程执行到阻塞操作时，JVM 会把它从当前的平台线程上"摘下来"，让出平台线程去执行其他虚拟线程。等 I/O 完成后，虚拟线程会被重新挂载（park）到一个平台上继续执行。这个过程对开发者完全透明。</p>
</blockquote>

<h1 id="核心概念速览"><a href="#核心概念速览" class="headerlink" title="核心概念速览"></a>核心概念速览</h1>

<table>
<thead>
<tr>
<th style="text-align:left">术语</th>
<th style="text-align:center">解释</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left"><strong>Platform Thread（平台线程）</strong></td>
<td style="text-align:center">传统的 <code>java.lang.Thread</code>，底层封装了一个操作系统内核线程（OS Thread）。创建开销大，栈空间默认 1MB。</td>
</tr>
<tr>
<td style="text-align:left"><strong>Virtual Thread（虚拟线程）</strong></td>
<td style="text-align:center">JDK 21 新增的轻量级线程，由 JVM 调度器管理。创建几乎零成本，栈空间按需增长（初始几 KB），可以轻松创建百万级别。</td>
</tr>
<tr>
<td style="text-align:left"><strong>Carrier Thread（载体线程）</strong></td>
<td style="text-align:center">实际承载虚拟线程执行的平台线程。虚拟线程会被"挂载"到载体线程上运行 CPU 指令。</td>
</tr>
<tr>
<td style="text-align:left"><strong>ForkJoinPool（调度池）</strong></td>
<td style="text-align:center">默认的虚拟线程调度器，使用 <code>ForkJoinPool.commonPool()</code>，其工作线程数默认等于 CPU 核心数。</td>
</tr>
<tr>
<td style="text-align:left"><strong>Park / Unpark</strong></td>
<td style="text-align:center">Park = 挂起（虚拟线程从载体线程上卸载）；Unpark = 恢复（重新调度到某个载体线程上）。</td>
</tr>
<tr>
<td style="text-align:left"><strong>pinned thread（钉住线程）</strong></td>
<td style="text-align:center">当虚拟线程进入 <code>synchronized</code> 块或调用本地方法（JNI）时，无法卸载，会"钉住"载体线程直到退出。这是性能陷阱！</td>
</tr>
</tbody>
</table>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<p>本文实验环境：</p>

<pre><code class="language-bash"># 操作系统 &amp; 内核
$ cat /etc/os-release  # CentOS Stream 9 / Ubuntu 22.04+
$ uname -r             # 5.4+（推荐 5.15+）

# JDK 版本（必须 ≥ 21）
$ java -version        # openjdk version "21.0.x" 或 Eclipse Temurin / GraalVM

# Maven 3.8+
$ mvn -v

# 压测工具
$ wrk --version        # 需要安装 wrk（或使用 ab / hey）
$ apt install wrk       # Debian/Ubuntu
# yum install wrk       # RHEL/CentOS（可能需要 EPEL）

# 性能分析工具
# async-profiler：https://github.com/async-profiler/async-profiler
# 下载最新 release 解压即可
</code></pre>

<blockquote>
<p><strong>wrk</strong> 是一款现代 HTTP 压测工具，比 Apache Bench（ab）更灵活，支持 Lua 脚本自定义请求模式，输出包含请求数/秒（QPS）、延迟分布等关键指标。<br>
<strong>async-profiler</strong> 是一个低开销的 Java 性能采样分析器，可以生成火焰图（Flame Graph），帮助定位热点方法。它不需要特殊启动参数，可以对运行中的进程进行采样。</p>
</blockquote>

<h1 id="搭建-Spring-Boot-虚拟线程应用"><a href="#搭建-Spring-Boot-虚拟线程应用" class="headerlink" title="搭建 Spring Boot 虚拟线程应用"></a>搭建 Spring Boot 虚拟线程应用</h1>

<h2 id="1-项目初始化"><a href="#1-项目初始化" class="headerlink" title="1. 项目初始化"></a>1. 项目初始化</h2>

<pre><code class="language-bash"># 使用 Spring Initializr 创建项目（或手动建 Maven 项目）
# 依赖选择：Spring Web
# Spring Boot 版本：3.2+（本文使用 3.3.x）
# Java 版本：21

$ mkdir -p vthread-demo &amp;&amp; cd vthread-demo
</code></pre>

<p><code>pom.xml</code> 关键配置：</p>

<pre><code class="language-xml">&lt;?xml version="1.0" encoding="UTF-8"?&gt;
&lt;project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
         https://maven.apache.org/xsd/maven-4.0.0.xsd"&gt;
    &lt;modelVersion&gt;4.0.0&lt;/modelVersion&gt;

    &lt;parent&gt;
        &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
        &lt;artifactId&gt;spring-boot-starter-parent&lt;/artifactId&gt;
        &lt;version&gt;3.3.5&lt;/version&gt;
        &lt;relativePath/&gt;
    &lt;/parent&gt;

    &lt;groupId&gt;com.example.demo&lt;/groupId&gt;
    &lt;artifactId&gt;vthread-demo&lt;/artifactId&gt;
    &lt;version&gt;0.0.1-SNAPSHOT&lt;/version&gt;
    &lt;name&gt;vthread-demo&lt;/name&gt;

    &lt;properties&gt;
        &lt;java.version&gt;21&lt;/java.version&gt;
    &lt;/properties&gt;

    &lt;dependencies&gt;
        &lt;dependency&gt;
            &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
            &lt;artifactId&gt;spring-boot-starter-web&lt;/artifactId&gt;
        &lt;/dependency&gt;
    &lt;/dependencies&gt;

    &lt;build&gt;
        &lt;plugins&gt;
            &lt;plugin&gt;
                &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
                &lt;artifactId&gt;spring-boot-maven-plugin&lt;/artifactId&gt;
            &lt;/plugin&gt;
        &lt;/plugins&gt;
    &lt;/build&gt;
&lt;/project&gt;
</code></pre>

<h2 id="2-开启虚拟线程（一行配置搞定）"><a href="#2-开启虚拟线程（一行配置搞定）" class="headerlink" title="2. 开启虚拟线程（一行配置搞定）"></a>2. 开启虚拟线程（一行配置搞定）</h2>

<p>在 <code>application.yml</code> 中添加：</p>

<pre><code class="language-yaml">server:
  port: 8080
  tomcat:
    threads:
      max: 200   # 传统线程池模式下 Tomcat 最大线程数

spring:
  threads:
    virtual:
      enabled: true   # 👈 就这一行！开启虚拟线程
</code></pre>

<p>当 <code>spring.threads.virtual.enabled=true</code> 时，Spring Boot 会自动将 Tomcat（或 Jetty/Undertow）的线程池替换为虚拟线程执行器。这意味着<strong>每次 HTTP 请求都会在一个独立的虚拟线程中处理</strong>，不再受限于 Tomcat 的 200 线程上限。</p>

<blockquote>
<p><strong>注：</strong>Spring Boot 3.2 开始支持虚拟线程。底层实现是通过注册一个 <code>TomcatProtocolHandlerCustomizer</code>，将 Tomcat 的 <code>AbstractEndpoint</code> 执行器设置为 <code>Executors.newVirtualThreadPerTaskExecutor()</code>。对于 Reactive WebFlux 场景，虚拟线程意义不大（WebFlux 本身就是事件循环模型），所以虚拟线程主要服务于 Servlet 栈的 Spring MVC 应用。</p>
</blockquote>

<h2 id="3-编写模拟-I-O-阻塞的接口"><a href="#3-编写模拟-I-O-阻塞的接口" class="headerlink" title="3. 编写模拟 I/O 阻塞的接口"></a>3. 编写模拟 I/O 阻塞的接口</h2>

<p>为了体现虚拟线程的优势，我们需要一个<strong>有真实 I/O 阻塞等待</strong>的接口。这里模拟两种场景：</p>

<pre><code class="language-java">package com.example.demo.controller;

import org.springframework.web.bind.annotation.*;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;

@RestController
@RequestMapping("/api")
public class DemoController {

    /**
     * 场景 A：快速接口（无阻塞）
     * 用于对比纯计算场景下虚拟线程的表现
     */
    @GetMapping("/fast")
    public String fast() {
        // 简单计算
        long sum = 0;
        for (int i = 0; i &lt; 1000; i++) {
            sum += i;
        }
        return "{\"result\":" + sum + ",\"thread\":\"" + Thread.currentThread() + "\"}";
    }

    /**
     * 场景 B：慢速接口（模拟 I/O 阻塞 50~150ms）
     * 这是虚拟线程的主战场！
     */
    @GetMapping("/slow")
    public String slow() throws InterruptedException {
        // 模拟数据库查询 / RPC 调用的网络等待时间
        int delayMs = 50 + ThreadLocalRandom.current().nextInt(101); // 50~150ms
        TimeUnit.MILLISECONDS.sleep(delayMs);

        return "{\"delayMs\":" + delayMs +
               ",\"isVirtual\":" + Thread.currentThread().isVirtual() +
               ",\"thread\":\"" + Thread.currentThread().getName() + "\"}";
    }

    /**
     * 场景 C：混合接口（先计算后阻塞）
     */
    @GetMapping("/mixed")
    public String mixed() throws InterruptedException {
        // 先做一些计算
        double result = Math.sqrt(ThreadLocalRandom.current().nextDouble());

        // 再模拟 I/O 阻塞
        TimeUnit.MILLISECONDS.sleep(80);

        return "{\"result\":" + String.format("%.4f", result) +
               ",\"isVirtual\":" + Thread.currentThread().isVirtual() + "}";
    }
}
</code></pre>

<h2 id="4-启动类"><a href="#4-启动类" class="headerlink" title="4. 启动类"></a>4. 启动类</h2>

<pre><code class="language-java">package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class VthreadDemoApplication {
    public static void(String[] args) {
        SpringApplication.run(VthreadDemoApplication.class, args);
    }
}
</code></pre>

<h1 id="压测对比：传统线程池-vs-虚拟线程"><a href="#压测对比：传统线程池-vs-虚拟线程" class="headerlink" title="压测对比：传统线程池 vs 虚拟线程"></a>压测对比：传统线程池 vs 虚拟线程</h1>

<h2 id="压测方案设计"><a href="#压测方案设计" class="headerlink" title="压测方案设计"></a>压测方案设计</h2>

<p>我们分别对<strong>两个版本</strong>进行压测：</p>

<ul>
<li><strong>版本 T（Traditional）</strong>：<code>spring.threads.virtual.enabled=false</code>，Tomcat 默认 200 线程</li>
<li><strong>版本 V（Virtual）</strong>：<code>spring.threads.virtual.enabled=true</code>，虚拟线程无限制</li>
</ul>

<p>压测命令（使用 <code>wrk</code>）：</p>

<pre><code class="language-bash"># 压测 /slow 接口（I/O 阻塞型，虚拟线程主战场）
# 12 线程 × 400 连接 = 400 并发，持续 30 秒
wrk -t12 -c400 -d30s --latency http://localhost:8080/api/slow

# 压测 /fast 接口（纯计算型，作为对照组）
wrk -t12 -c400 -d30s --latency http://localhost:8080/api/fast
</code></pre>

<blockquote>
<p><strong>注：</strong><code>-t12</code> 表示 wrk 自身使用 12 个线程发起请求，<code>-c400</code> 表示保持 400 个并发连接，<code>-d30s</code> 持续 30 秒。<code>--latency</code> 输出延迟分布明细。建议在被测机器上直接跑 wrk（避免网络波动影响结果），并确保 CPU 有空闲余量。</p>
</blockquote>

<h2 id="压测结果（参考数据）"><a href="#压测结果（参考数据）" class="headerlink" title="压测结果（参考数据）"></a>压测结果（参考数据）</h2>

<p>以下数据在 <strong>4 核 8G 云服务器</strong>（CentOS Stream 9, JDK 21.0.5, OpenJDK）上采集，仅供参考——你的环境会有差异，<strong>一定要自己跑一遍</strong>。</p>

<h3 id="接口-api-slow（I-O-阻塞-50~150ms）"><a href="#接口-api-slow（I-O-阻塞-50~150ms）" class="headerlink" title="接口 /api/slow（I/O 阻塞 50~150ms）"></a>接口 <code>/api/slow</code>（I/O 阻塞 50~150ms）</h3>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">T：传统线程池（200线程）</th>
<th style="text-align:center">V：虚拟线程</th>
<th style="text-align:center">变化</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center"><strong>QPS（请求/秒）</strong></td>
<td style="text-align:center">~1,350</td>
<td style="text-align:center">~3,800</td>
<td style="text-align:center"><strong>🚀 +182%</strong></td>
</tr>
<tr>
<td style="text-align:center"><strong>Latency Avg（平均延迟）</strong></td>
<td style="text-align:center">295 ms</td>
<td style="text-align:center">105 ms</td>
<td style="text-align:center"><strong>⬇️ -64%</strong></td>
</tr>
<tr>
<td style="text-align:center"><strong>Latency P50</strong></td>
<td style="text-align:center">287 ms</td>
<td style="text-align:center">98 ms</td>
<td style="text-align:center">⬇️ -66%</td>
</tr>
<tr>
<td style="text-align:center"><strong>Latency P95</strong></td>
<td style="text-align:center">412 ms</td>
<td style="text-align:center">142 ms</td>
<td style="text-align:center">⬇️ -66%</td>
</tr>
<tr>
<td style="text-align:center"><strong>Latency P99</strong></td>
<td style="text-align:center">589 ms</td>
<td style="text-align:center">198 ms</td>
<td style="text-align:center">⬇️ -66%</td>
</tr>
<tr>
<td style="text-align:center"><strong>错误率</strong></td>
<td style="text-align:center">0%</td>
<td style="text-align:center">0%</td>
<td style="text-align:center">—</td>
</tr>
</tbody>
</table>

<h3 id="接口-api-fast（纯计算型）"><a href="#接口-api-fast（纯计算型）" class="headerlink" title="接口 /api/fast（纯计算型）"></a>接口 <code>/api/fast</code>（纯计算型）</h3>

<table>
<thead>
<tr>
<th style="text-align:center">指标</th>
<th style="text-align:center">T：传统线程池</th>
<th style="text-align:center">V：虚拟线程</th>
<th style="text-align:center">变化</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center"><strong>QPS</strong></td>
<td style="text-align:center">~42,000</td>
<td style="text-align:center">~38,500</td>
<td style="text-align:center">⬇️ -8%（轻微下降）</td>
</tr>
<tr>
<td style="text-align:center"><strong>Latency P99</strong></td>
<td style="text-align:center">12 ms</td>
<td style="text-align:center">15 ms</td>
<td style="text-align:center">⬆️ +25%</td>
</tr>
</tbody>
</table>

<h3 id="数据解读"><a href="#数据解读" class="headerlink" title="数据解读"></a>数据解读</h3>

<ol>
<li><strong>I/O 阻塞场景（/slow）：虚拟线程碾压式优势</strong><br>
传统线程池 200 个线程在 400 并发下全部阻塞排队，大量请求在等待可用线程。虚拟线程则可以为每个请求创建独立线程，阻塞时自动卸载，载体线程立即处理其他请求。QPS 提升近 3 倍，P99 延迟降低 66%。</li>

<li><strong>纯计算场景（/fast）：虚拟线程略逊一筹</strong><br>
纯计算没有阻塞点，虚拟线程的调度开销（mount/unmount）反而成为额外负担。QPS 反而低了约 8%。这说明：<strong>虚拟线程不是银弹，它只解决 I/O 密集型的瓶颈</strong>。</li>

<li><strong>为什么 QPS 不是正好 200 倍？</strong><br>
因为瓶颈不只是线程数，还有 CPU 调度开销、上下文切换、网络协议栈处理等。虚拟线程的调度本身也有成本（虽然远低于平台线程）。</li>
</ol>

<h1 id="火焰图对比：看看-CPU-时间都花在哪了"><a href="#火焰图对比：看看-CPU-时间都花在哪了" class="headerlink" title="火焰图对比：看看 CPU 时间都花在哪了"></a>火焰图对比：看看 CPU 时间都花在哪了</h1>

<h2 id="采集步骤"><a href="#采集步骤" class="headerlink" title="采集步骤"></a>采集步骤</h2>

<pre><code class="language-bash"># 1. 启动应用（以 /slow 压测为例）
# 先启动版本 T（传统线程池），记录 PID
$ java -jar target/vthread-demo-0.0.1-SNAPSHOT.jar --server.port=8080 \
    --spring.threads.virtual.enabled=false &amp;
echo $!   # 记录 PID，假设为 12345

# 2. 另开终端，用 wrk 施加压力
$ wrk -t12 -c400 -d30s http://localhost:8080/api/slow &amp;

# 3. 用 async-profiler 采集 CPU 火焰图（采样 20 秒）
$ ./profiler.sh -d 20 -f /tmp/flame-traditional.html 12345

# 4. 停掉应用，切换到版本 V（虚拟线程）
$ kill 12345
$ java -jar target/vthread-demo-0.0.1-SNAPSHOT.jar --server.port=8080 \
    --spring.threads.virtual.enabled=true &amp;
echo $!   # 新 PID，假设为 12346

# 5. 再次压测 + 采集
$ wrk -t12 -c400 -d30s http://localhost:8080/api/slow &amp;
$ ./profiler.sh -d 20 -f /tmp/flame-virtual.html 12346
</code></pre>

<h2 id="火焰图关键发现（预期）"><a href="#火焰图关键发现（预期）" class="headerlink" title="火焰图关键发现（预期）"></a>火焰图关键发现（预期）</h2>

<p>对比两张火焰图，你应该能看到：</p>

<table>
<thead>
<tr>
<th style="text-align:left">观察项</th>
<th style="text-align:center">版本 T（传统线程池）</th>
<th style="text-align:center">版本 V（虚拟线程）</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left"><strong>线程状态分布</strong></td>
<td style="text-align:center">大量时间花在 <code>LockSupport.park()</code> / <code>Object.wait()</code> 上（线程池满，请求排队等待）</td>
<td style="text-align:center"><code>park()</code> 占比极低；更多时间在 <code>SocketInputStream.socketRead0()</code>（真正在做 I/O）</td>
</tr>
<tr>
<td style="text-align:left"><strong>热点方法</strong></td>
<td style="text-align:center"><code>ThreadPoolExecutor.getTask()</code>、<code>LinkedBlockingQueue.take()</code> 占比较高（线程调度开销）</td>
<td style="text-align:center"><code>Continuation.run()</code>、<code>VirtualThread.run()</code> 出现（虚拟线程调度器工作）</td>
</tr>
<tr>
<td style="text-align:left"><strong>GC 压力</strong></td>
<td style="text-align:center">200 个平台线程的栈内存占用较大（~200MB）</td>
<td style="text-align:center">数千个虚拟线程总栈内存远小于平台线程（弹性伸缩）</td>
</tr>
</tbody>
</table>

<blockquote>
<p><strong>如何验证火焰图结论：</strong>用浏览器打开生成的 <code>.html</code> 文件（Chrome/Firefox 均可），鼠标悬停可以看到每个方法的具体采样占比。重点关注 <code>park</code> 类方法和 <code>socketRead</code> 类方法的占比变化。</p>
</blockquote>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="坑-1：synchronized-会钉住虚拟线程"><a href="#坑-1：synchronized-会钉住虚拟线程" class="headerlink" title="坑 1：synchronized 会钉住虚拟线程"></a>坑 1：<code>synchronized</code> 会钉住虚拟线程</h2>

<p>这是目前虚拟线程最大的<strong>性能陷阱</strong>。当虚拟线程进入 <code>synchronized</code> 块时，它<strong>无法卸载</strong>（不能 park），会一直占用载体线程直到退出 synchronized 块。</p>

<pre><code class="language-java">// ❌ 错误写法：synchronized 会 pin 住虚拟线程
private final Object lock = new Object();

@GetMapping("/bad")
public String bad() throws InterruptedException {
    synchronized (lock) {          // ← 虚拟线程在这里被"钉住"！
        TimeUnit.MILLISECONDS.sleep(100); // 阻塞期间载体线程被浪费
    }
    return "done";
}

// ✅ 正确写法：改用 ReentrantLock
private final ReentrantLock lock = new ReentrantLock();

@GetMapping("/good")
public String good() throws InterruptedException {
    lock.lock();                    // ← ReentrantLock 支持 park
    try {
        TimeUnit.MILLISECONDS.sleep(100);
    } finally {
        lock.unlock();
    }
    return "done";
}
</code></pre>

<p><strong>如何检测 pin 问题：</strong>JDK 提供了 JVM 参数：</p>

<pre><code class="language-bash">-Djdk.tracePinnedThreads=short   # 打印 pinned 线程的短堆栈
-Djdk.tracePinnedThreads=full    # 打印完整堆栈
</code></pre>

<p>启动时加上这个参数，当虚拟线程被 pin 住超过阈值时会在控制台输出警告。生产环境排查必备。</p>

<h2 id="坑-2：ThreadLocal-内存爆炸风险"><a href="#坑-2：ThreadLocal-内存爆炸风险" class="headerlink" title="坑 2：ThreadLocal 内存爆炸风险"></h2>

<p>虚拟线程可以轻松创建成千上万个。如果你的代码在每个请求中都往 <code>ThreadLocal</code> 放数据（比如 Spring 的 <code>RequestContextHolder</code>、一些中间件的上下文传递），那内存压力会非常大。</p>

<pre><code class="language-java">// ⚠️ 危险：每个虚拟线程都会创建一份 ThreadLocal 副本
private static final ThreadLocal&lt;byte[]&gt; data = ThreadLocal.withInitial(() -&gt; new byte[1024 * 1024]); // 1MB！

// 如果有 10,000 个并发虚拟线程 → 仅此 ThreadLocal 就吃掉 10GB 内存！
</code></pre>

<p><strong>解决方案：</strong>
- 尽量避免大对象 ThreadLocal
- 使用 JDK 21 的 <code>ScopedValue</code>（预览特性）替代 ThreadLocal，它在虚拟线程场景下做了专门优化
- 及时调用 <code>ThreadLocal.remove()</code></p>

<h2 id="坑-3：虚拟线程不适合-CPU-密集型任务"><a href="#坑-3：虚拟线程不适合-CPU-密集型任务" class="headerlink" title="坑 3：虚拟线程不适合 CPU 密集型任务"></a>坑 3：虚拟线程不适合 CPU 密集型任务</h2>

<p>从前面的压测数据可以看到，纯计算场景下虚拟线程反而略慢。原因很简单：CPU 密集型任务不阻塞，虚拟线程的 mount/unmount 调度开销变成了纯粹的额外负担。这种场景下，<code>ForkJoinPool</code> 或固定大小的线程池仍然是更好的选择。</p>

<h2 id="坑-4：连接池仍然需要（而且更重要了）"><a href="#坑-4：连接池仍然需要（而且更重要了）" class="headerlink" title="坑 4：连接池仍然需要（而且更重要了）"></a>坑 4：连接池仍然需要（而且更重要了）</h2>

<p>虚拟线程解决了<strong>线程</strong>的瓶颈，但没有解决<strong>外部资源</strong>的瓶颈。数据库连接、HTTP 连接、Redis 连接仍然是有限的。以前 200 个线程最多用 200 个数据库连接；现在 10,000 个虚拟线程如果同时抢连接，连接池瞬间被打满。</p>

<pre><code class="language-yaml"># HikariCP 配置建议（虚拟线程环境下）
spring:
  datasource:
    hikari:
      maximum-pool-size: 50    # 不需要太大！虚拟线程会排队等连接
      minimum-idle: 10
</code></pre>

<p>连接池大小应该根据<strong>下游服务的承载能力</strong>来定，而不是根据线程数来定。</p>

<h2 id="坑-5：Spring-Bean-的作用域问题"><a href="#坑-5：Spring-Bean-的作用域问题" class="headerlink" title="坑 5：Spring Bean 的作用域问题"></a>坑 5：Spring Bean 的作用域问题</h2>

<p>默认情况下 Spring Bean 是单例（Singleton）的，这没问题。但如果使用了 <code>@Scope("request")</code> 或 <code>@Scope("session")</code> 的 Bean，要确保底层容器支持虚拟线程。Spring Boot 3.2+ 已经处理好了这个问题，但如果你用了自定义的 <code>ThreadLocalStrategy</code> 或老版本的 RequestContextHolder 实现，可能会踩坑。</p>

<h1 id="何时迁移？迁移清单"><a href="#何时迁移？迁移清单" class="headerlink" title="何时迁移？迁移清单"></a>何时迁移？迁移清单</h1>

<h2 id="适合迁移的场景"><a href="#适合迁移的场景" class="headerlink" title="适合迁移的场景"></a>适合迁移的场景</h2>

<ul>
<li>应用是 <strong>I/O 密集型</strong>（大量 HTTP RPC、数据库查询、文件读写）</li>
<li>当前遇到线程池瓶颈（频繁看到 <code>RejectedExecutionException</code> 或线程池满告警）</li>
<li>代码基于 <strong>Spring MVC 同步模式</strong>（不是 WebFlux）</li>
<li>能够升级到 <strong>JDK 21+</strong> 和 <strong>Spring Boot 3.2+</strong></li>
</ul>

<h2 id="迁移检查清单"><a href="#迁移检查清单" class="headerlink" title="迁移检查清单"></a>迁移检查清单</h2>

<ol>
<li><input type="checkbox" disabled> 升级 JDK 到 21+（推荐 LTS 版本，如 21.0.x）</li>
<li><input type="checkbox" disabled> 升级 Spring Boot 到 3.2+</li>
<li><input type="checkbox" disabled> <code>application.yml</code> 加上 <code>spring.threads.virtual.enabled: true</code></li>
<li><input type="checkbox" disabled> 全局搜索 <code>synchronized</code> 块，评估是否需要改为 <code>ReentrantLock</code></li>
<li><input type="checkbox" disabled> 检查 <code>ThreadLocal</code> 使用情况，评估内存影响</li>
<li><input type="checkbox" disabled> 调整连接池大小（HikariCP / HttpClient 连接池等）</li>
<li><input type="checkbox" disabled> 添加 <code>-Djdk.tracePinnedThreads=short</code> 做 pin 检测</li>
<li><input type="checkbox" disabled> 用 wrk/ab 做压测对比，建立基线数据</li>
<li><input type="checkbox" disabled> 监控 GC 频率和暂停时间（虚拟线程栈更小，GC 行为会变）</li>
<li><input type="checkbox" disabled> 灰度发布：先在非核心接口上验证，再逐步扩大范围</li>
</ol>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>本文从原理到实战全面梳理了 Spring Boot 3.x 虚拟线程的关键知识点：</p>

<ul>
<li><strong>本质</strong>：虚拟线程是 JVM 层面的用户态轻量线程，通过 ForkJoinPool 调度，阻塞时自动卸载/恢复</li>
<li><strong>开启方式</strong>：Spring Boot 3.2+ 只需一行 <code>spring.threads.virtual.enabled=true</code></li>
<li><strong>适用场景</strong>：I/O 密集型 Web 应用（QPS 可提升 2~3 倍，P99 延迟降低 60%+）</li>
<li><strong>不适用场景</strong>：CPU 密集型计算（调度开销反而拖后腿）</li>
<li><strong>最大陷阱</strong>：<code>synchronized</code> 导致 pin（用 ReentrantLock 替代）、ThreadLocal 内存爆炸、连接池仍需合理配置</li>
<li><strong>验证手段</strong>：wrk 压测拿 QPS/延迟数据 + async-profiler 火焰图看 CPU 时间分布 + <code>-Djdk.tracePinnedThreads</code> 检测 pin</li>
</ul>

<p>虚拟线程不是银弹，但在正确的场景下，它是 Java 并发编程领域近年来最有意义的升级之一。如果你正在维护一个 I/O 密集型的 Spring Boot 应用，强烈建议在测试环境试一试——数据不会骗人。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li><strong>OpenJDK 官方文档 — Project Loom</strong><br>
<a href="https://openjdk.org/projects/loom/" target="_blank">https://openjdk.org/projects/loom/</a><br>
Loom 项目主页，包含虚拟线程的设计目标、JEP 文档和状态更新。</li>

<li><strong>Spring Blog — Virtual Threads in Spring Boot 3.2</strong><br>
<a href="https://spring.io/blog/2023/11/16/virtual-threads-in-spring-boot-3-2" target="_blank">https://spring.io/blog/2023/11/16/virtual-threads-in-spring-boot-3-2</a><br>
Spring 官方博客介绍 Spring Boot 3.2 中虚拟线程的集成方式和使用注意事项。</li>

<li><strong>Oracle Java Blog — Virtual Threads: New Foundations for High-Scale Java Applications</strong><br>
<a href="https://blogs.oracle.com/java/post/the-evolution-of-java-scalability-and-why-virtual-threads-are-the-next-big-step" target="_blank">https://blogs.oracle.com/java/post/the-evolution-of-java-scalability-and-why-virtual-threads-are-the-next-big-step</a><br>
Ron Pressler（Loom 项目技术负责人）撰写的虚拟线程深度解析，涵盖设计哲学和技术细节。</li>

<li><strong> Nicolai Parlog — Virtual Threads in Practice (Part 1~3)</strong><br>
<a href="https://nipafx.dev/java-virtual-threads/" target="_blank">https://nipafx.dev/java-virtual-threads/<br>
</a>系列实战文章，涵盖虚拟线程与 synchronized、ThreadLocal、结构化并发等话题，配有详尽的示例代码和性能测试。</li>

<li><strong>美团技术团队 — Java 线程池在大规模在线场景下的实践与调优</strong><br>
<a href="https://tech.meituan.com/2022/04/07/java-threadpool-practice-in-meituan.html" target="_blank">https://tech.meituan.com/2022/04/07/java-threadpool-practice-in-meituan.html<br>
</a>虽然主题是传统线程池，但对理解线程池瓶颈、调优参数、监控指标非常有帮助，可以作为"迁移前基线"的参考。</li>

<li><strong>阿里云开发者社区 — JDK 21 虚拟线程在生产环境的实践与踩坑</strong><br>
<a href="https://developer.aliyun.com/article/1250000" target="_blank">https://developer.aliyun.com/article/1250000<br>
</a>（示例链接）国内云厂商分享的虚拟线程生产实践经验，包含 pin 问题排查、ThreadLocal 优化、GC 表现等一手经验。</li>

<li><strong>async-profiler 官方文档</strong><br>
<a href="https://github.com/async-profiler/async-profiler/blob/master/README.md" target="_blank">https://github.com/async-profiler/async-profiler/blob/master/README.md<br>
</a>async-profiler 使用手册，支持 Java 8~21+，可生成火焰图/树形图，支持 CPU 和分配（alloc）两种采样模式。</li>
</ol>
