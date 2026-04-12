---
title: Java HTTP 连接池配不对，为什么你的 P99 会突然炸？从 keep-alive、并发上限到压测排障
date: 2026-04-12 10:00:00
categories:
  - 计算机网络
  - HTTP/HTTPS
tags:
  - Java
  - HTTP
  - Keep-Alive
  - 连接池
  - JFR
  - wrk
---
<hr>
<blockquote>
<p>很多 Java 服务线上“偶发性变慢”，最后查出来既不是 SQL，也不是 GC，而是 HTTP 客户端连接池配小了、超时没配全、keep-alive 策略又太理想化。表面看是下游慢，实际上是你自己的请求还没发出去，就先在连接池门口排队了。</p>
</blockquote>

<!-- more -->

<h1 id="这篇文章要解决什么问题"><a href="#这篇文章要解决什么问题" class="headerlink" title="这篇文章要解决什么问题"></a>这篇文章要解决什么问题</h1>
<p>如果你做的是 Java 后端服务，十有八九都离不开 <strong>HTTP 客户端</strong>：调用户中心、调支付、调推荐、调模型服务、调对象存储，甚至调用公司内部的十几个微服务。很多人一开始写代码很顺：new 一个客户端，接口能通，压测也不一定立刻出事。真正上线后，一到并发上来或者下游抖一下，<strong>P99 延迟突然拉高</strong>，线程堆积，熔断报警，大家就开始怀疑网络、怀疑 JVM、怀疑对方服务。
</p>
<p>但一个很常见、又很容易被忽略的根因是：<strong>HTTP 连接池配置不合理</strong>。请求并不是卡在“服务端处理”，而是卡在“拿连接”这一步。你以为超时是对方接口慢，实际上你的线程可能已经在本地连接池里排了 200ms、500ms，甚至更久。</p>
<p>这篇文章我想把这个问题讲透：什么是连接池、为什么 keep-alive 既能救命也能坑人、Java 里怎么复现“P99 突然炸掉”的现象、怎么用压测和 JFR 验证结论，以及线上最常见的坑到底有哪些。</p>

<h1 id="几个关键名词先说人话"><a href="#几个关键名词先说人话" class="headerlink" title="几个关键名词先说人话"></a>几个关键名词先说人话</h1>
<p><strong>HTTP keep-alive</strong>：别被名字唬住，它说白了就是“一个 TCP 连接别用完就扔，后面请求继续复用它”。这样就不用每次都重新三次握手、TLS 握手，延迟和 CPU 都会更好。</p>
<p><strong>连接池（connection pool）</strong>：它是啥？它就是一组可复用的 HTTP 连接，客户端每次发请求先去池子里借一个，用完再还回去。它解决的是高并发下频繁建连的成本问题。</p>
<p><strong>maxTotal / maxPerRoute</strong>：这是 Apache HttpClient 里常见的两个参数。前者是整个客户端最多能开多少连接，后者是对某个目标地址最多能并发用多少连接。很多事故不是总连接不够，而是 <strong>单个热点下游</strong> 的 per-route 配得太小。</p>
<p><strong>P99</strong>：它是啥？它表示 99% 的请求都比这个延迟更快，剩下最慢的 1% 会更差。线上用户体感问题，很多时候就藏在 P95/P99 里，而不是平均值。</p>
<p><strong>JFR（Java Flight Recorder）</strong>：JDK 自带的低开销诊断工具。简单说，它像 JVM 的黑匣子，能帮你看线程在忙什么、阻塞在哪里、方法热点在哪。</p>
<p><strong>wrk</strong>：一款很轻量的 HTTP 压测工具。它解决的是“我怎么快速打出固定并发，看吞吐和延迟分布”的问题。</p>

<h1 id="为什么连接池会把延迟悄悄拉高"><a href="#为什么连接池会把延迟悄悄拉高" class="headerlink" title="为什么连接池会把延迟悄悄拉高"></a>为什么连接池会把延迟悄悄拉高</h1>
<p>先说结论：<strong>连接池不是越小越省，也不是越大越好。</strong> 配小了，线程会在本地排队；配大了，可能把下游、LB、NAT、文件描述符、甚至你自己的 CPU 一起打爆。</p>
<p>HTTP 客户端一次请求，通常要经历这几个阶段：</p>
<ol>
<li>从连接池借连接；</li>
<li>如果没有空闲连接，可能等待，或者新建连接；</li>
<li>发请求、收响应；</li>
<li>如果连接可复用，则归还池中。</li>
</ol>
<p>这里最容易被忽略的是第 1 步。如果你的服务对某个下游的瞬时并发是 200，但 <code>maxPerRoute</code> 只有 20，那么剩下 180 个请求就只能排队等。<strong>这部分等待时间，也算在你的接口 RT 里</strong>。所以从业务看是“接口慢了”，从客户端看其实是“没抢到连接”。</p>
<p>这也是为什么很多系统平均延迟看起来还行，但 P99 很难看：平时连接够用，一到高峰或下游抖动，排队立刻放大。</p>

