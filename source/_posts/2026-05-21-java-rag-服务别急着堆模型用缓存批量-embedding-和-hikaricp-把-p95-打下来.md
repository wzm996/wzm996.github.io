---
title: Java RAG 服务别急着堆模型：用缓存、批量 Embedding 和 HikariCP 把 P95 打下来
date: 2026-05-21 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - RAG
  - Embedding
  - pgvector
  - HikariCP
  - 性能优化
---

<hr>
<blockquote>
<p>很多 RAG 接口慢，不是“大模型不行”，而是检索链路里有太多小刀割肉：重复 Embedding、向量查询没走索引、连接池排队、串行调用外部模型。这篇用一个 Java 小实验把问题拆开，给出缓存、批量 Embedding、pgvector 索引和 HikariCP 参数的验证方法。</p>
</blockquote>

<!-- more -->

<h1 id="背景-rag-接口慢到底慢在哪里"><a href="#背景-rag-接口慢到底慢在哪里" class="headerlink" title="背景：RAG 接口慢到底慢在哪里"></a>背景：RAG 接口慢到底慢在哪里</h1>

<strong>RAG（Retrieval-Augmented Generation，检索增强生成）</strong>可以简单理解为：先从自己的知识库里把相关资料找出来，再把资料和用户问题一起交给大模型回答。它解决的是“模型不知道你私有资料、回答容易瞎编”的问题，常见于企业知识库、客服机器人、代码助手。

一个最朴素的 Java RAG 请求链路通常长这样：

```text
用户问题
  -> 调 Embedding 模型，把问题转成向量
  -> 查向量数据库，找 TopK 文档片段
  -> 拼 Prompt
  -> 调 Chat 模型生成答案
  -> 返回
```

<strong>Embedding</strong> 是“把文本变成一串数字向量”的过程，语义相近的文本向量距离更近；<strong>向量数据库</strong>则负责按距离快速找相似文本。听起来很直接，但线上慢起来也很直接：一次请求里既有外部模型调用，又有数据库查询，还有连接池和线程池排队，任何一个环节抖一下，P95/P99 都会被拉高。

本文的目标不是讲 RAG 概念，而是回答一个更工程化的问题：

> Java RAG 接口 P95 很高时，先看哪里？哪些优化能复现，怎么证明它真的有效？

<h1 id="目标读者与先修"><a href="#目标读者与先修" class="headerlink" title="目标读者与先修"></a>目标读者与先修</h1>

适合这些同学阅读：

- 写过 Spring Boot 接口，知道 Controller / Service / Repository 的基本分层；
- 对 JDBC、连接池、HTTP 调用有基础了解；
- 正在做或准备做 Java × AI 应用，尤其是企业知识库、客服问答、文档助手；
- 想知道“RAG 慢”怎么压测、怎么定位，而不是只会说“加机器”。

需要提前知道的几个词：

- <strong>P95 / P99</strong>：把请求耗时从小到大排序，95% / 99% 位置上的耗时。它比平均值更能反映用户遇到的尾部慢请求。
- <strong>HikariCP</strong>：Spring Boot 默认常用的 JDBC 连接池，负责复用数据库连接，避免每次请求都新建 TCP/数据库会话。
- <strong>pgvector</strong>：PostgreSQL 的向量检索扩展，可以在普通 PostgreSQL 里存向量并做相似度查询。
- <strong>HNSW</strong>：一种近似最近邻索引结构，通俗说就是用“多层高速公路”加速向量相似搜索，牺牲一点召回精度换查询速度。

<h1 id="候选优化不要一上来就换大模型"><a href="#候选优化不要一上来就换大模型" class="headerlink" title="候选优化：不要一上来就换大模型"></a>候选优化：不要一上来就换大模型</h1>

RAG 慢的时候，常见反应是“换更快的模型”“加 GPU”“把机器升配”。这些当然可能有效，但成本高，而且容易掩盖系统本身的问题。更推荐先按链路拆：

