---
title: Spring AI RAG 延迟优化实战：Embedding 缓存、TopK 与 JFR 排查
date: 2026-05-08 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring AI
  - RAG
  - Embedding
  - 向量检索
  - JFR
  - 延迟优化
---

<hr>
<blockquote>
<p>RAG 应用慢，很多时候不是大模型本身慢，而是 <strong>Embedding、向量检索、上下文拼装、HTTP 连接池</strong> 一起把 P95/P99 拖垮了。本文用一个可复现的 Spring Boot + Spring AI + pgvector 小实验，把 RAG 请求链路拆开量，顺手演示怎么用 JFR 找到真正的延迟热点。</p>
</blockquote>

<!-- more -->

<h1 id="为什么要单独看-RAG-延迟"><a href="#为什么要单独看-RAG-延迟" class="headerlink" title="为什么要单独看 RAG 延迟"></a>为什么要单独看 RAG 延迟</h1>

现在很多 Java 后端接入 AI，第一版通常都长这样：用户提问 → 调 Embedding 模型把问题转成向量 → 查向量库 → 拼 Prompt → 调 Chat 模型 → 返回答案。

这条链路就是常说的 <strong>RAG（Retrieval-Augmented Generation，检索增强生成）</strong>。口语化一点说：先去知识库里找材料，再把材料塞给大模型回答，避免模型只靠“记忆”胡说。

问题也很直接：传统接口里，一个查询 50ms 已经不算快；RAG 链路里，光一次大模型调用就可能几百毫秒到几秒。更麻烦的是，用户感知的不是平均值，而是 <strong>P95/P99 延迟</strong>：100 个请求里最慢的那几个，往往决定了系统看起来是不是“卡”。

本文目标不是把 RAG 讲成玄学，而是按工程排障方式拆它：

1. 建一个最小可运行的 Spring Boot + Spring AI + pgvector 示例；
2. 用压测数据拆出 RAG 链路各阶段耗时；
3. 用 <strong>JFR（Java Flight Recorder）</strong> 看线程、Socket、GC 等运行时证据；
4. 对比 Embedding 缓存、TopK、连接池参数对 P95/P99 的影响；
5. 给出常见坑和验证方法。

> 注：本文数据来自本地可复现实验的示例量级，不代表任何云厂商或线上业务的真实 SLA。重点是方法：如何拆、如何量、如何验证。

<h1 id="目标读者与先修知识"><a href="#目标读者与先修知识" class="headerlink" title="目标读者与先修知识"></a>目标读者与先修知识</h1>

适合这些读者：

- 做 Java/Spring Boot 后端，准备接入 RAG 或正在排查 AI 接口慢；
- 听过 Embedding、向量数据库，但还没有系统压测过链路；
- 知道 JVM 基本概念，希望用 JFR 看真实运行证据。

需要的先修知识：

- 会启动 Spring Boot 服务；
- 会用 Docker Compose 起 PostgreSQL；
- 对 HTTP 接口、连接池、SQL 索引有基本了解。

<h1 id="RAG-链路先拆开"><a href="#RAG-链路先拆开" class="headerlink" title="RAG 链路先拆开"></a>RAG 链路先拆开</h1>

一个典型 RAG 请求，大致可以拆成 5 段：

| 阶段 | 做什么 | 常见耗时来源 | 优化方向 |
| --- | --- | --- | --- |
| Query Embedding | 把用户问题转成向量 | 模型 API 延迟、网络抖动、限流 | 缓存、批量、降维、小模型 |
| Vector Search | 在知识库里查相似片段 | 索引类型、TopK、过滤条件、连接池 | HNSW/IVFFlat、TopK 控制、预过滤 |
| Context Build | 拼上下文和 Prompt | 文本过长、重复片段、序列化 | 去重、截断、模板化 |
| Chat Completion | 调大模型生成答案 | 模型大小、输出长度、流式响应 | 控制 max tokens、流式、模型路由 |
| Response Post-process | 引用、格式化、审计 | JSON 解析、正则、二次调用 | 减少同步后处理 |

这里有几个新词先说清楚：

- <strong>Embedding</strong>：把文本变成一串数字向量，语义相近的文本向量距离也更近；适合做语义检索。
- <strong>向量数据库</strong>：专门按向量相似度查数据的存储系统；pgvector 是 PostgreSQL 的一个向量扩展。
- <strong>TopK</strong>：检索时返回最相似的前 K 条。K 越大，召回材料越多，但延迟和 Prompt 成本也会上升。
- <strong>P95/P99</strong>：百分位延迟。P99=1200ms 表示 99% 请求不超过 1200ms，剩下 1% 更慢。
- <strong>JFR</strong>：JDK 自带的低开销运行时采样工具，可以记录 CPU、线程阻塞、Socket、GC、对象分配等事件。

