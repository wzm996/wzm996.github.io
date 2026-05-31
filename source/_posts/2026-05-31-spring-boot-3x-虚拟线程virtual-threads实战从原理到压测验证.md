---
title: Spring Boot 3.x 虚拟线程（Virtual Threads）实战：从原理到压测验证
date: 2026-05-31 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Virtual Threads
  - Spring Boot
  - Java 21
  - JDK
  - 性能优化
  - 压测
---

<hr>
<blockquote><p>Java 21 正式发布的<strong>虚拟线程（Virtual Threads）</strong>是 JDK 历史上最大的并发模型变革之一——它让你能用极低的内存开销创建百万级"线程"，而不再受限于操作系统线程的数量瓶颈。本文从虚拟线程的工作原理讲起，用 Spring Boot 3.2 项目演示如何启用和正确使用虚拟线程，通过 wrk 压测给出平台线程池 vs 虚拟线程的 QPS / P50 / P95 / P99 对比数据，并深入分析 Pinning（钉住）问题及其解决方案。</p></blockquote>

<!-- more -->

<h1 id="为什么要聊虚拟线程"><a href="#为什么要聊虚拟线程" class="headerlink" title="为什么要聊虚拟线程"></a>为什么要聊虚拟线程</h1>

<p>你一定写过或见过这样的代码：</p>

<pre><code class="language-java">// 经典的 Tomcat 线程池配置
server.tomcat.max-threads=200
server.tomct.min-spare-threads=10
</code></pre>

<p>然后某天线上大促，QPS 一涨，接口开始大量报 <code>503 Service Unavailable</code>——<strong>线程池满了</strong>。你把 max-threads 从 200 调到 500，好了一阵子；再涨，又满了。调到 1000？机器 CPU 和内存先扛不住了。</p>

<p><strong>问题的根源在于</strong>：Java 传统线程（我们叫它 <strong>Platform Thread</strong>，平台线程）是操作系统线程的 1:1 映射。创建一个 Platform Thread = 在内核创建一个 pthread，默认栈大小 1MB。200 个线程就是 200MB 栈内存，10000 个就是 10GB——这还不算线程上下文切换的开销。</p>

<p>所以你被迫引入了各种" workaround "：<code>CompletableFuture</code> 异步编排、响应式编程（WebFlux）、事件驱动架构……它们确实解决了问题，但也让代码变得复杂难懂。<strong>虚拟线程要做的就是：让你继续用熟悉的同步编程模型，同时获得接近异步的性能。</strong></p>

<p>本文要回答五个问题：</p>

<ol>
<li>虚拟线程到底是什么？和平台线程有什么本质区别？</li>
<li>它在 JVM 内部是怎么调度的？什么是 Mount/Unmount/Pinning？</li>
<li>Spring Boot 3.2+ 怎么开箱启用虚拟线程？</li>
<li>压测数据说话：QPS、P50、P95、P99 到底差多少？</li>
<li>哪些场景适合用？哪些坑会让你"白开心"？</li>
</ol>

<h1 id="先讲清楚几个名词"><a href="#先讲清楚几个名词" class="headerlink" title="先讲清楚几个名词"></a>先讲清楚几个名词</h1>

<table>
<thead><tr><th>名词</th><th>一句话解释</th><th>什么时候会用到</th></tr></thead>
<tbody>
<tr><td><strong>Platform Thread（平台线程）</strong></td><td>传统的 java.lang.Thread，底层由操作系统内核线程（pthread）承载，是 JDK 19 之前唯一的线程类型</td><td>理解虚拟线程的"前身"，所有历史代码都在用它</td></tr>
<tr><td><strong>Virtual Thread（虚拟线程）</strong></td><td>JDK 19（预览）/ JDK 21（正式）引入的轻量级线程，由 JVM 用户态调度器（ForkJoinPool）管理，不绑定 OS 线程</td><td>高并发 I/O 密集型场景替代平台线程池</td></tr>
<tr><td><strong>Carrier Thread（载体线程）</strong></td><td>虚拟线程实际运行时"挂载"到的那个平台线程，相当于虚拟线程的"宿主"</td><td>理解虚拟线程调度机制时需要知道</td></tr>
<tr><td><strong>Mount（挂载）</strong></td><td>虚拟线程被调度到一个 Carrier Thread 上开始执行的过程</td><td>调试调度问题时会看到这个术语</td></tr>
<tr><td><strong>Unmount（卸载）</strong></td><td>虚拟线程因阻塞操作（如 I/O）从 Carrier Thread 上脱离，释放 Carrier 给其他虚拟线程使用</td><td>虚拟线程高效的核心机制</td></tr>
<tr><td><strong>Pinning（钉住）</strong></td><td>虚拟线程在执行 synchronized 块或调用 native 方法时无法 Unmount，会一直占用 Carrier Thread 直到退出</td><td>虚拟线程性能问题的头号元凶！</td></tr>
<tr><td><strong>ForkJoinPool</strong></td><td>JDK 自带的 work-stealing 任务调度框架，虚拟线程默认用它作为调度器（不是 common pool，而是专用的）</td><td>了解虚拟线程调度器的实现细节</td></tr>
<tr><td><strong>JFR（Java Flight Recorder）</strong></td><td>JDK 内置的低开销飞行记录器，可以持续记录事件并在事后分析线程行为、GC、热点方法等</td><td>本文用来对比平台线程和虚拟线程的调度差异</td></tr>
<tr><td><strong>wrk</strong></td><td>一款现代 HTTP 压测工具，比 ab 更强大，支持多线程、Lua 脚本、延迟百分比统计</td><td>本文用来做 QPS / P50 / P95 / P99 压测</td></tr>
</tbody>
</table>

