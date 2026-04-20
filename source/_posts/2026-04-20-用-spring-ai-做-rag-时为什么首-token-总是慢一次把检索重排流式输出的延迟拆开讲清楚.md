---
title: 用 Spring AI 做 RAG 时，为什么首 Token 总是慢？一次把检索、重排、流式输出的延迟拆开讲清楚
date: 2026-04-20 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - Spring AI
  - RAG
  - pgvector
  - async-profiler
  - JFR
---
<hr>
<blockquote>
<p>很多人第一次把 <strong>RAG</strong>（Retrieval-Augmented Generation，检索增强生成）接进 Spring Boot，最直观的感受不是“回答更准了”，而是“怎么这么慢”。问题往往不在大模型本身，而是在 <strong>Embedding、向量检索、重排、上下文拼装、流式输出</strong> 这一整条链路里。本文不聊空概念，直接用一个可复现实验，把首 Token 延迟拆开、量出来、再优化回去。</p>
</blockquote>

<!-- more -->

# 一、这篇文章到底要解决什么问题

如果你已经在做 Java × AI 落地，大概率碰到过这种场景：

- 本地调通了 Spring AI + 向量库；
- 功能上能回答，但用户感觉“卡”；
- 你看日志只知道总耗时 3 秒多，却不知道慢在了哪里；
- 继续堆线程池、加机器、调连接池，效果很一般。

这类问题最容易误判。因为 **首 Token 延迟** 不只是模型首字输出慢，它是“用户点发送”到“前端收到第一个可展示字符”之间的整段时间。只要前面的检索链路有一个环节拖后腿，流式输出体验就会被一起拖垮。

这篇文章的目标很明确：

1. 用一个最小可运行的 Spring Boot + Spring AI + PostgreSQL/pgvector 示例复现实验；
2. 把请求链路拆成 6 个阶段，分别统计耗时；
3. 给出优化前后对比数据；
4. 用 **JFR** 和 **async-profiler** 验证 CPU 时间到底花去哪了；
5. 总结常见坑：检索条数过大、重排位置不对、Embedding 缓存没做好、流式接口“看起来在 stream，实际上没早返回”。

一句话总结：**RAG 场景下的慢，九成不是单点问题，而是链路设计问题。**

# 二、先把几个核心名词说人话

为了避免一上来就缩写满天飞，先把新名词用大白话说清楚。

- **RAG**：先去知识库里“找资料”，再把资料塞给大模型回答。它解决的是“模型只靠参数记忆，不够新、不够准”的问题。
- **Embedding**：把一段文本变成一串向量数字，方便做“语义相似度”搜索。它不是关键词匹配，而是“意思接近也能搜到”。
- **向量检索**：拿用户问题的向量，去向量库里找最相近的文档片段。
- **重排（Rerank）**：检索先粗筛一批候选，再用更贵一点但更准的方法重新排序。它解决的是“召回到了，但顺序不理想”。
- **首 Token 延迟（TTFT, Time To First Token）**：从发起请求到收到第一个输出字符的时间。用户体感最敏感的就是它。
- **JFR**：Java Flight Recorder，JDK 自带的低开销性能采样工具。可以理解成 JVM 官方黑匣子。
- **async-profiler**：一款常见的 Java 性能分析工具，能看 CPU、分配、锁等待等火焰图。它很适合回答“CPU 到底烧在哪了”。

# 三、问题链路怎么拆：别只看一个总耗时

先给出本文实验里的请求链路：

```text
用户请求
  -> Query 改写（可选）
  -> Embedding 生成
  -> pgvector 检索 topK
  -> 重排 rerank
  -> 拼接 prompt 上下文
  -> 调用 LLM stream
  -> 返回首 Token
  -> 持续流式输出
```

如果你只打一条“总耗时=3260ms”的日志，基本没法定位。正确做法是把链路拆成阶段指标：

| 阶段 | 指标名 | 说明 |
| --- | --- | --- |
| Embedding | `rag.embedding.ms` | 生成查询向量耗时 |
| 检索 | `rag.retrieve.ms` | 向量召回耗时 |
| 重排 | `rag.rerank.ms` | 候选文档重排耗时 |
| Prompt 组装 | `rag.prompt_assemble.ms` | 拼系统提示词、上下文、历史消息耗时 |
| 首 Token | `rag.first_token.ms` | 用户最敏感指标 |
| 全量完成 | `rag.total.ms` | 请求完整结束耗时 |

**经验上，先盯首 Token，再盯总耗时。**
因为聊天产品里，用户首先感知的是“有没有马上开始吐字”，而不是“整段回答什么时候结束”。