<h1 id="可复现实验：Spring-Boot-Spring-AI-pgvector"><a href="#可复现实验：Spring-Boot-Spring-AI-pgvector" class="headerlink" title="可复现实验：Spring Boot + Spring AI + pgvector"></a>可复现实验：Spring Boot + Spring AI + pgvector</h1>

下面的示例尽量小，但保留真实 RAG 链路里的关键点：Embedding、向量检索、Prompt 拼装、Chat 调用。

<h2 id="1-启动-pgvector"><a href="#1-启动-pgvector" class="headerlink" title="1. 启动 pgvector"></a>1. 启动 pgvector</h2>

新建 `docker-compose.yml`：

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: rag-pgvector
    environment:
      POSTGRES_USER: rag
      POSTGRES_PASSWORD: rag
      POSTGRES_DB: rag
    ports:
      - "5432:5432"
    command: ["postgres", "-c", "shared_preload_libraries=vector"]
```

启动：

```bash
docker compose up -d
```

初始化表结构：

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_chunk (
  id BIGSERIAL PRIMARY KEY,
  doc_id VARCHAR(64) NOT NULL,
  chunk_no INT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_embedding
ON knowledge_chunk USING hnsw (embedding vector_cosine_ops);
```

> 注：<strong>HNSW</strong> 是一种近似最近邻索引。简单理解，它用图结构加速“找相似向量”，牺牲一点点精确度，换更稳定的查询速度。

<h2 id="2-Spring-Boot-依赖"><a href="#2-Spring-Boot-依赖" class="headerlink" title="2. Spring Boot 依赖"></a>2. Spring Boot 依赖</h2>

`pom.xml` 关键依赖示例：

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
    <groupId>org.postgresql</groupId>
    <artifactId>postgresql</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-openai-spring-boot-starter</artifactId>
  </dependency>
</dependencies>
```

`application.yml` 示例：

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/rag
    username: rag
    password: rag
    hikari:
      maximum-pool-size: 16
      minimum-idle: 4
      connection-timeout: 1000
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4o-mini
          temperature: 0.2
          max-tokens: 512
      embedding:
        options:
          model: text-embedding-3-small
```

这里的 <strong>HikariCP</strong> 是 Spring Boot 默认常用的 JDBC 连接池，负责复用数据库连接，避免每次请求都新建 TCP 连接。

<h2 id="3-核心代码：给每段打点"><a href="#3-核心代码：给每段打点" class="headerlink" title="3. 核心代码：给每段打点"></a>3. 核心代码：给每段打点</h2>

先定义响应结构，把每段耗时带出来：

```java
public record RagAnswer(
    String answer,
    long embeddingMs,
    long searchMs,
    long promptMs,
    long chatMs,
    long totalMs
) {}
```

RAG Service 示例：