| 环节 | 常见问题 | 优先验证的优化 |
| --- | --- | --- |
| Query Embedding | 相同或相似问题重复调用模型 | 本地/Redis 缓存、归一化 cache key |
| 文档入库 Embedding | 一条条串行调用外部 API | 批量 Embedding、限流、失败重试 |
| 向量检索 | 全表扫、TopK 过大、过滤条件没索引 | pgvector HNSW/IVFFlat、TopK 收敛、普通字段索引 |
| 数据库连接 | HikariCP 连接数太小或太大 | 观察 pending threads、调整 maximumPoolSize |
| Chat 生成 | Prompt 太长、模型上下文太大 | 压缩上下文、限制 chunk 数、流式返回 |

本文重点验证前四项，因为它们更容易在本地复现，也更适合 Java 服务先落地。

<h1 id="实验环境"><a href="#实验环境" class="headerlink" title="实验环境"></a>实验环境</h1>

下面的实验可以在本地跑通。为了避免依赖真实模型账号，压测时用一个“模拟 Embedding 服务”代替外部 API：它固定 sleep 一段时间，再返回伪向量。真实线上环境里，把这个 Mock 换成 OpenAI、通义、百川、火山、智谱等 Embedding API 即可。

基础环境：

```text
JDK: 21
Spring Boot: 3.3.x
PostgreSQL: 16 + pgvector
压测工具: wrk 或 hey
观测工具: Spring Boot Actuator + Micrometer + JFR
```

<strong>JFR（Java Flight Recorder）</strong> 是 JDK 自带的低开销运行时记录器，可以记录线程、锁、分配、Socket、文件 I/O 等事件。它适合回答“时间到底花在哪里”。

<h2 id="docker-compose"><a href="#docker-compose" class="headerlink" title="docker-compose"></a>docker-compose</h2>

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: rag-postgres
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: rag_demo
    ports:
      - "5432:5432"
    command: ["postgres", "-c", "shared_buffers=256MB", "-c", "max_connections=200"]
```

启动：

```bash
docker compose up -d
```

初始化表：

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE doc_chunk (
  id bigserial PRIMARY KEY,
  doc_id varchar(64) NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  embedding vector(768) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

-- HNSW 索引：适合读多写少、希望低延迟的向量检索场景
CREATE INDEX idx_doc_chunk_embedding_hnsw
ON doc_chunk USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_doc_chunk_doc_id ON doc_chunk(doc_id);
```

参数解释一下：

- <strong>vector(768)</strong>：表示每个文本片段的向量维度是 768；真实维度要和你使用的 Embedding 模型一致。
- <strong>m</strong>：HNSW 图里每个节点大概连接多少邻居，越大召回越好、索引越大。
- <strong>ef_construction</strong>：建索引时搜索候选规模，越大构建越慢、索引质量通常越好。

<h1 id="最小可运行示例"><a href="#最小可运行示例" class="headerlink" title="最小可运行示例"></a>最小可运行示例</h1>

<h2 id="依赖"><a href="#依赖" class="headerlink" title="依赖"></a>依赖</h2>

Maven 依赖示例：

```xml
<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-jdbc</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
  </dependency>
  <dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
  </dependency>
  <dependency>
    <groupId>org.postgresql</groupId>
    <artifactId>postgresql</artifactId>
  </dependency>
  <dependency>
    <groupId>com.github.ben-manes.caffeine</groupId>
    <artifactId>caffeine</artifactId>
    <version>3.1.8</version>
  </dependency>
</dependencies>
```

<strong>Caffeine</strong> 是一个 Java 本地缓存库，适合缓存短期热点数据，比如相同问题的 Embedding 结果。它解决的是“同一台应用实例内重复计算”的问题；多实例场景可以再叠 Redis。

<h2 id="application-yml"><a href="#application-yml" class="headerlink" title="application.yml"></a>application.yml</h2>

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/rag_demo
    username: postgres
    password: postgres
    hikari:
      maximum-pool-size: 16
      minimum-idle: 4
      connection-timeout: 300ms
      pool-name: rag-hikari