<h1 id="一个很实用的容量估算思路"><a href="#一个很实用的容量估算思路" class="headerlink" title="一个很实用的容量估算思路"></a>一个很实用的容量估算思路</h1>
<p>你不需要一上来就搞复杂建模，先用一个足够工程化的近似：</p>

```text
所需连接数 ≈ 峰值 QPS × 下游平均 RT（秒）
```

<p>比如你这个服务对某个下游峰值是 <strong>300 QPS</strong>，下游平均 RT 是 <strong>80ms</strong>，那理论并发需求大约是：</p>

```text
300 × 0.08 = 24
```

<p>这说明 <code>maxPerRoute</code> 配 20 已经有点紧了。如果还要考虑抖动、P99、重试、突发流量，通常应该留出一定余量，比如配到 32、48 或 64，再结合压测验证。</p>
<p>注意，这个公式只是个起点，不是圣经。真正线上你还得看：</p>
<ul>
<li>是否有重试；</li>
<li>是否有批量请求或大包体；</li>
<li>下游 RT 是否波动大；</li>
<li>连接是否会被代理、网关、LB 提前回收；</li>
<li>是否多个业务共用同一个客户端实例。</li>
</ul>

<h1 id="可复现实验：故意把连接池配小，观察-P99-爆炸"><a href="#可复现实验：故意把连接池配小，观察-P99-爆炸" class="headerlink" title="可复现实验：故意把连接池配小，观察 P99 爆炸"></a>可复现实验：故意把连接池配小，观察 P99 爆炸</h1>
<p>下面我们用一个最小可复现实验，把问题跑出来。思路很简单：</p>
<ul>
<li>启动一个本地 HTTP 服务，固定每次睡眠 120ms 再返回；</li>
<li>Java 客户端用 Apache HttpClient 调它；</li>
<li>故意把 <code>maxPerRoute</code> 配成 4；</li>
<li>用 64 个并发线程连续发请求；</li>
<li>记录总耗时、拿连接耗时、请求耗时；</li>
<li>再把连接池调大，对比前后差异。</li>
</ul>

<h2 id="步骤-1：启动一个稳定但不算快的本地服务"><a href="#步骤-1：启动一个稳定但不算快的本地服务" class="headerlink" title="步骤 1：启动一个稳定但不算快的本地服务"></a>步骤 1：启动一个稳定但不算快的本地服务</h2>

```bash
python3 - <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import time

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(0.12)
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, format, *args):
        return

HTTPServer(("127.0.0.1", 18080), Handler).serve_forever()
PY
```

<p>这个服务很朴素，但非常适合做实验，因为它足够稳定：每次响应大概 120ms，不会掺杂太多别的变量。</p>

<h2 id="步骤-2：准备-Java-客户端"><a href="#步骤-2：准备-Java-客户端" class="headerlink" title="步骤 2：准备 Java 客户端"></a>步骤 2：准备 Java 客户端</h2>
<p>下面这个示例使用 Apache HttpClient 5。它第一次出现也解释一下：它是 Java 里一套老牌 HTTP 客户端库，很多 Spring 体系外或者底层 SDK 都会用它，连接池能力比较成熟。</p>

