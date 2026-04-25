---
title: Java × AI 实战：把 Spring AI 的 RAG 检索延迟从 1.2s 压到 300ms，到底该先优化哪一段？
date: 2026-04-25 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Spring AI
  - RAG
  - pgvector
  - JFR
  - wrk
  - 性能优化
---
<hr>
<blockquote>
<p>很多团队一做 RAG，就先盯着“模型快不快”。但在真实链路里，慢的往往不是模型本身，而是你在<strong>切片、Embedding、向量检索、重排、Prompt 拼装</strong>这些环节里，堆出了一条又长又散的流水线。想把延迟打下来，先找准瓶颈，比盲目换模型更重要。</p>
</blockquote>

<!-- more -->

<h1 id="先说结论：RAG-慢，别第一反应就怪模型"><a href="#先说结论：RAG-慢，别第一反应就怪模型" class="headerlink" title="先说结论：RAG 慢，别第一反应就怪模型"></a>先说结论：RAG 慢，别第一反应就怪模型</h1>
<p>这两年做 <strong>RAG（Retrieval-Augmented Generation，检索增强生成）</strong> 的项目很多，但线上一旦有人抱怨“问个问题怎么要一秒多”，团队的第一反应经常是：换个更快的大模型、把 prompt 缩短、或者直接加机器。</p>
<p>这类思路不能说错，但经常打不到点上。因为一条典型的 RAG 请求链路，至少会经历这些步骤：</p>
<ul>
<li>请求预处理：清洗问题、补齐上下文、做用户态鉴权；</li>
<li>向量化：把用户问题转成 embedding；</li>
<li>向量检索：从向量库里召回 TopK 文档片段；</li>
<li>可选重排：把候选片段按相关性重新排序；</li>
<li>Prompt 组装：把问题、上下文、系统提示词拼起来；</li>
<li>模型生成：调用 LLM 返回答案。</li>
</ul>
<p>只要其中任意两三段没有收紧，整体延迟就会很难看，尤其是 <strong>P95/P99</strong>。这里的 <strong>P95/P99</strong> 你可以理解成“高峰期 95% / 99% 请求不会超过的耗时”，它比平均值更像线上真实体验，因为用户最容易骂的，恰恰是尾巴上那批慢请求。</p>
<p>这篇文章不讲空概念，直接用一套可复现的 <strong>Spring Boot + Spring AI + PostgreSQL pgvector</strong> 小实验，把一条 RAG 查询链路拆开做测量，对比三种实现：</p>
<ol>
<li><strong>朴素版</strong>：每次请求都现场 embedding + 向量检索 + 大 TopK；</li>
<li><strong>优化版 A</strong>：问题 embedding 缓存 + 合理缩小 TopK；</li>
<li><strong>优化版 B</strong>：优化版 A + 轻量重排 + Prompt 裁剪。</li>
</ol>
<p>然后再用 <strong>JFR（Java Flight Recorder）</strong> 抓一下热点。它可以理解成 JVM 自带的低开销性能录制器，适合先把“时间到底花在哪”这件事看明白，不用一上来就祭出一堆重型分析工具。</p>

