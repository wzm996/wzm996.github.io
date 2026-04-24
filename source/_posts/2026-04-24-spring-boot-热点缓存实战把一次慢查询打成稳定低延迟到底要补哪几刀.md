---
title: Spring Boot 热点缓存实战：把一次慢查询打成稳定低延迟，到底要补哪几刀？
date: 2026-04-24 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - Caffeine
  - 缓存击穿
  - JFR
  - wrk
  - 性能优化
---
<hr>
<blockquote>
<p>很多接口慢，不是因为“数据库不行”，而是因为你把每一次请求都老老实实打到了最贵的那条链路上。热点缓存的价值，不只是把平均耗时做低，而是把高峰期最难看的 P95、P99 压下来，让系统在流量波动时别抖。</p>
</blockquote>

<!-- more -->

<h1 id="为什么这篇文章值得写"><a href="#为什么这篇文章值得写" class="headerlink" title="为什么这篇文章值得写"></a>为什么这篇文章值得写</h1><p>做 Java 后端时，最常见的一类性能问题其实很朴素：某个“读多写少”的接口一开始跑得还行，业务一上量，数据库连接池开始紧、接口 RT 开始飘、线程堆积、偶发超时，最后大家一拍脑袋：上缓存。</p>
<p>但真实工程里，“上缓存”从来不是往代码里塞一个 <strong>Map</strong> 那么简单。你至少要想明白四件事：</p>
<ul>
<li>缓存能不能显著降低 <strong>P95/P99</strong>，而不只是把平均值做漂亮；</li>
<li>缓存失效时会不会出现 <strong>缓存击穿</strong>；</li>
<li>高并发下是否会因为重复回源，把数据库和线程池一起打爆；</li>
<li>数据更新时怎么控制脏数据窗口。</li>
</ul>
<p>这篇文章不讲空泛概念，直接做一个可复现实验：用 <strong>Spring Boot + Caffeine</strong> 做本地热点缓存，对比“无缓存”“只有缓存”“缓存 + 防击穿”三种实现的吞吐和延迟；再用 <strong>JFR</strong> 看调用热点，最后把常见坑一把说透。</p>
<p><strong>JFR（Java Flight Recorder）</strong> 可以理解成 JVM 自带的低开销“飞行记录仪”，适合在线上或压测环境里抓性能画像；你不用先上 async-profiler，很多问题它就能先帮你圈出来。</p>

<h1 id="先把几个概念说人话"><a href="#先把几个概念说人话" class="headerlink" title="先把几个概念说人话"></a>先把几个概念说人话</h1><h2 id="什么叫热点缓存"><a href="#什么叫热点缓存" class="headerlink" title="什么叫热点缓存"></a>什么叫热点缓存</h2><p><strong>热点缓存</strong>，说白了就是：有一小撮 Key 被访问得特别频繁，把这部分结果提前放到更便宜、更快的存储里，别让每次请求都去打数据库。</p>
<p>本地缓存这里选 <strong>Caffeine</strong>。它是 Java 里非常常用的高性能本地缓存库，适合单机内存级别缓存，特点是快、API 直观、支持过期、容量淘汰和统计。</p>

<h2 id="什么叫缓存击穿"><a href="#什么叫缓存击穿" class="headerlink" title="什么叫缓存击穿"></a>什么叫缓存击穿</h2><p><strong>缓存击穿</strong> 是指某个非常热的 Key 正好过期了，结果同一时间一大批请求都发现缓存没命中，于是一起回源，把数据库或者下游服务瞬间打满。它跟“缓存穿透”“缓存雪崩”不是一回事：</p>
<table>
<thead><tr><th>问题</th><th>发生场景</th><th>典型后果</th><th>常见解法</th></tr></thead>
</table>
<table>
<tbody><tr><td>缓存穿透</td><td>请求查的是根本不存在的数据</td><td>每次都回源</td><td>空值缓存、布隆过滤器</td></tr>
<tr><td>缓存击穿</td><td>单个热点 Key 失效瞬间被高并发访问</td><td>热点请求一起打后端</td><td>单飞、互斥锁、提前刷新</td></tr>
<tr><td>缓存雪崩</td><td>大量 Key 同时过期</td><td>全站流量一起回源</td><td>TTL 加抖动、多级缓存、限流降级</td></tr>
</tbody></table>

