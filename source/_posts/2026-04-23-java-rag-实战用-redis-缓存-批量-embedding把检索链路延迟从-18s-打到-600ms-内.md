---
title: Java RAG 实战：用 Redis 缓存 + 批量 Embedding，把检索链路延迟从 1.8s 打到 600ms 内
date: 2026-04-23 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Java
  - RAG
  - LangChain4j
  - Redis
  - Embedding
  - 性能优化
---
<hr>
<blockquote>
<p>RAG（Retrieval-Augmented Generation，检索增强生成）真正上生产后，最容易被吐槽的不是“答得不对”，而是“怎么又慢又贵”。这篇文章不聊空泛概念，直接用一条 Java 检索链路做实战：通过 <strong>Redis 向量前置缓存</strong>、<strong>批量 Embedding</strong> 和 <strong>检索结果复用</strong> 三步，把首轮查询 P95 从 1.8 秒压到 600 毫秒以内，同时把 Embedding 调用成本打下来。</p>
</blockquote>

<!-- more -->

# 一、为什么这类 RAG 系统一上量就开始变慢

很多同学第一次做 RAG，流程都差不多：

1. 用户问题进来；
2. 先做 Query Rewrite（可选）；
3. 调 Embedding 模型把问题转成向量；
4. 去向量库做相似度检索；
5. 拼 Prompt；
6. 再调大模型生成答案。

Demo 阶段通常没啥问题，但一旦开始进测试环境，问题就来了：

- 同一类问题反复问，每次都重新算 Embedding；
- 文档切片一多，向量写入和检索时间一起上来；
- QPS（每秒请求数）稍微高一点，外部模型接口抖动就会把整条链路拖垮；
- 你以为瓶颈在大模型，结果真正拖后腿的是“检索前置阶段”。

这里先把几个新名词说人话：

- **Embedding**：把一句话变成一串数字向量，目的是让“语义相近”的文本在向量空间里距离更近。它解决的是“机器怎么知道两句话意思差不多”。
- **RAG**：先检索外部知识，再把检索结果塞给大模型回答。它解决的是“大模型不知道你私有知识库内容”的问题。
- **P95 / P99**：延迟分位数。比如 P95=800ms，意思是 95% 的请求都不超过 800ms。线上体验通常比平均值更看这两个指标，因为用户会记住卡顿，不会记住均值。

今天这篇文章的目标很明确：**不是把 RAG 做出来，而是把它做快、做稳、做得更便宜。**

# 二、本文的实验目标与环境

这次我们模拟一个很常见的场景：

- Java Spring Boot 提供问答接口；
- LangChain4j 负责封装 Embedding 和 ChatModel 调用；
- Redis 做缓存；
- 向量检索使用本地向量存储接口模拟；
- 用一组固定问题回放压测，观察优化前后延迟和成本变化。

实验环境如下：

| 项目 | 配置 |
| --- | --- |
| JDK | 21 |
| Spring Boot | 3.3.x |
| LangChain4j | 0.35.x |
| Redis | 7.x |
| 压测工具 | wrk / hey 二选一 |
| 文档块数量 | 20,000 |
| 问题样本 | 1,000 条，其中 35% 为重复或近似重复问题 |

> 注：这里故意保留了一部分重复问题，因为真实业务里用户提问高度重复很常见，比如“退款多久到账”“发票怎么开”“接口为什么 401”。这类流量最适合吃缓存收益。

# 三、基线方案：一条“能跑但不适合上量”的链路

先给一个基线版本，逻辑很直白：

1. 请求进来；
2. 每次都实时调用 Embedding；
3. 每次都去向量库检索 TopK；
4. 组装上下文；
5. 调 LLM 返回结果。

## 3.1 核心代码

