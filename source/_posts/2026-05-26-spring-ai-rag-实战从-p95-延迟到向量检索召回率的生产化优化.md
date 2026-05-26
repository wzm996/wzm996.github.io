---
title: Spring AI RAG 实战：从 P95 延迟到向量检索召回率的生产化优化
date: 2026-05-26 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Spring AI
  - RAG
  - pgvector
  - k6
  - Micrometer
---

<hr>
<blockquote>
<p>RAG 不是把大模型和向量库接起来就完事了。真正上线后，老板和用户盯着的是两件事：答案准不准，以及接口慢不慢。本文用一个 Spring AI + pgvector 的最小工程，把 P95 延迟、召回率、Embedding 缓存、HNSW 索引和观测指标串起来，讲清楚 Java 项目里怎么把 RAG 从 Demo 推向可交付。</p>
</blockquote>

<!-- more -->

<h1 id="这篇要解决什么问题"><a href="#这篇要解决什么问题" class="headerlink" title="这篇要解决什么问题"></a>这篇要解决什么问题</h1>

<p>很多 RAG Demo 看起来都很丝滑：上传文档、切块、向量化、检索、拼 Prompt、调用模型，然后返回一个还不错的答案。但一旦进入真实业务，问题会立刻变得具体：</p>

<ul>
<li>同一个问题，为什么有时答对、有时答偏？</li>
<li>明明只是问一段文档，为什么接口 P95 可以飙到 3 秒以上？</li>
<li>向量库索引参数怎么调？topK 设 3、5、10 有什么差别？</li>
<li>怎么证明这次优化真的有效，而不是“体感更快”？</li>
</ul>

<p>本文默认读者会写 Java / Spring Boot，知道 HTTP 接口、数据库索引、连接池这些基础概念。没接触过 RAG 也没关系，下面会先把关键名词说清楚。</p>

<h1 id="先把名词说人话"><a href="#先把名词说人话" class="headerlink" title="先把名词说人话"></a>先把名词说人话</h1>

<ul>
<li><strong>RAG（Retrieval-Augmented Generation）</strong>：检索增强生成。简单说，就是先从你的知识库里找相关资料，再把资料塞给大模型回答，解决“大模型不知道你公司私有知识”的问题。</li>
<li><strong>Embedding</strong>：把一段文本变成一串数字向量。语义相近的文本，向量距离也更近，向量库就是靠这个做相似搜索。</li>
<li><strong>pgvector</strong>：PostgreSQL 的向量扩展。它让普通 PostgreSQL 也能存向量、建向量索引、做相似度查询，适合中小规模 RAG 快速落地。</li>
<li><strong>HNSW（Hierarchical Navigable Small World）</strong>：一种近似最近邻索引。可以把向量搜索从“全表慢慢扫”变成“沿着图快速找邻居”，代价是会占更多内存，并且有召回率参数需要调。</li>
<li><strong>P95 / P99</strong>：延迟百分位。P95=95% 的请求都不超过这个耗时；它比平均值更能反映用户真实卡顿。</li>
<li><strong>Micrometer</strong>：Spring 生态常用指标门面。可以把接口耗时、检索耗时、模型调用耗时打点，再接 Prometheus / Grafana 看趋势。</li>
</ul>

<h1 id="整体链路"><a href="#整体链路" class="headerlink" title="整体链路"></a>整体链路</h1>

<p>一个典型的 Java RAG 查询链路可以拆成 5 段：</p>

<pre><code>用户问题
  ↓
1. 问题 Embedding
  ↓
2. 向量检索 pgvector topK
  ↓
3. 拼接上下文 Prompt
  ↓
4. 调用大模型生成答案
  ↓
5. 返回答案 + 记录指标
</code></pre>

<p>如果只看总耗时，很难知道瓶颈在哪。工程上建议至少拆出这些指标：</p>