```java
@Service
public class RagService {

    private final JdbcTemplate jdbcTemplate;
    private final EmbeddingModel embeddingModel;
    private final ChatClient chatClient;
    private final LoadingCache<String, float[]> embeddingCache;

    public RagService(JdbcTemplate jdbcTemplate,
                      EmbeddingModel embeddingModel,
                      ChatClient.Builder chatClientBuilder) {
        this.jdbcTemplate = jdbcTemplate;
        this.embeddingModel = embeddingModel;
        this.chatClient = chatClientBuilder.build();
        this.embeddingCache = Caffeine.newBuilder()
                .maximumSize(10_000)
                .expireAfterWrite(Duration.ofHours(6))
                .build(this::embed);
    }

    public RagAnswer ask(String question, int topK, boolean useCache) {
        long start = System.nanoTime();

        long t1 = System.nanoTime();
        float[] queryVector = useCache ? embeddingCache.get(question) : embed(question);
        long embeddingMs = elapsedMs(t1);

        long t2 = System.nanoTime();
        List<String> chunks = search(queryVector, topK);
        long searchMs = elapsedMs(t2);

        long t3 = System.nanoTime();
        String prompt = buildPrompt(question, chunks);
        long promptMs = elapsedMs(t3);

        long t4 = System.nanoTime();
        String answer = chatClient.prompt(prompt).call().content();
        long chatMs = elapsedMs(t4);

        return new RagAnswer(answer, embeddingMs, searchMs, promptMs, chatMs, elapsedMs(start));
    }

    private float[] embed(String text) {
        EmbeddingResponse response = embeddingModel.embedForResponse(List.of(text));
        return response.getResult().getOutput();
    }

    private List<String> search(float[] vector, int topK) {
        String sql = """
            SELECT content
            FROM knowledge_chunk
            ORDER BY embedding <=> ?::vector
            LIMIT ?
            """;
        String vectorLiteral = toPgVector(vector);
        return jdbcTemplate.query(sql, (rs, rowNum) -> rs.getString("content"), vectorLiteral, topK);
    }

    private String buildPrompt(String question, List<String> chunks) {
        String context = String.join("\n\n---\n\n", chunks);
        return """
            你是一个严谨的技术助手。只能基于给定资料回答，资料不足就说不知道。

            ## 资料
            %s

            ## 问题
            %s
            """.formatted(context, question);
    }

    private String toPgVector(float[] vector) {
        return Arrays.stream(toDoubleArray(vector))
                .mapToObj(v -> String.format(Locale.ROOT, "%.8f", v))
                .collect(Collectors.joining(",", "[", "]"));
    }

    private static double[] toDoubleArray(float[] values) {
        double[] result = new double[values.length];
        for (int i = 0; i < values.length; i++) {
            result[i] = values[i];
        }
        return result;
    }

    private static long elapsedMs(long startedAtNanos) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAtNanos);
    }
}
```

Controller：

```java
@RestController
@RequestMapping("/api/rag")
public class RagController {
    private final RagService ragService;

    public RagController(RagService ragService) {
        this.ragService = ragService;
    }

    @GetMapping("/ask")
    public RagAnswer ask(@RequestParam String q,
                         @RequestParam(defaultValue = "5") int topK,
                         @RequestParam(defaultValue = "true") boolean cache) {
        return ragService.ask(q, topK, cache);
    }
}
```

> 注：生产环境不建议直接把问题作为缓存 key，因为用户输入可能包含隐私信息；这里为了实验简单，后面会讲怎么处理。

<h2 id="4-准备测试数据"><a href="#4-准备测试数据" class="headerlink" title="4. 准备测试数据"></a>4. 准备测试数据</h2>

准备 1000~10000 条技术文档切片，每条 300~800 字，然后批量生成 Embedding 写入数据库。切片是把长文档拆成小段，避免一次塞给模型的上下文太长。

伪代码如下：

```java
for (DocumentChunk chunk : chunks) {
    float[] vector = embeddingModel.embed(chunk.content());
    jdbcTemplate.update("""
        INSERT INTO knowledge_chunk(doc_id, chunk_no, content, embedding)
        VALUES (?, ?, ?, ?::vector)
        """, chunk.docId(), chunk.chunkNo(), chunk.content(), toPgVector(vector));
}
```

验证索引是否被使用：

```sql
EXPLAIN ANALYZE
SELECT content
FROM knowledge_chunk
ORDER BY embedding <=> '[0.01,0.02,...]'::vector
LIMIT 5;
```

如果看到 `Index Scan using idx_knowledge_chunk_embedding`，说明 HNSW 索引生效；如果是全表扫描，先别急着优化 Java，数据库这一段就已经慢了。

<h1 id="压测方法：不要只看平均值"><a href="#压测方法：不要只看平均值" class="headerlink" title="压测方法：不要只看平均值"></a>压测方法：不要只看平均值</h1>

用 `wrk` 或 `k6` 都可以。这里用 `k6`，因为它输出 P95/P99 比较直接。

`rag.js`：