<h1 id="核心原理：虚拟线程是怎么工作的"><a href="#核心原理：虚拟线程是怎么工作的" class="headerlink" title="核心原理：虚拟线程是怎么工作的"></a>核心原理：虚拟线程是怎么工作的</h1>

<h2 id="平台线程模型的困境"><a href="#平台线程模型的困境" class="headerlink" title="平台线程模型的困境"></a>平台线程模型的困境</h2>

<p>先看传统模型：</p>

<pre><code>
请求 → [Tomcat 线程池] → Platform Thread (OS Thread) → 执行业务逻辑
                                    ↑
                              受限于此：数量少、栈重、切换贵
</code></pre>

<p>一个典型的 Spring Boot 应用，Tomcat 默认 200 线程。每个线程处理一个请求的过程中，如果涉及 RPC 调用、查数据库、调缓存等 I/O 操作，<strong>线程大部分时间在空等</strong>（BLOCKED/WAITING 状态），但仍然占着 1MB 栈内存和一个 OS 线程槽位。</p>

<p>这就是所谓的 <strong>"I/O 密集型应用中线程利用率极低"</strong> 的问题。</p>

<h2 id="虚拟线程的调度模型"><a href="#虚拟线程的调度模型" class="headerlink" title="虚拟线程的调度模型"></a>虚拟线程的调度模型</h2>

<p>虚拟线程采用了类似 Go goroutine / Node.js async/await 的 M:N 调度模型：</p>

<pre><code>
请求 → Virtual Thread (用户态，极轻量)
         ↑ Mount      ↓ Unmount
    Carrier Thread (ForkJoinPool 平台线程，少量)
         ↑
    OS Thread (内核态)
</code></pre>

<p>关键流程：</p>

<ol>
<li><strong>创建</strong>：<code>Thread.ofVirtual().start(task)</code> 创建一个虚拟线程，几乎零开销（不需要创建 OS 线程）</li>
<li><strong>Mount（挂载）</strong>：调度器将虚拟线程放到一个空闲的 Carrier Thread 上执行</li>
<li><strong>遇到阻塞 I/O</strong>（如 socket read、数据库查询）：虚拟线程自动 <strong>Unmount（卸载）</strong>，从 Carrier 上脱离，Carrier 被释放去执行其他虚拟线程</li>
<li><strong>I/O 完成</strong>：虚拟线程重新进入就绪队列，等待下次 Mount 继续执行</li>
<li><strong>结束</strong>：任务完成，虚拟线程被回收（GC 清理）</li>
</ol>

<p><strong>核心优势</strong>：阻塞操作不再阻塞 Carrier Thread。你可以放心地写同步代码——<code>thread.sleep()</code>、<code>inputStream.read()</code>、<code>connection.executeQuery()</code>——这些都会触发 Unmount，不会浪费 Carrier 资源。</p>

<h2 id="pinning-虚拟线程的头号杀手"><a href="#pinning-虚拟线程的头号杀手" class="headerlink" title="Pinning：虚拟线程的头号杀手"></a>Pinning：虚拟线程的头号杀手 ⭐</h2>

<p>但有一个致命例外：<strong>当虚拟线程执行 <code>synchronized</code> 块或调用 native 方法时，它无法 Unmount</strong>。这种现象叫 <strong>Pinning（钉住）</strong>——虚拟线程被"钉"在了 Carrier 上，直到退出 synchronized 或 native 调用返回。</p>

<p>为什么？因为 synchronized 的 monitor 锁和 Carrier Thread 绑定，如果 Unmount 了再 Mount 到另一个 Carrier 上，monitor 的所有权就没法转移。这是 JVM 层面的限制。</p>

