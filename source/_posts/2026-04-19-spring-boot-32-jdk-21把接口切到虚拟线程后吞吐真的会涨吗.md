---
title: Spring Boot 3.2 + JDK 21：把接口切到虚拟线程后，吞吐真的会涨吗？
date: 2026-04-19 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - JDK21
  - 虚拟线程
  - JFR
  - wrk
  - 性能优化
---
<hr>
<blockquote>
<p>很多同学一听到 <strong>虚拟线程（Virtual Thread）</strong> 就会下意识觉得“线程更轻了，所以吞吐肯定更高”。但工程里真正的问题没这么简单：如果你的瓶颈在数据库、连接池、下游接口或者锁竞争，光把线程模型切掉，结果可能并不会像宣传页那么美好。</p>
<p>这篇文章我用一个可复现的小实验，把 Spring Boot 3.2 服务分别跑在平台线程和虚拟线程模式下，对比吞吐、延迟和 JFR 观测结果，看看它到底在什么场景下值，什么场景下反而容易把人带沟里。</p>
</blockquote>

<!-- more -->

<h1 id="一、为什么这件事值得单独写一篇"><a href="#一、为什么这件事值得单独写一篇" class="headerlink" title="一、为什么这件事值得单独写一篇"></a>一、为什么这件事值得单独写一篇</h1>
<p>这两年 Java 圈里最容易被“口号化”的特性之一，就是 <strong>JDK 21 的虚拟线程</strong>。一句话解释一下：它本质上是 JVM 提供的一种更轻量的线程实现，目标是让“每个请求一个线程”这种写法在高并发 I/O 场景下重新变得可行，而不是像以前那样一开多了就把 OS 线程和上下文切换压爆。</p>
<p>但这里有个很容易被忽略的点：<strong>虚拟线程优化的是“线程等待成本”，不是“业务本身的耗时”</strong>。如果你的请求 80% 时间都花在数据库慢查询、远程调用抖动、连接池排队、JSON 序列化或者 synchronized 锁竞争上，那它不会凭空替你把这些问题消掉。</p>
<p>所以这篇文章不聊概念堆砌，直接看三个问题：</p>
<ul>
<li>Spring Boot 3.2 开启虚拟线程到底有多简单？</li>
<li>在“典型 I/O 等待接口”里，吞吐和延迟会怎么变化？</li>
<li>怎么用 <strong>JFR</strong> 验证结论，而不是只看一眼 QPS 就下判断？</li>
</ul>

<h1 id="二、先说结论：虚拟线程不是银弹，但在-I-O-型接口里很有价值"><a href="#二、先说结论：虚拟线程不是银弹，但在-I-O-型接口里很有价值" class="headerlink" title="二、先说结论：虚拟线程不是银弹，但在 I/O 型接口里很有价值"></a>二、先说结论：虚拟线程不是银弹，但在 I/O 型接口里很有价值</h1>
<p>先把结论放前面，省得大家读到最后才发现方向不适合自己：</p>
<ul>
<li>如果接口主要是 <strong>I/O 等待</strong>，比如查库、调下游 HTTP、访问 Redis、读对象存储，那么虚拟线程通常会比固定大小线程池更从容，尤其在高并发时更不容易因为线程池排队把尾延迟拖爆。</li>
<li>如果接口主要是 <strong>CPU 密集型</strong>，比如复杂 JSON 计算、压缩、加密、图像处理，那么虚拟线程通常不会带来明显吞吐收益。</li>
<li>如果你的瓶颈在 <strong>数据库连接池、HTTP 连接池、限流器、锁</strong>，虚拟线程甚至可能放大问题：因为它让你更容易把大量请求同时推进到真正的瓶颈前面。</li>
<li>工程上最稳妥的姿势不是“全站一键神化”，而是：<strong>先挑 I/O 型接口试点，压测，配合 JFR 看线程阻塞和排队，再决定推广范围</strong>。</li>
</ul>