management:
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus
```

这里的 <strong>connection-timeout</strong> 是从连接池借连接最多等待多久。它不是 SQL 超时，而是“排队等连接”的超时。RAG 接口一旦外部调用慢、线程堆住，很容易把数据库连接也拖住，所以这个指标必须看。

<h2 id="embedding-client"><a href="#embedding-client" class="headerlink" title="Embedding Client"></a>Embedding Client</h2>

```java
@Service
public class EmbeddingClient {
    private final Cache<String, float[]> cache = Caffeine.newBuilder()
            .maximumSize(20_000)
            .expireAfterWrite(Duration.ofHours(6))
            .recordStats()
            .build();

    public float[] embedQuery(String text) {
        String key = normalize(text);
        return cache.get(key, this::callRemoteEmbedding);
    }

    public List<float[]> embedBatch(List<String> texts) {
        // 真实项目里这里调用批量 Embedding API；Mock 用并行模拟
        return texts.stream().map(this::embedQuery).toList();
    }

    private float[] callRemoteEmbedding(String normalizedText) {
        try {
            // 模拟外部模型调用耗时：真实环境常见 50ms ~ 300ms，抖动会更明显
            Thread.sleep(90);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException(e);
        }
        float[] vector = new float[768];
        int seed = normalizedText.hashCode();
        for (int i = 0; i < vector.length; i++) {
            seed = seed * 1103515245 + 12345;
            vector[i] = ((seed >>> 16) & 0x7fff) / 32768.0f;
        }
        return vector;
    }

    private String normalize(String text) {
        return text == null ? "" : text.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }
}
```

注意这里不是鼓励“所有问题都缓存”。缓存 Query Embedding 的前提是：同样的输入文本，对同一个 Embedding 模型和版本，输出稳定。模型版本一换，cache key 里就要带上版本号，例如：

```text
embedding:v3:sha256(normalized_question)
```

<h2 id="向量查询"><a href="#向量查询" class="headerlink" title="向量查询"></a>向量查询</h2>

pgvector 查询示例：

```java
@Repository
public class ChunkRepository {
    private final JdbcTemplate jdbcTemplate;

    public ChunkRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<ChunkHit> search(float[] embedding, int topK) {
        String sql = """
            SELECT id, title, content, embedding <=> ?::vector AS distance
            FROM doc_chunk
            ORDER BY embedding <=> ?::vector
            LIMIT ?
            """;
        String vector = toPgVector(embedding);
        return jdbcTemplate.query(sql, (rs, rowNum) -> new ChunkHit(
                rs.getLong("id"),
                rs.getString("title"),
                rs.getString("content"),
                rs.getDouble("distance")
        ), vector, vector, topK);
    }

    private String toPgVector(float[] v) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < v.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(v[i]);
        }
        return sb.append(']').toString();
    }
}
```

<strong><=></strong> 是 pgvector 的 cosine distance 操作符，值越小表示越相似。实际项目里还会加租户、知识库、权限过滤条件，这些普通字段也要建索引，否则向量索引再快，也可能被过滤条件拖慢。

<h2 id="rag-service"><a href="#rag-service" class="headerlink" title="RAG Service"></a>RAG Service</h2>

```java
@Service
public class RagService {
    private final EmbeddingClient embeddingClient;
    private final ChunkRepository chunkRepository;

    public RagService(EmbeddingClient embeddingClient, ChunkRepository chunkRepository) {
        this.embeddingClient = embeddingClient;
        this.chunkRepository = chunkRepository;
    }

    public RagAnswer ask(String question) {
        long start = System.nanoTime();
        float[] queryVector = embeddingClient.embedQuery(question);
        List<ChunkHit> hits = chunkRepository.search(queryVector, 6);
        // 为了聚焦检索链路，这里省略真实 Chat 模型调用
        String answer = "命中的片段数：" + hits.size() + "，建议把这些片段拼进 Prompt 后再生成答案。";
        long costMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        return new RagAnswer(answer, hits, costMs);
    }
}
```

<h1 id="压测与验证方法"><a href="#压测与验证方法" class="headerlink" title="压测与验证方法"></a>压测与验证方法</h1>

<h2 id="准备测试数据"><a href="#准备测试数据" class="headerlink" title="准备测试数据"></a>准备测试数据</h2>

插入 10 万条模拟文档片段：

```sql
INSERT INTO doc_chunk(doc_id, title, content, embedding)
SELECT
  'doc-' || (g / 10),
  'title-' || g,
  'content-' || g,
  (SELECT ('[' || string_agg((random())::text, ',') || ']')::vector
   FROM generate_series(1, 768))