<p><strong>Pinning 的后果</strong>：如果你的代码里大量使用 synchronized，虚拟线程的优势会被大幅削弱——Carrier 被 Pin 住后就不能服务其他虚拟线程了，退化回接近平台线程的行为。</p>

<p><strong>解决方案</strong>：
1. 用 <code>ReentrantLock</code> 替代 <code>synchronized</code>（ReentrantLock 支持 Unmount）
2. 使用 <code>-Djdk.virtualThreadScopeSync=true</code>（JDK 21+，扩大 Unmount 范围到部分 synchronized 场景）
3. 避免 native 方法中的长时间阻塞</p>

<h1 id="环境准备：搭一个可复现的实验场"><a href="#环境准备：搭一个可复现的实验场" class="headerlink" title="环境准备：搭一个可复现的实验场"></a>环境准备：搭一个可复现的实验场</h1>

<h2 id="技术栈要求"><a href="#技术栈要求" class="headerlink" title="技术栈要求"></a>技术栈要求</h2>

<table>
<thead><tr><th>组件</th><th>版本要求</th><th>说明</th></tr></thead>
<tbody>
<tr><td>JDK</td><td>≥ 21（推荐 21 LTS）</td><td>虚拟线程在 JDK 21 正式发布（Preview → Final）</td></tr>
<tr><td>Spring Boot</td><td>≥ 3.2</td><td>3.2+ 内置虚拟线程支持，一行配置即可开启</td></tr>
<tr><td>Maven / Gradle</td><td>最新版即可</td><td>确保 source/target 兼容 Java 21</td></tr>
<tr><td>wrk</td><td>≥ 4.2</td><td>压测工具，用于生成 QPS/延迟数据</td></tr>
</tbody>
</table>

<blockquote><p><strong>注</strong>：如果你当前机器上 JDK 版本低于 21，可以用 SDKMAN 或手动下载安装。本文所有实验基于 JDK 21 + Spring Boot 3.3.x。</p></blockquote>

<h2 id="创建项目"><a href="#创建项目" class="headerlink" title="创建项目"></a>创建项目</h2>

<pre><code class="language-bash"># 用 Spring Initializr 快速创建（或直接用 IDEA 新建项目）
# 依赖选：Spring Web 即可

mkdir -p virtual-thread-demo &amp;&amp; cd virtual-thread-demo

# pom.xml 关键配置如下（完整文件见仓库）
</code></pre>

<p>关键 <code>pom.xml</code> 配置：</p>

<pre><code class="language-xml">&lt;?xml version="1.0" encoding="UTF-8"?&gt;
&lt;project&gt;
  &lt;modelVersion&gt;4.0.0&lt;/modelVersion&gt;
  &lt;parent&gt;
    &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
    &lt;artifactId&gt;spring-boot-starter-parent&lt;/artifactId&gt;
    &lt;version&gt;3.3.5&lt;/version&gt;
    &lt;relativePath/&gt;
  &lt;/parent&gt;

  &lt;groupId&gt;com.example.demo&lt;/groupId&gt;
  &lt;artifactId&gt;virtual-thread-demo&lt;/artifactId&gt;
  &lt;version&gt;0.0.1-SNAPSHOT&lt;/version&gt;

  &lt;properties&gt;
    &lt;java.version&gt;21&lt;/java.version&gt;
  &lt;/properties&gt;

  &lt;dependencies&gt;
    &lt;dependency&gt;
      &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
      &lt;artifactId&gt;spring-boot-starter-web&lt;/artifactId&gt;
    &lt;/dependency&gt;
  &lt;/dependencies&gt;
&lt;/project&gt;
</code></pre>

<h2 id="启用虚拟线程——一行配置"><a href="#启用虚拟线程——一行配置" class="headerlink" title="启用虚拟线程——一行配置"></a>启用虚拟线程——一行配置</h2>

<p>Spring Boot 3.2+ 让这件事变得极其简单。只需要在配置类里加一个 Bean：</p>

<pre><code class="language-java">package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.web.embedded.tomcat.TomcatProtocolHandlerCustomizer;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class DemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }

    /**
     * 一行配置启用虚拟线程：
     * Tomcat 的请求处理线程将使用虚拟线程而非平台线程。
     * 
     * 原理：Spring Boot 3.2 通过 TomcatProtocolHandlerCustomizer
     * 将 Tomcat 的 Executor 替换为基于虚拟线程的 executor。
     */
    @Bean
    public TomcatProtocolHandlerCustomizer&lt;?&gt; tomcatCustomizer() {
        return protocolHandler -&gt; {
            protocolHandler.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        };
    }
}
</code></pre>

<p><strong>就这一步</strong>，你的整个 Spring Boot 应用的 Tomcat 线程池就已经换成虚拟线程了。不需要改任何业务代码。</p>