```javascript
import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  vus: 20,
  duration: '2m',
  thresholds: {
    http_req_duration: ['p(95)<2500'],
  },
};

const questions = [
  'Spring Boot 接口 P99 很高应该怎么排查？',
  'Redis 缓存穿透和缓存击穿有什么区别？',
  'JVM 发生 Full GC 时接口为什么会变慢？',
  'MySQL 联合索引最左前缀怎么理解？'
];

export default function () {
  const q = questions[Math.floor(Math.random() * questions.length)];
  http.get(`http://localhost:8080/api/rag/ask?q=${encodeURIComponent(q)}&topK=5&cache=true`);
  sleep(1);
}
```

执行：

```bash
k6 run rag.js
```

同时把应用日志打出每段耗时，建议用 JSON 格式，方便后面用 jq 统计：

```json
{"embeddingMs":18,"searchMs":12,"promptMs":1,"chatMs":713,"totalMs":744,"topK":5,"cache":true}
```

<h1 id="实验结果：Embedding-缓存和-TopK-影响很明显"><a href="#实验结果：Embedding-缓存和-TopK-影响很明显" class="headerlink" title="实验结果：Embedding 缓存和 TopK 影响很明显"></a>实验结果：Embedding 缓存和 TopK 影响很明显</h1>

示例环境：8C16G 本地开发机、JDK 21、Spring Boot 3.x、PostgreSQL 16 + pgvector、知识库 5000 个 chunk、20 VU、持续 2 分钟。

| 场景 | QPS | 平均延迟 | P95 | P99 | 备注 |
| --- | ---: | ---: | ---: | ---: | --- |
| A：无 Embedding 缓存，TopK=10 | 7.8 | 2140ms | 3920ms | 5410ms | 每次都调 Embedding，Prompt 也偏长 |
| B：有 Embedding 缓存，TopK=10 | 10.9 | 1530ms | 2860ms | 4110ms | 重复问题命中缓存后明显改善 |
| C：有缓存，TopK=5 | 14.6 | 1040ms | 1890ms | 2670ms | 上下文减半，Chat 耗时下降 |
| D：有缓存，TopK=5，连接池 4 → 16 | 15.8 | 960ms | 1710ms | 2380ms | DB 等待减少，但不是主瓶颈 |

这里要注意两点：

第一，<strong>Embedding 缓存降低的是检索前置成本</strong>。如果业务里重复问题很多，例如客服 FAQ、内部知识库问答，缓存收益会很大；如果每个问题都完全不同，缓存命中率低，收益就有限。

第二，<strong>TopK 不是越大越好</strong>。TopK=10 看起来给模型更多资料，但也会增加 Prompt token 数量，导致 Chat 阶段更慢、更贵，还可能把噪声材料塞进去。多数业务应该先从 TopK=3~5 起步，再用评测集验证召回率。

<h2 id="分段耗时对比"><a href="#分段耗时对比" class="headerlink" title="分段耗时对比"></a>分段耗时对比</h2>

以 P95 附近请求为例：

| 场景 | Embedding | Vector Search | Prompt Build | Chat | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| A：无缓存，TopK=10 | 620ms | 42ms | 5ms | 3250ms | 3920ms |
| B：有缓存，TopK=10 | 20ms | 39ms | 5ms | 2780ms | 2860ms |
| C：有缓存，TopK=5 | 18ms | 22ms | 3ms | 1840ms | 1890ms |

这个结果挺符合直觉：在 RAG 链路里，Chat 模型调用通常是大头，但 Embedding 和 TopK 会间接放大它。

<h1 id="用-JFR-看证据：慢在哪，不要靠猜"><a href="#用-JFR-看证据：慢在哪，不要靠猜" class="headerlink" title="用 JFR 看证据：慢在哪，不要靠猜"></a>用 JFR 看证据：慢在哪，不要靠猜</h1>

压测时启动 JFR：

```bash
java \
  -XX:StartFlightRecording=filename=rag.jfr,duration=120s,settings=profile \
  -jar target/rag-demo.jar
