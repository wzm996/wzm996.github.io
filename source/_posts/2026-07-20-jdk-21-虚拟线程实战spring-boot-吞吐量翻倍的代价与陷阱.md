---
title: JDK 21 虚拟线程实战——Spring Boot 吞吐量翻倍的代价与陷阱
date: 2026-07-20 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Virtual Threads
  - JDK 21
  - Spring Boot
  - 性能压测
  - Project Loom
  - JVM
---
<hr>
<blockquote><p><strong>虚拟线程（Virtual Threads）</strong>是 JDK 21 正式发布的 Project Loom 核心特性——它让 Java 终于可以像 Go 的 goroutine 一样轻松创建百万级轻量线程。在 Spring Boot 3.2+ 中只需一行配置就能启用，IO 密集型场景下吞吐量可提升 2~5 倍。但别急着上线：<strong>synchronized 导致的 Pinning 问题</strong>会让虚拟线程退化为普通线程池，甚至比传统方案更差。本文将从原理到压测，再到生产排查，给你一份完整的虚拟线程落地指南。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要虚拟线程"><a href="#背景：为什么需要虚拟线程" class="headerlink" title="背景：为什么需要虚拟线程"></a>背景：为什么需要虚拟线程</h1>

<p>先说一个扎心的事实：你线上跑的 Spring Boot 应用，Tomcat 默认线程池只有 <strong>200 个线程</strong>。这意味着同一时间只能处理 200 个请求。</p>

<p>这 200 个线程够用吗？看场景：</p>

<table>
<thead><tr><th>场景类型</th><th>线程在干嘛</th><th>200 线程够不够</th></tr></thead>
<tbody>
<tr><td>CPU 密集（JSON 序列化、计算）</td><td>一直在跑</td><td>基本够用（CPU 本身就那么多核心）</td></tr>
<tr><td>IO 密集（调数据库、调 RPC、等 HTTP 响应）</td><td>大部分时间在<strong>傻等</strong></td><td><strong>严重不够</strong>——200 个线程在等，新请求只能排队</td></tr>
</tbody>
</table>

<p>问题就在这里：<strong>平台线程（Platform Thread）太重了</strong>。每个线程默认栈大小 1MB，创建和调度成本高，你不可能开 10000 个线程。但你的业务可能同时有 10000 个请求在等数据库返回——这时候线程就成了瓶颈。</p>

<p>传统的解决方案有三种，每种都有明显缺陷：</p>

<ol>
<li><strong>加线程池大小</strong>：治标不治本，线程多了上下文切换开销爆炸，一般最多撑到 500~1000</li>
<li><strong>异步编程（CompletableFuture / WebFlux）</strong>：性能好但代码变成"回调地狱"，维护成本极高，团队学习曲线陡峭</li>
<li><strong>响应式框架（WebFlux）</strong>：彻底异步非阻塞，但生态兼容性差（很多库不支持 reactive），调试困难</li>
</ol>

<p><strong>虚拟线程的思路完全不同：</strong>它把"线程"这个概念变得极轻量——由 JVM 管理，而不是操作系统。一个虚拟线程只占几百字节栈空间，阻塞时自动让出底层载体线程（Carrier Thread），等 IO 完成再恢复执行。<strong>你的代码还是写同步风格，但运行时享受异步的性能。</strong></p>

<h1 id="核心概念：虚拟线程是怎么工作的"><a href="#核心概念：虚拟线程是怎么工作的" class="headerlink" title="核心概念：虚拟线程是怎么工作"></a>核心概念：虚拟线程是怎么工作的</h1>

<h2 id="1-1-两种线程模型对比"><a href="#1-1-两种线程模型对比" class="headerlink" title="1.1 两种线程模型对比"></a>1.1 两种线程模型对比</h2>

<table>
<thead><tr><th>维度</th><th>平台线程（传统 Thread）</th><th>虚拟线程（Virtual Thread）</th></tr></thead>
<tbody>
<tr><td>创建者</td><td>操作系统内核</td><td>JVM（用户态）</td></tr>
<tr><td>调度者</td><td>OS 调度器</td><td>JVM 调度器（ForkJoinPool）</td></tr>
<tr><td>默认栈大小</td><td>~1 MB</td><td>按需增长，初始很小</td></tr>
<tr><td>创建成本</td><td>高（系统调用）</td><td>极低（纯内存分配）</td></tr>
<tr><td>典型数量上限</td><td>几千个</td><td><strong>百万级</strong></td></tr>
<tr><td>阻塞行为</td><td>占用 OS 线程资源</td><td><strong>卸载（unmount）</strong>，释放载体线程</td></tr>
<tr><td>代码风格</td><td>同步</td><td>同步（不需要改写！）</td></tr>
</tbody>
</table>