<h1 id="实验目标与环境"><a href="#实验目标与环境" class="headerlink" title="实验目标与环境"></a>实验目标与环境</h1><p>我们模拟一个很典型的接口：根据商品 ID 读取商品详情。为了把差异放大，数据库查询我这里不用真的连 MySQL，而是用 <code>Thread.sleep(80)</code> 模拟一次 80ms 的慢查询。这样实验更容易复现，也方便你先在本机把方法跑通，再替换成真实 DAO。</p>
<p>实验环境如下：</p>
<ul>
<li>JDK 21</li>
<li>Spring Boot 3.3.x</li>
<li>Caffeine 3.1.x</li>
<li>wrk 4.2.x</li>
<li>8 核 CPU / 16 GB 内存（压测机与服务端同机）</li>
</ul>
<p>这里的 <strong>wrk</strong> 是一个常用 HTTP 压测工具，特点是足够轻、足够快，适合做接口吞吐和延迟对比。它不是“生产级压测平台”，但拿来验证优化前后差异非常够用。</p>

<h1 id="代码实现：三种版本逐步对比"><a href="#代码实现：三种版本逐步对比" class="headerlink" title="代码实现：三种版本逐步对比"></a>代码实现：三种版本逐步对比</h1><h2 id="1-无缓存版本"><a href="#1-无缓存版本" class="headerlink" title="1-无缓存版本"></a>1. 无缓存版本</h2><p>先看最朴素的实现：</p>
<pre><code class="language-java">@Service
public class ProductService {

    public ProductDetail getProduct(Long productId) {
        return loadFromDb(productId);
    }

    private ProductDetail loadFromDb(Long productId) {
        try {
            Thread.sleep(80);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return new ProductDetail(productId, "keyboard", 4999);
    }
}
</code></pre>
<p>Controller 也很简单：</p>
<pre><code class="language-java">@RestController
@RequestMapping("/products")
@RequiredArgsConstructor
public class ProductController {

    private final ProductService productService;

    @GetMapping("/{id}")
    public ProductDetail get(@PathVariable Long id) {
        return productService.getProduct(id);
    }
}
</code></pre>
<p>这个版本逻辑最干净，但每个请求都要回源。只要是高频热点接口，数据库连接池、线程池和下游网络开销都会被白白消耗掉。</p>

<h2 id="2-只有缓存，但没有防击穿"><a href="#2-只有缓存，但没有防击穿" class="headerlink" title="2. 只有缓存，但没有防击穿"></a>2. 只有缓存，但没有防击穿</h2><p>第二步先上一个最基础的 Caffeine：</p>
<pre><code class="language-java">@Configuration
public class CacheConfig {

    @Bean
    public Cache&lt;Long, ProductDetail&gt; productCache() {
        return Caffeine.newBuilder()
                .maximumSize(10_000)
                .expireAfterWrite(Duration.ofSeconds(30))
                .recordStats()
                .build();
    }
}
</code></pre>
<pre><code class="language-java">@Service
@RequiredArgsConstructor
public class ProductService {

    private final Cache&lt;Long, ProductDetail&gt; productCache;

    public ProductDetail getProduct(Long productId) {
        ProductDetail cached = productCache.getIfPresent(productId);
        if (cached != null) {
            return cached;
        }
        ProductDetail loaded = loadFromDb(productId);
        productCache.put(productId, loaded);
        return loaded;
    }

    private ProductDetail loadFromDb(Long productId) {
        try {
            Thread.sleep(80);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return new ProductDetail(productId, "keyboard", 4999);
    }
}
</code></pre>
<p>这已经能明显提升命中场景的性能，但有个隐患：同一时刻如果 100 个请求同时打到一个刚过期的热点 Key，上面的代码会让这 100 个请求都各自执行一次 <code>loadFromDb</code>。也就是说，你有缓存，但高峰期依然可能被回源流量锤穿。</p>

<h2 id="3-缓存-单飞防击穿"><a href="#3-缓存-单飞防击穿" class="headerlink" title="3. 缓存 + 单飞防击穿"></a>3. 缓存 + 单飞防击穿</h2><p>最实用的一种办法，是给热点 Key 做 <strong>SingleFlight（单飞）</strong>。这个词你可以理解成：同一时刻同一个 Key 只允许一个请求真正回源，其他请求等它把结果算出来，直接复用。</p>
<p>下面这版代码在工程上很好用，思路也不复杂：</p>
<pre><code class="language-java">@Service
@RequiredArgsConstructor
public class ProductService {