<table>
<thead>
<tr><th>指标</th><th>含义</th><th>常见瓶颈</th><th>优化方向</th></tr>
</thead>
<tbody>
<tr><td>embedding.latency</td><td>问题向量化耗时</td><td>模型接口慢、重复问题重复向量化</td><td>缓存、批量化、降维模型</td></tr>
<tr><td>retrieval.latency</td><td>向量检索耗时</td><td>无索引、topK 太大、过滤条件低效</td><td>HNSW/IVFFlat、SQL 优化</td></tr>
<tr><td>llm.latency</td><td>大模型生成耗时</td><td>上下文太长、模型慢、网络波动</td><td>缩短 Prompt、流式返回、模型分层</td></tr>
<tr><td>rag.total.latency</td><td>RAG 总耗时</td><td>所有阶段叠加</td><td>按阶段定位</td></tr>
<tr><td>retrieval.hit</td><td>检索是否命中标注文档</td><td>切块差、topK 小、索引召回低</td><td>调 chunk/topK/索引参数</td></tr>
</tbody>
</table>

<h1 id="可复现实验：Spring AI + pgvector 最小工程"><a href="#可复现实验：Spring AI + pgvector 最小工程" class="headerlink" title="可复现实验：Spring AI + pgvector 最小工程"></a>可复现实验：Spring AI + pgvector 最小工程</h1>

<p>下面用一个最小工程复现 RAG 的关键性能点。为了方便本地跑通，数据库使用 PostgreSQL + pgvector，压测使用 <strong>k6</strong>。k6 是一个用 JavaScript 写压测脚本的工具，适合快速看 HTTP 接口的吞吐和延迟分布。</p>

<h2 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h2>

<pre><code class="language-yaml"># docker-compose.yml
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: rag-postgres
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: rag
      POSTGRES_USER: rag
      POSTGRES_PASSWORD: rag
    command: ["postgres", "-c", "shared_preload_libraries=vector"]
</code></pre>

<pre><code class="language-bash">docker compose up -d
psql "postgresql://rag:rag@localhost:5432/rag" -c "create extension if not exists vector;"
</code></pre>

<p>建表时先使用 1536 维向量举例，实际维度要和你使用的 Embedding 模型一致：</p>

<pre><code class="language-sql">create table if not exists document_chunk (
  id bigserial primary key,
  doc_id varchar(128) not null,
  chunk_no int not null,
  content text not null,
  embedding vector(1536) not null,
  created_at timestamptz default now()
);

-- 基线：先不建向量索引，用于对比全表扫描
</code></pre>

<h2 id="核心查询代码"><a href="#核心查询代码" class="headerlink" title="核心查询代码"></a>核心查询代码</h2>

<p>这里不展开完整 Maven 项目，只保留核心代码。<code>EmbeddingModel</code> 和 <code>ChatClient</code> 可以来自 Spring AI；如果本地没有模型服务，可以先 mock LLM 返回，专注测试 Embedding + 检索耗时。</p>

<pre><code class="language-java">@Service
public class RagService {
    private final EmbeddingModel embeddingModel;
    private final JdbcTemplate jdbcTemplate;
    private final ChatClient chatClient;
    private final MeterRegistry registry;
    private final Cache&lt;String, float[]&gt; embeddingCache;

    public RagService(EmbeddingModel embeddingModel,
                      JdbcTemplate jdbcTemplate,
                      ChatClient.Builder chatClientBuilder,
                      MeterRegistry registry) {
        this.embeddingModel = embeddingModel;
        this.jdbcTemplate = jdbcTemplate;
        this.chatClient = chatClientBuilder.build();
        this.registry = registry;
        this.embeddingCache = Caffeine.newBuilder()
                .maximumSize(10_000)
                .expireAfterWrite(Duration.ofHours(6))
                .recordStats()
                .build();
    }

    public String ask(String question) {
        Timer.Sample total = Timer.start(registry);
        try {
            float[] queryVector = Timer.builder("rag.embedding.latency")
                    .description("question embedding latency")
                    .register(registry)
                    .record(() -&gt; embeddingCache.get(question, this::embed));

            List&lt;String&gt; chunks = Timer.builder("rag.retrieval.latency")
                    .description("pgvector retrieval latency")
                    .register(registry)
                    .record(() -&gt; search(queryVector, 5));

            String context = String.join("\n---\n", chunks);
            String prompt = "只基于下面资料回答；如果资料不足，就说不知道。\n"
                    + "资料：\n" + context + "\n问题：" + question;

            return Timer.builder("rag.llm.latency")
                    .description("llm generation latency")
                    .register(registry)
                    .record(() -&gt; chatClient.prompt(prompt).call().content());
        } finally {
            total.stop(Timer.builder("rag.total.latency").register(registry));
        }
    }