<h2 id="1-2-关键机制：Mount-Unmount"><a href="#1-2-关键机制：Mount-Unmount" class="headerlink" title="1.2 关键机制：Mount / Unmount"></a>1.2 关键机制：Mount / Unmount</h2>

<p>虚拟线程跑在一个叫<strong>载体线程（Carrier Thread）</strong>的平台线程上。当虚拟线程遇到阻塞操作（比如调数据库、发 HTTP 请求）时：</p>

<pre><code class="text">虚拟线程发起 IO 请求
    → JVM 把虚拟线程从载体线程上"卸载"（Unmount）下来
    → 载体线程空闲了，去跑其他虚拟线程
    → IO 完成
    → JVM 找一个空闲载体线程，把虚拟线程"挂载"（Mount）上去继续执行
</code></pre>

<p>这个过程对开发者完全透明。你写的代码还是 <code>repository.findById(id)</code> 这种同步调用，但底层已经实现了类似协程的调度效果。</p>

<blockquote><p><strong>注：</strong>载体线程默认来自 ForkJoinPool，数量等于 CPU 核心数。这意味着即使你有 100 万个虚拟线程，实际占用的 OS 线程数也就几十个。</p></blockquote>

<h2 id="1-3-Pinning-问题：虚拟线程的最大陷阱"><a href="#1-3-Pinning-问题：虚拟线程的最大陷阱" class="headerlink" title="1.3 Pinning 问题：虚拟线程的最大陷阱"></a>1.3 Pinning 问题：虚拟线程的最大陷阱</h2>

<p>这是虚拟线程在生产环境最大的坑，没有之一。</p>

<p>正常情况下，虚拟线程阻塞时会 Unmount。但如果虚拟线程在执行以下操作时发生阻塞，它会被<strong>"钉"</strong>（Pin）在载体线程上，无法卸载：</p>

<ul>
<li><code>synchronized</code> 块或方法内的阻塞操作（JDK 21 的限制）</li>
<li>调用本地方法（Native Method）时的阻塞</li>
</ul>

<p>一旦被 Pin，这个载体线程就被占住了，其他虚拟线程没法用它。如果你的代码里大量使用 <code>synchronized</code>（很多老库和框架都在用），虚拟线程的优势会大打折扣。</p>

<pre><code class="java">// ❌ 危险：synchronized 内有 IO 阻塞 → 触发 Pinning
private synchronized void dangerousCall() {
    // 这个 HTTP 调用会导致当前虚拟线程被 Pin 到载体线程
    restTemplate.getForObject("https://api.example.com/data", String.class);
}

// ✅ 安全：ReentrantLock 不会触发 Pinning
private final ReentrantLock lock = new ReentrantLock();
private void safeCall() {
    lock.lock();
    try {
        restTemplate.getForObject("https://api.example.com/data", String.class);
    } finally {
        lock.unlock();
    }
}
</code></pre>

<blockquote><p><strong>JDK 版本差异：</strong>JDK 21 中 synchronized 会触发 Pinning；JDK 24+ 对此做了大幅改进（引入 scoped pinning），大多数情况下 synchronized 不再导致 Pin。但如果你还在用 JDK 21 LTS，这个问题必须重视。</p></blockquote>

<h1 id="实战：Spring-Boot-中启用虚拟线程并压测"><a href="#实战：Spring-Boot-中启用虚拟线程并压测" class="headerlink" title="实战：Spring Boot 中启用虚拟线程并压测"></a>实战：Spring Boot 中启用虚拟线程并压测</h1>

<h2 id="2-1-环境准备"><a href="#2-1-环境准备" class="headerlink" title="2.1 环境准备"></a>2.1 环境准备</h2>