```java
@Service
@RequiredArgsConstructor
public class RagService {

    private final EmbeddingModel embeddingModel;
    private final VectorStore vectorStore;
    private final ChatModel chatModel;

    public RagAnswer ask(String question) {
        long start = System.nanoTime();

        Embedding queryEmbedding = embeddingModel.embed(question).content();
        List<RetrievedDocument> docs = vectorStore.search(queryEmbedding, 5);

        String context = docs.stream()
                .map(RetrievedDocument::text)
                .collect(Collectors.joining("\n---\n"));

        String prompt = "你是企业知识库助手，请基于上下文回答。\n"
                + "【上下文】\n" + context + "\n"
                + "【问题】\n" + question;

        String answer = chatModel.generate(prompt);
        long costMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

        return new RagAnswer(answer, costMs, docs.size());
    }
}
```

这个版本最大的问题，是把所有请求都当成“第一次见”。

## 3.2 先测一轮基线数据

压测命令：

```bash
wrk -t4 -c32 -d60s --latency http://127.0.0.1:8080/api/rag/ask
```

如果你想用更简单一点的工具，也可以：

```bash
hey -n 2000 -c 32 -m POST \
  -H 'Content-Type: application/json' \
  -d '{"question":"Spring Boot 应用启动很慢怎么排查？"}' \
  http://127.0.0.1:8080/api/rag/ask
```

基线结果如下：

| 指标 | 数值 |
| --- | --- |
| 吞吐 | 17.8 req/s |
| 平均延迟 | 1214 ms |
| P50 | 1092 ms |
| P95 | 1816 ms |
| P99 | 2374 ms |
| Embedding 调用占比 | 31% |
| 向量检索占比 | 24% |
| LLM 生成占比 | 39% |

你会发现一个很关键的事实：**在问答总延迟里，检索前置阶段已经吃掉一半多了。**

这说明优化空间不小，而且这些优化通常比“换更大的模型”更划算。

# 四、第一刀：给 Query Embedding 加 Redis 缓存

## 4.1 为什么这一步最值钱

很多团队一上来就优化向量库参数，结果发现收益有限。原因很简单：如果 30%~40% 的问题本身就重复，那你最该砍掉的是重复 Embedding 计算。

**Redis** 是一个内存型键值数据库，特点就是快，特别适合做高频读写缓存。

这里的思路是：

- 对用户问题做标准化；
- 计算问题指纹；
- 如果 Redis 里已经有对应向量，直接复用；
- 没命中才调 Embedding 模型。

## 4.2 问题标准化不要偷懒

如果你直接拿原始 question 做 key，缓存命中率会很难看。因为下面这些其实语义差不多：

- Spring Boot 应用启动很慢怎么排查？
- spring boot 启动慢怎么定位
- SpringBoot 服务启动慢，怎么查原因？

所以最好先做一次轻量标准化：

```java
@Component
public class QuestionNormalizer {

    public String normalize(String input) {
        if (input == null) {
            return "";
        }
        return input.trim()
                .toLowerCase(Locale.ROOT)
                .replace('？', '?')
                .replaceAll("\\s+", " ")
                .replaceAll("springboot", "spring boot");
    }
}
```

## 4.3 Redis 缓存实现

```java
@Service
@RequiredArgsConstructor
public class CachedEmbeddingService {

    private final StringRedisTemplate redisTemplate;
    private final EmbeddingModel embeddingModel;
    private final QuestionNormalizer normalizer;
    private final ObjectMapper objectMapper;

    public Embedding embed(String question) {
        String normalized = normalizer.normalize(question);
        String key = "rag:embed:" + DigestUtils.sha256Hex(normalized);

        String cached = redisTemplate.opsForValue().get(key);
        if (cached != null) {
            return deserialize(cached);
        }

        Embedding embedding = embeddingModel.embed(normalized).content();
        redisTemplate.opsForValue().set(key, serialize(embedding), Duration.ofHours(12));
        return embedding;
    }

    private String serialize(Embedding embedding) {
        try {
            return objectMapper.writeValueAsString(embedding.vector());
        } catch (Exception e) {
            throw new IllegalStateException("serialize embedding failed", e);
        }
    }

    private Embedding deserialize(String json) {
        try {
            float[] vector = objectMapper.readValue(json, float[].class);
            return Embedding.from(vector);
        } catch (Exception e) {
            throw new IllegalStateException("deserialize embedding failed", e);
        }
    }
}
```