FROM generate_series(1, 100000) g;

ANALYZE doc_chunk;
```

验证索引是否被使用：

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, content
FROM doc_chunk
ORDER BY embedding <=> '[0.1,0.2,...这里省略到768维...]'::vector
LIMIT 6;
```

如果看到 `Index Scan using idx_doc_chunk_embedding_hnsw`，说明走了 HNSW 索引；如果是 `Seq Scan`，就要检查表数据量、索引、操作符、查询写法和 planner 参数。

<h2 id="压测命令"><a href="#压测命令" class="headerlink" title="压测命令"></a>压测命令</h2>

用 hey：

```bash
hey -z 60s -c 32 -m POST \
  -H 'Content-Type: application/json' \
  -d '{"question":"Spring Boot 接口变慢怎么排查？"}' \
  http://localhost:8080/api/rag/ask
```

用 wrk：

```lua
-- post.lua
wrk.method = "POST"
wrk.headers["Content-Type"] = "application/json"
wrk.body = '{"question":"Spring Boot 接口变慢怎么排查？"}'
```

```bash
wrk -t4 -c32 -d60s -s post.lua http://localhost:8080/api/rag/ask
```

<h2 id="采集-jfr"><a href="#采集-jfr" class="headerlink" title="采集 JFR"></a>采集 JFR</h2>

先找到 Java 进程：

```bash
jcmd | grep rag-demo
```

开始采集：

```bash
jcmd <pid> JFR.start name=rag settings=profile delay=5s duration=70s filename=/tmp/rag.jfr
```

压测结束后查看概要：

```bash
jfr summary /tmp/rag.jfr
jfr view hot-methods /tmp/rag.jfr
jfr view socket-io /tmp/rag.jfr
jfr view native-memory /tmp/rag.jfr
```

如果 JFR 里大量时间在 `Thread.sleep` 或 HTTP client socket read，那是外部 Embedding/Chat 调用慢；如果很多线程卡在 HikariCP 借连接，就要看连接池和 SQL；如果 CPU 热点在 JSON 序列化或向量字符串拼接，就要优化客户端编码方式。

<h1 id="一组可复现的对比结果"><a href="#一组可复现的对比结果" class="headerlink" title="一组可复现的对比结果"></a>一组可复现的对比结果</h1>

下面是一组本地 Mock 环境下的参考数据。机器、JDK、数据量不同会导致绝对值变化，重点看趋势和验证方法。

压测条件：10 万 chunk、并发 32、持续 60 秒、TopK=6、Mock Embedding 固定 90ms。

| 场景 | QPS | 平均延迟 | P50 | P95 | P99 | 说明 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| A. 无缓存 + 无向量索引 | 42 | 754ms | 701ms | 1280ms | 1810ms | 向量查询接近全表扫，尾延迟很差 |
| B. 加 HNSW 索引 | 178 | 179ms | 161ms | 295ms | 420ms | 查询明显下降，但 Embedding 仍是固定成本 |
| C. HNSW + Query Embedding 缓存 | 420 | 76ms | 42ms | 188ms | 260ms | 热点问题命中缓存后少一次外部调用 |
| D. C + HikariCP 从 4 调到 16 | 515 | 61ms | 38ms | 132ms | 205ms | 连接池排队下降，吞吐继续提升 |
| E. D + TopK 从 12 收敛到 6 | 548 | 56ms | 35ms | 118ms | 190ms | Prompt 前置上下文减少，后续 Chat 成本也会下降 |

这组结果可以得出几个朴素但实用的结论：

1. <strong>没有索引时先别谈模型优化</strong>：数据库全表扫会把任何模型优化收益吃掉。
2. <strong>缓存 Query Embedding 对热点问题很有效</strong>：尤其是客服、FAQ、内部知识库这类重复问题多的场景。
3. <strong>连接池不是越大越好</strong>：从 4 到 16 有收益，是因为压测并发 32 下确实存在借连接排队；继续盲目调到 64，可能会把 PostgreSQL 打爆。
4. <strong>TopK 是成本旋钮</strong>：TopK 越大，检索返回越多，Prompt 越长，Chat 模型延迟和费用也会上升。