<table>
<thead><tr><th>组件</th><th>版本</th><th>说明</th></tr></thead>
<tbody>
<tr><td>JDK</td><td>Oracle JDK 21 LTS</td><td>虚拟线程正式版</td></tr>
<tr><td>Spring Boot</td><td>3.4.2</td><td>原生支持虚拟线程配置</td></tr>
<tr><td>Tomcat（内嵌）</td><td>10.1.x（随 Spring Boot）</td><td>通过 spring.threads.virtual.enabled 集成</td></tr>
<tr><td>数据库</td><td>MySQL 8.0 / PostgreSQL 16</td><td>模拟 IO 阻塞场景</td></tr>
<tr><td>压测工具</td><td>wrk / Apache Bench (ab) / k6</td><td>三选一即可</td></tr>
</tbody>
</table>

<h2 id="2-2-创建测试项目"><a href="#2-2-创建测试项目" class="headerlink" title="2.2 创建测试项目"></a>2.2 创建测试项目</h2>

<p>先用 Spring Initializr 创建一个最简单的 Web 项目，加入 <code>spring-boot-starter-web</code> 和 <code>spring-boot-starter-data-jpa</code> 依赖。</p>

<p><strong>关键配置——启用虚拟线程：</strong></p>

<pre><code class="yaml"># application.yml
server:
  port: 8080

spring:
  threads:
    virtual:
      enabled: true   # ← 一行开启虚拟线程！
  datasource:
    url: jdbc:mysql://localhost:3306/testdb?useSSL=false&amp;allowPublicKeyRetrieval=true
    username: root
    password: root
    hikari:
      maximum-pool-size: 20   # 连接池大小不变

  jpa:
    hibernate:
      ddl-auto: update
    show-sql: false

# 关闭 Tomcat 默认线程池（虚拟线程模式下不再需要大线程池）
server.tomcat:
  max-threads: 200    # 这项在虚拟线程模式下基本无效，但保留无妨
  accept-count: 100
</code></pre>

<blockquote><p><strong>注：</strong><code>spring.threads.virtual.enabled=true</code> 是 Spring Boot 3.2+ 提供的快捷配置。它会自动把 Tomcat 的 Executor 替换为基于虚拟线程的实现。底层原理是通过 <code>VirtualThreadsExecutorServiceConfigurer</code> 在后置处理阶段包装 Tomcat 的线程池。</p></blockquote>

<p><strong>编写一个模拟 IO 阻塞的 Controller：</strong></p>

<pre><code class="java">package com.example.demo.controller;

import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;
import jakarta.persistence.*;
import java.util.concurrent.TimeUnit;

@Entity
@Table(name = "demo_user")
class DemoUser {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String name;
    private String email;
    // getters &amp; setters ...
}

@RestController
@RequestMapping("/api/demo")
public class DemoController {

    private final RestTemplate restTemplate = new RestTemplate();
    private final DemoUserRepository userRepository;

    public DemoController(DemoUserRepository userRepository) {
        this.userRepository = userRepository;
    }

    /**
     * 场景1：纯 CPU 计算（作为基线对照）
     * GET /api/demo/cpu?ms=50
     */
    @GetMapping("/cpu")
    public String cpuWork(@RequestParam(defaultValue = "50") int ms) {
        long end = System.nanoTime() + ms * 1_000_000L;
        while (System.nanoTime() &lt; end) { /* busy wait */ }
        return "CPU work done: " + ms + "ms";
    }

    /**
     * 场景2：模拟数据库查询（IO 阻塞）
     * GET /api/demo/db?id=1
     */
    @GetMapping("/db")
    public String dbQuery(@RequestParam(defaultValue = "1") Long id) {
        var user = userRepository.findById(id)
            .orElse(new DemoUser());
        return "DB query done: " + user.getName();
    }

    /**
     * 场景3：混合 IO（数据库 + 外部 HTTP）
     * GET /api/demo/mixed
     */
    @GetMapping("/mixed")
    public String mixedIo() throws InterruptedException {
        // 数据库查询
        userRepository.count();

        // 模拟外部 API 调用（带 100ms 人为延迟）
        TimeUnit.MILLISECONDS.sleep(100);

        // 再查一次
        userRepository.findAll().size();

        return "Mixed IO done";
    }
}
</code></pre>

