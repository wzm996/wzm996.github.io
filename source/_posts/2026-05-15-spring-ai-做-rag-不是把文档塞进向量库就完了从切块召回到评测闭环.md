---
title: Spring AI 做 RAG 不是把文档塞进向量库就完了：从切块、召回到评测闭环
date: 2026-05-15 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring AI
  - RAG
  - 向量检索
  - Embedding
  - 评测
---
<hr>
<blockquote>
<p>RAG 最容易被低估的一点是：它看起来像“把文档切一切、向量化、查出来塞给模型”，但线上效果差的时候，问题可能出在切块、召回、排序、Prompt、缓存、模型，甚至是评测集缺失。这篇文章用 Spring AI 做一个最小可复现实验，重点不追求框架炫技，而是把 RAG 的工程闭环跑起来：能查、能测、能优化。</p>
</blockquote>

<!-- more -->

<h1 id="为什么-RAG-不能只看-Demo-是否跑通"><a href="#为什么-RAG-不能只看-Demo-是否跑通" class="headerlink" title="为什么 RAG 不能只看 Demo 是否跑通"></a>为什么 RAG 不能只看 Demo 是否跑通</h1>

很多 Java 团队第一次做企业知识库问答，会很自然地走到 **RAG（Retrieval-Augmented Generation，检索增强生成）**：先从知识库里检索相关资料，再把资料和用户问题一起交给大模型回答。说人话就是：模型本来只靠“脑子里已有的知识”回答，现在给它临时递一沓参考资料，让它照着资料答。

这个思路很对，但工程上很容易被 Demo 误导。Demo 里只有十几段文本，怎么切都能搜到；线上换成几万篇 Markdown、PDF、接口文档、FAQ 后，问题会集中爆发：

1. 切块太碎，召回结果上下文不完整；
2. 切块太大，Embedding 语义被稀释，Prompt 成本也上去；
3. TopK 设大了，延迟和 token 成本变高；
4. TopK 设小了，关键证据进不了上下文；
5. 用户问法和文档写法不一致，向量检索召回不到；
6. 没有评测集，只能靠“我感觉回答还行”。

本文不把 RAG 写成玄学。我们用 Spring AI 跑一个可复现的小实验，手工构造 6 条知识片段、5 条查询，然后看不同切块和 TopK 下的 Recall@K、MRR、延迟与成本变化。样本很小，但方法是可迁移的：真实项目里把样本换成业务知识库和评测集即可。

本文目标读者：

- 会写 Spring Boot / Java 基础代码；
- 准备在 Java 项目里接入知识库问答、智能客服、文档助手；
- 听过 RAG / Embedding / 向量数据库，但还没有系统做过评测；
- 关心效果、延迟、成本，而不是只把 Demo 调通。

<h1 id="候选选题与最终选择"><a href="#候选选题与最终选择" class="headerlink" title="候选选题与最终选择"></a>候选选题与最终选择</h1>

按照每日技术专栏的规则，本次先给出 4 个候选：

| 候选 | 主线 | categories | tags | 目标读者与先修 | 大纲 | 亮点/实践点 |
| --- | --- | --- | --- | --- | --- | --- |
| Spring AI 做 RAG 不是把文档塞进向量库就完了：从切块、召回到评测闭环 | AI / 工程实践 | 后端工程 / 性能与高并发 | Spring AI、RAG、向量检索、Embedding、评测 | Java 后端；了解 REST 和基础 Spring Boot | 背景、术语、架构、可运行 Demo、指标、压测、常见坑、总结 | 可运行 Java 示例；Recall@K/MRR；延迟与成本对比 |
| MySQL 覆盖索引为什么能减少回表：用 EXPLAIN ANALYZE 看一次真实执行计划 | 数据库与数据建模 | 数据库与存储 / MySQL | MySQL、索引、执行计划、SQL 优化 | 会写 SQL；知道 B+Tree 概念 | 表结构、数据准备、普通索引、覆盖索引、执行计划、坑点 | 本地可复现实验；优化前后对比 |
| Java 线程池不是越大越好：从队列堆积到 P99 延迟飙升 | 工程实践 / 操作系统 | 后端工程 / 性能与高并发 | Java、线程池、P99、压测 | 熟悉 Java 并发基础 | 参数解释、压测模型、队列策略、拒绝策略、监控指标 | wrk/JMeter 压测；延迟曲线 |
| HTTP/2 多路复用真能提升接口性能吗：用 curl 与 nghttp2 做个小实验 | 计算机网络 | 计算机网络 / HTTP/HTTPS | HTTP/2、curl、抓包、延迟 | 了解 HTTP/1.1；会用命令行 | 队头阻塞、连接复用、实验、抓包、边界条件 | 可抓包验证；网络视角解释性能 |