```

或者对运行中的进程采集：

```bash
jcmd <pid> JFR.start name=rag settings=profile duration=120s filename=rag.jfr
```

用 JDK Mission Control 打开 `rag.jfr`，重点看这几个面板：

| 面板 | 看什么 | 可能结论 |
| --- | --- | --- |
| Method Profiling | CPU 热点方法 | JSON 序列化、向量字符串转换是否过重 |
| Socket I/O | 外部 HTTP 调用耗时 | 模型 API 是否在 P99 抖动 |
| Threads | WAITING/BLOCKED | 连接池、HTTP 客户端池是否排队 |
| Garbage Collections | GC 次数与暂停 | 大 Prompt 拼接是否制造太多临时对象 |
| Allocation | 对象分配热点 | `String.format`、大字符串拼接是否过多 |

这次示例里能看到两个有意思的点：

1. Socket Read 时间占比很高，说明模型调用确实是主耗时；
2. `toPgVector` 里的 `String.format` 有明显分配，虽然不是最大瓶颈，但在高并发下会增加 GC 压力。

优化一下向量序列化：

```java
private String toPgVectorFast(float[] vector) {
    StringBuilder sb = new StringBuilder(vector.length * 10);
    sb.append('[');
    for (int i = 0; i < vector.length; i++) {
        if (i > 0) sb.append(',');
        sb.append(vector[i]);
    }
    sb.append(']');
    return sb.toString();
}
```

再次压测，Vector Search 阶段平均可能只少几毫秒，但 Allocation 压力会下降。这个优化本身不神奇，关键是过程：<strong>先用 JFR 找证据，再决定改哪里</strong>。

<h1 id="优化策略：先控成本，再谈体验"><a href="#优化策略：先控成本，再谈体验" class="headerlink" title="优化策略：先控成本，再谈体验"></a>优化策略：先控成本，再谈体验</h1>

<h2 id="1-Embedding-缓存：能省钱，也能稳住-P99"><a href="#1-Embedding-缓存：能省钱，也能稳住-P99" class="headerlink" title="1. Embedding 缓存：能省钱，也能稳住 P99"></a>1. Embedding 缓存：能省钱，也能稳住 P99</h2>

Embedding 缓存适合这些场景：

- FAQ、文档问答，问题重复率高；
- 查询改写后能归一化，例如去掉空格、标点、大小写；
- 可以接受缓存短时间不更新。

不建议直接缓存原始用户问题，至少要做三件事：

```java
String normalized = question
    .trim()
    .toLowerCase(Locale.ROOT)
    .replaceAll("\\s+", " ");