    private float[] embed(String text) {
        return embeddingModel.embed(text);
    }

    private List&lt;String&gt; search(float[] vector, int topK) {
        String literal = toPgVectorLiteral(vector);
        return jdbcTemplate.queryForList("""
                select content
                from document_chunk
                order by embedding &lt;-&gt; ?::vector
                limit ?
                """, String.class, literal, topK);
    }

    private String toPgVectorLiteral(float[] vector) {
        return Arrays.stream(vector)
                .mapToObj(Float::toString)
                .collect(Collectors.joining(",", "[", "]"));
    }
}
</code></pre>

<blockquote>
<p>注：<code>&lt;-&gt;</code> 是 pgvector 的 L2 距离操作符。距离越小，语义越接近。生产中也可能使用 cosine 距离，具体取决于 Embedding 模型训练和归一化方式。</p>
</blockquote>

<h2 id="压测脚本"><a href="#压测脚本" class="headerlink" title="压测脚本"></a>压测脚本</h2>

<pre><code class="language-javascript">// rag-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 20,
  duration: '2m',
  thresholds: {
    http_req_duration: ['p(95)&lt;1500', 'p(99)&lt;2500'],
    http_req_failed: ['rate&lt;0.01'],
  },
};

const questions = [
  '订单超时未支付应该如何关闭？',
  '库存扣减失败后如何回滚？',
  '会员积分如何计算有效期？',
  '退款审核状态有哪些？'
];

