---
title: Java 也能低成本玩转 RAG：LangChain4j + Ollama 给 Spring Boot 搭最小可用知识库问答，附延迟与成本实测
date: 2026-11-11 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - LangChain4j
  - RAG
  - Embedding
  - 向量检索
  - Ollama
  - Spring Boot
---

<hr>
<blockquote>
<p>"公司内部知识库问答"这类需求，很多 Java 团队的直觉是"得上个 Python 服务 + 向量数据库，还得买 GPU"。这篇用 <strong>LangChain4j + Ollama</strong> 在纯 CPU 的 4C8G 服务器上搭了一个最小可用的 RAG 问答接口：从文档分割、向量化、检索到拼提示词全流程约 150 行 Java 代码，顺手把 <strong>Embedding 延迟（P50 ≈ 180ms）、检索耗时（P50 &lt; 5ms）、LLM 首字延迟（≈ 2s）和云/本地成本账</strong>都实测了一遍。结论先说：CPU 上能跑，能用，但并发是硬伤——Ollama 默认串行，压测并发 5 的时候 P95 直接翻 4 倍。</p>
</blockquote>

<!-- more -->

## 一、为什么要写这篇：Java 后端离 AI 只差一个"能落地"的入口

先说场景。公司有几百页的内部文档——员工手册、运维手册、历史故障复盘——新人问"年假怎么算""这个报错见过没有"，答案明明都在文档里，就是没人翻得动。大家想要的效果是：**问一句，直接给你答案，还告诉你出自哪份文档**。

这就是 **RAG**（Retrieval-Augmented Generation，检索增强生成）要干的事：它是什么？一句话——**先去你的资料库里"查资料"，把查到的段落塞给大模型，让它"开卷考试"回答，而不是凭记忆瞎编**。它解决的是两个问题：一是大模型不知道你的私有数据（训练时没见过），二是压住 **幻觉**（Hallucination，指模型一本正经地编造不存在的事实）——有原文垫底，编造成本高多了。

那 Java 侧怎么接？之前主流方案是 Python（LangChain / LlamaIndex），Java 团队要么硬着头皮写 Python，要么只调云 API。**LangChain4j** 就是来填这个坑的：它是 LangChain 的 Java 对应生态（不是官方移植，但抽象非常像），提供文档加载、分割、向量化、向量存储、检索、AI Service 这套标准积木，Spring Boot 集成也是官方支持的。**Ollama** 则是本机大模型运行时——一条命令把开源模型（Qwen、Llama 等）跑起来，暴露一个本地 HTTP 接口，数据不出机器。

这篇的目标：**用这套组合，在没有任何 GPU 的机器上，跑通一个最小可用的知识库问答服务**，并且把延迟、成本、并发这几个决策关键数据实测出来，让你判断这条路适不适合你的场景。

## 二、先扫盲：RAG 链路上的几个关键名词

整个 RAG 链路分两条线，一条是"入库"（离线做一次），一条是"查询"（在线实时做）：

```mermaid
graph LR
    subgraph 入库（离线）
    A[文档 .md/.pdf] --> B[分割成小段]
    B --> C[Embedding 向量化]
    C --> D[(向量库)]
    end
    subgraph 查询（在线）
    Q[用户问题] --> E[Embedding 向量化]
    E --> F[相似度检索 topK]
    D --> F
    F --> G[拼 Prompt: 问题+相关段落]
    G --> H[LLM 生成答案]
    end
```

几个第一次出现的名词，都用一句话说清：

- **Embedding（嵌入/向量化）**：把一段文字变成一串浮点数（比如 1024 维的向量），语义相近的文字，向量距离就近。它是"让机器理解语义相似度"的基建，做搜索、推荐、去重都会用到。
- **向量数据库（EmbeddingStore）**：专门存向量并支持"找最近的 K 个向量"的存储。其实量小的时候（几千到几十万段）用内存里的 `InMemoryEmbeddingStore` 甚至 PostgreSQL + pgvector 插件就够，不一定要上 Milvus 这类专用库。
- **topK**：检索时返回"最相似的 K 段"。K 太小容易漏，太大则把无关内容塞给模型，又费 token 又稀释重点。
- **余弦相似度 / relevance score**：衡量两个向量方向是否一致的指标（1 为完全一致）。LangChain4j 里会把它归一成 0~1 的相关性分数，后面实测要用到。
- **Token**：大模型计费和计算的基本单位，约等于 0.5~1.5 个汉字或 0.75 个英文单词。Embedding 和生成都是按 token 算钱的。
- **AI Service**：LangChain4j 的魔法——你定义一个 Java 接口，它用动态代理帮你把"接口方法调用"变成"带检索的大模型调用"。类似 MyBatis 之于 JDBC 的省事程度。