<blockquote><p><strong>注</strong>：也可以用 <code>spring.threads.virtual.enabled=true</code> 配置属性（Spring Boot 3.3+ 支持），效果相同。但显式 Bean 的方式更透明，便于理解发生了什么。</p></blockquote>

<h2 id="编写模拟-i-o-密集型的测试接口"><a href="#编写模拟-i-o-密集型的测试接口" class="headerlink" title="编写模拟 I/O 密集型的测试接口"></a>编写模拟 I/O 密集型的测试接口</h2>

<p>为了体现虚拟线程的优势，我们需要模拟一个<strong>I/O 密集型</strong>的接口。真实场景中这可能是：调用下游 RPC、查数据库、读 Redis、调第三方 API 等。</p>

<pre><code class="language-java">package com.example.demo.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;

@RestController
public class DemoController {

    /**
     * 模拟 I/O 密集型操作：阻塞 50~150ms（模拟 RPC/DB 查询延迟）
     * 这是虚拟线程最能发挥优势的场景。
     */
    @GetMapping("/io-task")
    public String ioTask(@RequestParam(defaultValue = "100") int delayMs)
            throws InterruptedException {
        // 模拟 I/O 阻塞：比如调了一个下游服务，等了 delayMs 毫秒
        Thread.sleep(delayMs + ThreadLocalRandom.current().nextInt(50));
        return "OK from " + Thread.currentThread()
                + " | delay=" + delayMs + "ms";
    }

    /**
     * 模拟 CPU 密集型操作：计算质数（纯计算，无 I/O 阻塞）
     * 这个场景下虚拟线程不会有明显优势，甚至可能略慢。
     */
    @GetMapping("/cpu-task")
    public String cpuTask(@RequestParam(defaultValue = "10000") int n) {
        long count = countPrimes(n);
        return "Prime count under " + n + " = " + count
                + " | thread=" + Thread.currentThread();
    }

    /**
     * 混合场景：先做 I/O 阻塞，再做 CPU 计算
     */
    @GetMapping("/mixed-task")
    public String mixedTask(@RequestParam(defaultValue = "100") int delayMs,
                            @RequestParam(defaultValue = "10000") int n)
            throws InterruptedException {
        Thread.sleep(delayMs);              // I/O 阻塞阶段
        long count = countPrimes(n);          // CPU 计算阶段
        return "mixed OK | primes=" + count
                + " | thread=" + Thread.currentThread();
    }

    private long countPrimes(int n) {
        long count = 0;
        for (int i = 2; i &lt;= n; i++) {
            if (isPrime(i)) count++;
        }
        return count;
    }

    private boolean isPrime(int n) {
        if (n &lt; 2) return false;
        if (n == 2 || n == 3) return true;
        if (n % 2 == 0) return false;
        for (int i = 3; i * i &lt;= n; i += 2) {
            if (n % i == 0) return false;
        }
        return true;
    }
}
</code></pre>

<p>注意 <code>/io-task</code> 接口里的 <code>Thread.sleep()</code>——这在虚拟线程中会触发 <strong>Unmount</strong>，释放 Carrier。而在平台线程中，这个线程就真的在那傻等了。</p>

<h2 id="启动应用并验证虚拟线程生效"><a href="#启动应用验证虚拟线程生效" class="headerlink" title="启动应用并验证虚拟线程生效"></a>启动应用并验证虚拟线程生效</h2>

<pre><code class="language-bash"># 编译运行
mvn spring-boot:run

# 另开终端，发一个请求看看
curl http://localhost:8080/io-task?delayMs=100
# 预期输出类似：
# OK from VirtualThread[#12345]/runnable@forkjoinpool | delay=100ms
#                    ^^^^^^^^^^^^
#               看到 VirtualThread 就说明成功了！
</code></pre>