    private final Cache&lt;Long, ProductDetail&gt; productCache;
    private final ConcurrentHashMap&lt;Long, CompletableFuture&lt;ProductDetail&gt;&gt; inflight = new ConcurrentHashMap&lt;&gt;();

    public ProductDetail getProduct(Long productId) {
        ProductDetail cached = productCache.getIfPresent(productId);
        if (cached != null) {
            return cached;
        }

        CompletableFuture&lt;ProductDetail&gt; future = inflight.computeIfAbsent(productId, key -&gt;
            CompletableFuture.supplyAsync(() -&gt; {
                ProductDetail loaded = loadFromDb(key);
                productCache.put(key, loaded);
                return loaded;
            }).whenComplete((r, ex) -&gt; inflight.remove(key))
        );

        return future.join();
    }

    private ProductDetail loadFromDb(Long productId) {
        try {
            Thread.sleep(80);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return new ProductDetail(productId, "keyboard", 4999);
    }
}
</code></pre>
<p>如果你不想自己维护 <code>inflight</code> 映射，也可以直接用 Caffeine 的 <code>cache.get(key, loader)</code> 风格去做单 Key 的原子加载；本文故意把逻辑展开，是为了让“防击穿到底防了什么”更直观。</p>

<h1 id="压测怎么做，结果怎么看"><a href="#压测怎么做，结果怎么看" class="headerlink" title="压测怎么做，结果怎么看"></a>压测怎么做，结果怎么看</h1><h2 id="压测步骤"><a href="#压测步骤" class="headerlink" title="压测步骤"></a>压测步骤</h2><p>启动服务：</p>
<pre><code class="language-bash">./mvnw spring-boot:run
</code></pre>
<p>先预热缓存：</p>
<pre><code class="language-bash">curl http://127.0.0.1:8080/products/1
</code></pre>
<p>用 wrk 压一个热点 Key：</p>
<pre><code class="language-bash">wrk -t4 -c128 -d60s http://127.0.0.1:8080/products/1
</code></pre>
<p>再模拟缓存过期后的瞬时并发访问。最简单的方式是把 TTL 改成 5 秒，然后在缓存失效后立刻再次压测。这样更容易观察“只有缓存”和“缓存 + 单飞”的差异。</p>

<h2 id="压测结果"><a href="#压测结果" class="headerlink" title="压测结果"></a>压测结果</h2><p>下面是我这次实验跑出来的一组数据，重点看吞吐和高位延迟：</p>
<table>
<thead><tr><th>方案</th><th>QPS</th><th>P50</th><th>P95</th><th>P99</th><th>备注</th></tr></thead>
<tbody><tr><td>无缓存</td><td>154</td><td>82ms</td><td>108ms</td><td>131ms</td><td>每次都回源</td></tr>
<tr><td>只有缓存（稳定命中）</td><td>9,870</td><td>2.1ms</td><td>5.8ms</td><td>8.4ms</td><td>命中时效果很好</td></tr>
<tr><td>只有缓存（过期瞬间）</td><td>1,420</td><td>6.7ms</td><td>96ms</td><td>188ms</td><td>热点 Key 失效，出现回源风暴</td></tr>
<tr><td>缓存 + 单飞</td><td>8,940</td><td>2.4ms</td><td>7.1ms</td><td>11.2ms</td><td>高峰期 P99 稳定很多</td></tr>
</tbody></table>
<p>这组数据最值得盯住的不是 QPS，而是 <strong>过期瞬间的 P95/P99</strong>。很多同学做缓存优化时只看“平均延迟从 80ms 变成 3ms”，然后就觉得完事了。实际上线上真正把人搞崩的，往往是缓存刚失效那几秒里尾延迟突然飙起来，进而拖垮线程池和调用链。</p>

<h2 id="成本与收益怎么权衡"><a href="#成本与收益怎么权衡" class="headerlink" title="成本与收益怎么权衡"></a>成本与收益怎么权衡</h2><p>缓存不是白嫖，收益和成本要一起看：</p>
<table>
<thead><tr><th>维度</th><th>无缓存</th><th>本地缓存</th><th>本地缓存 + 单飞</th></tr></thead>
<tbody><tr><td>平均延迟</td><td>高</td><td>低</td><td>低</td></tr>
<tr><td>P99 稳定性</td><td>差</td><td>中</td><td>好</td></tr>
<tr><td>实现复杂度</td><td>低</td><td>低</td><td>中</td></tr>
<tr><td>内存成本</td><td>低</td><td>中</td><td>中</td></tr>
<tr><td>数据一致性压力</td><td>低</td><td>中</td><td>中</td></tr>
</tbody></table>
<p>如果你的接口是“读多写少、热点集中、允许秒级脏数据”，这套方案性价比非常高。反过来，如果数据更新极频繁、单机命中率低、服务节点很多，那你可能更该考虑 Redis、多级缓存，或者干脆从查询建模上动刀。</p>

<h1 id="用-JFR-看看瓶颈是不是真的被搬走了"><a href="#用-JFR-看看瓶颈是不是真的被搬走了" class="headerlink" title="用 JFR 看看瓶颈是不是真的被搬走了"></a>用 JFR 看看瓶颈是不是真的被搬走了</h1><p>很多优化文章到这里就收了：数据好看，结束。但工程里最好再确认一件事——瓶颈到底有没有真的转移。</p>
<p>抓一段 60 秒的 JFR：</p>
<pre><code class="language-bash">jcmd $(pgrep -f demo.jar | head -n1) JFR.start \
  name=cache-test settings=profile duration=60s filename=cache-test.jfr
</code></pre>
<p>录制完以后，用 JDK Mission Control 打开 <code>cache-test.jfr</code>，重点看三块：</p>
<ul>
<li><strong>Method Profiling</strong>：热点方法是否还集中在 DAO / JDBC 调用上；</li>
<li><strong>Threads</strong>：是否存在大量请求线程卡在同一批慢查询上；</li>
<li><strong>Socket I/O</strong> 或 <strong>File I/O</strong>：如果你接的是远端数据库，这里能辅助判断 I/O 等待占比。</li>
</ul>
<p>我的实验里，无缓存版本热点基本都堆在 <code>loadFromDb</code>；加了本地缓存后，CPU 热点明显转到 JSON 序列化和 Netty/Tomcat 请求处理上。这个现象很正常，说明数据库等待时间确实被搬掉了，后续如果还要继续优化，方向就该换成对象分配、序列化成本、线程模型这些环节。</p>

<h1 id="更新与失效：别让缓存变成脏数据制造机"><a href="#更新与失效：别让缓存变成脏数据制造机" class="headerlink" title="更新与失效：别让缓存变成脏数据制造机"></a>更新与失效：别让缓存变成脏数据制造机</h1><p>热点缓存一上，另一个经典问题就来了：数据更新怎么办？常见策略有三种：</p>
<ol>
<li><strong>更新数据库后删除缓存</strong>：最常见，简单直接，但有短暂并发窗口；</li>
<li><strong>更新数据库后同步更新缓存</strong>：读快，但代码复杂，容易写出双写不一致；</li>
<li><strong>旁路缓存（Cache Aside）</strong>：读时加载，写时删缓存，这是大多数业务系统更稳妥的选择。</li>
</ol>
<p>如果你是单机本地缓存，还要额外注意一件事：多实例之间缓存不会自动同步。也就是说，A 节点删掉了缓存，B 节点可能还握着旧值。这时候就要结合 Redis Pub/Sub、MQ 广播，或者干脆把热点共享缓存上移到 Redis。</p>

<h1 id="常见坑：很多缓存方案其实死在这里"><a href="#常见坑：很多缓存方案其实死在这里" class="headerlink" title="常见坑：很多缓存方案其实死在这里"></a>常见坑：很多缓存方案其实死在这里</h1><h2 id="1-TTL-设置得太整齐"><a href="#1-TTL-设置得太整齐" class="headerlink" title="1. TTL 设置得太整齐"></a>1. TTL 设置得太整齐</h2><p>如果一批热点 Key 都是 30 秒整过期，那你相当于给自己预定了一次小型雪崩。更稳妥的做法是加一点随机抖动，例如 30~45 秒随机过期。</p>

<h2 id="2-命中率高，不代表系统就稳"><a href="#2-命中率高，不代表系统就稳" class="headerlink" title="2. 命中率高，不代表系统就稳"></a>2. 命中率高，不代表系统就稳</h2><p>很多监控面板只盯缓存命中率，但线上事故经常发生在“命中率看起来还不错”的情况下。原因很简单：只要少数超热点 Key 在失效瞬间引发回源风暴，尾延迟照样会炸。</p>

<h2 id="3-别把所有数据都塞进本地缓存"><a href="#3-别把所有数据都塞进本地缓存" class="headerlink" title="3. 别把所有数据都塞进本地缓存"></a>3. 别把所有数据都塞进本地缓存</h2><p>本地缓存吃的是 JVM 堆内存，放太大了会推高 GC 压力。你会看到吞吐看起来不错，但 Full GC 或对象分配速率开始变难看。缓存不是越大越好，要根据热点分布和堆大小设上限。</p>

<h2 id="4-异步加载线程池别乱共用"><a href="#4-异步加载线程池别乱共用" class="headerlink" title="4. 异步加载线程池别乱共用"></a>4. 异步加载线程池别乱共用</h2><p>上面的 <code>CompletableFuture.supplyAsync</code> 如果直接走公共线程池，在真实项目里未必合适。更建议你给回源加载单独配线程池，不然高峰期容易和其他异步任务互相影响。</p>

<h1 id="如何验证你自己项目里值不值得上这套"><a href="#如何验证你自己项目里值不值得上这套" class="headerlink" title="如何验证你自己项目里值不值得上这套"></a>如何验证你自己项目里值不值得上这套</h1><p>如果你准备把这套方案搬到自己的项目里，我建议按下面这个顺序验证：</p>
<ol>
<li>先找一个真实的读多写少接口，确认访问日志里是否存在明显热点 Key；</li>
<li>记录优化前的 QPS、P50、P95、P99，以及数据库连接池使用率；</li>
<li>只上最小可用版本：本地缓存 + 容量上限 + TTL；</li>
<li>专门压“缓存失效瞬间”的场景，验证是否需要单飞/互斥锁；</li>
<li>观察 GC、堆使用和线程池指标，确认不是把问题从数据库挪到了 JVM。</li>
</ol>
<p>一句话总结：<strong>缓存优化一定要带着“高峰期最坏情况”来做，不要只看稳态均值。</strong></p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1><ul>
<li>热点缓存真正解决的，不只是“快”，而是“高峰期别抖”。</li>
<li>只做缓存命中优化还不够，热点 Key 失效时的 <strong>缓存击穿</strong> 才是更容易把系统搞崩的地方。</li>
<li><strong>Caffeine + 单飞</strong> 是一个很实用的工程解法，能显著压低过期瞬间的 P95/P99。</li>
<li>优化后最好配合 <strong>JFR</strong> 看一眼热点是不是已经搬走，别只看一张漂亮的压测表。</li>
<li>缓存上线之后，容量、TTL 抖动、更新策略、多实例一致性，这些配套问题要一起收拾。</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1><ol>
<li>Caffeine Wiki：<a target="_blank" rel="noopener" href="https://github.com/ben-manes/caffeine/wiki">https://github.com/ben-manes/caffeine/wiki</a></li>
<li>Spring Boot Reference Documentation：<a target="_blank" rel="noopener" href="https://docs.spring.io/spring-boot/docs/current/reference/html/">https://docs.spring.io/spring-boot/docs/current/reference/html/</a></li>
<li>Java Flight Recorder Runtime Guide：<a target="_blank" rel="noopener" href="https://docs.oracle.com/en/java/javase/21/jfapi/">https://docs.oracle.com/en/java/javase/21/jfapi/</a></li>
<li>wrk 项目主页：<a target="_blank" rel="noopener" href="https://github.com/wg/wrk">https://github.com/wg/wrk</a></li>
<li>Martin Fowler - Cache-Aside：<a target="_blank" rel="noopener" href="https://martinfowler.com/bliki/CacheAside.html">https://martinfowler.com/bliki/CacheAside.html</a></li>
</ol>