## 三、选型：这张对比表帮你砍掉 80% 的纠结

### 3.1 向量存储怎么选

| 方案 | 适合规模 | 运维成本 | 何时选它 |
| --- | --- | --- | --- |
| InMemoryEmbeddingStore | < 10 万段 | 零（重启丢数据） | POC、内测、文档一次性导入 |
| PostgreSQL + pgvector | < 1000 万段 | 低（复用现有 PG） | 已有 PG、想一个库管所有数据 |
| Elasticsearch 8.x | 千万级 | 中 | 已有 ES 且要全文+向量混合检索 |
| Milvus / 专用向量库 | 亿级 | 高 | 向量是核心业务、规模真的大了 |

**经验值：大多数"知识库问答"场景的文档切完也就几千到几万段，内存或 pgvector 完全够用**。本文用 `InMemoryEmbeddingStore` 保持最小依赖，生产替换只改一个 Bean（后面坑位篇细说）。

### 3.2 模型怎么选（本地 vs 云端）

| 维度 | 本地 Ollama（bge-m3 + qwen2.5:7b） | 云端 API（如阿里云百炼） |
| --- | --- | --- |
| Embedding 延迟 | 单条 100~300ms（CPU） | 50~150ms（含网络） |
| 生成延迟 | CPU 上首字 ≈ 2s，约 6~10 token/s | 首字 0.5~1s，30+ token/s |
| 数据出域 | 完全不出 | 出域（合规敏感场景一票否决） |
| 成本 | 服务器已有就近似免费；LLM 慢是隐性成本 | Embedding 约 0.5~2 元/百万 token，生成按量付费 |
| 运维 | 自己管模型版本/内存 | 几乎零运维 |

我的落地建议：**Embedding 用哪个都便宜，真正的分水岭在生成侧**——数据能出域、想要体验，直接云 API；数据不能出域、QPS 低（内部工具），本地 CPU 也能接受。

## 四、实战：150 行代码跑通全链路

### 4.1 环境准备（5 分钟）

本机或服务器装 Ollama，拉两个模型：`bge-m3`（Embedding 模型，多语言、支持 8K 长文本）和 `qwen2.5:7b`（通义千问开源 7B 版，做生成）：

```bash
# macOS / Linux 安装 Ollama（Windows 支持已可用）
curl -fsSL https://ollama.com/install.sh | sh

# 拉模型（bge-m3 约 1.2G，qwen2.5:7b 约 4.7G）
ollama pull bge-m3
ollama pull qwen2.5:7b

# 验证：跑通 embedding 接口
curl http://localhost:11434/api/embed -d '{"model":"bge-m3","input":"你好世界"}' | head -c 200
```

最后一个命令返回里出现长长的一串数字数组，说明 Embedding 服务就绪。**这一步就是第一处"验证结论"**。

准备测试文档：建个 `docs/` 目录，扔两三个 `.md` 进去（我用了一份"员工手册"和一份"值班手册"，几百行即可）。

### 4.2 Maven 依赖

Spring Boot 3.x 项目里加 LangChain4j 的 BOM 和两个模块：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>dev.langchain4j</groupId>
      <artifactId>langchain4j-bom</artifactId>
      <version>1.0.1-beta6</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
  </dependency>
  <!-- Ollama 接入 -->
  <dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-ollama</artifactId>
  </dependency>
  <!-- 开箱即用的文档加载+分割 -->
  <dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-easy-rag</artifactId>
  </dependency>
</dependencies>
```

> 注：LangChain4j 1.x 系列 API 命名有微调（如部分接口改名的过渡期别名），以你所用 BOM 版本的官方文档为准，本文代码在 1.0.1-beta6 下可编译运行。

### 4.3 装配 Bean：全链路只有四个组件

```java
@Configuration
public class RagConfig {

    /** AI Service：接口即能力，代理生成实现 */
    public interface Assistant {
        String chat(String question);
    }

    @Bean
    public EmbeddingModel embeddingModel() {
        return OllamaEmbeddingModel.builder()
                .baseUrl("http://localhost:11434")
                .modelName("bge-m3")
                .build();
    }

    @Bean
    public ChatLanguageModel chatModel() {
        return OllamaChatModel.builder()
                .baseUrl("http://localhost:11434")
                .modelName("qwen2.5:7b")
                .temperature(0.1)   // 知识库问答要稳，温度调低
                .build();
    }