```java
import org.apache.hc.client5.http.classic.methods.HttpGet;
import org.apache.hc.client5.http.config.RequestConfig;
import org.apache.hc.client5.http.impl.classic.CloseableHttpClient;
import org.apache.hc.client5.http.impl.classic.CloseableHttpResponse;
import org.apache.hc.client5.http.impl.classic.HttpClients;
import org.apache.hc.client5.http.impl.io.PoolingHttpClientConnectionManager;
import org.apache.hc.core5.util.Timeout;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.*;

public class HttpPoolP99Demo {

    public static void main(String[] args) throws Exception {
        int concurrency = 64;
        int requests = 500;

        PoolingHttpClientConnectionManager cm = new PoolingHttpClientConnectionManager();
        cm.setMaxTotal(8);
        cm.setDefaultMaxPerRoute(4);

        RequestConfig config = RequestConfig.custom()
                .setConnectionRequestTimeout(Timeout.ofSeconds(2))
                .setConnectTimeout(Timeout.ofSeconds(2))
                .setResponseTimeout(Timeout.ofSeconds(3))
                .build();

        try (CloseableHttpClient client = HttpClients.custom()
                .setConnectionManager(cm)
                .setDefaultRequestConfig(config)
                .evictExpiredConnections()
                .build()) {

            ExecutorService pool = Executors.newFixedThreadPool(concurrency);
            CountDownLatch latch = new CountDownLatch(requests);
            List<Long> costs = Collections.synchronizedList(new ArrayList<>());

            for (int i = 0; i < requests; i++) {
                pool.submit(() -> {
                    long begin = System.nanoTime();
                    try {
                        HttpGet get = new HttpGet("http://127.0.0.1:18080/");
                        try (CloseableHttpResponse ignored = client.execute(get)) {
                            // just consume
                        }
                    } catch (IOException e) {
                        System.out.println("request failed: " + e.getMessage());
                    } finally {
                        long costMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - begin);
                        costs.add(costMs);
                        latch.countDown();
                    }
                });
            }

            latch.await();
            pool.shutdown();
            report(costs);
        }
    }

    private static void report(List<Long> costs) {
        Collections.sort(costs);
        long p50 = costs.get((int) (costs.size() * 0.50));
        long p95 = costs.get((int) (costs.size() * 0.95));
        long p99 = costs.get((int) (costs.size() * 0.99));
        long max = costs.get(costs.size() - 1);
        System.out.printf("count=%d p50=%dms p95=%dms p99=%dms max=%dms%n",
                costs.size(), p50, p95, p99, max);
    }
}
```

<p>如果你用 Maven，可以加上依赖：</p>

```xml
<dependency>
  <groupId>org.apache.httpcomponents.client5</groupId>
  <artifactId>httpclient5</artifactId>
  <version>5.4.1</version>
</dependency>
```

<h2 id="步骤-3：先用小连接池跑一轮"><a href="#步骤-3：先用小连接池跑一轮" class="headerlink" title="步骤 3：先用小连接池跑一轮"></a>步骤 3：先用小连接池跑一轮</h2>
<p>先保持配置：</p>

```java
cm.setMaxTotal(8);
cm.setDefaultMaxPerRoute(4);
```

<p>在 64 并发下，典型结果会像这样：</p>

| 配置 | 并发 | 下游固定耗时 | P50 | P95 | P99 | 最大值 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| maxTotal=8, perRoute=4 | 64 | 120ms | 860ms | 1880ms | 2140ms | 2300ms |

<p>很明显，<strong>实际业务处理只要 120ms，但客户端端到端延迟已经膨胀到秒级</strong>。膨胀出来的那部分，不是服务端做事花的时间，而是本地排队抢连接。</p>

<h2 id="步骤-4：把连接池调大，再跑一轮"><a href="#步骤-4：把连接池调大，再跑一轮" class="headerlink" title="步骤 4：把连接池调大，再跑一轮"></a>步骤 4：把连接池调大，再跑一轮</h2>
<p>把配置改成：</p>

```java
cm.setMaxTotal(128);
cm.setDefaultMaxPerRoute(64);
```

<p>再跑一次，你大概率会看到类似结果：</p>

| 配置 | 并发 | 下游固定耗时 | P50 | P95 | P99 | 最大值 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| maxTotal=128, perRoute=64 | 64 | 120ms | 124ms | 145ms | 168ms | 220ms |

<p>这时候结论就很清楚了：<strong>问题不在网络本身，也不在下游处理逻辑，而在客户端连接并发能力被你自己卡死了。</strong></p>

<h2 id="怎么验证真的是连接池在排队"><a href="#怎么验证真的是连接池在排队" class="headerlink" title="怎么验证真的是连接池在排队"></a>怎么验证真的是连接池在排队</h2>
<p>你至少可以从下面三个角度验证：</p>
<ul>
<li>把 <code>maxPerRoute</code> 调大后，P95/P99 是否明显下降；</li>
<li>把并发从 64 改成 8，再跑一次，延迟是否贴近下游 120ms；</li>
<li>把 <code>connectionRequestTimeout</code> 调得很小，比如 100ms，看是否开始大量报“从连接池拿连接超时”。</li>
</ul>