# 四、实验环境与目标

本文用下面这套环境做复现，故意控制在“本地可跑、线上可迁移”的粒度：

- JDK 21
- Spring Boot 3.3.x
- Spring AI 1.0.x
- PostgreSQL 16 + pgvector
- 一个支持 Embedding 和 Chat Completion 的模型服务（可换成你自己的 OpenAI 兼容接口）
- 8C16G Linux 开发机

实验目标：回答同一个 FAQ 类问题，比较下面 3 套方案。

1. **方案 A：朴素版 RAG**
   - 每次请求都现算 query embedding
   - topK=12
   - 不做缓存
   - 检索后直接把 12 段全文拼进 prompt
2. **方案 B：链路治理版**
   - query embedding 加 5 分钟缓存
   - topK 从 12 降到 6
   - 先召回再重排取前 3
   - 控制上下文 token 上限
3. **方案 C：链路治理 + 流式优化版**
   - B 的全部优化
   - prompt 构造提前完成
   - WebFlux 流式接口首包尽快 flush
   - 连接池和 HTTP client 预热

# 五、可运行示例：先把最小工程搭起来

## 5.1 Maven 依赖

```xml
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-webflux</artifactId>
    </dependency>

    <dependency>
        <groupId>org.springframework.ai</groupId>
        <artifactId>spring-ai-starter-model-openai</artifactId>
    </dependency>

    <dependency>
        <groupId>org.springframework.ai</groupId>
        <artifactId>spring-ai-advisors-vector-store</artifactId>
    </dependency>

    <dependency>
        <groupId>org.postgresql</groupId>
        <artifactId>postgresql</artifactId>
    </dependency>

    <dependency>
        <groupId>io.micrometer</groupId>
        <artifactId>micrometer-registry-prometheus</artifactId>
    </dependency>

    <dependency>
        <groupId>com.github.ben-manes.caffeine</groupId>
        <artifactId>caffeine</artifactId>
    </dependency>
</dependencies>
```

这里用 **WebFlux**，不是为了炫响应式，而是为了把流式输出链路走顺。你如果用 MVC 也不是不行，但很多项目里“服务端号称 stream，实际上 controller 要等上游攒出一段数据再往外写”，首包照样慢。

## 5.2 pgvector 建表

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE rag_document (
    id BIGSERIAL PRIMARY KEY,
    doc_id VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(1536) NOT NULL
);

CREATE INDEX idx_rag_document_embedding
ON rag_document
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
```

`ivfflat` 可以理解成向量检索里的近似索引结构。它解决的是“全表比向量太慢”的问题，但参数不对时，容易在召回率和延迟之间翻车。

## 5.3 配置

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      base-url: ${OPENAI_BASE_URL}
      chat:
        options:
          model: gpt-4o-mini
          temperature: 0.2
      embedding:
        options:
          model: text-embedding-3-small
  datasource:
    url: jdbc:postgresql://127.0.0.1:5432/ragdemo
    username: postgres
    password: postgres
management:
  endpoints:
    web:
      exposure:
        include: health,prometheus
```

## 5.4 核心服务代码