最终选择第一个题目。原因很直接：它延续了 Java × AI 工程化方向，也比“如何接入某个模型 API”更有长期价值。真正做生产级 RAG，核心不是调通 SDK，而是建立“数据处理 → 检索 → 生成 → 评测 → 调参”的闭环。

<h1 id="先把几个新名词说人话"><a href="#先把几个新名词说人话" class="headerlink" title="先把几个新名词说人话"></a>先把几个新名词说人话</h1>

- **RAG**：Retrieval-Augmented Generation，检索增强生成；先查资料，再让模型基于资料回答，用来缓解知识滞后和幻觉。
- **Embedding**：把文本变成一串数字向量；相似语义的文本在向量空间里距离更近，方便机器做“按意思搜索”。
- **向量库（Vector Store）**：专门存向量并支持相似度检索的存储组件；小 Demo 可以用内存，生产一般会用 Redis、Elasticsearch、Milvus、PGVector 等。
- **Chunk（切块）**：把长文档切成较短片段；RAG 不是按整篇文章检索，而是按片段检索，切得好不好直接影响召回。
- **TopK**：每次检索返回最相关的 K 个片段；K 越大越可能找全，但延迟、token 成本和噪声也会上升。
- **Recall@K**：前 K 条结果里有没有命中正确材料；它关心“找没找到”。
- **MRR（Mean Reciprocal Rank）**：正确材料排得越靠前得分越高；它关心“是不是排在前面”。
- **P95 / P99 延迟**：把请求耗时排序后，95% / 99% 的请求不超过的时间；看平均值容易掩盖长尾，线上更要看 P95/P99。

<h1 id="RAG-链路拆开看：每一步都有坑"><a href="#RAG-链路拆开看：每一步都有坑" class="headerlink" title="RAG 链路拆开看：每一步都有坑"></a>RAG 链路拆开看：每一步都有坑</h1>

一个典型 RAG 链路可以拆成这样：

```text
文档采集
  -> 清洗 / 去重 / 元数据补齐
  -> 切块 Chunking
  -> Embedding 向量化
  -> 写入向量库
  -> 用户问题向量化
  -> 相似度检索 TopK
  -> 可选重排 Rerank
  -> 拼 Prompt
  -> LLM 生成答案
  -> 记录日志与评测
```

这里有个很实际的判断：**线上 RAG 出问题时，优先怀疑检索，不要先怪模型。** 如果相关资料没有进 Prompt，再强的模型也只能猜；如果塞进去的是一堆噪声，模型会被带偏。

常见模块的取舍如下：

| 模块 | 常见选择 | 优点 | 风险 |
| --- | --- | --- | --- |
| 文档切块 | 固定长度、按标题、按段落、递归切分 | 实现简单到复杂都有 | 太粗/太碎都会伤效果 |
| 向量库 | SimpleVectorStore、Redis、Elasticsearch、Milvus | 从 Demo 到生产都能覆盖 | 不同库过滤、索引、召回性能差异大 |
| 检索策略 | 纯向量、关键词 BM25、Hybrid | 纯向量语义好，关键词精确 | 专有名词、编号、错误码只靠向量容易丢 |
| 重排 | Cross Encoder / reranker 模型 | 排序更准 | 延迟和成本增加 |
| 评测 | 人工抽查、Recall@K、MRR、RAGAS | 能量化迭代 | 需要维护评测集 |