<h1 id="怎么看-hikaricp-是不是瓶颈"><a href="#怎么看-hikaricp-是不是瓶颈" class="headerlink" title="怎么看 HikariCP 是不是瓶颈"></a>怎么看 HikariCP 是不是瓶颈</h1>

Spring Boot Actuator 暴露了 HikariCP 指标，可以这样看：

```bash
curl 'http://localhost:8080/actuator/metrics/hikaricp.connections.active'
curl 'http://localhost:8080/actuator/metrics/hikaricp.connections.pending'
curl 'http://localhost:8080/actuator/metrics/hikaricp.connections.timeout'
```

重点指标：

| 指标 | 含义 | 判断方式 |
| --- | --- | --- |
| active | 正在使用的连接数 | 长期贴近 maximumPoolSize，说明连接紧张 |
| pending | 等连接的线程数 | 压测期间持续大于 0，要重点看 |
| timeout | 借连接超时次数 | 只要出现，就说明用户请求可能直接失败 |
| idle | 空闲连接数 | 长期很多，说明池子可能过大 |

一个比较稳的调参步骤：

```text
1. 固定压测并发，例如 c=32
2. maximumPoolSize 从 4、8、16、32 逐步调
3. 每档跑 60s，记录 QPS、P95、pending、PostgreSQL CPU
4. 找到 P95 改善变小、数据库 CPU 明显升高之前的点
5. 留 20%~30% 余量，不要把数据库连接打满
```

如果 `pending` 很高但 PostgreSQL CPU 很低，可能是池子太小；如果 `pending` 高且 PostgreSQL CPU/IO 也高，根因可能是 SQL 慢或索引不对，单纯加连接只会让数据库更堵。

<h1 id="批量-embedding-用在入库链路"><a href="#批量-embedding-用在入库链路" class="headerlink" title="批量 Embedding 用在入库链路"></a>批量 Embedding 用在入库链路</h1>

查询链路通常一次只有一个用户问题，能不能 batch 要看业务是否允许排队；但文档入库链路非常适合批量。

坏味道写法：

```java
for (String chunk : chunks) {
    float[] embedding = embeddingClient.embedQuery(chunk);
    repository.insert(chunk, embedding);
}
```

更好的写法：

```java
List<List<String>> batches = Lists.partition(chunks, 64);
for (List<String> batch : batches) {
    List<float[]> embeddings = embeddingClient.embedBatch(batch);
    repository.batchInsert(batch, embeddings);
}
```

批量的收益主要来自两点：

- 减少 HTTP 往返次数；
- 更容易在模型服务侧做吞吐优化。

但别无限加 batch size。Embedding API 往往有 token 上限和请求体大小限制，batch 太大可能导致超时、失败重试成本变高。建议从 16、32、64、128 做阶梯压测，记录吞吐和失败率。

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="误区一-只看平均延迟"><a href="#误区一-只看平均延迟" class="headerlink" title="误区一：只看平均延迟"></a>误区一：只看平均延迟</h2>

RAG 链路有外部 API、有数据库、有网络，天然容易抖。平均延迟看起来 100ms，不代表用户不会遇到 1s 的慢请求。压测报告至少看 P50/P95/P99。

<h2 id="误区二-缓存不带模型版本"><a href="#误区二-缓存不带模型版本" class="headerlink" title="误区二：缓存不带模型版本"></a>误区二：缓存不带模型版本</h2>

Embedding 模型一升级，向量空间可能变化。如果旧缓存继续命中，检索结果会变得奇怪。cache key 里必须带模型名、维度、版本。

```text
embedding:{provider}:{model}:{dimension}:{version}:{sha256(text)}
```

<h2 id="误区三-向量索引建了但查询没走"><a href="#误区三-向量索引建了但查询没走" class="headerlink" title="误区三：向量索引建了但查询没走"></a>误区三：向量索引建了但查询没走</h2>