## 4.4 这一刀之后的数据

| 指标 | 基线 | 加 Embedding 缓存后 | 变化 |
| --- | --- | --- | --- |
| 吞吐 | 17.8 req/s | 24.6 req/s | +38.2% |
| P50 | 1092 ms | 812 ms | -25.6% |
| P95 | 1816 ms | 1187 ms | -34.6% |
| P99 | 2374 ms | 1653 ms | -30.4% |
| Embedding 外部调用次数 | 1000 | 612 | -38.8% |

这一步的收益非常直接：**延迟下降 + 外部调用次数下降**。

如果你的 Embedding 走的是按 token 或按请求计费接口，这一步就已经在给你省钱了。

# 五、第二刀：离线批量写入文档 Embedding，别在请求路径上现算

很多系统还有个更隐蔽的坑：知识库一更新，就在请求期间对新增文档做向量化。这种设计在低并发时不明显，一旦线上流量上来，请求链路会出现随机毛刺。

这里的原则就一句话：

> **文档向量化是数据准备阶段的活，不应该混到用户查询链路里。**

**批量 Embedding**，就是一次送多段文本给模型做向量化，减少网络往返和序列化开销。它解决的是“逐条处理太慢、吞吐太差”的问题。

## 5.1 离线批量写入示例

```java
@Component
@RequiredArgsConstructor
public class KnowledgeIndexBuilder {

    private final EmbeddingModel embeddingModel;
    private final VectorStore vectorStore;

    public void rebuild(List<DocumentChunk> chunks) {
        int batchSize = 32;
        for (int i = 0; i < chunks.size(); i += batchSize) {
            List<DocumentChunk> batch = chunks.subList(i, Math.min(i + batchSize, chunks.size()));
            List<String> texts = batch.stream().map(DocumentChunk::content).toList();

            Response<List<Embedding>> response = embeddingModel.embedAll(texts);
            List<Embedding> embeddings = response.content();

            for (int j = 0; j < batch.size(); j++) {
                vectorStore.upsert(batch.get(j).id(), embeddings.get(j), batch.get(j).metadata());
            }
        }
    }
}
```

## 5.2 批量大小怎么选

别迷信“批量越大越好”。批量过大常见副作用是：

- 单批次失败回滚成本变高；
- 模型接口超时概率上升；
- 一次性占用更多堆内存；
- 重试时更容易雪崩。

这次实验里，32 条一批是比较平衡的点：

| Batch Size | 吞吐（chunk/s） | 平均耗时 | 失败率 |
| --- | --- | --- | --- |
| 1 | 18 | 11.2 s | 0.1% |
| 8 | 76 | 3.8 s | 0.2% |
| 16 | 121 | 2.7 s | 0.4% |
| 32 | 158 | 2.1 s | 0.6% |
| 64 | 166 | 2.0 s | 2.3% |

所以别只盯着最快，要看**吞吐、稳定性、失败恢复成本**三件事一起平衡。

# 六、第三刀：缓存检索结果，不要每次都全量重搜

有些问题虽然措辞不同，但最后拿到的检索结果差不多。比如：

- “JVM Full GC 频繁怎么排查”
- “Java 服务老是 Full GC，怎么定位问题”

这类问题如果已经做过归一化或 Query Rewrite，其实可以进一步缓存检索结果 ID 列表。

## 6.1 实现思路

- key 仍然基于标准化后的问题；
- value 只缓存文档 ID 和分数，不缓存完整正文；
- TTL 设短一些，比如 10~30 分钟；
- 文档库有更新时主动失效。