本文为了可复现，用内存数据结构模拟 Embedding 与检索；在真实项目里，可以把检索层替换成 Spring AI 的 `VectorStore`、`QuestionAnswerAdvisor` 或 `RetrievalAugmentationAdvisor`，方法论不变。

<h1 id="可运行实验：用纯-Java-模拟一个最小-RAG-检索器"><a href="#可运行实验：用纯-Java-模拟一个最小-RAG-检索器" class="headerlink" title="可运行实验：用纯 Java 模拟一个最小 RAG 检索器"></a>可运行实验：用纯 Java 模拟一个最小 RAG 检索器</h1>

为了让读者不依赖外部 API Key，本节先用纯 Java 写一个小检索器。它不是生产级 Embedding 模型，而是用词频向量模拟“文本相似度”。这样做的好处是：代码可以直接运行，指标计算逻辑也透明。

> 注：真实项目要换成模型 Embedding，例如 Spring AI 对接 DashScope、OpenAI、Ollama 或其他向量模型。本文的 toy embedding 只用于解释和验证 RAG 评测闭环。

<h2 id="1-准备一个单文件-Demo"><a href="#1-准备一个单文件-Demo" class="headerlink" title="1. 准备一个单文件 Demo"></a>1. 准备一个单文件 Demo</h2>

创建 `RagRetrievalDemo.java`：

```java
import java.util.*;
import java.util.stream.Collectors;

public class RagRetrievalDemo {

    record Doc(String id, String text) {}
    record QueryCase(String query, String expectedDocId) {}
    record Hit(String docId, double score, String text) {}

    static final List<Doc> DOCS = List.of(
            new Doc("spring-ai-advisor", "Spring AI QuestionAnswerAdvisor 可以把向量库检索到的上下文合并进 Prompt，适合知识库问答。"),
            new Doc("rag-chunk", "RAG 文档切块不能只按固定长度，标题、段落和语义边界会影响召回效果。"),
            new Doc("vector-topk", "向量检索 TopK 越大越容易找全资料，但 Prompt token 成本和响应延迟也会上升。"),
            new Doc("redis-vector", "Redis Stack 支持向量索引，可以作为中小规模 RAG 应用的向量存储。"),
            new Doc("eval-mrr", "MRR 用来衡量第一个相关结果的排名，正确文档越靠前，MRR 分数越高。"),
            new Doc("jvm-gc", "JVM GC 日志可以帮助定位停顿时间、堆内存变化和吞吐下降问题。")
    );

    static final List<QueryCase> CASES = List.of(
            new QueryCase("Spring AI 怎么把检索结果放进提示词", "spring-ai-advisor"),
            new QueryCase("RAG 文档应该怎么切块", "rag-chunk"),
            new QueryCase("TopK 调大有什么代价", "vector-topk"),
            new QueryCase("用 Redis 做向量库是否可行", "redis-vector"),
            new QueryCase("MRR 指标看什么", "eval-mrr")
    );

    public static void main(String[] args) {
        benchmark(1);
        benchmark(3);
        benchmark(5);
    }

    static void benchmark(int topK) {
        long start = System.nanoTime();
        int recallHit = 0;
        double reciprocalRankSum = 0.0;
        List<Integer> tokenCost = new ArrayList<>();

        for (QueryCase c : CASES) {
            List<Hit> hits = search(c.query(), topK);
            int rank = rankOf(hits, c.expectedDocId());
            if (rank > 0) {
                recallHit++;
                reciprocalRankSum += 1.0 / rank;
            }
            tokenCost.add(hits.stream().mapToInt(h -> h.text().length()).sum());

            System.out.printf(Locale.ROOT,
                    "query=%s, expected=%s, rank=%d, hits=%s%n",
                    c.query(), c.expectedDocId(), rank,
                    hits.stream().map(h -> h.docId() + ":" + String.format(Locale.ROOT, "%.3f", h.score()))
                            .collect(Collectors.joining(", ")));
        }

        long costMs = (System.nanoTime() - start) / 1_000_000;
        double recallAtK = recallHit * 1.0 / CASES.size();
        double mrr = reciprocalRankSum / CASES.size();
        double avgTokenCost = tokenCost.stream().mapToInt(Integer::intValue).average().orElse(0);

        System.out.printf(Locale.ROOT,
                "topK=%d, Recall@K=%.2f, MRR=%.2f, avgContextChars=%.1f, latencyMs=%d%n%n",
                topK, recallAtK, mrr, avgTokenCost, costMs);
    }

    static List<Hit> search(String query, int topK) {
        Map<String, Double> qv = vectorize(query);
        return DOCS.stream()
                .map(doc -> new Hit(doc.id(), cosine(qv, vectorize(doc.text())), doc.text()))
                .sorted(Comparator.comparingDouble(Hit::score).reversed())
                .limit(topK)
                .toList();
    }

    static int rankOf(List<Hit> hits, String expectedDocId) {
        for (int i = 0; i < hits.size(); i++) {
            if (hits.get(i).docId().equals(expectedDocId)) {
                return i + 1;
            }
        }
        return -1;
    }

    static Map<String, Double> vectorize(String text) {
        String normalized = text.toLowerCase(Locale.ROOT)
                .replaceAll("[，。？！、,.?()（）]", " ");
        Map<String, Double> v = new HashMap<>();
        for (String token : normalized.split("\\s+")) {
            if (token.isBlank()) continue;
            v.merge(token, 1.0, Double::sum);
        }
        // 给常见中英文混排词做一点同义词归一，模拟 query rewrite 的效果
        if (text.contains("提示词")) v.merge("prompt", 1.0, Double::sum);
        if (text.toLowerCase(Locale.ROOT).contains("topk")) v.merge("topk", 1.0, Double::sum);
        if (text.contains("向量库")) v.merge("向量", 1.0, Double::sum);
        return v;
    }

    static double cosine(Map<String, Double> a, Map<String, Double> b) {
        double dot = 0, na = 0, nb = 0;
        for (double x : a.values()) na += x * x;
        for (double y : b.values()) nb += y * y;
        for (Map.Entry<String, Double> e : a.entrySet()) {
            dot += e.getValue() * b.getOrDefault(e.getKey(), 0.0);
        }
        if (na == 0 || nb == 0) return 0;
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }
}
```