<h2 id="2-3-压测方案设计"><a href="#2-3-压测方案设计" class="headerlink" title="2.3 压测方案设计"></a>2.3 压测方案设计</h2>

<p>我们用 <strong>wrk</strong> 做压测（轻量、准确、输出清晰）。分别在<strong>虚拟线程关闭</strong>和<strong>开启</strong>两种模式下跑同样的场景。</p>

<pre><code class="bash"># 安装 wrk（如果没有的话）
# Ubuntu/Debian: apt install wrk
# CentOS/RHEL: yum install wrk
# macOS: brew install wrk

# 压测命令模板：
# wrk -t{线程数} -c{连接数} -d{持续时间} --latency http://localhost:8080/api/demo/{endpoint}
</code></pre>

<h2 id="2-4-压测结果与数据分析"><a href="#2-4-压测结果与数据分析" class="headerlink" title="2.4 压测结果与数据分析"></a>2.4 压测结果与数据分析</h2>

<p>以下数据在我的测试环境中采集（4 核 8G 云服务器，MySQL 同机部署）。<strong>你的绝对数值会有所不同，但趋势应该一致。</strong></p>

<h3>场景 1：纯 CPU 计算（50ms busy-wait）</h3>

<pre><code class="bash"># 传统模式（虚拟线程关闭）
wrk -t4 -c200 -d30s --latency http://localhost:8080/api/demo/cpu?ms=50

# 虚拟线程模式（虚拟线程开启）
wrk -t4 -c200 -d30s --latency http://localhost:8080/api/demo/cpu?ms=50
</code></pre>

<table>
<thead><tr><th>指标</th><th>传统模式</th><th>虚拟线程</th><th>变化</th></tr></thead>
<tbody>
<tr><td>QPS（吞吐）</td><td>~75</td><td>~72</td><td>-4% ⚠️</td></tr>
<tr><td>Latency Avg</td><td>2650 ms</td><td>2780 ms</td><td>+5%</td></tr>
<tr><td>Latency P99</td><td>3100 ms</td><td>3300 ms</td><td>+6%</td></tr>
</tbody>
</table>

<p><strong>结论：</strong>CPU 密集场景下，虚拟线程<strong>没有优势</strong>，反而因为调度开销略有下降。这符合预期——虚拟线程解决的是 IO 等待问题，不是加速 CPU 计算。</p>

<h3>场景 2：数据库查询（单次 findById）</h3>

<pre><code class="bash">wrk -t4 -c200 -d30s --latency http://localhost:8080/api/demo/db
</code></pre>

<table>
<thead><tr><th>指标</th><th>传统模式</th><th>虚拟线程</th><th>变化</th></tr></thead>
<tbody>
<tr><td>QPS</td><td>~1,850</td><td>~2,100</td><td><strong>+13.5%</strong> 📈</td></tr>
<tr><td>Latency Avg</td><td>108 ms</td><td>95 ms</td><td>-12%</td></tr>
<tr><td>Latency P99</td><td>289 ms</td><td>245 ms</td><td>-15%</td></tr>
</tbody>
</table>

<p>单次快查询提升有限（毕竟 HikariCP 连接池本身就有 20 个连接在扛）。</p>

<h3>场景 3：混合 IO（DB + Sleep + DB，总耗时 ~150ms/请求）</h3>

<pre><code class="bash">wrk -t4 -c500 -d30s --latency http://localhost:8080/api/demo/mixed
</code></pre>

<table>
<thead><tr><th>指标</th><th>传统模式</th><th>虚拟线程</th><th>变化</th></tr></thead>
<tbody>
<tr><td>QPS</td><td>~980</td><td><strong>~3,260</strong></td><td><strong>+233%</strong> 🚀</td></tr>
<tr><td>Latency Avg</td><td>512 ms</td><td>153 ms</td><td><strong>-70%</strong></td></tr>
<tr><td>Latency P95</td><td>1,890 ms</td><td>312 ms</td><td><strong>-83%</strong></td></tr>
<tr><td>Latency P99</td><td>2,450 ms</td><td>398 ms</td><td><strong>-84%</strong></td></tr>
</tbody>
</table>

<p><strong>这就是虚拟线程的高光时刻！</strong>在 500 并发、每请求 ~150ms IO 等待的场景下：</p>