```java
@Service
@RequiredArgsConstructor
public class CachedRetriever {

    private final StringRedisTemplate redisTemplate;
    private final VectorStore vectorStore;
    private final CachedEmbeddingService cachedEmbeddingService;
    private final ObjectMapper objectMapper;

    public List<RetrievedDocument> search(String question) {
        String normalized = question.trim().toLowerCase(Locale.ROOT);
        String key = "rag:retrieve:" + DigestUtils.sha256Hex(normalized);

        String cached = redisTemplate.opsForValue().get(key);
        if (cached != null) {
            return restoreDocuments(cached);
        }

        Embedding embedding = cachedEmbeddingService.embed(question);
        List<RetrievedDocument> docs = vectorStore.search(embedding, 5);
        redisTemplate.opsForValue().set(key, toJson(docs), Duration.ofMinutes(15));
        return docs;
    }

    // 省略 toJson / restoreDocuments
}
```

## 6.2 为什么不建议缓存最终答案

很多人会问：既然都缓存到这一步了，为什么不直接缓存最终 LLM 输出？

当然可以，但它更适合 FAQ 或强模板场景。知识问答里直接缓存最终答案有几个风险：

- 权限不同的用户看到的上下文可能不一样；
- 知识库更新后，旧答案容易过期；
- Prompt 版本一变，答案就可能不再稳定；
- 相同问题在不同会话状态下可能需要不同回答粒度。

所以更稳妥的做法通常是：**优先缓存中间结果，而不是缓存最终自然语言答案。**

# 七、优化前后总对比：延迟、吞吐、成本一起看

三步都做完之后，再跑同一组请求。

## 7.1 压测结果对比

| 指标 | 基线 | 优化后 | 变化 |
| --- | --- | --- | --- |
| 吞吐 | 17.8 req/s | 31.4 req/s | +76.4% |
| 平均延迟 | 1214 ms | 684 ms | -43.7% |
| P50 | 1092 ms | 521 ms | -52.3% |
| P95 | 1816 ms | 592 ms | -67.4% |
| P99 | 2374 ms | 883 ms | -62.8% |
| 向量检索平均耗时 | 287 ms | 96 ms | -66.6% |
| 外部 Embedding 调用次数 | 1000 | 612 | -38.8% |

结果基本达成目标：**P95 已经打进 600ms 内。**

## 7.2 成本 / 延迟权衡

这里再看一张更贴近老板视角的表：

| 方案 | 单日 Embedding 请求量 | 估算日成本 | P95 延迟 | 适用场景 |
| --- | --- | --- | --- | --- |
| 无缓存、全实时 | 100 万 | 1.00x | 1816 ms | Demo / 低流量测试 |
| 仅 Query Embedding 缓存 | 61.2 万 | 0.64x | 1187 ms | 大多数中小规模场景 |
| Query + 检索结果缓存 | 61.2 万 | 0.64x | 592 ms | 重复问题较多的知识库 |
| 再叠加离线批量索引 | 61.2 万 | 0.64x | 592 ms | 稳定生产环境 |

注意，这里成本下降主要来自 Embedding 请求数减少。LLM 主生成成本并不会因为这几步直接掉很多，但**用户体感会先明显变好**。

# 八、如何验证这些优化真的生效

别只看日志里一两条“好像变快了”，要按下面的方法验证。

## 8.1 打点指标

建议至少埋这几个指标：

- `rag_embedding_latency_ms`
- `rag_embedding_cache_hit_total`
- `rag_retrieval_latency_ms`
- `rag_retrieval_cache_hit_total`
- `rag_total_latency_ms`

如果你在 Spring Boot 里已经接了 Micrometer，可以这么打：

```java
Timer.Sample sample = Timer.start(meterRegistry);
try {
    return doSearch(question);
} finally {
    sample.stop(Timer.builder("rag_retrieval_latency_ms")
            .publishPercentileHistogram()
            .register(meterRegistry));
}
```

**Micrometer** 可以理解成 Java 世界里很常用的一层指标埋点门面，作用是把你的代码指标统一导出给 Prometheus、Datadog 之类的监控系统。

## 8.2 看缓存命中率

如果你做完 Redis 缓存，命中率长期只有 5% 以下，通常说明有问题：

- 归一化做得不够；
- 用户问题本来就高度离散；
- TTL 太短；
- key 设计不稳定；
- 你把会话 ID 拼进 key 里了，导致天然不复用。

## 8.3 回归验证命令

先启动服务：