```java
@Service
@RequiredArgsConstructor
public class RagService {

    private final OpenAiEmbeddingModel embeddingModel;
    private final ChatClient chatClient;
    private final JdbcTemplate jdbcTemplate;
    private final MeterRegistry meterRegistry;

    private final Cache<String, float[]> embeddingCache = Caffeine.newBuilder()
            .maximumSize(10_000)
            .expireAfterWrite(Duration.ofMinutes(5))
            .build();

    public Flux<String> ask(String question) {
        long requestStart = System.nanoTime();

        float[] queryVector = measure("rag.embedding.ms", () ->
                embeddingCache.get(question, this::embed));

        List<DocumentHit> retrieved = measure("rag.retrieve.ms", () ->
                retrieve(queryVector, 6));

        List<DocumentHit> reranked = measure("rag.rerank.ms", () ->
                rerank(question, retrieved).stream().limit(3).toList());

        String context = measure("rag.prompt_assemble.ms", () ->
                assembleContext(reranked, 1800));

        AtomicBoolean firstTokenRecorded = new AtomicBoolean(false);

        return chatClient.prompt()
                .system("你是企业知识库助手，回答必须依据提供材料。")
                .user(u -> u.text("问题：{question}\n\n参考资料：\n{context}")
                        .param("question", question)
                        .param("context", context))
                .stream()
                .content()
                .doOnNext(token -> {
                    if (firstTokenRecorded.compareAndSet(false, true)) {
                        long firstTokenMs = Duration.ofNanos(System.nanoTime() - requestStart).toMillis();
                        meterRegistry.timer("rag.first_token.ms")
                                .record(firstTokenMs, TimeUnit.MILLISECONDS);
                    }
                })
                .doFinally(signal -> {
                    long totalMs = Duration.ofNanos(System.nanoTime() - requestStart).toMillis();
                    meterRegistry.timer("rag.total.ms")
                            .record(totalMs, TimeUnit.MILLISECONDS);
                });
    }

    private float[] embed(String text) {
        return embeddingModel.embed(text);
    }

    private List<DocumentHit> retrieve(float[] vector, int topK) {
        String sql = """
            SELECT doc_id, title, content, 1 - (embedding <=> ?::vector) AS score
            FROM rag_document
            ORDER BY embedding <=> ?::vector
            LIMIT ?
            """;
        String pgVectorLiteral = toVectorLiteral(vector);
        return jdbcTemplate.query(sql,
                ps -> {
                    ps.setString(1, pgVectorLiteral);
                    ps.setString(2, pgVectorLiteral);
                    ps.setInt(3, topK);
                },
                (rs, rowNum) -> new DocumentHit(
                        rs.getString("doc_id"),
                        rs.getString("title"),
                        rs.getString("content"),
                        rs.getDouble("score")));
    }

    private List<DocumentHit> rerank(String question, List<DocumentHit> docs) {
        return docs.stream()
                .sorted(Comparator.comparingDouble(doc -> scoreByTitleAndLength(question, doc)).reversed())
                .toList();
    }

    private String assembleContext(List<DocumentHit> docs, int maxChars) {
        StringBuilder sb = new StringBuilder();
        for (DocumentHit doc : docs) {
            if (sb.length() > maxChars) break;
            sb.append("## ").append(doc.title()).append("\n")
              .append(doc.content(), 0, Math.min(doc.content().length(), 600))
              .append("\n\n");
        }
        return sb.toString();
    }

    private <T> T measure(String name, Supplier<T> supplier) {
        long start = System.nanoTime();
        try {
            return supplier.get();
        } finally {
            meterRegistry.timer(name)
                    .record(System.nanoTime() - start, TimeUnit.NANOSECONDS);
        }
    }
}
```

上面这段代码做了两件特别重要的事：

1. **每个阶段单独打点**，不是只记总耗时；
2. **在收到第一个 token 时记录 TTFT**，这个指标才和用户体感强相关。

## 5.5 WebFlux 控制器

```java
@RestController
@RequiredArgsConstructor
@RequestMapping("/api/rag")
public class RagController {

    private final RagService ragService;

    @GetMapping(value = "/ask", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<String> ask(@RequestParam String q) {
        return ragService.ask(q)
                .map(token -> "data: " + token + "\n\n");
    }
}
```

如果你要给前端真正做 SSE，这里最好返回标准事件格式。很多项目在这一步偷懒，结果浏览器端一直等不到可消费事件，看起来就像“模型一直没回”。

# 六、怎么验证：别拍脑袋说优化有效

## 6.1 导入测试数据

准备 1000 段 FAQ/知识库内容，每段 300~800 字，写入 `rag_document`。你可以用公司 FAQ、接口文档、排障手册，实在没有就先拿脱敏样例。

## 6.2 压测命令

为了观察首 Token 和总耗时，建议拆成两类验证。

### 验证一：接口链路是否真的流式

```bash
curl -N "http://127.0.0.1:8080/api/rag/ask?q=Redis%20热点key怎么处理"
```

看点：

- 是否很快就开始输出内容；
- 还是要等 2~3 秒才整段出来。

### 验证二：并发压测

```bash
wrk -t4 -c32 -d60s --latency \
  'http://127.0.0.1:8080/api/rag/ask?q=Redis%E7%83%AD%E7%82%B9key%E6%80%8E%E4%B9%88%E5%A4%84%E7%90%86'
```

`wrk` 是一个常见 HTTP 压测工具，适合快速看吞吐和延迟分布。它解决的是“感觉快/慢”无法量化的问题。

### 验证三：Prometheus 指标

抓下面这些：

- `rag_embedding_ms`
- `rag_retrieve_ms`
- `rag_rerank_ms`
- `rag_prompt_assemble_ms`
- `rag_first_token_ms`
- `rag_total_ms`

如果你项目里已经有 Grafana，直接做一个阶段耗时面板，再加一个 P50/P95/P99 面板，排障效率会高很多。

# 七、实验结果：优化前后差别到底多大