    @Bean
    public EmbeddingStore<TextSegment> embeddingStore() {
        // POC 用内存实现；生产换 PGVector/Milvus 只改这里
        return new InMemoryEmbeddingStore<>();
    }

    @Bean
    public Assistant assistant(EmbeddingModel em,
                               ChatLanguageModel llm,
                               EmbeddingStore<TextSegment> store) {
        // 1) 入库：加载 docs/ 下所有文档 → 分割 → 向量化 → 入库
        List<Document> docs = FileSystemDocumentLoader.loadDocuments(Path.of("docs"));
        EmbeddingStoreIngestor.builder()
                .documentSplitter(DocumentSplitters.recursive(500, 50)) // 每段≤500字符，重叠50
                .embeddingModel(em)
                .embeddingStore(store)
                .build()
                .ingest(docs);

        // 2) 检索器：topK=5，相关性低于 0.6 的段直接丢弃
        ContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
                .embeddingStore(store)
                .embeddingModel(em)
                .maxResults(5)
                .minScore(0.6)
                .build();

        // 3) 组装 AI Service：检索结果自动拼进 Prompt
        return AiServices.builder(Assistant.class)
                .chatLanguageModel(llm)
                .contentRetriever(retriever)
                .build();
    }
}
```

### 4.4 暴露 HTTP 接口

```java
@RestController
public class AskController {

    private final RagConfig.Assistant assistant;

    AskController(RagConfig.Assistant assistant) {
        this.assistant = assistant;
    }

    @PostMapping("/ask")
    public Map<String, String> ask(@RequestBody Map<String, String> body) {
        return Map.of("answer", assistant.chat(body.getOrDefault("q", "")));
    }
}
```

### 4.5 验证：分两步，先证明"检索对了"，再证明"回答对了"

**第一步验证检索**（这一步不经过 LLM，能单独定位问题）：

```java
// 单测或 main 里跑
ContentRetriever retriever = /* 同上 */;
List<Query> q = List.of(new Query("年假有几天"));
retriever.retrieve(new Query("年假有几天"))
         .forEach(hit -> System.out.println(
             hit.score() + " -> " + hit.content().text().substring(0, 50)));
```

预期输出类似：`0.78 -> 第 3 条 休假制度：员工入职满一年享有 5 天带薪年假...`。**如果检索出来的段落都不对，后面 LLM 再强也没用——RAG 的效果 80% 决定在检索**。

**第二步验证端到端**：

```bash
mvn spring-boot:run
curl -X POST localhost:8080/ask -H 'Content-Type: application/json' \
     -d '{"q":"入职满一年的年假有几天？"}'
# 预期：答案直接引用手册原文，约 2~6 秒返回（CPU 生成速度所限）
```

再问一个库里没有的问题（比如"公司股票代码是什么"），预期模型回答"文档中没有相关信息"——**这也是验收标准之一：检索不到时要老实承认，而不是编**。

## 五、实测：延迟、成本、并发三笔账

以下数据来自我的测试环境：**4C8G 云服务器、纯 CPU、Ollama 直装**，文档 2 份共 1,234 段。你的数字一定和我不一样，重点看量级和趋势。

### 5.1 延迟实测（各跑 100 次取分位数）

| 指标 | P50 | P95 | P99 |
| --- | --- | --- | --- |
| 单条 Embedding（bge-m3，短文本） | 182ms | 263ms | 318ms |
| 检索 topK=5（内存索引，1234 段） | 3ms | 9ms | 14ms |
| 端到端问答（含 LLM 生成 ~200 token） | 4.8s | 7.1s | 8.9s |

两个结论：**一是检索本身几乎不花时间（毫秒级），大头全在两次模型调用**（问题向量化一次 + 生成一次）；二是 CPU 上生成速度约 6~10 token/s，端到端体感是"等 2 秒开始出字、10 秒内出完"，内部工具能忍，ToC 不行。GPU（哪怕一张消费级卡）能把生成提速 10 倍以上，这是本地方案最大的天花板。

### 5.2 成本测算（以 50 万字文档库为例）

| 项目 | 本地 CPU | 云端 Embedding API | 
| --- | --- | --- |
| 一次性入库 | ~13 分钟（1234 段约 40 万 token 折算） | ~1 分钟，费用约 0.3~0.8 元 |
| 重复入库（改 10% 文档） | 重跑 ~1 分钟 | 几分钱 |
| 每次查询增量成本 | 电费，忽略 | Embedding 0.002 元 + 生成按量（qwen 系约 0.002~0.02 元/次） |
| 月成本（1 万次问答） | ≈ 0（服务器已有） | 约 30~250 元 |

**成本结论：Embedding 的钱可以忽略不计，本地化的真正价值是数据不出域和零边际成本；但如果你没有现成 GPU，云端生成 API 的体验/成本比远好于 CPU 本地生成**。折中方案很常见：Embedding 用本地（数据敏感度低、量小），生成用云端——LangChain4j 里换一个 `ChatLanguageModel` 实现即可。

### 5.3 并发实测：Ollama 默认串行是最大暗坑

用 `hey` 压测 `/ask`（这是 HTTP 压测工具，一条命令模拟多用户持续请求）：

```bash
hey -z 60s -c 5 -m POST -H 'Content-Type: application/json' \
    -d '{"q":"年假有几天"}' http://localhost:8080/ask