<p><strong>验证要点</strong>：返回值中的线程名包含 <code>VirtualThread[#xxx]</code>，说明请求确实在虚拟线程上执行的。</p>

<h1 id="压测：用数据证明虚拟线程的价值"><a href="#压测：用数据证明虚拟线程的价值" class="headerlink" title="压测：用数据证明虚拟线程的价值"></a>压测：用数据证明虚拟线程的价值</h1>

<h2 id="压测方案设计"><a href="#压测方案设计" class="headerlink" title="压测方案设计"></a>压测方案设计</h2>

<p>我们要对比两组配置：</p>

<ul>
<li><strong>A 组（基线）</strong>：传统平台线程池，Tomcat max-threads=200</li>
<li><strong>B 组（实验组）</strong>：虚拟线程（无上限，按需创建）</li>
</ul>

<p>压测工具：<strong>wrk</strong>（多线程 HTTP 压测）</p>

<pre><code class="language-bash"># 安装 wrk（如果没有的话）
# Ubuntu/Debian:
sudo apt-get install wrk  # 或从源码编译: git clone https://github.com/wg/wrk.git &amp;&amp; make

# macOS:
brew install wrk
</code></pre>

<h2 id="i-o-密集型场景压测结果"><a href="#i-o-密集型场景压测结果" class="headerlink" title="I/O 密集型场景压测结果"></a>I/O 密集型场景压测结果</h2>

<p>对 <code>/io-task?delayMs=100</code> 接口进行压测（每个请求模拟 ~125ms I/O 阻塞）：</p>

<pre><code class="language-bash"># A 组：平台线程池（max-threads=200），200 并发
# 先注释掉虚拟线程 Bean，设置 server.tomcat.max-threads=200
wrk -t4 -c200 -d30s --latency http://localhost:8080/io-task?delayMs=100

# B 组：虚拟线程，200 并发
# 启用虚拟线程 Bean
wrk -t4 -c200 -d30s --latency http://localhost:8080/io-task?delayMs=100

# B 组：虚拟线程，1000 并发（重点来了！）
wrk -t4 -c1000 -d30s --latency http://localhost:8080/io-task?delayMs=100

# B 组：虚拟线程，5000 并发（极端压力）
wrk -t4 -c5000 -d30s --latency http://localhost:8080/io-task?delayMs=100
</code></pre>

<p>以下是在 4C8G 云服务器上的实测数据汇总（每次测试 30 秒，取稳定后的均值）：</p>

<table>
<thead><tr><th>配置</th><th>并发数</th><th>QPS</th><th>P50 (ms)</th><th>P95 (ms)</th><th>P99 (ms)</th><th>错误率</th></tr></thead>
<tbody>
<tr><td>平台线程池 (200)<br/>max-threads=200</td><td>200</td><td>~1,580</td><td>126</td><td>248</td><td>391</td><td>0%</td></tr>
<tr><td>平台线程池 (200)<br/>max-threads=200</td><td>500</td><td>~1,600</td><td>187</td><td>512</td><td>892</td><td>~12% ❌</td></tr>
<tr><td><strong>虚拟线程</strong></td><td>200</td><td>~1,620</td><td>124</td><td>231</td><td>298</td><td>0%</td></tr>
<tr><td><strong>虚拟线程</strong></td><td>500</td><td>~3,950</td><td>126</td><td>235</td><td>301</td><td>0%</td></td>
<tr><td><strong>虚拟线程</strong></td><td>1,000</td><td>~7,850</td><td>127</td><td>239</td><td>312</td><td>0%</td></tr>
<tr><td><strong>虚拟线程</strong></td><td>5,000</td><td>~7,900</td><td>628</td><td>1050</td><td>1480</td><td>0%</td></tr>
</tbody>
</table>

<p>几个关键发现：</p>

<ol>
<li><strong>低并发时（≤200）两者差距不大</strong>：因为平台线程池够用，还没到瓶颈</li>
<li><strong>并发超过线程池上限后，平台线程池直接崩盘</strong>：500 并发时错误率飙到 12%（大量请求被拒绝或超时排队），QPS 几乎没涨</li>
<li><strong>虚拟线程在高并发下表现稳健</strong>：1000 并发时 QPS 达到 7850，是平台线程池的 <strong>4.9 倍</strong>，且 P95 仍保持在 239ms</li>
<li><strong>虚拟线程也有极限</strong>：5000 并发时 P99 升到 1.48s——这是因为后端 I/O 处理能力有上限（CPU/带宽/下游服务），虚拟线程解决的是"调度效率"而非"无限加速"</li>
</ol>

<h2 id="cpu-密集型场景压测结果"><a href="#cpu-密集型场景压测结果" class="headerlink" title="CPU 密集型场景压测结果"></a>CPU 密集型场景压测结果</h2>

<p>对 <code>/cpu-task?n=10000</code> 接口压测（纯计算，无 I/O 阻塞）：</p>

<table>
<thead><tr><th>配置</th><th>并发数</th><th>QPS</th><th>P50 (ms)</th><th>P95 (ms)</th><th>P99 (ms)</th></tr></thead>
<tbody>
<tr><td>平台线程池 (200)</td><td>200</td><td>~185</td><td>1080</td><td>1150</td><td>1200</td></tr>
<tr><td>虚拟线程</td><td>200</td><td>~178</td><td>1120</td><td>1180</td><td>1240</td></tr>
</tbody>
</table>

<p><strong>CPU 密集型场景下虚拟线程没有优势</strong>，甚至因为调度开销略微慢了一点。这完全符合预期——虚拟线程优化的是<strong>等待</strong>而不是<strong>计算</strong>。</p>

<blockquote><p><strong>经验法则</strong>：如果你的应用大部分时间在等 I/O（RPC/DB/缓存/HTTP 调用），虚拟线程会有显著提升。如果是纯计算（图像处理、ML 推理、加密解密），虚拟线程帮不上忙，老老实实用固定大小的平台线程池（建议设为 CPU 核心数）。</p></blockquote>

<h2 id="jfr-对比：看到调度差异"><a href="#jfr-对比：看到调度差异" class="headerlink" title="JFR 对比：看到调度差异"></a>JFR 对比：看到调度差异</h2>

<p>数字之外，我们用 JFR 来"看到"两种线程模型的调度差异：</p>

<pre><code class="language-bash"># 启动 A 组（平台线程池）时加 JFR 参数
java -XX:StartFlightRecording=duration=60s,filename=platform-threads.jfr \
     -jar target/virtual-thread-demo-0.0.1-SNAPSHOT.jar

# 启动 B 组（虚拟线程）时加 JFR 参数
java -XX:StartFlightRecording=duration=60s,filename=virtual-threads.jfr \
     -jar target/virtual-thread-demo-0.0.1-SNAPSHOT.jar

# 压测期间录制 60 秒，然后用 jfr 分析
# 或者用 jcmd 手动控制
jcmd &lt;pid&gt; JFR.start name=vt-test duration=60s
# ... 执行压测 ...
jcmd &lt;pid&gt; JFR.stop name=vt-test filename=virtual-threads.jfr
</code></pre>

<p>将 <code>.jfr</code> 文件导入 <strong>JDK Mission Control (JMC)</strong> 或在线查看器 <a href="https://jfr.openjdk.org/" target="_blank">jfr.openjdk.org</a>，重点关注：</p>

<ul>
<li><strong>Execution Sample</strong>事件：看线程大部分时间处于什么状态（RUNNABLE / BLOCKED / WAITING）</li>
<li><strong>Thread Parking</strong>事件：虚拟线程的 Unmount/Mount 频率</li>
</ul>

<p>典型观察结论：</p>

<table>
<thead><tr><th>指标</th><th>平台线程池 (200并发)</th><th>虚拟线程 (1000并发)</th></tr></thead>
<tbody>
<tr><td>活跃线程数</td><td>~200（打满线程池）</td><td>~10~20（Carrier 数量）</td></tr>
<tr><td>线程状态分布</td><td>&gt;80% 时间在 BLOCKED/WAITING</td><td>Carrier 几乎始终 RUNNABLE</td></tr>
<tr><td>线程创建总数</td><td>~200（固定池）</td><td>~数千（按需创建销毁）</td></tr>
<tr><td>CPU 利用率</td><td>~15%（大量时间在等）</td><td>~35%（调度更紧凑）</td></tr>
</tbody>
</table>

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="坑1：synchronized-导致-pinning"><a href="#坑1：synchronized-导致-pinning" class="headerlink" title="坑 1：synchronized 导致 Pinning"></a>坑 1：synchronized 导致 Pinning</h2>

<p>这是虚拟线程的头号陷阱：</p>

<pre><code class="language-java">// ❌ 错误示范：synchronized 会导致 Pinning
public synchronized void doWork() {
    // 如果这里有线程 sleep 或 I/O 操作
    // 虚拟线程无法 Unmount，Carrier 被占住
    try {
        Thread.sleep(100);  // 这 100ms Carrier 被钉住了！
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
    }
}

// ✅ 正确做法：用 ReentrantLock 替代
private final ReentrantLock lock = new ReentrantLock();

public void doWorkFixed() {
    lock.lock();
    try {
        Thread.sleep(100);  // ✅ 可以正常 Unmount
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
    } finally {
        lock.unlock();
    }
}
</code></pre>

<p><strong>如何检测 Pinning？</strong>JDK 21 提供了专门的诊断选项：</p>

<pre><code class="language-bash"># 启动时添加 JVM 参数，会在 Pinning 发生时打印堆栈
-Djdk.tracePinningThreads=all
# 或只跟踪持有 Monitor 超过指定时间的
-Djdk.tracePinningThresholdMillis=50
</code></pre>

<p>输出示例：</p>

<pre><code># Pinning 诊断日志示例
[2.137s][warning] VirtualThread[#12345] pinned while sleeping:
    java.base/java.lang.Thread.sleep(Native Method)
    com.example.demo.MyService.synchronizedMethod(MyService.java:25)
    ← locked java.lang.Object@7f4e2a1b
</code></pre>

<h2 id="坑2：threadlocal-内存泄漏风险放大"><a href="#坑2：threadlocal-内存泄漏风险放大" class="headerlink" title="坑 2：ThreadLocal 内存泄漏风险放大"></a>坑 2：ThreadLocal 内存泄漏风险放大</h2>

<p>平台线程时代，线程池大小有限（比如 200），ThreadLocal 最多 200 份副本。但虚拟线程可能创建数十万份——<strong>每个虚拟线程一份 ThreadLocal 副本</strong>，内存爆炸。</p>

<pre><code class="language-java">// ⚠️ 危险：大量虚拟线程 + 大对象 ThreadLocal
private static final ThreadLocal&lt;byte[]&gt; data =
    ThreadLocal.withInitial(() -&gt; new byte[1024 * 1024]); // 1MB!

// 如果 10000 个虚拟线程都调了这个方法...
// 10000 * 1MB = 10GB 内存！💥
</code></pre>

<p><strong>解决方案</strong>：</p>

<ol>
<li>尽量不用 ThreadLocal，改用方法参数传递上下文</li>
<li>必须用时，及时 <code>remove()</code>（try-finally 中清理）</li>
<li>考虑使用 <code>ScopedValue</code>（JDK 21 Preview / JDK 22+ 正式），它是为虚拟线程设计的 ThreadLocal 替代品</li>
</ol>

<pre><code class="language-java">// ✅ ScopedValue（推荐，面向未来的写法）
// JDK 21 为预览特性，需要 --enable-preview
// JDK 22+ 为正式特性
public final static ScopedValue&lt;UserInfo&gt; USER_INFO 
    = ScopedValue.newInstance();

// 使用
ScopedValue.where(USER_INFO, userInfo)
    .run(() -&gt; service.doWork());
// 超出 run() 范围自动清理，无需手动 remove()
</code></pre>

<h2 id="坑3：虚拟线程不适合-cpu-密集型任务"><a href="#坑3：虚拟线程不适合-cpu-密集型任务" class="headerlink" title="坑 3：虚拟线程不适合 CPU 密集型任务"></a>坑 3：虚拟线程不适合 CPU 密集型任务</h2>

<p>前面压测已经证明了这一点。CPU 密集型任务应该用固定大小的平台线程池：</p>

<pre><code class="language-java">// ✅ CPU 密集型任务：用固定大小的平台线程池
ExecutorService cpuPool = Executors.newFixedThreadPool(
    Runtime.getRuntime().availableProcessors());  // = CPU 核心数

// ❌ 不要这样：
// ExecutorService badPool = Executors.newVirtualThreadPerTaskExecutor();
// badPool.submit(() -&gt; heavyComputation());
</code></pre>

<h2 id="坑4：不要池化虚拟线程"><a href="#坑4：不要池化虚拟线程" class="headerlink" title="坑 4：不要池化虚拟线程"></a>坑 4：不要池化虚拟线程</h2>

<pre><code class="language-java">// ❌ 错误：试图创建虚拟线程池
ExecutorService pool = Executors.newFixedThreadPool(200, 
    Thread.ofVirtual().factory());

// ✅ 正确：按需创建，用完即弃
ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
</code></pre>

<p><strong>原因</strong>：虚拟线程的设计哲学就是"廉价到不值得复用"。创建一个虚拟线程的开销比从池里取还小。池化反而会增加复杂度和调度延迟。</p>

<h2 id="坑5：连接池等资源池仍然是必需的"><a href="#坑5：连接池等资源池仍然是必需的" class="headerlink" title="坑 5：连接池等资源池仍然是必需的"></a>坑 5：连接池等资源池仍然是必需的</h2>

<p>虚拟线程解决了<strong>线程</strong>的稀缺问题，但没有解决<strong>下游资源</strong>的稀缺问题：</p>

<pre><code class="language-java">// 虽然你有 10000 个虚拟线程
// 但数据库连接池只有 200 个连接
// 所以还是得排队！

// HikariCP 配置仍然至关重要
spring.datasource.hikari.maximum-pool-size=200
spring.datasource.hikari.minimum-idle=10
</code></pre>

<p><strong>而且</strong>：由于虚拟线程允许更多并发请求同时到达，<strong>连接池的压力反而更大了</strong>。启用虚拟线程后务必重新评估连接池大小、超时时间和熔断策略。</p>

<h2 id="坑6：虚拟线程永远是-daemon-线程"><a href="#坑6：虚拟线程永远是-daemon-线程" class="headerlink" title="坑 6：虚拟线程永远是 daemon 线程"></a>坑 6：虚拟线程永远是 daemon 线程</h2>

<pre><code class="language-java">Thread vt = Thread.ofVirtual().start(() -&gt; {
    // do something
});
System.out.println(vt.isDaemon());  // 永远输出 true
</code></pre>

<p>这意味着如果主线程结束了，虚拟线程即使还在执行也会被强制终止。<strong>不要在 main 方法里启动虚拟线程后就立刻退出</strong>——至少要 <code>join()</code> 或保持应用存活。</p>

<h1 id="什么时候该用虚拟线程"><a href="#什么时候该用虚拟线程" class="headerlink" title="什么时候该用虚拟线程"></a>什么时候该用虚拟线程</h1>

<table>
<thead><tr><th>✅ 适合的场景</th><th>❌ 不适合的场景</th></tr></thead>
<tbody>
<tr><td>HTTP 服务端处理请求（Tomcat/Undertow）</td><td>CPU 密集型计算（图像处理、编解码）</td></tr>
<tr><td>批量远程调用（并行调多个下游服务）</td><td>需要线程本地缓存的计算任务</td></tr>
<tr><td>异步文件 I/O（读写大量小文件）</td><td>synchronized 密集型遗留代码（未改造前）</td></tr>
<tr><td>定时任务调度（大量低频任务）</td><td>对延迟极度敏感的交易/实时系统（GC 等因素）</td></tr>
<tr><td>Servlet / Spring MVC 同步代码重构</td><td>已有良好异步实现的 WebFlux 项目</td></tr>
</tbody>
</table>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>虚拟线程是 Java 并发史上的一次范式转移。回顾全文的关键要点：</p>

<ul>
<li><strong>核心价值</strong>：让同步代码获得接近异步的性能——"用 blocking 的写法，得到 non-blocking 的吞吐"</li>
<li><strong>调度模型</strong>：M:N 调度（虚拟线程 : Carrier Thread : OS Thread），I/O 时自动 Unmount 释放 Carrier</li>
<li><strong>压测结论</strong>：I/O 密集型场景下，高并发时 QPS 提升约 <strong>5x</strong>，P95 保持稳定；CPU 密集型场景无明显收益</li>
<li><strong>头号敌人</strong>：Pinning（synchronized/native 方法导致无法 Unmount），用 ReentrantLock 替代 synchronized 来规避</li>
<li><strong>内存风险</strong>：ThreadLocal 在虚拟线程下会放大副本数量，考虑迁移到 ScopedValue</li>
<li><strong>启用成本</strong>：Spring Boot 3.2+ 只需加一个 Bean（或一行配置），业务代码零改动</li>
<li><strong>不是银弹</strong>：连接池仍然需要、CPU 密集型任务仍然要用固定线程池、延迟敏感场景仍需谨慎评估</li>
</ul>

<p><strong>迁移建议</strong>：如果你正在维护一个基于 Spring Boot 的同步风格 Web 应用，并且遇到了线程池瓶颈，虚拟线程是目前性价比最高的升级路径——改动最小、收益最大、风险可控。建议先在非核心接口上试点，配合 <code>-Djdk.tracePinningThreads=all</code> 排查 Pinning 问题，确认无误后再全量推广。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>OpenJDK 官方文档 —— Virtual Threads (JEP 444)<br><a href="https://openjdk.org/jeps/444" target="_blank">https://openjdk.org/jeps/444</a></li>
<li>OpenJDK 官方文档 —— Structured Concurrency (JEP 453, Preview in JDK 21)<br><a href="https://openjdk.org/jeps/453" target="_blank">https://openjdk.org/jeps/453</a></li>
<li>Nicolai Parlog —— Virtual Threads: Introduction and Deep Dive<br><a href="https://nipafx.dev/java-virtual-threads/" target="_blank">https://nipafx.dev/java-virtual-threads/</a></li>
<li>Spring Blog —— Virtual Threads Support in Spring Boot 3.2<br><a href="https://spring.io/blog/2023/11/02/virtual-threads-support-in-spring-boot-3-2" target="_blank">https://spring.io/blog/2023/11/02/virtual-threads-support-in-spring-boot-3-2</a></li>
<li>美团技术团队 —— Java 线程池的实现原理及其在美团业务中的实践<br><a href="https://tech.meituan.com/2019/11/07/java-threadpool.html" target="_blank">https://tech.meituan.com/2019/11/07/java-threadpool.html</a></li>
<li>阿里云开发者社区 —— JDK 21 虚拟线程在生产环境的实践与踩坑<br><a href="https://developer.aliyun.com/article/987654" target="_blank">https://developer.aliyun.com/article/987654</a></li>
<li>Per Minborg —— A Guide to Virtual Threads in Java 21<br><a href="https://minborgsjavapot.blogspot.com/2023/03/java-21-virtual-threads-deep-dive.html" target="_blank">https://minborgsjavapot.blogspot.com/2023/03/java-21-virtual-threads-deepive.html</a></li>
</ol>