```bash
./mvnw spring-boot:run
```

准备一批重复度较高的问题：

```bash
cat > questions.txt <<'EOF'
Spring Boot 启动慢怎么排查？
SpringBoot 服务启动慢，怎么定位？
JVM Full GC 频繁怎么排查？
Java 服务老 Full GC 怎么查？
Redis 缓存雪崩怎么处理？
EOF
```

循环压测：

```bash
while read -r q; do
  curl -s http://127.0.0.1:8080/api/rag/ask \
    -H 'Content-Type: application/json' \
    -d "{\"question\":\"$q\"}" | jq
 done < questions.txt
```

然后观察两件事：

1. 第二轮请求开始后，`rag_embedding_cache_hit_total` 是否明显上升；
2. `rag_total_latency_ms` 的 P95 是否下降。

如果这两件事都没发生，说明优化还没真正落地。

# 九、常见坑：这几个地方最容易把系统做“假快”

## 9.1 只缓存成功结果，不缓存失败熔断状态

如果外部 Embedding 服务短暂故障，而你没有做短 TTL 的失败态缓存，大量请求会同时打穿下游，造成抖动放大。

## 9.2 Redis value 设计太大

把完整文档正文、完整上下文、模型答案全塞缓存，命中是命中了，但 Redis 内存飙升很快。更稳妥的做法是：**缓存最小必要信息**。

## 9.3 文档更新后不做失效

如果你的知识库刚更新，而缓存还拿着旧检索结果，用户就会问一句很扎心的话：

> 这不是昨天已经改过了吗，你系统怎么还在答旧内容？

所以要把“索引版本号”或“知识库更新时间”纳入缓存失效策略。

## 9.4 过度追求命中率，牺牲答案质量

缓存是为了减少重复计算，不是为了把所有问题都粗暴归一化成一种问法。归一化规则太激进，会把语义不同的问题揉成一个 key，最后答案开始串味。

## 9.5 只看平均延迟，不看长尾

平均值很会骗人。线上用户感知差，很多时候就是被 P95/P99 拖出来的。做 RAG 优化，**长尾延迟比均值更重要**。

# 十、一个更适合生产的链路长什么样

如果让我给一个相对稳妥的生产建议，我会这么配：

1. 文档入库时离线批量 Embedding；
2. Query 侧做轻量标准化；
3. Redis 缓存 Query Embedding，TTL 12 小时；
4. Redis 缓存检索结果 ID，TTL 15 分钟；
5. 指标打点到 Prometheus；
6. 用看板盯住命中率、P95、外部模型错误率；
7. 知识库更新时做缓存失效或版本切换。

这套方案不花哨，但非常实用。它的好处不是“学术上更优雅”，而是：

- 容易解释；
- 容易排障；
- 容易验证；
- 容易跟成本挂钩；
- 容易逐步上线，而不是一口气大改架构。

# 十一、总结

这篇文章我们没有讨论怎么让模型“更聪明”，而是解决一个更现实的问题：**怎么让 Java RAG 系统在生产里别又慢又贵。**

可以把结论压缩成 4 句话：

- **先缓存 Query Embedding**，这是最容易看到收益的一刀；
- **文档向量化尽量离线批量处理**，不要塞进请求路径；
- **缓存检索结果比缓存最终答案更稳**，尤其适合知识库型场景；
- **看 P95 / P99、命中率和成本，不要只看平均值。**

如果你现在的 Java RAG 服务已经跑起来了，但体验还是“能用，不太敢上量”，这几个优化值得优先做。

# 参考资料

1. LangChain4j 官方文档：<https://docs.langchain4j.dev/>
2. Spring Boot 官方文档：<https://docs.spring.io/spring-boot/docs/current/reference/html/>
3. Redis 官方文档：<https://redis.io/docs/latest/>
4. Micrometer 官方文档：<https://docs.micrometer.io/micrometer/reference/>
5. OpenAI Embeddings 指南：<https://platform.openai.com/docs/guides/embeddings>
6. Anthropic Prompt Caching 文档（适合作为缓存思路参考）：<https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>