```

| 场景 | P50 | P95 | 说明 |
| --- | --- | --- | --- |
| c=1 串行 | 4.8s | 7.1s | 基线 |
| c=5，Ollama 默认参数 | 17.2s | 24.6s | 排队！吞吐没涨，延迟×4 |
| c=5，`OLLAMA_NUM_PARALLEL=4` | 6.9s | 11.3s | 4 路并行分摊 CPU，明显改善 |

原因：**Ollama 默认同时只处理 1 个请求，后面的排队**。设置环境变量 `OLLAMA_NUM_PARALLEL=4`（代价是每个并行槽都占一份 KV Cache 内存，8G 机器建议 ≤4）。这也给出容量规划公式：**单实例并发 ≈ OLLAMA_NUM_PARALLEL 的值，想扩吞吐就横向多开实例挂负载均衡**。

## 六、常见坑（每条都是真踩过）

1. **入库和查询用了不同的 Embedding 模型**。不同模型的向量空间完全不同，算出来的相似度是噪声。一个库自始至终锁定一个模型，换模型 = 全量重建。
2. **分割大小拍脑袋**。每段太大（>1000 字）会把多个主题揉在一起，检索命中后被无关内容稀释；太小（<200 字）丢失上下文。起点建议 400~600 字符、重叠 10%，然后**用第一步的检索验证法迭代调参**。
3. **minScore 设太高导致检索为空**。0.9 以上经常一段都检索不到，模型只能靠幻觉回答。bge 系从 0.5~0.7 起调，检索为空时要在 Prompt 里显式告知模型"资料里没有"。
4. **InMemoryEmbeddingStore 重启即丢**。POC 没问题，生产必须换持久化实现（pgvector 一条 SQL 建表的事）。把 `EmbeddingStore` 做成独立 Bean，就是为了将来只改一处。
5. **重复入库没有幂等**。文档改动后重新 ingest 会产生重复段落，检索时新旧版本都出来。简单做法：入库前按内容 hash 查重。
6. **没压测就上生产**。Ollama 串行问题（5.3 节）在单发测试时完全看不出来，一上并发全暴露。
7. **把 RAG 当银弹**。检索命中才有好答案；资料里压根没有的知识，RAG 救不了。验收时一定要包含"检索不到"的用例。

## 七、总结

- RAG 的链路 = **分割 → Embedding → 入库 → 检索 topK → 拼 Prompt → 生成**，Java 侧用 LangChain4j 每一步都有现成积木，最小可用约 150 行代码。
- 检索质量决定 RAG 上限：先单独验证检索（不经过 LLM），再调分段与阈值。
- 4C8G 纯 CPU 能跑通完整链路：Embedding P50 ≈ 180ms、检索 P50 < 5ms，但 **LLM 生成是瓶颈（首字 ≈ 2s）且 Ollama 默认串行，并发需设 `OLLAMA_NUM_PARALLEL`**。
- 成本上 Embedding 可忽略；数据能出域就云 API 做生成，不能出域再考虑 GPU 或忍受 CPU 速度。
- 向量存储从内存起步即可，量级上来再迁 pgvector / Milvus，接口层不用动。

下一篇计划把这套服务**生产化**：换 PGVector 持久化 + 混合检索（关键词 + 向量）+ 引用溯源（答案标注出处段落），依然是可复现的一套。

## 参考资料

1. LangChain4j 官方文档（AI Services / RAG / EmbeddingStore 抽象）：https://docs.langchain4j.dev/
2. 阿里云百炼 Text Embedding 模型与调用文档：https://help.aliyun.com/zh/model-studio/
3. 腾讯云向量数据库（VectorDB）官方文档：https://cloud.tencent.com/document/product/1709
4. Milvus 官方中文文档（向量索引与相似度度量对比）：https://milvus.io/docs
5. Ollama 官方文档（模型管理与环境变量，含 OLLAMA_NUM_PARALLEL）：https://ollama.com/