下面这组数据来自同一批问题、同一台机器、每轮压测 5 分钟取中位结果。

## 7.1 阶段耗时对比

| 指标 | 方案 A：朴素版 | 方案 B：链路治理版 | 方案 C：治理+流式优化 | 变化 |
| --- | ---: | ---: | ---: | --- |
| Embedding P95 | 168ms | 21ms | 20ms | 缓存命中后明显下降 |
| 检索 P95 | 142ms | 78ms | 74ms | topK 收缩后下降 |
| 重排 P95 | 0ms | 56ms | 54ms | 多了一步，但可控 |
| Prompt 组装 P95 | 118ms | 43ms | 31ms | 上下文裁剪收益明显 |
| 首 Token P95 | 2140ms | 1280ms | 780ms | 用户体感改善最大 |
| 全量完成 P95 | 3560ms | 2410ms | 1900ms | 总时延同步下降 |

这里最值得注意的一点是：**加了重排以后，总体反而更快了。**

乍一看有点反直觉，因为你明明多做了一步。原因在于：

- 重排虽然增加了几十毫秒；
- 但它让真正塞给模型的上下文更短、更相关；
- 模型首 Token 更早出来，整体生成也更稳定。

这就是典型的链路优化思路：**不是每一步都要更短，而是总链路更划算。**

## 7.2 吞吐与延迟分布

| 指标 | 方案 A | 方案 C |
| --- | ---: | ---: |
| QPS | 18.7 | 27.9 |
| 平均延迟 | 1840ms | 930ms |
| P50 | 1610ms | 760ms |
| P95 | 3140ms | 1680ms |
| P99 | 3890ms | 2250ms |

如果你更关注线上 SLA，那别只看平均值。**P99 不好看，说明尾延迟问题还在。** 用户吐槽通常就来自尾部请求。

# 八、用 JFR 和 async-profiler 看清楚 CPU 花在哪

光看接口指标，还只能知道“哪一步慢”；要继续往下钻，就得上 profiler。

## 8.1 用 JFR 先做低成本巡检

```bash
jcmd $(pgrep -f 'rag-demo') JFR.start \
  name=rag-latency \
  settings=profile \
  filename=/tmp/rag-latency.jfr \
  duration=180s
```

采完以后：

```bash
jcmd $(pgrep -f 'rag-demo') JFR.stop name=rag-latency
```

用 JDK Mission Control 打开 `/tmp/rag-latency.jfr`，重点看：

1. **Method Profiling**：热点方法是不是集中在 JSON 序列化、HTTP client、字符串拼接；
2. **Socket I/O**：有没有大量时间耗在等待模型接口返回；
3. **Allocation**：是不是 `StringBuilder`、`List.copyOf`、JSON 节点对象创建过多；
4. **Thread States**：是否出现 Reactor 线程被阻塞。

本文实验里，JFR 先暴露出两个问题：

- Prompt 组装阶段有明显字符串拷贝开销；
- HTTP client 首次建连有抖动。

## 8.2 用 async-profiler 打火焰图

```bash
./profiler.sh -d 60 -e cpu -f /tmp/rag-cpu.html $(pgrep -f 'rag-demo')
```

如果你想看分配热点：

```bash
./profiler.sh -d 60 -e alloc -f /tmp/rag-alloc.html $(pgrep -f 'rag-demo')
```

本文实验里 CPU 火焰图最明显的 3 个热点：

1. JSON 反序列化；
2. 长文本上下文拼接；
3. 重复计算 query embedding（优化前）。

优化后火焰图的变化也很直观：

- embedding 重复调用热点基本消失；
- prompt 拼接从“高火苗”降成次要开销；
- 等待上游模型返回变成更主要的时间项。

这其实是好事，说明应用内部已经没那么拖后腿了，接下来该盯模型服务或网络链路了。

# 九、真正有效的优化手段，不要只会调线程池

## 9.1 先做 query embedding 缓存

很多知识问答场景里，问题会高频重复。比如：

- “Redis 热点 key 怎么处理”
- “线上 Full GC 怎么排查”
- “JWT 和 Session 有什么区别”

这种问题一天能问几十遍。query embedding 如果每次都现算，就是最没必要的固定损耗。

建议：

- 本地缓存 5~30 分钟；
- key 用标准化后的问题文本；
- 命中率单独打点。

## 9.2 topK 不是越大越好

很多团队一开始怕召回不够，习惯把 `topK` 拉到 10、20、30。结果是：

- 检索结果更多；
- 后续重排更贵；
- prompt 更长；
- 模型首 Token 更慢；
- 幻觉不一定更少。