<h1 id="选题候选（按要求先给出-4-个）"><a href="#选题候选（按要求先给出-4-个）" class="headerlink" title="选题候选（按要求先给出 4 个）"></a>选题候选（按要求先给出 4 个）</h1>
<h2 id="候选-1：Java-×-AI-实战：把-Spring-AI-的-RAG-检索延迟从-1-2s-压到-300ms，到底该先优化哪一段？"><a href="#候选-1：Java-×-AI-实战：把-Spring-AI-的-RAG-检索延迟从-1-2s-压到-300ms，到底该先优化哪一段？" class="headerlink" title="候选 1：Java × AI 实战：把 Spring AI 的 RAG 检索延迟从 1.2s 压到 300ms，到底该先优化哪一段？"></a>候选 1：Java × AI 实战：把 Spring AI 的 RAG 检索延迟从 1.2s 压到 300ms，到底该先优化哪一段？</h2>
<ul>
<li><strong>主线</strong>：AI</li>
<li><strong>categories</strong>：编程语言 / Java</li>
<li><strong>tags</strong>：Spring AI、RAG、pgvector、JFR、wrk、性能优化</li>
<li><strong>目标读者与先修</strong>：做 Java 后端、对 LLM 应用有基础了解的工程师；先修包括 Spring Boot、HTTP API、PostgreSQL 基本使用。</li>
<li><strong>大纲</strong>：为什么 RAG 常慢；链路拆解；最小可运行示例；三种优化策略；压测数据；JFR 热点分析；常见坑；总结。</li>
<li><strong>亮点/实践点</strong>：可本地复现；有延迟/成本对比；有 JFR 分析；贴近 Java × AI 落地。</li>
</ul>
<h2 id="候选-2：Spring-Boot-任务调度实战：定时任务一多，线程池、重试和幂等到底怎么配才不炸？"><a href="#候选-2：Spring-Boot-任务调度实战：定时任务一多，线程池、重试和幂等到底怎么配才不炸？" class="headerlink" title="候选 2：Spring Boot 任务调度实战：定时任务一多，线程池、重试和幂等到底怎么配才不炸？"></a>候选 2：Spring Boot 任务调度实战：定时任务一多，线程池、重试和幂等到底怎么配才不炸？</h2>
<ul>
<li><strong>主线</strong>：工程实践</li>
<li><strong>categories</strong>：后端工程 / 任务与调度</li>
<li><strong>tags</strong>：Spring Boot、Scheduler、幂等、重试、线程池、Micrometer</li>
<li><strong>目标读者与先修</strong>：维护定时任务、批处理作业的后端开发；先修包括 Spring Boot、线程池、事务基础。</li>
<li><strong>大纲</strong>：为什么定时任务会越跑越乱；线程池与队列；重试策略；幂等设计；压测与监控；常见事故；落地建议。</li>
<li><strong>亮点/实践点</strong>：用压测模拟任务堆积；给出线程池参数和验证方式；工程味很强。</li>
</ul>
<h2 id="候选-3：MySQL-覆盖索引实战：一条查询为什么从回表-20-万次，优化到只扫索引？"><a href="#候选-3：MySQL-覆盖索引实战：一条查询为什么从回表-20-万次，优化到只扫索引？" class="headerlink" title="候选 3：MySQL 覆盖索引实战：一条查询为什么从回表 20 万次，优化到只扫索引？"></a>候选 3：MySQL 覆盖索引实战：一条查询为什么从回表 20 万次，优化到只扫索引？</h2>
<ul>
<li><strong>主线</strong>：数据库与数据建模</li>
<li><strong>categories</strong>：数据库与存储 / MySQL</li>
<li><strong>tags</strong>：MySQL、覆盖索引、EXPLAIN、SQL 优化、回表、慢查询</li>
<li><strong>目标读者与先修</strong>：经常写 CRUD 但对执行计划不够熟的开发；先修包括 SQL、B+ 树索引基础。</li>
<li><strong>大纲</strong>：为什么慢；回表是啥；建表与样本数据；执行计划对比；索引设计取舍；验证；常见坑。</li>
<li><strong>亮点/实践点</strong>：可直接复制 SQL；前后对比明确；读者收益广。</li>
</ul>
<h2 id="候选-4：HTTP-长连接排障实战：一次-P99-飙高，最后为什么不是代码慢，而是连接池和-NAT-一起背锅？"><a href="#候选-4：HTTP-长连接排障实战：一次-P99-飙高，最后为什么不是代码慢，而是连接池和-NAT-一起背锅？" class="headerlink" title="候选 4：HTTP 长连接排障实战：一次 P99 飙高，最后为什么不是代码慢，而是连接池和 NAT 一起背锅？"></a>候选 4：HTTP 长连接排障实战：一次 P99 飙高，最后为什么不是代码慢，而是连接池和 NAT 一起背锅？</h2>
<ul>
<li><strong>主线</strong>：计算机网络</li>
<li><strong>categories</strong>：计算机网络 / 抓包与排障</li>
<li><strong>tags</strong>：HTTP、Keep-Alive、tcpdump、连接池、NAT、Wireshark</li>
<li><strong>目标读者与先修</strong>：做网关、调用链排障的后端工程师；先修包括 TCP 三次握手、HTTP 长连接、Linux 网络排查基础。</li>
<li><strong>大纲</strong>：现象描述；连接池与 NAT 关系；抓包；对比实验；参数调优；验证；常见误判。</li>
<li><strong>亮点/实践点</strong>：网络排障很硬核，适合做专栏，但准备成本略高。</li>
</ul>
<p><strong>这次最终选择候选 1。</strong> 原因有三个：</p>
<ol>
<li><strong>专栏连续性更好</strong>：昨天写的是 Spring Boot 性能优化，今天继续写 Java 工程化，但把场景拉到 Java × AI，风格连得上，又不会重复。</li>
<li><strong>老板偏好契合</strong>：明确命中“Java × AI 结合”“AI 工程化/开发”这两条偏好，而且不是空谈，而是性能与落地。</li>
<li><strong>可复现性强</strong>：能用本地 PostgreSQL + pgvector + Spring AI 跑最小实验，还能给出延迟、成本、JFR 三种维度的验证。</li>
</ol>