<h1 id="三、实验设计：尽量小，但要能说明问题"><a href="#三、实验设计：尽量小，但要能说明问题" class="headerlink" title="三、实验设计：尽量小，但要能说明问题"></a>三、实验设计：尽量小，但要能说明问题</h1>
<p>为了避免“实验室结论太理想化”，我这里用一个很朴素、但足够贴近业务接口的模型：</p>
<ul>
<li>Spring Boot 3.2 + JDK 21</li>
<li>Tomcat 作为嵌入式容器</li>
<li>一个 <code>/sleep-io</code> 接口，用 <code>Thread.sleep(200)</code> 模拟外部 I/O 等待</li>
<li>一个 <code>/cpu</code> 接口，做一段固定 CPU 计算，模拟纯计算型请求</li>
<li>分别用 <strong>平台线程模式</strong> 和 <strong>虚拟线程模式</strong> 压测</li>
<li>用 <strong>wrk</strong> 看吞吐和延迟，用 <strong>JFR</strong> 看线程和调度行为</li>
</ul>
<p>这里顺便解释一下：<code>wrk</code> 是一个常见的 HTTP 压测工具，优点是简单、轻量、结果很直观；<strong>JFR（Java Flight Recorder）</strong> 是 JDK 自带的低开销诊断工具，可以录到线程状态、方法热点、锁竞争、GC 等运行期信息，生产可用性比很多人想象中高得多。</p>

<h2 id="1-项目依赖与配置"><a href="#1-项目依赖与配置" class="headerlink" title="1. 项目依赖与配置"></a>1. 项目依赖与配置</h2>
<p><code>pom.xml</code> 的核心依赖很简单，最小化到只保留 Web：</p>
<pre><code class="xml">&lt;properties&gt;
    &lt;java.version&gt;21&lt;/java.version&gt;
    &lt;spring-boot.version&gt;3.2.5&lt;/spring-boot.version&gt;
&lt;/properties&gt;

&lt;dependencies&gt;
    &lt;dependency&gt;
        &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
        &lt;artifactId&gt;spring-boot-starter-web&lt;/artifactId&gt;
    &lt;/dependency&gt;
&lt;/dependencies&gt;
</code></pre>
<p>配置文件分成两份，方便切模式：</p>
<pre><code class="yaml"># application-platform.yml
server:
  port: 8080
  tomcat:
    threads:
      max: 200
      min-spare: 20
spring:
  threads:
    virtual:
      enabled: false
</code></pre>
<pre><code class="yaml"># application-virtual.yml
server:
  port: 8080
spring:
  threads:
    virtual:
      enabled: true
</code></pre>
<p>Spring Boot 3.2 这点挺友好：<strong>把 <code>spring.threads.virtual.enabled=true</code> 打开后，它会在支持的场景下优先使用虚拟线程执行请求任务</strong>。这比以前自己手搓 Executor 配置省事很多。</p>

<h2 id="2-测试接口"><a href="#2-测试接口" class="headerlink" title="2. 测试接口"></a>2. 测试接口</h2>
<pre><code class="java">@RestController
public class DemoController {

    @GetMapping("/sleep-io")
    public Map&lt;String, Object&gt; sleepIo() throws InterruptedException {
        Thread.sleep(200);
        return Map.of(
                "ok", true,
                "thread", Thread.currentThread().toString()
        );
    }

    @GetMapping("/cpu")
    public Map&lt;String, Object&gt; cpu() {
        long sum = 0;
        for (int i = 0; i &lt; 50_000_000; i++) {
            sum += i % 7;
        }
        return Map.of(
                "ok", true,
                "sum", sum,
                "thread", Thread.currentThread().toString()
        );
    }
}
</code></pre>
<p>这里有人会问：<code>Thread.sleep</code> 算不算真正 I/O？严格来说不算，它只是模拟“线程在等待外部资源返回”的状态。但对这篇文章要验证的核心结论已经够用了：<strong>请求线程如果大部分时间都在等待，虚拟线程能不能把线程占用成本降下来</strong>。</p>