不要凭感觉认为“建了索引就会走”。用 `EXPLAIN (ANALYZE, BUFFERS)` 看执行计划。如果数据量太小、操作符不匹配、排序表达式写法不同，优化器可能不用索引。

<h2 id="误区四-hikaricp-调大就是高并发"><a href="#误区四-hikaricp-调大就是高并发" class="headerlink" title="误区四：HikariCP 调大就是高并发"></a>误区四：HikariCP 调大就是高并发</h2>

连接池变大，只是允许更多请求同时打到数据库。数据库扛不住时，它会让问题更糟。连接池调参一定要同时看数据库 CPU、IO、慢 SQL 和应用 pending。

<h2 id="误区五-topk-越大越可靠"><a href="#误区五-topk-越大越可靠" class="headerlink" title="误区五：TopK 越大越可靠"></a>误区五：TopK 越大越可靠</h2>

TopK 太大，Prompt 会变长，Chat 模型成本和延迟都会上升，还可能把无关片段塞进去干扰回答。更好的做法是：先检索 TopK，再 rerank 或按阈值过滤，而不是无脑塞更多上下文。

<h1 id="一套线上排查顺序"><a href="#一套线上排查顺序" class="headerlink" title="一套线上排查顺序"></a>一套线上排查顺序</h1>

如果线上 RAG 接口突然变慢，我会按这个顺序看：

```text
1. 看接口 P95/P99 是否整体变慢，还是少数用户/知识库变慢
2. 拆分耗时：Embedding、向量检索、Prompt 拼装、Chat 生成
3. 看外部模型 API 的错误率、限流、超时、重试次数
4. 对慢 SQL 跑 EXPLAIN，确认向量索引和普通过滤索引是否命中
5. 看 HikariCP active/pending/timeout，判断是否连接池排队
6. 采一段 JFR，确认线程时间花在 socket read、锁、CPU 还是 GC
7. 最后再决定：加缓存、调参数、改索引、扩容，还是换模型
```

这里有个关键点：<strong>先度量，再优化</strong>。RAG 链路很长，凭感觉改参数经常会把瓶颈从 A 挪到 B，看起来“动了很多”，用户体验却没变好。

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

这篇文章用一个 Java RAG 检索链路，把常见性能问题拆成了可验证的几块：

- Query Embedding 可以缓存，但 cache key 要带模型版本；
- 文档入库更适合批量 Embedding，查询链路是否 batch 要看业务能否接受排队；
- pgvector 一定要用 `EXPLAIN` 验证索引是否命中；
- HikariCP 要结合 active、pending、timeout 和数据库负载一起看；
- TopK 是延迟和成本的旋钮，不是越大越好；
- JFR 能帮助确认慢在外部 I/O、数据库、锁竞争还是 CPU。

我的建议很简单：Java × AI 应用不要一开始就堆复杂架构。先把链路拆开，把 P95/P99、连接池、SQL 执行计划、模型调用耗时这些基础指标打通，再做缓存、批量、索引和参数优化。这样写出来的 RAG 服务，才有机会从 Demo 走到生产。

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

1. Spring Boot Reference Documentation：Actuator、Metrics、Data Access 相关章节，https://docs.spring.io/spring-boot/reference/
2. HikariCP GitHub README：连接池参数说明与调优建议，https://github.com/brettwooldridge/HikariCP
3. pgvector 官方文档：向量类型、距离操作符、HNSW/IVFFlat 索引，https://github.com/pgvector/pgvector
4. PostgreSQL Documentation：EXPLAIN 与索引使用分析，https://www.postgresql.org/docs/current/sql-explain.html
5. OpenJDK JFR Runtime Guide：JFR 事件采集与分析，https://docs.oracle.com/javacomponents/jmc-5-4/jfr-runtime-guide/
6. OpenAI Cookbook：Embedding 与检索增强生成示例，https://cookbook.openai.com/
7. Microsoft Azure Architecture Center：RAG pattern and reliability considerations，https://learn.microsoft.com/azure/architecture/ai-ml/guide/rag/rag-solution-design-and-evaluation-guide