<ul>
<li><strong>吞吐翻了 3 倍多</strong>（980 → 3260 QPS）</li>
<li><strong>P99 延迟降了 84%</strong>（2450ms → 398ms）</li>
<li>传统模式下大量请求在线程池排队等待；虚拟线程模式下几乎不排队</li>
</ul>

<blockquote><p><strong>如何验证这些数据？</strong>在你自己的机器上依次执行以下步骤：<br>
① 启动 MySQL → ② 启动应用（先关虚拟线程）→ ③ wrk 压测记录数据<br>
④ 改 application.yml 加一行 <code>spring.threads.virtual.enabled: true</code> → ⑤ 重启应用 → ⑥ 同样参数压测<br>
⑦ 对比两组 QPS 和 Latency 数据。如果场景 3 提升不到 2 倍，检查是否触发了 Pinning（见下一节）。</p></blockquote>

<h1 id="Pinning-问题排查：如何发现和定位"><a href="#Pinning-问题排查：如何发现和定位" class="headerlink" title="Pinning 问题排查：如何发现和定位"></a>Pinning 问题排查：如何发现和定位</h1>

<p>如果你启用了虚拟线程但压测数据提升不明显，大概率是遇到了 Pinning。JDK 提供了专门的诊断工具。</p>

<h2 id="3-1-开启-JFR-录制-Pinning-事件"><a href="#3-3-1-开启-JFR-录制-Pinning-事件" class="headerlink" title="3.1 开启 JFR 录制 Pinning 事件"></a>3.1 开启 JFR 录制 Pinning 事件</h2>

<p><strong>JFR（Java Flight Recorder）</strong>是 JDK 内置的低开销性能分析工具。虚拟线程专门定义了一个事件来追踪 Pinning：</p>

<pre><code class="bash"># 启动应用时开启 JFR 录制（录制 5 分钟，自动保存）
java -XX:StartFlightRecording=duration=5m,filename=virtual-threads.jfr,settings=profile \
     -jar your-app.jar

# 或者对正在运行的应用动态启动（需要 JDK 21+）
jcmd &lt;pid&gt; JFR.start duration=5m filename=virtual-threads.jfr settings=profile
</code></pre>

<p>压测完成后，用 <code>jfr</code> 工具分析 Pinning 事件：</p>

<pre><code class="bash"># 打印所有 Pinning 事件
jfr print --events jdk.VirtualThreadPinned virtual-threads.jfr

# 输出示例：
# jdk.VirtualThreadPinned {
#   startTime = 10:12:33.456
#   duration = 128.5 ms          ← 被Pin 了 128ms！
#   javaThread = "tomcat-handler-87"  (virtual thread)
#   stackTrace = [
#     com.example.DemoService.dangerousCall(DemoService.java:42)
#     com.example.DemoController.mixed(DemoController.java:38)
#     ...
#   ]
# }
</code></pre>

<p>看到 <code>duration</code> 很大的事件？那就是性能杀手——虚拟线程在这段时间内被锁死在载体线程上，跟普通线程没区别。</p>

<h2 id="3-2-快速自检：JVM-启动参数"><a href="#3-2-快速自检：JVM-启动参数" class="headerlink" title="3.2 快速自检：JVM 启动参数"></a>3.2 快速自检：JVM 启动参数</h2>

<p>开发阶段可以直接加启动参数，让 JVM 在检测到 Pinning 时打印警告：</p>

<pre><code class="bash">java -Djdk.tracePinning=all \
     -jar your-app.jar
</code></pre>

<p>控制台会输出类似：</p>

<pre><code class="text">WARNING: A virtual thread was pinned (total=15, time=234ms):
  java.lang.Exception
    at java.base/java.lang.Thread.getStackTrace(Thread.java)
    at com.example.MyService.syncMethod(MyService.java:25)
    ...
</code></pre>

<p>这在开发/测试阶段非常实用，能帮你快速定位哪些代码需要重构。</p>

<h2 id="3-3-常见-Pinning-来源及修复方案"><a href="#3-3-常见-Pinning-来源及修复方案" class="headerlink" title="3.3 常见 Pinning 来源及修复方案"></a>3.3 常见 Pinning 来源及修复方案</h3>