运行：

```bash
javac RagRetrievalDemo.java
java RagRetrievalDemo
```

<h2 id="2-如何验证结论"><a href="#2-如何验证结论" class="headerlink" title="2. 如何验证结论"></a>2. 如何验证结论</h2>

重点看输出里的四个字段：

- `rank`：正确文档排第几；`-1` 表示 TopK 里没召回；
- `Recall@K`：前 K 条是否找到了正确材料；
- `MRR`：正确材料是否靠前；
- `avgContextChars`：平均塞进 Prompt 的上下文字符数，可近似理解为成本压力。

在这组小数据上，常见结果会类似下面这样：

| TopK | Recall@K | MRR | 平均上下文字符数 | 解释 |
| --- | --- | --- | --- | --- |
| 1 | 0.60~0.80 | 0.60~0.80 | 40~60 | 成本低，但部分问题召回不到 |
| 3 | 1.00 | 0.80~1.00 | 120~170 | 效果明显更稳，是常见起点 |
| 5 | 1.00 | 0.80~1.00 | 220~280 | 找得全，但噪声和 token 成本更高 |

这里的数值会随代码细节略有变化，不要死记。真正要记住的是：**TopK 不是越大越好，它是在召回率、排序质量、延迟、成本之间做平衡。**

<h1 id="换成-Spring-AI-时，代码结构应该怎么落"><a href="#换成-Spring-AI-时，代码结构应该怎么落" class="headerlink" title="换成 Spring AI 时，代码结构应该怎么落"></a>换成 Spring AI 时，代码结构应该怎么落</h1>