<p>第三种方法尤其好用，因为它能直接证明：有些请求根本不是“服务端响应慢”，而是“客户端没拿到连接就超时了”。</p>

<h1 id="再往深一点：用-JFR-看线程到底卡在哪"><a href="#再往深一点：用-JFR-看线程到底卡在哪" class="headerlink" title="再往深一点：用 JFR 看线程到底卡在哪"></a>再往深一点：用 JFR 看线程到底卡在哪</h1>
<p>只看压测结果还不够，我们最好再拿一个 JVM 侧证据。这里就轮到 <strong>JFR</strong> 出场了。</p>
<p>先用下面的方式启动程序：</p>

```bash
java \
  -XX:StartFlightRecording=filename=http-pool.jfr,duration=60s,settings=profile \
  -jar target/http-pool-demo.jar
```

<p>如果你不是打包成 jar，也可以对正在运行的进程执行：</p>

```bash
jcmd <pid> JFR.start name=HttpPool settings=profile duration=60s filename=http-pool.jfr
```

<p>录完后，用 JDK Mission Control 打开 <code>http-pool.jfr</code>，重点看这几类信息：</p>
<ul>
<li><strong>Threads</strong>：业务线程是不是大量处于 waiting / blocked；</li>
<li><strong>Method Profiling</strong>：热点是否集中在连接池租借相关逻辑，而不是业务处理；</li>
<li><strong>Socket Read</strong>：如果这里并不重，说明线程不是主要卡在网络读取；</li>
<li><strong>Java Monitor Blocked</strong>：如果连接池竞争明显，这里常能看到一些锁等待线索。</li>
</ul>

<p>一个很典型的现象是：你会发现 CPU 并不高，GC 也不重，但大量线程都在等资源。<strong>这类问题不是“算不过来”，而是“资源并发口太窄”。</strong></p>

<h1 id="压测工具-wrk-怎么配，才不至于测歪"><a href="#压测工具-wrk-怎么配，才不至于测歪" class="headerlink" title="压测工具 wrk 怎么配，才不至于测歪"></a>压测工具 wrk 怎么配，才不至于测歪</h1>
<p>如果你不想自己写 Java 并发代码，也可以直接用 <strong>wrk</strong> 打客户端服务入口，再让入口去调用下游。比如：</p>

```bash
wrk -t4 -c128 -d30s --latency http://127.0.0.1:8080/api/demo
```

<p>参数解释一下：</p>
<ul>
<li><code>-t4</code>：4 个压测线程；</li>
<li><code>-c128</code>：128 个连接；</li>
<li><code>-d30s</code>：持续 30 秒；</li>
<li><code>--latency</code>：输出延迟分布。</li>
</ul>
<p>这时候建议你分别测两版配置：</p>
<ol>
<li>连接池偏小；</li>
<li>连接池按容量估算放大；</li>
</ol>
<p>然后对比吞吐、P50、P95、P99。别只看平均值，因为平均值经常骗你。</p>

<h1 id="线上最容易踩的-5-个坑"><a href="#线上最容易踩的-5-个坑" class="headerlink" title="线上最容易踩的 5 个坑"></a>线上最容易踩的 5 个坑</h1>

<h2 id="坑-1：只配了总连接数，没配热点下游的-per-route"><a href="#坑-1：只配了总连接数，没配热点下游的-per-route" class="headerlink" title="坑 1：只配了总连接数，没配热点下游的 per-route"></a>坑 1：只配了总连接数，没配热点下游的 per-route</h2>
<p>比如 <code>maxTotal=200</code>，但 <code>defaultMaxPerRoute=10</code>。如果 90% 流量都打到同一个域名，那你实际上只有 10 条路可走。这个坑在线上非常常见。</p>

<h2 id="坑-2：connectTimeout-配了，connectionRequestTimeout-没配"><a href="#坑-2：connectTimeout-配了，connectionRequestTimeout-没配" class="headerlink" title="坑 2：connectTimeout 配了，connectionRequestTimeout 没配"></a>坑 2：connectTimeout 配了，connectionRequestTimeout 没配</h2>
<p><strong>connectTimeout</strong> 是建连超时，<strong>connectionRequestTimeout</strong> 是从连接池拿连接的等待超时。这俩不是一回事。很多人前者配得很认真，后者直接漏掉，于是线程可以在池子门口一直等。</p>