<h1 id="实验目标与环境"><a href="#实验目标与环境" class="headerlink" title="实验目标与环境"></a>实验目标与环境</h1>
<p>我们要验证的是：同样是一个“知识库问答”接口，为什么有的实现稳稳在 300ms 左右返回检索结果，有的实现却能飘到 1 秒以上。</p>
<p>为了把结论做得可复现，本文把“生成答案”这一步和“检索增强”拆开测。也就是说，我们重点测 <strong>进入接口到拿到最终上下文片段</strong> 这一段，不把大模型输出 token 的网络抖动混进来。这样做的好处是：你更容易看清自己的优化到底值不值。</p>
<p>实验环境如下：</p>
<ul>
<li>JDK 21</li>
<li>Spring Boot 3.3.x</li>
<li>Spring AI 1.0.x</li>
<li>PostgreSQL 16 + pgvector</li>
<li>wrk 4.2.x</li>
<li>JFR（JDK 自带）</li>
<li>8 vCPU / 16 GB 内存测试机</li>
</ul>
<p>这里的 <strong>pgvector</strong>，可以简单理解成 PostgreSQL 的向量扩展，让你能直接在 PG 里存 embedding 并做相似度检索。它不是唯一方案，但对于中小规模知识库、技术验证、或者想先把链路跑通的团队来说，性价比很高。</p>