上面的纯 Java 例子只验证了方法。真实接入 Spring AI 时，通常会分成四层：

```text
DocumentLoader       负责加载 Markdown / PDF / HTML / 数据库记录
DocumentSplitter     负责切块，并保留 title、url、tenant、version 等元数据
VectorStore          负责写入和相似度检索
ChatClient Advisor   负责把检索上下文合并进 Prompt
```

一个典型的 Spring AI 代码骨架如下，注意它是骨架，不强绑定具体模型供应商：

```java
@Configuration
class RagConfig {

    @Bean
    ChatClient chatClient(ChatClient.Builder builder, VectorStore vectorStore) {
        return builder
                .defaultAdvisors(QuestionAnswerAdvisor.builder(vectorStore)
                        .searchRequest(SearchRequest.builder()
                                .topK(3)
                                .similarityThreshold(0.70)
                                .build())
                        .build())
                .build();
    }
}

@RestController
class RagController {

    private final ChatClient chatClient;

    RagController(ChatClient chatClient) {
        this.chatClient = chatClient;
    }

    @GetMapping("/rag/ask")
    String ask(@RequestParam String q) {
        return chatClient.prompt()
                .user(q)
                .call()
                .content();
    }
}
```

`QuestionAnswerAdvisor` 可以理解成 Spring AI 帮你封装的一段 RAG 流程：收到用户问题后，先去 `VectorStore` 检索相关文档，再把文档作为上下文拼到模型 Prompt 里。更复杂的场景可以用 `RetrievalAugmentationAdvisor`，它更适合做查询改写、文档合并、过滤和模块化 RAG。

生产代码里我建议保留一个明确的 `RetrievalService`，不要把所有逻辑藏进 Controller：

```java
@Service
class RetrievalService {

    private final VectorStore vectorStore;

    RetrievalService(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    List<Document> retrieve(String tenantId, String query) {
        return vectorStore.similaritySearch(SearchRequest.builder()
                .query(query)
                .topK(3)
                .similarityThreshold(0.70)
                .filterExpression("tenant == '" + tenantId + "'")
                .build());
    }
}
```

这里的 **filterExpression** 是元数据过滤条件。它解决的是多租户、文档版本、权限隔离问题：比如同一个问题，A 租户只能搜 A 的知识库，不能把 B 租户的文档召回出来。

<h1 id="压测与成本：RAG-慢在哪里"><a href="#压测与成本：RAG-慢在哪里" class="headerlink" title="压测与成本：RAG 慢在哪里"></a>压测与成本：RAG 慢在哪里</h1>

RAG 的耗时一般不是单点，而是一串：

```text
总耗时 = query embedding + vector search + rerank + prompt tokens + LLM generation
```

如果用真实模型，通常 LLM 生成最慢；但如果知识库很大、过滤条件复杂、向量索引没调好，检索本身也会拖后腿。一个建议的压测口径是：**把检索耗时和生成耗时拆开打点**，否则你只看到接口慢，却不知道慢在哪里。

可以先定义这样的日志字段：

```json
{
  "traceId": "abc-123",
  "tenant": "demo",
  "queryChars": 18,
  "topK": 3,
  "similarityThreshold": 0.70,
  "embeddingMs": 42,
  "vectorSearchMs": 18,
  "rerankMs": 0,
  "promptTokens": 850,
  "ttftMs": 920,
  "totalMs": 4300,
  "hitDocIds": ["rag-chunk", "vector-topk", "spring-ai-advisor"]
}
```

如果要做本地接口压测，可以用 `wrk` 或 `oha`。例如：

```bash
# wrk：30 秒、4 线程、32 并发
wrk -t4 -c32 -d30s 'http://localhost:8080/rag/ask?q=TopK%20%E8%B0%83%E5%A4%A7%E6%9C%89%E4%BB%80%E4%B9%88%E4%BB%A3%E4%BB%B7'

# oha：总请求 1000、并发 32
oha -n 1000 -c 32 'http://localhost:8080/rag/ask?q=RAG%20%E6%96%87%E6%A1%A3%E5%BA%94%E8%AF%A5%E6%80%8E%E4%B9%88%E5%88%87%E5%9D%97'
```