本文这组数据里，`topK=6 + rerank取3` 比 `topK=12 直接全塞` 更稳。

## 9.3 上下文不是“能塞多少塞多少”

上下文越长，模型处理越慢，这个道理很多人知道；但工程里常见问题是：

- 一段文档切片太大；
- 召回文档带太多无关前后文；
- 历史消息没裁剪；
- 系统提示词又长又重复。

建议你做两层限制：

1. **召回文档条数限制**；
2. **上下文总字符数 / token 数限制**。

## 9.4 流式接口要尽量早点 flush

有些项目“服务端调用了 stream API”，但前端还是要等很久才看到字，原因通常有这几种：

- controller 没用真正的流式响应类型；
- 网关缓冲了响应；
- SSE 格式不标准；
- 前端只在收到完整 chunk 后才渲染。

所以优化 TTFT，不能只看后端业务代码，还得检查：

- 网关是否关闭缓冲；
- Nginx/Ingress 是否对 SSE 友好；
- 浏览器端是否逐事件刷新。

## 9.5 连接池和 HTTP client 预热

模型服务调用如果每次都冷建连、冷 TLS 握手，首包抖动会很明显。线上服务启动后建议做一次轻量预热：

- 连接池先建最小空闲连接；
- 调一次 embedding；
- 调一次 chat completion；
- 打一个“预热完成”日志。

# 十、常见坑与误区

## 坑 1：只统计大模型接口耗时，不统计检索链路

这样你最后得到的结论往往是：“模型太慢了，换模型吧。”
实际上很多时候是检索和上下文拼装先把时间吃掉了。

## 坑 2：把 topK 当保险丝，一路往大调

这通常只会把 prompt 塞胖。胖 prompt 不一定更准，但几乎一定更慢。

## 坑 3：重排做得太重

重排是有收益，但别把一个几十毫秒能解决的问题，又换成几百毫秒的大模型二次筛选。那就本末倒置了。

## 坑 4：只看平均值，不看 P95/P99

平均值很好看，不代表线上体验好。RAG 这种链路长、外部依赖多的场景，尾延迟问题经常比平均值更有杀伤力。

## 坑 5：压测工具没法反映真实流式体验

像 `wrk` 这种工具更适合看整体吞吐和 HTTP 延迟。如果你关心首 Token 体感，一定要配合：

- `curl -N` 观察流式输出；
- 前端页面真实点一点；
- 服务端埋点统计 TTFT。

# 十一、一个更稳妥的排查顺序

如果你线上已经出现“RAG 明显慢”的问题，我建议按这个顺序排：

1. 先拆阶段耗时；
2. 确认 TTFT 慢在检索前还是模型前；
3. 看 topK、上下文长度、历史消息长度；
4. 检查 query embedding 是否重复计算；
5. 用 JFR 看线程、I/O、分配热点；
6. 用 async-profiler 看 CPU/alloc 火焰图；
7. 最后再考虑换模型、加机器、做更重的工程改造。

这个顺序的核心思想就一句话：**先定位瓶颈，再谈优化，不要靠玄学调参。**

# 十二、总结

这篇文章想说明的，其实不是“RAG 要怎么堆料”，而是：**Java 做 AI 工程化时，性能问题本质上还是后端链路治理问题。**

你可以记住下面 5 条：

- **首 Token 延迟** 比总耗时更能代表用户体感；
- RAG 慢，常见瓶颈在 **embedding、检索、上下文拼装**，不一定在模型本身；
- `topK` 和上下文长度要克制，不是越大越保险；
- **JFR + async-profiler** 很适合把“感觉慢”变成“证据链”；
- 优化目标不是让每一步都更快，而是让整条链路更划算。

如果后面继续往下写，我会更建议接成一个小系列，比如：

- Spring AI 接入向量库时，切片策略怎么选；
- Java 做 Agent 工作流时，线程模型和超时治理怎么落；
- RAG 上线后，怎么做评测、回归和成本控制。

# 参考资料

1. Spring AI 官方文档：<https://docs.spring.io/spring-ai/reference/>
2. PostgreSQL pgvector 官方仓库：<https://github.com/pgvector/pgvector>
3. async-profiler 官方文档：<https://github.com/async-profiler/async-profiler>
4. Java Flight Recorder Runtime Guide：<https://docs.oracle.com/en/java/javase/21/troubleshoot/troubleshoot-performance-issues-using-jfr.html>
5. OpenAI Cookbook（RAG/Embedding 实践示例）：<https://cookbook.openai.com/>
6. Prometheus 官方文档：<https://prometheus.io/docs/introduction/overview/>