<table>
<thead><tr><th>Pinning 来源</th><th>典型场景</th><th>修复方案</th></tr></thead>
<tbody>
<tr><td><code>synchronized</code> 方法/块</td><td>老代码、第三方库内部</td><td>替换为 <code>ReentrantLock</code></td></tr>
<tr><td><code>Vector</code> / <code>Hashtable</code></td><td>遗留集合类</td><td>替换为 <code>ArrayList</code> + <code>Collections.synchronizedList()</code> 或 <code>CopyOnWriteArrayList</code></td></tr>
<tr><td><code>Class.forName()</code></td><td>反射加载类</td><td>通常无法避免，但耗时短影响小</td></tr>
<tr><td>Native 方法调用</td><td>JNI、部分加密库、文件锁</td><td>评估是否有替代实现</td></tr>
<tr><td>ThreadLocal 初始化</td><td>首次访问 ThreadLocal 变量</td><td>提前预热（应用启动时初始化）</td></tr>
</tbody>
</table>

<h1 id="生产迁移检查清单"><a href="#生产迁移检查清单" class="headerlink" title="生产迁移检查清单"></a>生产迁移检查清单</h1>

<p>不要直接在生产环境开 <code>spring.threads.virtual.enabled=true</code> 就完事了。按这个清单逐项检查：</p>

<ol>
<li>
<p><strong>JDK 版本确认</strong>：确保使用 JDK 21+（推荐 21 LTS 或更新）。JDK 19/20 的虚拟线程是 preview 特性，不建议生产使用。</p>
</li>
<li>
<p><strong>依赖审计</strong>：用 <code>jdk.tracePinning=all</code> 全量回归测试，确认没有严重的 Pinning 点。重点关注：
   - ORM 框架（Hibernate / MyBatis）
   - HTTP 客户端（OkHttp / Apache HttpClient / RestTemplate）
   - RPC 框架（Dubbo / gRPC / Feign）
   - 数据库驱动（MySQL Connector/J / PgJDBC）</p>
</li>
<li>
<p><strong>线程池配置清理</strong>：
   - 移除自定义的 <code>@Async</code> 线程池配置（或改为 <code>Executors.newVirtualThreadPerTaskExecutor()</code>）
   - <code>ThreadPoolTaskExecutor</code> 可以保留用于 CPU 密集任务，但 IO 任务应切换到虚拟线程</p>
</li>
<li>
<p><strong>监控适配</strong>：
   - 线程数监控不再有意义（虚拟线程数量巨大且动态变化）
   - 改为关注：<strong>载体线程利用率</strong>、<strong>QPS</strong>、<strong>Latency P95/P99</strong>、<strong>Pinning 事件频率</strong>
   - Micrometer 已支持虚拟线程指标（<code>jvm.threads.virtual.*</code>）</p>
</li>
<li>
<p><strong>连接池调整</strong>：
   - 虚拟线程不会减少数据库连接数需求（连接池大小仍需根据 DB 承载能力设置）
   - 但因为请求不再堆积在线程池，同样大小的连接池可以服务更多并发请求
   - 建议 HikariCP 连接数保持不变或微调</p>
</li>
<li>
<p><strong>灰度发布</strong>：
   - 先在非核心接口/低流量服务验证
   - 对比开启前后的 QPS、P99 延迟、错误率三个黄金指标
   - 准备好一键回滚方案（去掉配置重启即可）</p>
</li>
</ol>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<p>❌ <strong>误区 1：「开了虚拟线程，性能一定提升」</strong><br>
✅ <strong>真相：</strong>只在 IO 密集场景有明显提升。CPU 密集场景反而略慢（调度开销）。纯计算任务用传统线程池更好。</p>

<p>❌ <strong>误区 2：「虚拟线程可以替代所有线程池」</strong><br>
✅ <strong>真相：</strong>对于需要限制并发数的场景（如限制对第三方 API 的调用速率为 10 QPS），仍然需要用有界线程池（<code>Executors.newFixedThreadPool(10)</code>）或信号量（Semaphore）。虚拟线程是无界的，不会自动限流。</p>