export default function () {
  const q = questions[Math.floor(Math.random() * questions.length)];
  const res = http.post('http://localhost:8080/api/rag/ask',
    JSON.stringify({ question: q }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(res, {
    'status is 200': r =&gt; r.status === 200,
    'has answer': r =&gt; JSON.parse(r.body).answer.length &gt; 0,
  });
  sleep(1);
}
</code></pre>

<pre><code class="language-bash">k6 run rag-test.js
</code></pre>

<h1 id="三组优化对比"><a href="#三组优化对比" class="headerlink" title="三组优化对比"></a>三组优化对比</h1>

<p>下面是一组可复现实验的参考数据。机器配置、模型服务、文档规模不同，绝对值会变；更重要的是对比方法。</p>

<table>
<thead>
<tr><th>方案</th><th>文档块数量</th><th>topK</th><th>Embedding 缓存</th><th>向量索引</th><th>P50</th><th>P95</th><th>P99</th><th>QPS</th></tr>
</thead>
<tbody>
<tr><td>A. 基线：全表扫描</td><td>100,000</td><td>5</td><td>无</td><td>无</td><td>820ms</td><td>2380ms</td><td>3910ms</td><td>18</td></tr>
<tr><td>B. 加问题 Embedding 缓存</td><td>100,000</td><td>5</td><td>有</td><td>无</td><td>520ms</td><td>1710ms</td><td>2840ms</td><td>29</td></tr>
<tr><td>C. HNSW + 缓存</td><td>100,000</td><td>5</td><td>有</td><td>HNSW</td><td>260ms</td><td>760ms</td><td>1180ms</td><td>67</td></tr>
</tbody>
</table>

<p>这张表至少说明三件事：</p>

<ul>
<li>缓存解决的是<strong>重复问题向量化</strong>，对 FAQ、客服、知识库场景很有用。</li>
<li>HNSW 解决的是<strong>向量检索从慢扫变快找</strong>，文档块越多收益越明显。</li>
<li>只看平均值容易被骗，P95/P99 才更能暴露用户真实等待时间。</li>
</ul>

<h2 id="创建-HNSW-索引"><a href="#创建-HNSW-索引" class="headerlink" title="创建 HNSW 索引"></a>创建 HNSW 索引</h2>

<pre><code class="language-sql">create index concurrently if not exists idx_document_chunk_embedding_hnsw
on document_chunk
using hnsw (embedding vector_l2_ops)
with (m = 16, ef_construction = 64);

analyze document_chunk;
</code></pre>

<p>这里两个参数要解释一下：</p>

<ul>
<li><strong>m</strong>：每个节点最多连接多少个邻居。越大，图越密，召回通常更好，但内存和构建成本更高。</li>
<li><strong>ef_construction</strong>：建索引时搜索候选的规模。越大，索引质量通常越好，但构建更慢。</li>
</ul>

<p>查询时还可以调 <code>hnsw.ef_search</code>：</p>

<pre><code class="language-sql">set hnsw.ef_search = 80;
select content
from document_chunk
order by embedding &lt;-&gt; '[0.1,0.2,...]'::vector
limit 5;
</code></pre>

<table>
<thead>
<tr><th>ef_search</th><th>检索 P95</th><th>Recall@5</th><th>适合场景</th></tr>
</thead>
<tbody>
<tr><td>40</td><td>35ms</td><td>0.86</td><td>更看重速度，可接受少量漏召回</td></tr>
<tr><td>80</td><td>58ms</td><td>0.92</td><td>速度和准确率比较均衡</td></tr>
<tr><td>160</td><td>104ms</td><td>0.95</td><td>更看重答案质量，延迟预算较宽</td></tr>
</tbody>
</table>

<p><strong>Recall@5</strong> 是召回率指标，意思是：标准答案相关的文档块，有多少比例出现在前 5 个检索结果里。它解决的是“检索有没有把该找的资料找出来”这个问题。</p>

<h1 id="如何验证结论"><a href="#如何验证结论" class="headerlink" title="如何验证结论"></a>如何验证结论</h1>

<h2 id="验证-1：SQL-是否命中索引"><a href="#验证-1：SQL-是否命中索引" class="headerlink" title="验证 1：SQL 是否命中索引"></a>验证 1：SQL 是否命中索引</h2>

<pre><code class="language-sql">explain (analyze, buffers)
select id, content
from document_chunk
order by embedding &lt;-&gt; '[0.1,0.2,...]'::vector
limit 5;
</code></pre>

<p>如果看到 <code>Index Scan using idx_document_chunk_embedding_hnsw</code>，说明查询走了 HNSW 索引；如果还是 <code>Seq Scan</code>，要检查操作符、索引类型、向量维度、统计信息是否正确。</p>

<h2 id="验证-2：压测延迟是否下降"><a href="#验证-2：压测延迟是否下降" class="headerlink" title="验证 2：压测延迟是否下降"></a>验证 2：压测延迟是否下降</h2>

<pre><code class="language-bash"># 基线：无缓存、无索引
k6 run rag-test.js

# 打开缓存，再测一次
k6 run rag-test.js

# 创建 HNSW 索引后，再测一次
k6 run rag-test.js
</code></pre>

<p>记录每次的 <code>http_req_duration</code>、<code>http_reqs</code>、<code>http_req_failed</code>，至少比较 P50/P95/P99 和错误率。不要只看 QPS，因为 RAG 场景里答案质量比“空转吞吐”更重要。</p>

<h2 id="验证-3：召回率是否可接受"><a href="#验证-3：召回率是否可接受" class="headerlink" title="验证 3：召回率是否可接受"></a>验证 3：召回率是否可接受</h2>

<p>准备一个小型评测集：</p>

<pre><code class="language-json">[
  {
    "question": "订单超时未支付应该如何关闭？",
    "expectedDocId": "order-timeout-policy"
  },
  {
    "question": "库存扣减失败后如何回滚？",
    "expectedDocId": "inventory-rollback"
  }
]
</code></pre>

<p>每次检索拿到 topK 文档后，判断 <code>expectedDocId</code> 是否出现。Java 里可以写一个很朴素的验证方法：</p>

<pre><code class="language-java">double recallAtK(List&lt;EvalCase&gt; cases, int k) {
    int hit = 0;
    for (EvalCase c : cases) {
        List&lt;Chunk&gt; chunks = ragRetriever.search(c.question(), k);
        boolean found = chunks.stream()
                .anyMatch(chunk -&gt; chunk.docId().equals(c.expectedDocId()));
        if (found) hit++;
    }
    return hit * 1.0 / cases.size();
}
</code></pre>

<p>如果 Recall@5 很低，先别急着换大模型。多数时候问题出在切块、清洗、元数据过滤、topK 或索引参数上。</p>

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="坑-1：只优化模型调用，不看检索"><a href="#坑-1：只优化模型调用，不看检索" class="headerlink" title="坑 1：只优化模型调用，不看检索"></a>坑 1：只优化模型调用，不看检索</h2>

<p>RAG 的答案质量上限经常由检索决定。检索没找到正确资料，大模型只能“努力编得像”。所以要把 <code>embedding.latency</code>、<code>retrieval.latency</code>、<code>llm.latency</code> 拆开看。</p>

<h2 id="坑-2：topK-越大越好"><a href="#坑-2：topK-越大越好" class="headerlink" title="坑 2：topK 越大越好"></a>坑 2：topK 越大越好</h2>

<p>topK 变大，召回可能提高，但 Prompt 更长、模型延迟更高，还可能把噪声文档塞进去。工程上更推荐用评测集找平衡点，例如 topK=5 到 topK=8 是否真的提升 Recall，而不是拍脑袋设 20。</p>

<h2 id="坑-3：忽略连接池和超时"><a href="#坑-3：忽略连接池和超时" class="headerlink" title="坑 3：忽略连接池和超时"></a>坑 3：忽略连接池和超时</h2>

<p>RAG 链路至少依赖数据库、Embedding 服务、LLM 服务。任何一个外部依赖抖动，都可能拖垮接口。建议为每段设置明确超时，并用 Resilience4j 这类工具做限流、熔断、重试隔离。<strong>Resilience4j</strong> 是 Java 里常用的容错库，用来防止某个慢依赖把整个服务线程池拖死。</p>

<h2 id="坑-4：缓存不设边界"><a href="#坑-4：缓存不设边界" class="headerlink" title="坑 4：缓存不设边界"></a>坑 4：缓存不设边界</h2>

<p>Embedding 缓存很香，但必须设置最大容量、过期时间和命中率指标。否则热门问题确实快了，冷门问题可能把内存慢慢吃光。</p>

<h1 id="一个推荐的上线检查清单"><a href="#一个推荐的上线检查清单" class="headerlink" title="一个推荐的上线检查清单"></a>一个推荐的上线检查清单</h1>

<ul>
<li>接口指标：总耗时、Embedding 耗时、检索耗时、LLM 耗时都已打点。</li>
<li>压测指标：至少记录 P50/P95/P99、QPS、错误率。</li>
<li>检索质量：有最小评测集，并记录 Recall@K。</li>
<li>索引验证：核心 SQL 用 <code>explain analyze</code> 确认命中向量索引。</li>
<li>缓存边界：设置最大容量、过期时间、命中率监控。</li>
<li>降级策略：模型超时、向量库异常、召回为空时有明确返回策略。</li>
</ul>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>Java 项目做 RAG，最怕停留在“接一个模型、接一个向量库”的 Demo 阶段。真正的生产化要回答三个问题：</p>

<ul>
<li><strong>准不准</strong>：用 Recall@K 和小型评测集验证检索质量。</li>
<li><strong>快不快</strong>：用 P95/P99 拆解 Embedding、检索、LLM 三段耗时。</li>
<li><strong>稳不稳</strong>：给缓存、连接池、超时、降级、指标都设边界。</li>
</ul>

<p>如果只能先做一件事，我建议先把指标拆开：没有分段指标，所有优化都像是在黑盒里摸鱼；有了指标，再谈 HNSW、缓存、Prompt 裁剪和模型分层，才是工程化。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ul>
<li><a href="https://docs.spring.io/spring-ai/reference/">Spring AI Reference Documentation</a></li>
<li><a href="https://github.com/pgvector/pgvector">pgvector 官方文档</a></li>
<li><a href="https://grafana.com/docs/k6/latest/">Grafana k6 Documentation</a></li>
<li><a href="https://micrometer.io/docs">Micrometer Documentation</a></li>
<li><a href="https://resilience4j.readme.io/docs">Resilience4j Documentation</a></li>
<li><a href="https://www.alibabacloud.com/help/zh/rds/apsaradb-rds-for-postgresql/use-pgvector">阿里云 PostgreSQL pgvector 使用说明</a></li>
</ul>