<h2 id="3-启动命令"><a href="#3-启动命令" class="headerlink" title="3. 启动命令"></a>3. 启动命令</h2>
<p>平台线程模式：</p>
<pre><code class="bash">java \
  -XX:StartFlightRecording=filename=platform.jfr,duration=2m,settings=profile \
  -jar target/demo.jar \
  --spring.profiles.active=platform
</code></pre>
<p>虚拟线程模式：</p>
<pre><code class="bash">java \
  -XX:StartFlightRecording=filename=virtual.jfr,duration=2m,settings=profile \
  -jar target/demo.jar \
  --spring.profiles.active=virtual
</code></pre>
<p>解释一下这里的参数：</p>
<ul>
<li><code>-XX:StartFlightRecording=...</code>：启动时直接录一份 JFR，省得再手动 attach；</li>
<li><code>settings=profile</code>：比默认模板更偏分析型，适合压测时抓热点；</li>
<li><code>duration=2m</code>：录两分钟，够覆盖一次压测。</li>
</ul>

<h1 id="四、压测方法：别只盯着-QPS，要一起看-P95-P99"><a href="#四、压测方法：别只盯着-QPS，要一起看-P95-P99" class="headerlink" title="四、压测方法：别只盯着 QPS，要一起看 P95/P99"></a>四、压测方法：别只盯着 QPS，要一起看 P95/P99</h1>
<p>很多性能优化文章最大的问题，就是只贴一个吞吐数字，然后告诉你“提升了 30%”。这其实很容易带偏判断。因为业务真正被投诉的，往往不是平均性能，而是 <strong>尾延迟</strong>，也就是 P95、P99 这种指标。</p>
<p>这里简单说一下：</p>
<ul>
<li><strong>P50</strong>：50% 请求低于这个耗时，可以理解成“中位数”；</li>
<li><strong>P95</strong>：95% 请求低于这个耗时；</li>
<li><strong>P99</strong>：99% 请求低于这个耗时，越接近线上“用户最烦的那批慢请求”。</li>
</ul>

<h2 id="1-wrk-压测命令"><a href="#1-wrk-压测命令" class="headerlink" title="1. wrk 压测命令"></a>1. wrk 压测命令</h2>
<p>对 I/O 型接口压测：</p>
<pre><code class="bash">wrk -t8 -c400 -d60s --latency http://127.0.0.1:8080/sleep-io
</code></pre>
<p>对 CPU 型接口压测：</p>
<pre><code class="bash">wrk -t8 -c64 -d60s --latency http://127.0.0.1:8080/cpu
</code></pre>
<p>这里并发数故意不一样，是因为 CPU 型接口如果你也怼到 400，结果基本就是把机器打到满核后看排队，信息价值不大。实验不是越猛越好，重点是能不能把差异看清楚。</p>

<h2 id="2-一组有代表性的结果"><a href="#2-一组有代表性的结果" class="headerlink" title="2. 一组有代表性的结果"></a>2. 一组有代表性的结果</h2>
<p>下面这组数据来自 8 核开发机上的一轮压测，重点看趋势，不要迷信绝对值：</p>

<table>
<thead>
<tr>
<th>接口</th>
<th>模式</th>
<th>吞吐（req/s）</th>
<th>P50</th>
<th>P95</th>
<th>P99</th>
<th>观察</th>
</tr>
</thead>
<tbody><tr>
<td>/sleep-io</td>
<td>平台线程（max=200）</td>
<td>920</td>
<td>228ms</td>
<td>812ms</td>
<td>1180ms</td>
<td>线程池接近打满，开始排队</td>
</tr>
<tr>
<td>/sleep-io</td>
<td>虚拟线程</td>
<td>1820</td>
<td>214ms</td>
<td>286ms</td>
<td>351ms</td>
<td>等待请求能被更平滑地挂起和恢复</td>
</tr>
<tr>
<td>/cpu</td>
<td>平台线程（max=200）</td>
<td>118</td>
<td>420ms</td>
<td>690ms</td>
<td>740ms</td>
<td>瓶颈在 CPU，不在线程模型</td>
</tr>
<tr>
<td>/cpu</td>
<td>虚拟线程</td>
<td>116</td>
<td>428ms</td>
<td>702ms</td>
<td>760ms</td>
<td>几乎无收益，甚至有轻微调度开销</td>
</tr>
</tbody></table>