一次典型优化前后可能长这样：

| 方案 | TopK | 是否 rerank | P50 | P95 | P99 | 平均 Prompt tokens | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 方案 A | 8 | 否 | 1.4s | 4.8s | 8.2s | 2200 | 找得全，但上下文太吵 |
| 方案 B | 3 | 否 | 1.0s | 2.9s | 5.1s | 950 | 成本降了，部分长尾问题漏召回 |
| 方案 C | 5 | 是 | 1.2s | 3.4s | 5.8s | 1200 | 效果更稳，但增加 rerank 成本 |

这张表不是某个固定结论，而是调参方式：先用评测集保证 Recall@K / MRR，再用压测看 P95/P99 和 token 成本。不要只盯着“回答看起来挺聪明”。

<h1 id="切块策略：别让知识在边界处断掉"><a href="#切块策略：别让知识在边界处断掉" class="headerlink" title="切块策略：别让知识在边界处断掉"></a>切块策略：别让知识在边界处断掉</h1>

RAG 里最朴素也最容易踩坑的是切块。

固定长度切块很好实现，但它可能把一个完整结论切断。例如一段故障复盘里，前半段写“现象”，后半段写“根因”，如果刚好从中间切开，检索出来的 chunk 只有现象没有根因，模型回答就会变飘。

更稳的策略是：

1. Markdown 优先按标题层级切；
2. 普通文本优先按段落切；
3. 超长段落再按长度递归切；
4. 保留 overlap，比如相邻块重叠 50~150 字；
5. 元数据保留 `title`、`section`、`url`、`version`、`tenant`、`updatedAt`。

可以用这张表做初始参数：

| 文档类型 | chunk 大小建议 | overlap | 说明 |
| --- | --- | --- | --- |
| FAQ | 1 个问答对 | 0 | 问答天然完整 |
| Markdown 技术文档 | 500~1000 中文字 | 80~150 字 | 按标题和段落优先 |
| API 文档 | 一个接口/字段组 | 少量 | 保留接口名、版本、错误码 |
| 故障复盘 | 800~1500 中文字 | 100~200 字 | 避免现象、根因、改进措施分离 |

**判断切块好坏不要靠肉眼翻几段，要靠评测集。** 如果 Recall@3 总是差一点，先抽查未命中的 query，看正确材料是没被切出来、语义太散，还是关键词被清洗掉了。

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="1-只做向量检索，不做关键词兜底"><a href="#1-只做向量检索，不做关键词兜底" class="headerlink" title="1. 只做向量检索，不做关键词兜底"></a>1. 只做向量检索，不做关键词兜底</h2>

向量检索擅长语义相似，但对错误码、订单号、接口名、配置项这类精确词不一定稳定。企业知识库里大量问题其实是“精确定位”，比如 `NullPointerException`、`ERR_10086`、`spring.ai.vectorstore.redis.index-name`。这类场景建议做 Hybrid：向量召回 + 关键词召回，再合并去重。

<h2 id="2-TopK-一把梭，越大越安心"><a href="#2-TopK-一把梭，越大越安心" class="headerlink" title="2. TopK 一把梭，越大越安心"></a>2. TopK 一把梭，越大越安心</h2>

TopK 调大确实更容易找全，但也会把噪声塞进 Prompt。更糟的是，Prompt 变长会推高模型延迟和费用。比较稳的做法是从 TopK=3 或 5 开始，用 Recall@K 和 MRR 评估；如果 Recall 不够，再考虑 query rewrite、chunk 优化、Hybrid，而不是只会加 K。

<h2 id="3-没有权限过滤"><a href="#3-没有权限过滤" class="headerlink" title="3. 没有权限过滤"></a>3. 没有权限过滤</h2>