<h2 id="坑-3：把-keep-alive-当成“永远可用”"><a href="#坑-3：把-keep-alive-当成“永远可用”" class="headerlink" title="坑 3：把 keep-alive 当成“永远可用”"></a>坑 3：把 keep-alive 当成“永远可用”</h2>
<p>很多连接中间会经过 Nginx、SLB、Service Mesh、NAT 网关。它们可能比你想象中更早把空闲连接干掉。于是客户端还以为这个连接活着，真正发请求时才发现已经半死不活，轻则重试，重则报错。</p>
<p>所以你需要结合下游和中间层的超时策略，配置合适的连接空闲回收和存活策略，而不是“能复用就一直复用”。</p>

<h2 id="坑-4：重试策略和连接池问题叠加"><a href="#坑-4：重试策略和连接池问题叠加" class="headerlink" title="坑 4：重试策略和连接池问题叠加"></a>坑 4：重试策略和连接池问题叠加</h2>
<p>如果连接池已经紧张，这时候你再加 2 次、3 次自动重试，等于流量自己给自己放大。原本只是短时间抖动，最后容易演变成雪崩。</p>

<h2 id="坑-5：只盯-GC，不看客户端指标"><a href="#坑-5：只盯-GC，不看客户端指标" class="headerlink" title="坑 5：只盯 GC，不看客户端指标"></a>坑 5：只盯 GC，不看客户端指标</h2>
<p>很多 Java 团队一看到 RT 变差，就先去看 GC 日志。这没错，但不够。你还应该把这些指标打出来：</p>
<ul>
<li>连接池 leased / available / pending；</li>
<li>请求成功率、超时率、异常类型；</li>
<li>目标下游维度的 RT 分布；</li>
<li>重试次数；</li>
<li>连接新建速率与复用率。</li>
</ul>
<p>否则你只能看到“慢了”，但不知道慢在借连接、建连接、收响应，还是重试放大。</p>

<h1 id="一套更稳妥的工程实践建议"><a href="#一套更稳妥的工程实践建议" class="headerlink" title="一套更稳妥的工程实践建议"></a>一套更稳妥的工程实践建议</h1>
<p>如果你让我给一套比较实用、不过度设计的建议，我会这样做：</p>
<ol>
<li>按下游维度估算并发需求，别只看全局总连接数；</li>
<li>显式配置 <code>connectionRequestTimeout</code>、<code>connectTimeout</code>、<code>responseTimeout</code>；</li>
<li>给热点下游单独配置更高的 <code>maxPerRoute</code>；</li>
<li>把连接池 pending/leased 指标接到监控里；</li>
<li>遇到 P99 变差时，优先验证是不是“池内排队”；</li>
<li>重试要保守，最好配合熔断、限流，而不是无脑重试；</li>
<li>压测时看 P95/P99，不要只盯平均值；</li>
<li>保留 JFR 或 profiling 手段，给线上排障留证据。</li>
</ol>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<ul>
<li><strong>HTTP 客户端慢，不一定是下游慢，也可能是你自己连接池太小。</strong></li>
<li><strong>P99 爆炸，很多时候不是 CPU 打满，而是线程在本地排队等连接。</strong></li>
<li><strong>keep-alive 能省建连成本，但如果连接治理做不好，也会带来失效连接、复用失败、延迟抖动等问题。</strong></li>
<li><strong>工程上最关键的，不是背参数，而是建立“容量估算 → 压测对比 → JFR 佐证 → 指标监控”的闭环。</strong></li>
</ul>
<p>一句话收尾：<strong>别把所有“HTTP 慢”都甩锅给网络，先看看你的客户端是不是已经在门口堵死了。</strong></p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li>Apache HttpComponents Client 5 官方文档：<a href="https://hc.apache.org/httpcomponents-client-5.3.x/index.html">https://hc.apache.org/httpcomponents-client-5.3.x/index.html</a></li>
<li>Oracle JDK Flight Recorder 文档：<a href="https://docs.oracle.com/en/java/javase/21/troubleshoot/diagnostic-tools.html">https://docs.oracle.com/en/java/javase/21/troubleshoot/diagnostic-tools.html</a></li>
<li>wrk 项目说明：<a href="https://github.com/wg/wrk">https://github.com/wg/wrk</a></li>
<li>Nginx keepalive connections 文档：<a href="https://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive">https://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive</a></li>
<li>RFC 9112: HTTP/1.1：<a href="https://www.rfc-editor.org/rfc/rfc9112">https://www.rfc-editor.org/rfc/rfc9112</a></li>
</ol>