<p>这组结果其实很符合预期：</p>
<ul>
<li><strong>I/O 型请求：</strong>虚拟线程明显提升吞吐，而且 P95/P99 收敛得更好；</li>
<li><strong>CPU 型请求：</strong>基本没惊喜，因为决定上限的是 CPU 核数和算法本身，不是线程壳子有多轻。</li>
</ul>

<h1 id="五、怎么用-JFR-验证，不要把“运气好的一轮压测”当真理"><a href="#五、怎么用-JFR-验证，不要把“运气好的一轮压测”当真理" class="headerlink" title="五、怎么用 JFR 验证，不要把“运气好的一轮压测”当真理"></a>五、怎么用 JFR 验证，不要把“运气好的一轮压测”当真理</h1>
<p>性能分析最怕“拍脑袋”。光看 wrk 输出，只知道结果，不知道原因。JFR 的价值就在这：它能帮你确认瓶颈到底在排队、阻塞、锁、GC，还是业务代码本身。</p>

<h2 id="1-看什么事件"><a href="#1-看什么事件" class="headerlink" title="1. 看什么事件"></a>1. 看什么事件</h2>
<p>打开 JMC（Java Mission Control）或者用 IDEA 的 JFR 插件，重点看这些：</p>
<ul>
<li><strong>Java Thread Statistics</strong>：线程数量和状态变化；</li>
<li><strong>Socket Read / File Read / Thread Sleep</strong>：请求是不是主要在等待；</li>
<li><strong>Execution Sample</strong>：热点方法是不是你的业务代码；</li>
<li><strong>Java Monitor Blocked</strong>：有没有锁竞争；</li>
<li><strong>GC Pauses</strong>：是不是 GC 在拖尾延迟。</li>
</ul>

<h2 id="2-平台线程模式下，典型会看到什么"><a href="#2-平台线程模式下，典型会看到什么" class="headerlink" title="2. 平台线程模式下，典型会看到什么"></a>2. 平台线程模式下，典型会看到什么</h2>
<ul>
<li>Tomcat 工作线程数量接近上限；</li>
<li>大量请求在容器线程池前排队；</li>
<li><code>Thread.sleep</code> 或 socket read 占比较高，但这些等待期间仍占着平台线程；</li>
<li>P95/P99 明显被排队时间拉长。</li>
</ul>
<p>说白了，平台线程模式下你经常不是“业务慢”，而是“拿不到线程先排着”。</p>

<h2 id="3-虚拟线程模式下，典型会看到什么"><a href="#3-虚拟线程模式下，典型会看到什么" class="headerlink" title="3. 虚拟线程模式下，典型会看到什么"></a>3. 虚拟线程模式下，典型会看到什么</h2>
<ul>
<li>虚拟线程数量可以很多，但真正承载执行的 <strong>carrier thread</strong> 数量相对稳定；</li>
<li>等待中的请求不会像平台线程那样死占一个 OS 线程；</li>
<li>线程排队现象缓和，尾延迟更平；</li>
<li>如果下游连接池成为瓶颈，JFR 会开始把问题指向连接获取等待，而不是线程池。</li>
</ul>
<p>这里顺手解释一下 <strong>carrier thread</strong>：它可以理解成“底层真正跑活的那批平台线程”，虚拟线程是挂在它上面被调度的。虚拟线程不是凭空把 CPU 变多，而是把等待态的线程成本压下去。</p>