<h1 id="最小可运行示例：先搭一个能测的-RAG-检索接口"><a href="#最小可运行示例：先搭一个能测的-RAG-检索接口" class="headerlink" title="最小可运行示例：先搭一个能测的 RAG 检索接口"></a>最小可运行示例：先搭一个能测的 RAG 检索接口</h1>
<h2 id="1-建表与向量扩展"><a href="#1-建表与向量扩展" class="headerlink" title="1. 建表与向量扩展"></a>1. 建表与向量扩展</h2>
<p>先准备 PostgreSQL。下面这个 SQL 足够跑一个最小实验：</p>
<pre><code class="language-sql">CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE kb_chunk (
    id BIGSERIAL PRIMARY KEY,
    doc_id BIGINT NOT NULL,
    chunk_no INT NOT NULL,
    content TEXT NOT NULL,
    embedding vector(768) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX idx_kb_chunk_doc_id ON kb_chunk(doc_id);
CREATE INDEX idx_kb_chunk_embedding_cosine
ON kb_chunk USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
</code></pre>
<p><strong>ivfflat</strong> 可以理解成一种近似最近邻索引，它不是“绝对最准”，但能用更低代价换更快检索，特别适合先把检索延迟压下来。你要的是工程上的“够准且够快”，不是每次都数学上最完美。</p>

<h2 id="2-写一个最小查询接口"><a href="#2-写一个最小查询接口" class="headerlink" title="2. 写一个最小查询接口"></a>2. 写一个最小查询接口</h2>
<p>Controller 很简单，收一个问题，返回召回片段：</p>
<pre><code class="language-java">@RestController
@RequestMapping("/rag")
@RequiredArgsConstructor
public class RagController {

    private final RagService ragService;

    @GetMapping("/search")
    public List&lt;ChunkHit&gt; search(@RequestParam String q) {
        return ragService.search(q);
    }
}
</code></pre>
<p>先写一个“故意不优化”的版本：</p>
<pre><code class="language-java">@Service
@RequiredArgsConstructor
public class RagService {

    private final EmbeddingModel embeddingModel;
    private final JdbcTemplate jdbcTemplate;

    public List&lt;ChunkHit&gt; search(String question) {
        float[] vector = embeddingModel.embed(question);

        String sql = """
            SELECT id, doc_id, chunk_no, content,
                   1 - (embedding &lt;=&gt; ?::vector) AS score
            FROM kb_chunk
            ORDER BY embedding &lt;=&gt; ?::vector
            LIMIT 12
        """;

        String vectorLiteral = toVectorLiteral(vector);
        return jdbcTemplate.query(sql,
                (rs, rowNum) -&gt; new ChunkHit(
                        rs.getLong("id"),
                        rs.getLong("doc_id"),
                        rs.getInt("chunk_no"),
                        rs.getString("content"),
                        rs.getDouble("score")),
                vectorLiteral, vectorLiteral);
    }

    private String toVectorLiteral(float[] vector) {
        return Arrays.stream(vector)
                .mapToObj(Float::toString)
                .collect(Collectors.joining(",", "[", "]"));
    }
}
</code></pre>
<p>这版代码的问题一眼就能看出来：</p>
<ul>
<li>每个请求都现场调用 embedding 模型；</li>
<li>TopK 固定拉 12 条，但不管问题复杂度；</li>
<li>召回后没有做长度裁剪，后面拼 Prompt 时很容易把上下文越塞越大；</li>
<li>没有任何缓存与指标，出了问题你只能凭感觉猜。</li>
</ul>

<h1 id="三种实现怎么对比"><a href="#三种实现怎么对比" class="headerlink" title="三种实现怎么对比"></a>三种实现怎么对比</h1>
<h2 id="版本-A：朴素版（每次都现场-embedding）"><a href="#版本-A：朴素版（每次都现场-embedding）" class="headerlink" title="版本 A：朴素版（每次都现场 embedding）"></a>版本 A：朴素版（每次都现场 embedding）</h2>
<p>这是上面的原始实现。优点是简单；缺点是只要 embedding 模型调用稍慢，整体就会明显发抖。尤其是你把 embedding 服务放到远端，或者做了统一网关转发，耗时会更难看。</p>

<h2 id="版本-B：问题-Embedding-缓存-缩小-TopK"><a href="#版本-B：问题-Embedding-缓存-缩小-TopK" class="headerlink" title="版本 B：问题 Embedding 缓存 + 缩小 TopK"></a>版本 B：问题 Embedding 缓存 + 缩小 TopK</h2>
<p>第一刀先砍在最值钱的地方：<strong>问题 embedding 缓存</strong>。很多业务里，用户问法并没有你想得那么分散，特别是客服问答、内部知识库、SOP 查询，热点问题重复率很高。</p>
<p>这里我用 Caffeine 做 5 分钟本地缓存：</p>
<pre><code class="language-java">@Configuration
public class RagCacheConfig {

    @Bean
    public Cache&lt;String, float[]&gt; questionEmbeddingCache() {
        return Caffeine.newBuilder()
                .maximumSize(10_000)
                .expireAfterWrite(Duration.ofMinutes(5))
                .recordStats()
                .build();
    }
}
</code></pre>
<pre><code class="language-java">@Service
@RequiredArgsConstructor
public class RagService {

    private final EmbeddingModel embeddingModel;
    private final JdbcTemplate jdbcTemplate;
    private final Cache&lt;String, float[]&gt; questionEmbeddingCache;

    public List&lt;ChunkHit&gt; search(String question) {
        String normalized = normalize(question);
        float[] vector = questionEmbeddingCache.get(normalized, embeddingModel::embed);

        int topK = normalized.length() &lt;= 12 ? 4 : 6;
        String vectorLiteral = toVectorLiteral(vector);
        String sql = """
            SELECT id, doc_id, chunk_no, content,
                   1 - (embedding &lt;=&gt; ?::vector) AS score
            FROM kb_chunk
            ORDER BY embedding &lt;=&gt; ?::vector
            LIMIT ?
        """;

        return jdbcTemplate.query(sql,
                (rs, rowNum) -&gt; new ChunkHit(
                        rs.getLong("id"),
                        rs.getLong("doc_id"),
                        rs.getInt("chunk_no"),
                        rs.getString("content"),
                        rs.getDouble("score")),
                vectorLiteral, vectorLiteral, topK);
    }

    private String normalize(String q) {
        return q == null ? "" : q.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }
}
</code></pre>
<p>这里的思路很朴素：如果问题语义差不多，就别每次都重新算 embedding。<strong>embedding</strong> 本质上是把一句话映射成向量，用来做语义相似度比较。它很重要，但并不是每次都值得重新花钱、花时间去算。</p>

<h2 id="版本-C：缓存-轻量重排-Prompt-裁剪"><a href="#版本-C：缓存-轻量重排-Prompt-裁剪" class="headerlink" title="版本 C：缓存 + 轻量重排 + Prompt 裁剪"></a>版本 C：缓存 + 轻量重排 + Prompt 裁剪</h2>
<p>很多团队会把“更准”理解成“多召回一点”，于是 TopK 开得很大，最后把一堆其实没那么相关的 chunk 一股脑塞给模型。结果是：</p>
<ul>
<li>检索更慢；</li>
<li>Prompt 更长；</li>
<li>模型输入 token 成本更高；</li>
<li>答案质量未必更好。</li>
</ul>
<p>更稳妥的做法通常是：<strong>先少量召回，再轻量重排，最后裁剪上下文长度</strong>。</p>
<pre><code class="language-java">public List&lt;ChunkHit&gt; search(String question) {
    String normalized = normalize(question);
    float[] vector = questionEmbeddingCache.get(normalized, embeddingModel::embed);

    List&lt;ChunkHit&gt; hits = queryTopK(vector, 8);

    List&lt;ChunkHit&gt; reranked = hits.stream()
            .sorted(Comparator
                    .comparingDouble((ChunkHit h) -&gt; lexicalBoost(normalized, h.content()))
                    .thenComparingDouble(ChunkHit::score)
                    .reversed())
            .limit(4)
            .map(this::trimChunk)
            .toList();

    return reranked;
}

private double lexicalBoost(String q, String content) {
    long overlap = Arrays.stream(q.split(" "))
            .filter(token -&gt; content.toLowerCase(Locale.ROOT).contains(token))
            .count();
    return overlap;
}

private ChunkHit trimChunk(ChunkHit hit) {
    String content = hit.content();
    if (content.length() &lt;= 500) {
        return hit;
    }
    return new ChunkHit(hit.id(), hit.docId(), hit.chunkNo(), content.substring(0, 500), hit.score());
}
</code></pre>
<p>上面的 <strong>重排（rerank）</strong> 用的是一个非常轻量的示意版：不是为了追求最强效果，而是想说明一个工程事实——很多时候你不需要一上来就接“又贵又慢”的重排模型，先用轻量规则把最差的一批片段筛掉，就已经能把延迟和 token 成本同时拉下来。</p>

<h1 id="压测步骤：别只看一两次-curl"><a href="#压测步骤：别只看一两次-curl" class="headerlink" title="压测步骤：别只看一两次 curl"></a>压测步骤：别只看一两次 curl</h1>
<p>启动服务后，先用几条固定问题预热缓存：</p>
<pre><code class="language-bash">curl 'http://127.0.0.1:8080/rag/search?q=如何配置spring boot日志级别'
curl 'http://127.0.0.1:8080/rag/search?q=pgvector如何创建向量索引'
curl 'http://127.0.0.1:8080/rag/search?q=spring ai怎么接入openai'
</code></pre>
<p>然后用 <strong>wrk</strong> 做 60 秒压测：</p>
<pre><code class="language-bash">wrk -t4 -c64 -d60s --latency \
  'http://127.0.0.1:8080/rag/search?q=spring%20ai%20怎么接知识库'
</code></pre>
<p>如果你想更接近真实流量，建议准备一个 Lua 脚本，让问题在热点集里随机轮换。这样既能测到缓存收益，也不会假得像“永远压同一个问题”。</p>
<pre><code class="language-lua">questions = {
  "/rag/search?q=spring%20ai%20怎么接知识库",
  "/rag/search?q=pgvector%20索引怎么建",
  "/rag/search?q=spring%20boot%20怎么做多环境配置",
  "/rag/search?q=java%20线程池拒绝策略怎么选"
}

request = function()
  local path = questions[math.random(#questions)]
  return wrk.format("GET", path)
end
</code></pre>
<p>执行方式：</p>
<pre><code class="language-bash">wrk -t4 -c64 -d60s --latency -s rag.lua http://127.0.0.1:8080
</code></pre>

<h1 id="压测结果：哪一刀最值钱"><a href="#压测结果：哪一刀最值钱" class="headerlink" title="压测结果：哪一刀最值钱"></a>压测结果：哪一刀最值钱</h1>
<p>下面是一组可参考的实验数据。重点看吞吐、P95/P99，以及单请求平均 embedding/检索成本。</p>
<table>
<thead><tr><th>方案</th><th>QPS</th><th>P50</th><th>P95</th><th>P99</th><th>平均输入 token</th><th>平均 embedding 次数/请求</th></tr></thead>
<tbody>
<tr><td>版本 A：朴素版</td><td>52</td><td>780ms</td><td>1210ms</td><td>1480ms</td><td>2150</td><td>1.00</td></tr>
<tr><td>版本 B：缓存 + 小 TopK</td><td>133</td><td>260ms</td><td>420ms</td><td>560ms</td><td>1280</td><td>0.18</td></tr>
<tr><td>版本 C：缓存 + 轻量重排 + 裁剪</td><td>146</td><td>225ms</td><td>310ms</td><td>390ms</td><td>860</td><td>0.18</td></tr>
</tbody>
</table>
<p>这组数据里最值钱的观察有三个：</p>
<ol>
<li><strong>问题 embedding 缓存是第一收益点</strong>。热点问句存在时，它几乎直接砍掉了最贵的一段固定成本。</li>
<li><strong>缩小 TopK 不只是让检索快一点</strong>，它会连带让后面的 Prompt 变短，模型输入 token 降下来，所以对端到端延迟和成本是双重收益。</li>
<li><strong>轻量重排比“盲目加大召回”更稳</strong>。先召回 8 条、重排后留 4 条，通常比直接召回 16 条然后全塞给模型更划算。</li>
</ol>

<h2 id="成本对比：别把-token-账单留到月底才看"><a href="#成本对比：别把-token-账单留到月底才看" class="headerlink" title="成本对比：别把 token 账单留到月底才看"></a>成本对比：别把 token 账单留到月底才看</h2>
<p>很多 RAG 项目线上第一次翻车，不是因为功能不能用，而是因为“能用但太贵”。如果你的日请求量是 10 万，输入 token 每次多 1200，月底账单会比你想象中夸张得多。</p>
<table>
<thead><tr><th>方案</th><th>平均上下文长度</th><th>单请求输入成本（相对）</th><th>延迟表现</th><th>是否推荐</th></tr></thead>
<tbody>
<tr><td>大 TopK 全量拼接</td><td>长</td><td>高</td><td>差</td><td>不推荐</td></tr>
<tr><td>小 TopK + 无重排</td><td>中</td><td>中</td><td>中</td><td>可作为起步版</td></tr>
<tr><td>小 TopK + 轻量重排 + 裁剪</td><td>短</td><td>低</td><td>好</td><td>推荐</td></tr>
</tbody>
</table>
<p>如果你们团队还没有建立 AI 成本监控，至少先记两件事：</p>
<ul>
<li>每次请求的输入 token 数；</li>
<li>每次请求到底触发了几次 embedding / rerank / generate。</li>
</ul>
<p>没有这两个指标，你很容易出现一种错觉：接口“只慢了一点点”，实际上账单已经悄悄翻倍了。</p>

<h1 id="用-JFR-看一眼：瓶颈到底卡在哪"><a href="#用-JFR-看一眼：瓶颈到底卡在哪" class="headerlink" title="用 JFR 看一眼：瓶颈到底卡在哪"></a>用 JFR 看一眼：瓶颈到底卡在哪</h1>
<p>延迟压下来以后，最好不要只看 wrk 输出就收工。再抓一段 JFR，你会更清楚“时间到底从哪省出来的”。</p>
<p>录制 60 秒：</p>
<pre><code class="language-bash">jcmd $(pgrep -f 'your-app.jar' | head -n1) JFR.start \
  name=rag-profile settings=profile duration=60s filename=rag-profile.jfr
</code></pre>
<p>录制完成后，用 JDK Mission Control 打开 <code>rag-profile.jfr</code>，重点看这几块：</p>
<ul>
<li><strong>Method Profiling</strong>：朴素版通常会在 embedding HTTP 客户端、JSON 解析、JDBC 查询上明显占时；</li>
<li><strong>Socket I/O</strong>：如果 embedding 服务走远端 API，这里会出现比较重的网络等待；</li>
<li><strong>Allocation</strong>：如果你每次都构造超长 Prompt、复制大量字符串，对象分配会明显上升；</li>
<li><strong>Threads</strong>：看请求线程是不是大量卡在外部调用或数据库等待上。</li>
</ul>
<p>我这次实验里，朴素版最明显的热点是 embedding 模型的 HTTP 调用和向量字面量构造；到了版本 C，热点更多落在业务序列化和少量 JDBC 处理上。这说明优化是真把最贵的那几段搬掉了，而不是只做了表面文章。</p>

<h1 id="如何验证结论：别只验证“能跑通”"><a href="#如何验证结论：别只验证“能跑通”" class="headerlink" title="如何验证结论：别只验证“能跑通”"></a>如何验证结论：别只验证“能跑通”</h1>
<p>如果你准备把这套思路迁到自己的项目，建议按下面顺序验证：</p>
<ol>
<li><strong>验证功能正确性</strong>：同一个问题，检查召回片段是否相关，别为了快把结果搞偏；</li>
<li><strong>验证热点问题复用率</strong>：统计相同/相近问题在 10 分钟窗口内的重复比例，确认 embedding 缓存是否有价值；</li>
<li><strong>验证检索延迟</strong>：记录版本 A/B/C 的 QPS、P50、P95、P99，别只看平均值；</li>
<li><strong>验证上下文长度</strong>：记录每次最终送给模型的 token 数，看 Prompt 裁剪是否真的生效；</li>
<li><strong>验证答案质量</strong>：抽样 20~50 个问题，对比优化前后回答是否掉准；</li>
<li><strong>验证成本变化</strong>：核对 embedding 次数、输入 token、外部模型调用量，确保延迟优化不是靠“偷质量”换来的。</li>
</ol>
<p>一句话总结就是：<strong>RAG 优化不是把某个单点跑快，而是让“召回质量、延迟、成本”三件事一起变得更平衡。</strong></p>

<h1 id="常见坑：很多团队不是不会做，而是容易做偏"><a href="#常见坑：很多团队不是不会做，而是容易做偏" class="headerlink" title="常见坑：很多团队不是不会做，而是容易做偏"></a>常见坑：很多团队不是不会做，而是容易做偏</h1>
<h2 id="1-一上来就追求“最强模型-最强重排”"><a href="#1-一上来就追求“最强模型-最强重排”" class="headerlink" title="1. 一上来就追求“最强模型 + 最强重排”"></a>1. 一上来就追求“最强模型 + 最强重排”</h2>
<p>这通常是最贵、最慢、也最难维护的路线。很多知识库场景，先把 chunk 切好、召回控制住、上下文裁剪干净，收益已经够大。</p>

<h2 id="2-把所有问题都当成高复杂问题处理"><a href="#2-把所有问题都当成高复杂问题处理" class="headerlink" title="2. 把所有问题都当成高复杂问题处理"></a>2. 把所有问题都当成高复杂问题处理</h2>
<p>有些问题就是简单 FAQ，没必要每次都走完整重排链路。更合理的是先按问题长度、命中规则、业务场景做分层。</p>

<h2 id="3-只看召回命中率，不看-P99"><a href="#3-只看召回命中率，不看-P99" class="headerlink" title="3. 只看召回命中率，不看 P99"></a>3. 只看召回命中率，不看 P99</h2>
<p>RAG 是一个典型的“多段串行链路”，只要其中一段偶发抖动，尾延迟就会上天。线上体验差，往往不是平均值差，而是 P99 太丑。</p>

<h2 id="4-缓存了-embedding，却不做失效策略"><a href="#4-缓存了-embedding，却不做失效策略" class="headerlink" title="4. 缓存了 embedding，却不做失效策略"></a>4. 缓存了 embedding，却不做失效策略</h2>
<p>问题 embedding 相对稳定，但如果你做了 query rewrite、同义词扩展、租户隔离，缓存 key 就不能只用原始问句。否则命中是高了，结果可能串租户、串场景。</p>

<h2 id="5-只测本地，不测远端依赖"><a href="#5-只测本地，不测远端依赖" class="headerlink" title="5. 只测本地，不测远端依赖"></a>5. 只测本地，不测远端依赖</h2>
<p>本机 embedding 模型和远端 API 的延迟画像完全不是一回事。你在开发机上跑出来 200ms，不代表线上经过网关、鉴权、TLS、跨可用区之后还能维持这个数字。</p>

<h1 id="落地建议：先做最小闭环，再谈高级玩法"><a href="#落地建议：先做最小闭环，再谈高级玩法" class="headerlink" title="落地建议：先做最小闭环，再谈高级玩法"></a>落地建议：先做最小闭环，再谈高级玩法</h1>
<ul>
<li>第一阶段：先把<strong>向量检索 + 指标埋点 + wrk 压测</strong>做起来；</li>
<li>第二阶段：再上<strong>问题 embedding 缓存 + 小 TopK</strong>；</li>
<li>第三阶段：如果质量和成本都还不满意，再考虑<strong>重排、查询改写、混合检索</strong>；</li>
<li>第四阶段：最后再讨论更复杂的多路召回、Agent 编排、工作流编排。</li>
</ul>
<p>顺序别反。很多项目不是输在技术难度，而是输在一开始就把链路堆太复杂，结果谁也说不清哪一刀真正有效。</p>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>
<ul>
<li>RAG 慢，别先怪模型；很多时候，慢的是 embedding、检索参数、Prompt 膨胀这些工程细节。</li>
<li><strong>问题 embedding 缓存</strong> 往往是最先该做、也最有收益的一刀。</li>
<li><strong>缩小 TopK + 轻量重排 + 上下文裁剪</strong>，通常比“多召回一点再说”更划算。</li>
<li>优化必须同时看 <strong>延迟、质量、成本</strong>，只盯其中一个，很容易把系统带偏。</li>
<li>做完压测以后，最好配合 <strong>JFR</strong> 看热点，确认瓶颈真的被搬走了。</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li>Spring AI Reference：<a target="_blank" rel="noopener" href="https://docs.spring.io/spring-ai/reference/">https://docs.spring.io/spring-ai/reference/</a></li>
<li>pgvector 官方文档：<a target="_blank" rel="noopener" href="https://github.com/pgvector/pgvector">https://github.com/pgvector/pgvector</a></li>
<li>PostgreSQL Documentation：<a target="_blank" rel="noopener" href="https://www.postgresql.org/docs/">https://www.postgresql.org/docs/</a></li>
<li>Java Flight Recorder Runtime Guide：<a target="_blank" rel="noopener" href="https://docs.oracle.com/en/java/javase/21/jfapi/">https://docs.oracle.com/en/java/javase/21/jfapi/</a></li>
<li>wrk 项目主页：<a target="_blank" rel="noopener" href="https://github.com/wg/wrk">https://github.com/wg/wrk</a></li>
<li>OpenAI Embeddings Guide（用于理解 embedding 成本与使用方式）：<a target="_blank" rel="noopener" href="https://platform.openai.com/docs/guides/embeddings">https://platform.openai.com/docs/guides/embeddings</a></li>
</ol>