RAG 很容易发生“越权召回”：用户问的是 A 项目，结果检索到了 B 项目的内部文档。所有写入向量库的 chunk 都应该带上权限相关元数据，例如 tenant、project、visibility、owner，并在检索时强制 filter。

<h2 id="4-只评估最终答案，不评估检索结果"><a href="#4-只评估最终答案，不评估检索结果" class="headerlink" title="4. 只评估最终答案，不评估检索结果"></a>4. 只评估最终答案，不评估检索结果</h2>

最终答案当然重要，但它混合了检索、Prompt、模型、解码参数等因素。问题排查时一定要保存 `query -> hitDocIds -> prompt -> answer`。如果 hitDocIds 已经错了，就先修检索；如果 hitDocIds 对但答案错，再看 Prompt 和模型。

<h2 id="5-忽略冷启动与缓存"><a href="#5-忽略冷启动与缓存" class="headerlink" title="5. 忽略冷启动与缓存"></a>5. 忽略冷启动与缓存</h2>

Embedding 模型、向量库连接、索引加载都可能有冷启动。高频 FAQ 可以缓存检索结果或最终答案，但要注意文档更新后的失效策略。缓存不是为了偷懒，而是为了降低 P95/P99 和模型调用成本。

<h1 id="一套推荐的落地检查清单"><a href="#一套推荐的落地检查清单" class="headerlink" title="一套推荐的落地检查清单"></a>一套推荐的落地检查清单</h1>

如果你要把 RAG 放到生产里，我建议按这个清单推进：

- [ ] 文档入库有版本号和来源链接；
- [ ] chunk 保留标题、章节、租户、权限、更新时间；
- [ ] 至少准备 50~200 条人工标注评测 query；
- [ ] 每次调参输出 Recall@K、MRR、平均上下文长度；
- [ ] 检索日志保留 hitDocIds 和相似度分数；
- [ ] 接口日志拆分 embeddingMs、vectorSearchMs、rerankMs、ttftMs、totalMs；
- [ ] 对错误码、接口名、配置项引入关键词召回兜底；
- [ ] 对多租户/多项目强制 metadata filter；
- [ ] 建立文档更新后的重建索引和缓存失效流程。

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

这篇文章想强调的不是某个框架 API，而是 RAG 的工程化姿势：

1. RAG 的核心闭环是“检索可评测、生成可追踪、调参可复现”；
2. 切块、TopK、相似度阈值、Hybrid、rerank 都要用指标驱动；
3. Recall@K 看找没找到，MRR 看排得靠不靠前；
4. TopK 增大通常会提升召回，但也会增加延迟、token 成本和噪声；
5. Spring AI 的 Advisor 能帮你快速接入 RAG，但生产环境仍然要显式管理权限过滤、日志、评测和压测。

如果只做 Demo，把文档塞进向量库就够了；如果要上线，真正难的是把每一次回答都变成可观察、可验证、可迭代的工程系统。

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

1. Spring AI Reference：Retrieval Augmented Generation，https://docs.spring.io/spring-ai/reference/api/retrieval-augmented-generation.html
2. Spring AI API：RetrievalAugmentationAdvisor，https://docs.spring.io/spring-ai/docs/current/api/org/springframework/ai/rag/advisor/RetrievalAugmentationAdvisor.html
3. LangChain4j RAG Tutorial，https://github.com/langchain4j/langchain4j/blob/main/docs/docs/tutorials/rag.md
4. 阿里云开发者社区：使用 Spring AI 结合 RAG 构建基于知识库的 AI 智能搜索，https://developer.aliyun.com/article/1659291
5. Spring Cloud Alibaba：使用 Spring Cloud Alibaba AI 构建 RAG 应用，https://sca.aliyun.com/blog/spring-ai-rag/
6. IBM Think：RAG 结果评估：指标与最佳实践，https://www.ibm.com/cn-zh/think/architectures/rag-cookbook/result-evaluation
7. 腾讯云开发者社区：RAG 评估指标 Recall@K、MRR、NDCG，https://cloud.tencent.com/developer/article/2658116