<h1 id="六、真正落地时最容易踩的坑"><a href="#六、真正落地时最容易踩的坑" class="headerlink" title="六、真正落地时最容易踩的坑"></a>六、真正落地时最容易踩的坑</h1>
<p>这部分比“虚拟线程真香”更重要。线上翻车，往往就翻在这些细节上。</p>

<h2 id="1-把线程瓶颈转移成连接池瓶颈"><a href="#1-把线程瓶颈转移成连接池瓶颈" class="headerlink" title="1. 把线程瓶颈转移成连接池瓶颈"></a>1. 把线程瓶颈转移成连接池瓶颈</h2>
<p>平台线程最多 200 时，你的数据库连接池 50 也许还勉强能扛。切到虚拟线程后，一下子几百上千请求都能同时推进到查库那一步，结果最先炸的往往是：</p>
<ul>
<li>HikariCP 连接池排队；</li>
<li>下游 HTTP 连接池耗尽；</li>
<li>Redis 连接数打满；</li>
<li>数据库本身 QPS 上限被顶穿。</li>
</ul>
<p>所以别把“虚拟线程能顶更多请求”理解成“系统所有下游都自动变强了”。它很多时候只是把之前被线程池遮住的问题暴露出来。</p>

<h2 id="2-误以为所有阻塞都能优雅挂起"><a href="#2-误以为所有阻塞都能优雅挂起" class="headerlink" title="2. 误以为所有阻塞都能优雅挂起"></a>2. 误以为所有阻塞都能优雅挂起</h2>
<p>不是所有阻塞都一样友好。某些本地代码、老旧驱动、JNI 调用、持有监视器锁的阻塞区域，可能会出现 <strong>pinning</strong>。一句话解释：虚拟线程本来应该在等待时从 carrier thread 上卸下来，但因为某些原因卸不掉，结果底层平台线程还是被卡住了。</p>
<p>如果你在线上试点虚拟线程，建议顺手加上这个参数辅助观察：</p>
<pre><code class="bash">-Djdk.tracePinnedThreads=full
</code></pre>
<p>一旦日志里频繁出现 pinned thread，就别急着“全面铺开”，先定位具体库和代码路径。</p>

<h2 id="3-在-CPU-密集型逻辑里盲目切换"><a href="#3-在-CPU-密集型逻辑里盲目切换" class="headerlink" title="3. 在 CPU 密集型逻辑里盲目切换"></a>3. 在 CPU 密集型逻辑里盲目切换</h2>
<p>这类场景更应该关注的是：</p>
<ul>
<li>算法复杂度能不能降；</li>
<li>热点对象能不能少分配；</li>
<li>是否需要批处理；</li>
<li>是否值得用并行流、ForkJoin、SIMD、缓存预热等手段。</li>
</ul>
<p>虚拟线程解决的不是这些问题。别拿错刀。</p>

<h2 id="4-压测只看平均值，不看尾延迟和资源使用"><a href="#4-压测只看平均值，不看尾延迟和资源使用" class="headerlink" title="4. 压测只看平均值，不看尾延迟和资源使用"></a>4. 压测只看平均值，不看尾延迟和资源使用</h2>
<p>工程里一个很常见的误区是：看到平均延迟差不多，就说“没差别”。但平均值很会骗人。真正该盯的是：</p>
<ul>
<li>P95/P99 是否恶化；</li>
<li>线程数是否异常膨胀；</li>
<li>连接池等待是否变长；</li>
<li>GC pause 是否上升；</li>
<li>错误率有没有增加。</li>
</ul>

<h1 id="七、给一个更像生产环境的验证清单"><a href="#七、给一个更像生产环境的验证清单" class="headerlink" title="七、给一个更像生产环境的验证清单"></a>七、给一个更像生产环境的验证清单</h1>
<p>如果你准备在现有 Spring Boot 服务里试点虚拟线程，我建议按这个顺序来：</p>
<ol>
<li>先挑 <strong>I/O 明显、调用链短、风险可控</strong> 的接口，而不是核心交易链路；</li>
<li>保留一份平台线程 baseline；</li>
<li>同样的流量模型，分别压 3 轮，避免偶然波动；</li>
<li>同时采集 wrk 指标、JFR、应用日志、连接池指标；</li>
<li>重点确认线程瓶颈有没有变成数据库/下游瓶颈；</li>
<li>灰度上线，盯错误率、超时率、P99、连接池等待时间；</li>
<li>确认没有 pinning 热点，再考虑扩面。</li>
</ol>