String key = DigestUtils.sha256Hex(normalized);
```

- 归一化：提高命中率；
- 哈希化：避免缓存系统里直接暴露用户输入；
- 设置 TTL：避免长期保留可能敏感的问题。

<h2 id="2-TopK-要用评测集定，不要拍脑袋"><a href="#2-TopK-要用评测集定，不要拍脑袋" class="headerlink" title="2. TopK 要用评测集定，不要拍脑袋"></a>2. TopK 要用评测集定，不要拍脑袋</h2>

建议准备一小批评测集：问题、期望命中的 doc_id、可接受答案要点。

```json
{
  "question": "Spring Boot 接口 P99 很高怎么排查？",
  "expectedDocIds": ["jvm-jfr", "thread-pool", "db-pool"],
  "answerKeywords": ["分段耗时", "JFR", "连接池", "P95"]
}
```

用不同 TopK 跑一遍：

| TopK | 召回率 | 平均 Prompt tokens | P95 | 结论 |
| ---: | ---: | ---: | ---: | --- |
| 3 | 86% | 1100 | 1420ms | 快，但少量问题材料不够 |
| 5 | 94% | 1800 | 1890ms | 性价比最好 |
| 10 | 97% | 3400 | 2860ms | 召回略升，延迟明显变差 |

如果没有评测集，TopK 调优基本就是玄学。

<h2 id="3-连接池：别让小池子制造排队"><a href="#3-连接池：别让小池子制造排队" class="headerlink" title="3. 连接池：别让小池子制造排队"></a>3. 连接池：别让小池子制造排队</h2>

RAG 接口里数据库不是最慢的部分，但小连接池会让请求排队，进一步放大尾延迟。

建议至少观测：

- Hikari `active connections`：正在使用的连接数；
- Hikari `pending threads`：等待连接的线程数；
- PostgreSQL 慢查询日志；
- `EXPLAIN ANALYZE` 的执行计划。

如果 `pending threads` 长期大于 0，说明应用线程在等连接。这个时候加缓存、换模型都救不了数据库排队。

<h2 id="4-Chat-阶段：减少输入，控制输出"><a href="#4-Chat-阶段：减少输入，控制输出" class="headerlink" title="4. Chat 阶段：减少输入，控制输出"></a>4. Chat 阶段：减少输入，控制输出</h2>

Chat 阶段的优化通常围绕两个词：<strong>tokens</strong> 和 <strong>streaming</strong>。

- tokens：可以理解为模型处理文本的基本单位，输入输出越长，耗时和费用通常越高；
- streaming：流式响应，模型生成一点就返回一点，不能减少总耗时太多，但能明显改善“首字响应时间”。

可操作建议：

1. 限制每个 chunk 的长度；
2. 检索后做去重，避免多个 chunk 讲同一件事；
3. 设置 `max_tokens`，别让模型无限发挥；
4. 对简单问题走小模型，对复杂问题再路由到大模型。

<h1 id="如何验证结论"><a href="#如何验证结论" class="headerlink" title="如何验证结论"></a>如何验证结论</h1>

建议按这个顺序验证，别一次改太多参数：

1. 固定知识库、固定问题集、固定并发数；
2. 基线压测：缓存关、TopK=10，记录 QPS/P95/P99；
3. 只打开 Embedding 缓存，重复压测；
4. 只调整 TopK：3、5、10 分别压测；
5. 只调整连接池：4、8、16 分别压测；
6. 每轮都采集 JFR，确认瓶颈是否真的转移。

一条简单的验收标准可以这么写：

```text
在 20 VU、5000 chunk、固定 4 个问题的条件下：
- P95 从 3000ms+ 降到 2000ms 内；
- P99 从 5000ms+ 降到 3000ms 内；
- 召回率不低于 94%；
- JFR 中没有明显连接池等待和频繁 Full GC。
```

注意，RAG 优化不能只看延迟。如果把 TopK 调到 1，延迟当然会下降，但答案质量可能崩掉。所以最终要一起看：延迟、成本、召回、答案正确率。

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="误区一：RAG-慢就一定是模型慢"><a href="#误区一：RAG-慢就一定是模型慢" class="headerlink" title="误区一：RAG 慢就一定是模型慢"></a>误区一：RAG 慢就一定是模型慢</h2>

不一定。模型通常是大头，但数据库索引没命中、HTTP 连接池排队、Prompt 过长、JSON 序列化过重，都可能把 P99 拉爆。先分段打点，再下结论。

<h2 id="误区二：TopK-越大答案越准"><a href="#误区二：TopK-越大答案越准" class="headerlink" title="误区二：TopK 越大答案越准"></a>误区二：TopK 越大答案越准</h2>

TopK 大只代表塞进去的材料多，不代表有用信息多。噪声材料会干扰模型，还会增加 token 成本。TopK 要用评测集定。

<h2 id="误区三：缓存可以无脑开"><a href="#误区三：缓存可以无脑开" class="headerlink" title="误区三：缓存可以无脑开"></a>误区三：缓存可以无脑开</h2>

缓存涉及隐私、过期、命中率和一致性。用户原始问题可能包含手机号、订单号、内部系统名，不要直接明文落到 Redis 或日志里。

<h2 id="误区四：只压平均延迟"><a href="#误区四：只压平均延迟" class="headerlink" title="误区四：只压平均延迟"></a>误区四：只压平均延迟</h2>

平均值会掩盖尾延迟。RAG 链路外部依赖多，P95/P99 更重要。线上告警也建议按百分位设置，而不是只看 average。

<h2 id="误区五：JFR-只适合 JVM-调优"><a href="#误区五：JFR-只适合 JVM-调优" class="headerlink" title="误区五：JFR 只适合 JVM 调优"></a>误区五：JFR 只适合 JVM 调优</h2>

JFR 不只是看 GC，它还能看 Socket I/O、线程等待、对象分配。排查 RAG 这种“Java 应用 + 外部模型 API + 数据库”的混合链路，非常实用。

<h1 id="小结"><a href="#小结" class="headerlink" title="小结"></a>小结</h1>

这篇文章核心观点很简单：<strong>RAG 延迟优化要拆链路，不要凭感觉调参数</strong>。

可以记住几条经验：

- Embedding、向量检索、Prompt、Chat 要分别打点；
- P95/P99 比平均值更能反映用户体验；
- Embedding 缓存适合重复问题，但要注意隐私和 TTL；
- TopK 要用评测集定，不能越大越好；
- JFR 能给 Java 侧的线程、Socket、GC、分配提供证据；
- 最终要同时看延迟、成本、召回和答案质量。

如果只做一件事，我建议先给 RAG 链路加分段耗时日志。没有这一步，后面的所有优化都容易变成“看起来很努力，但不知道有没有用”。

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

1. Spring AI Reference Documentation：<https://docs.spring.io/spring-ai/reference/>
2. pgvector 官方文档：<https://github.com/pgvector/pgvector>
3. PostgreSQL EXPLAIN 官方文档：<https://www.postgresql.org/docs/current/using-explain.html>
4. OpenJDK JFR Runtime Guide：<https://docs.oracle.com/javacomponents/jmc-5-5/jfr-runtime-guide/about.htm>
5. Caffeine Cache 官方文档：<https://github.com/ben-manes/caffeine>
6. Google SRE Book - Monitoring Distributed Systems：<https://sre.google/sre-book/monitoring-distributed-systems/>
7. AWS Builders Library - Timeouts, retries, and backoff with jitter：<https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/>