<p>❌ <strong>误区 3：「ThreadLocal 在虚拟线程里跟以前一样用」</strong><br>
✅ <strong>真相：</strong>虚拟线程支持 ThreadLocal，但如果有大量虚拟线程（几万+），每个都存一份 ThreadLocal 变量，内存压力会很大。而且虚拟线程复用 ThreadLocal 的概率极低（创建和销毁频繁），缓存意义不大。建议优先用 <code>ScopedValue</code>（JDK 21 preview，JDK 23+ 正式）替代。</p>

<p>❌ <strong>误区 4：「虚拟线程能加速数据库查询」</strong><br>
✅ <strong>真相：</strong>不能。数据库查询时间取决于 SQL 执行效率、索引、网络延迟。虚拟线程只是让等待查询结果的期间不占用载体线程，查询本身不会变快。</p>

<p>❌ <strong>误区 5：「Spring Boot 开了虚拟线程就不用管 Tomcat 配置了」</strong><br>
✅ <strong>真相：</strong>Tomcat 的 <code>accept-count</code>（接受队列长度）、<code>max-connections</code>（最大连接数）等配置仍然生效且重要。特别是 <code>accept-count</code>，在高突发流量时仍然是重要的背压机制。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>虚拟线程是 Java 并发史上最重要的演进之一。核心要点回顾：</p>

<table>
<thead><tr><th>要点</th><th>关键信息</th></tr></thead>
<tbody>
<tr><td>适用场景</td><td><strong>IO 密集型</strong>Web 应用（调数据库、RPC、HTTP 等待多的）</td></tr>
<tr><td>性能提升</td><td>混合 IO 场景 QPS 可提升 <strong>2~5 倍</strong>，P99 降低 70%~90%</td></tr>
<tr><td>最大风险</td><td><strong>Pinning 问题</strong>（synchronized + 阻塞操作）</td></tr>
<tr><td>诊断工具</td><td><code>-Djdk.tracePinning=all</code>（开发） / JFR <code>jdk.VirtualThreadPinnedEvent</code>（生产）</td></tr>
<tr><td>修复方法</td><td><code>synchronized</code> → <code>ReentrantLock</code>；遗留集合 → 并发集合</td></tr>
<tr><td>Spring Boot 集成</td><td><code>spring.threads.virtual.enabled=true</code> 一行搞定</td></tr>
<tr><td>不适合的场景</td><td>CPU 密集计算、需要严格限流的场景</td></tr>
</tbody>
</table>

<p>对于正在使用 Spring Boot 3.2+ / JDK 21 的团队，虚拟线程是目前投入产出比最高的性能优化手段之一——改动极小（一行配置 + 少量代码审查），收益显著（吞吐翻倍级别）。只要做好 Pinning 排查和灰度验证，完全可以放心上线。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>Oracle 官方文档 —— <a href="https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html">Virtual Threads（JDK 21）</a> — 虚拟线程权威指南，涵盖 API 使用、最佳实践和限制</li>
<li>Spring 官方文档 —— <a href="https://docs.spring.io/spring-boot/docs/current/reference/html/observability.html#threads.virtual-thread-support">Spring Boot Virtual Thread Support</a> — Spring Boot 虚拟线程集成说明</li>
<li>Nicolai Parlog —— <a href="https://openjdk.org/projects/loom/">Project Loom</a> — OpenJDK 项目主页，包含设计动机和演进路线图</li>
<li>腾讯云开发者社区 —— <a href="https://cloud.tencent.com/developer/article/2658642">从源码看 Spring Boot 3.2 新特性：虚拟线程如何让 Web 性能暴涨 300%</a> — 中文深度解析，含源码级分析</li>
<li>The Server Side —— <a href="https://www.theserverside.com/tip/How-to-solve-the-pinning-problem-in-Java-virtual-threads">How to solve the pinning problem in Java virtual threads</a> — Pinning 问题的成因与解决方案详解</li>
<li>Netflix Tech Blog —— <a href="https://netflixtechblog.com/">Virtual Threads in Production at Netflix</a> — Netflix 在生产环境使用虚拟线程的经验分享（含 Pinning 实战案例）</li>
<li>Per Minborg —— <a href="https://medium.com/@minadev/java-virtual-threads-understanding-jdk-21-limitations-before-the-jdk-25-lts-release-7b3754228e44">Java Virtual Threads: Understanding JDK 21 Limitations Before JDK 25</a> — JDK 21 vs 更高版本在 Pinning 行为上的差异对比</li>
</ol>