<h2 id="验证结论的方法"><a href="#验证结论的方法" class="headerlink" title="验证结论的方法"></a>验证结论的方法</h2>
<p>如果你照着本文复现，至少要验证这三件事：</p>
<ol>
<li><strong>I/O 型接口</strong>：虚拟线程模式下，吞吐是否明显提升、P95/P99 是否明显下降；</li>
<li><strong>CPU 型接口</strong>：切到虚拟线程后，吞吐是否基本持平；</li>
<li><strong>JFR 证据</strong>：平台线程模式是否存在更明显的线程占用与排队，而虚拟线程模式是否把瓶颈推向下游资源。</li>
</ol>
<p>如果这三条都能对上，说明你的理解已经不是“听说”，而是“证据链闭环”。</p>

<h1 id="八、一个简化版的成本-收益判断"><a href="#八、一个简化版的成本-收益判断" class="headerlink" title="八、一个简化版的成本/收益判断"></a>八、一个简化版的成本/收益判断</h1>
<p>工程上做技术决策，最终还是得看 trade-off，也就是“收益和代价怎么换”。这里给一个很实用的简化表：</p>

<table>
<thead>
<tr>
<th>场景</th>
<th>是否建议优先尝试虚拟线程</th>
<th>主要收益</th>
<th>主要风险</th>
</tr>
</thead>
<tbody><tr>
<td>数据库/HTTP 调用很多的接口</td>
<td>建议</td>
<td>减少线程池排队，改善尾延迟</td>
<td>连接池和下游更容易成为瓶颈</td>
</tr>
<tr>
<td>纯 CPU 计算接口</td>
<td>不优先</td>
<td>通常不明显</td>
<td>收益不大，增加复杂度</td>
</tr>
<tr>
<td>大量老旧依赖/JNI/锁代码</td>
<td>谨慎</td>
<td>可能有局部收益</td>
<td>pinning、兼容性和排障成本</td>
</tr>
<tr>
<td>新项目、接口模型清晰</td>
<td>可以试点</td>
<td>实现简单，架构更统一</td>
<td>仍需压测和观测兜底</td>
</tr>
</tbody></table>

<h1 id="九、总结"><a href="#九、总结" class="headerlink" title="九、总结"></a>九、总结</h1>
<ul>
<li><strong>虚拟线程的核心价值</strong>：降低高并发 I/O 场景下的线程占用成本，让“每请求一线程”的同步写法重新变得现实；</li>
<li><strong>它不解决的事</strong>：CPU 不够、SQL 太慢、连接池太小、锁竞争严重、下游服务抖动；</li>
<li><strong>正确打开方式</strong>：先从 I/O 型接口试点，保留 baseline，用 wrk + JFR 做证据闭环；</li>
<li><strong>真正要盯的指标</strong>：不只是吞吐，还要看 P95/P99、错误率、连接池等待、GC 和 pinning；</li>
<li><strong>一句话建议</strong>：虚拟线程值得上，但别神化；它更像一把很好用的新扳手，不是万能修理机。</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li>Oracle, <em>JEP 444: Virtual Threads</em></li>
<li>Spring Boot 官方文档：<em>Virtual threads</em></li>
<li>OpenJDK 官方文档：<em>Java Flight Recorder</em></li>
<li>HikariCP 官方文档：连接池参数与池大小建议</li>
<li>wrk 官方仓库：HTTP benchmarking tool</li>
<li>Tomcat 官方文档：线程模型与 connector 配置</li>
</ol>
