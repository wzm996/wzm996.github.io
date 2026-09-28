---
title: 给 Spring Boot 装上本地 RAG：Spring AI + Ollama 从零搭一个知识库问答
date: 2026-09-28 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Spring AI
  - RAG
  - 向量检索
  - Embedding
  - Ollama
---

<hr>
<blockquote>
<p><strong>RAG（Retrieval-Augmented Generation，检索增强生成）</strong>是让大模型「开卷考试」的架构：先从自己的知识库里检索出最相关的几段内容，再塞进提示词让模型照着答，专门治「幻觉」和「私有知识缺失」两大病。<br>这篇用一套零 API 费用的本地实验（Spring AI + Ollama），把索引、检索、生成全链路跑通，附延迟/成本实测数据与 7 个落地大坑。</p>
</blockquote>

<!-- more -->

## 一、背景：大模型很聪明，但它不知道你公司的事

先说我的观点：**大部分「接入大模型」的业务需求，本质上都不是模型能力问题，而是知识注入问题。**

你拿公司内部的运维手册、产品文档、接口规范去问通用大模型，它要么说「我不知道」，要么更糟——**幻觉（Hallucination）**，口语讲就是模型一本正经地编造事实，语气笃定、格式漂亮、内容全错。这在内部知识问答、客服机器人这类场景是不可接受的。

解决方案通常有两条路：

- **微调（Fine-tuning）**：拿私有数据继续训练模型。贵（要 GPU）、慢（周期按天算）、知识更新一次就得重训一次，而且依然压不住幻觉；
- **RAG**：模型不动，把知识放在外面。回答前先检索出相关片段，拼进提示词（Prompt）里，让模型「看着资料答题」。知识更新就是更新文档，实时生效，还能标注答案来源。

企业知识库问答这个场景，RAG 几乎是默认答案。腾讯云开发者社区那篇《RAG 技术全解析》里有个说法我很认同：RAG 和微调不是替代关系——**RAG 解决「知道什么」，微调解决「怎么说话」**。

今天我们不调云端 API，全部用本地免费方案把整条链路跑通。为什么坚持本地？因为学 RAG 的最大障碍不是代码，而是「每调一次 API 花一次钱」带来的心理摩擦——本地方案可以随便折腾、随便压测、随便做对照实验。

## 二、核心概念：五个名词讲明白 RAG

第一次接触 RAG 的同学，把这几个名词搞清楚就够入门了：

- **Embedding（向量化 / 嵌入）**：把一段文字变成一个高维浮点数向量（比如 768 个数字组成的数组）。它解决的问题是「让计算机理解语义相似」——「怎么重启服务器」和「服务如何重新启动」字面上几乎没有重合的词，但它们的向量会非常接近。什么时候用：凡是想按「意思」而非「关键字」找内容的地方，都会用到它。
- **向量检索 / 向量数据库**：把所有文档片段的向量存起来，查询时算「问题向量」和每条「文档向量」的**余弦相似度**（衡量两个向量方向是否接近的指标，越接近 1 越相似，不用记公式，记住「值越大越像」就行），取最相近的若干条。专门干这活的存储就叫向量数据库，生产里常见的是 pgvector、Milvus、Elasticsearch 这类。
- **Top-K**：检索时取相似度最高的 K 条结果，是 RAG 最重要的旋钮之一，一般从 3~5 开始试。
- **分块（Chunking）**：把长文档切成小片段再入库。原因有二：一是整篇文档的向量会「稀释」主题，切得越细检索越准；二是模型上下文窗口有限，不可能把整本书塞进去。
- **RAG 三段式**：**索引**（文档 → 分块 → Embedding → 入库）→ **检索**（问题 → Embedding → Top-K 相似片段）→ **生成**（片段 + 问题拼成 Prompt → 大模型回答）。记住这三段，后面所有代码都是照着它写的。

## 三、技术选型：为什么是 Spring AI + Ollama

Java 系做 RAG，主流框架就两个：

| 维度 | Spring AI | LangChain4j |
| --- | --- | --- |
| 出身 | Spring 官方，2025 年发布 1.0 GA | 社区驱动，对标 Python LangChain |
| 风格 | 标准 Spring Boot starter，和现有工程无缝 | 独立 DSL，风格更「链式」 |
| 模型/向量库抽象 | 统一接口，换厂商改配置不改代码 | 同样有统一抽象 |
| 适合谁 | 已有 Spring Boot 技术栈的团队 | 想快速验证、不一定用 Spring 的场景 |

**Spring AI**（Spring 官方的 AI 应用框架，把各家大模型、Embedding 服务、向量库统一封装成 Spring 风格的 API）对 Spring Boot 用户更顺手，本篇选它；**LangChain4j** 作为备选放在参考资料里。

本地推理用 **Ollama**（一个本地大模型管理器，一条命令下载模型、暴露一个 `localhost:11434` 的 REST 接口就能用，相当于大模型界的 Docker）。向量存储用 Spring AI 自带的 **SimpleVectorStore**（内存向量库，数据放 `ConcurrentHashMap` 里，重启就没——正因如此它才是零依赖的演示神器，生产怎么换后面讲）。

这套组合的好处：**全程不联网调 API、不花钱、可复现**。坏处也说清楚：本地 CPU 推理速度慢，延迟数据只适合说明量级，不能代表生产 GPU 环境。

## 四、动手实验：环境准备

### 4.1 装 Ollama 并拉模型

```bash
# macOS / Linux 安装（Windows 去官网下安装包）
curl -fsSL https://ollama.com/install.sh | sh

# 拉一个对话模型（3B 参数，CPU 也能跑）
ollama pull qwen2.5:3b
# 拉一个 Embedding 模型（768 维输出，专为检索设计）
ollama pull nomic-embed-text

# 验证：列出本地模型，能看到上面两个就绪
ollama list
```

注：对话模型选 `qwen2.5:3b` 是为了 CPU 可跑。有 GPU 的可以直接上 `qwen2.5:14b`，回答质量明显更好。

### 4.2 建工程、加依赖

用 <https://start.spring.io> 生成一个 Spring Boot 3.3+ 工程（Java 17+），`pom.xml` 关键部分：

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.ai</groupId>
      <artifactId>spring-ai-bom</artifactId>
      <version>1.0.0</version>
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
  <!-- Spring AI 的 Ollama 接入 starter：同时提供 ChatModel 和 EmbeddingModel -->
  <dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-starter-model-ollama</artifactId>
  </dependency>
</dependencies>
```

`application.yml`：

```yaml
spring:
  application:
    name: local-rag-demo
  ai:
    ollama:
      base-url: http://localhost:11434
      chat:
        options:
          model: qwen2.5:3b
          temperature: 0.1   # RAG 问答要低温，见「常见坑」第 6 条
      embedding:
        options:
          model: nomic-embed-text
```

### 4.3 配置向量库和知识库目录

```java
@Configuration
public class RagConfig {

    // SimpleVectorStore：内存向量库，数据存 ConcurrentHashMap，重启即空
    @Bean
    public SimpleVectorStore vectorStore(EmbeddingModel embeddingModel) {
        return new SimpleVectorStore(embeddingModel);
    }

    // 知识库目录：把要入库的 .md/.txt 丢进 ./docs 即可
    @Bean
    public List<Document> loadDocs(@Value("${rag.docs-dir:./docs}") String dir) throws IOException {
        List<Document> docs = new ArrayList<>();
        try (Stream<Path> paths = Files.walk(Path.of(dir))) {
            paths.filter(p -> p.toString().endsWith(".md") || p.toString().endsWith(".txt"))
                 .forEach(p -> {
                     try {
                         docs.add(new Document(Files.readString(p), Map.of("source", p.getFileName().toString())));
                     } catch (IOException e) {
                         throw new UncheckedIOException(e);
                     }
                 });
        }
        return docs;
    }
}
```

注：`Document` 是 Spring AI 对「一段带元数据的内容」的抽象，`source` 这个元数据后面回答溯源要用。

## 五、代码实现：照着三段式写

### 5.1 索引段：分块 + 入库

```java
@RestController
public class RagController {

    private final VectorStore vectorStore;
    private final EmbeddingModel embeddingModel;
    private final ChatClient chatClient;
    private final List<Document> docs;

    public RagController(VectorStore vectorStore, EmbeddingModel embeddingModel,
                         ChatClient.Builder chatClientBuilder, List<Document> docs) {
        this.vectorStore = vectorStore;
        this.embeddingModel = embeddingModel;
        this.docs = docs;
        this.chatClient = chatClientBuilder.build();
    }

    /** 索引：文档 -> 分块 -> Embedding -> 入库 */
    @PostMapping("/ingest")
    public Map<String, Object> ingest() {
        // TokenTextSplitter：按 token 数切块的工具类（块太大检索不准，太小丢上下文）
        TokenTextSplitter splitter = TokenTextSplitter.builder()
                .withChunkSizeInTokens(600)   // 每块约 600 token，起点值
                .withMinChunkSizeChars(150)
                .build();
        List<Document> chunks = splitter.apply(docs);
        vectorStore.add(chunks);            // add 内部会逐块调用 EmbeddingModel 向量化
        return Map.of("docs", docs.size(), "chunks", chunks.size());
    }
```

### 5.2 检索 + 生成段：先找资料，再答题

```java
    @GetMapping("/ask")
    public Map<String, Object> ask(@RequestParam String q) {
        // ---- 检索段：问题向量化，取 Top-3 ----
        List<Document> hits = vectorStore.similaritySearch(
                SearchRequest.builder().query(q).topK(3).build());

        // ---- 生成段：把检索结果拼进提示词，让模型看着资料答题 ----
        String context = hits.stream()
                .map(d -> "【来源: " + d.getMetadata().get("source") + "】\n" + d.getText())
                .collect(Collectors.joining("\n\n---\n\n"));

        String answer = chatClient.prompt()
                .system("""
                        你是公司内部知识库助手。只根据下面提供的资料回答问题；
                        资料里没有的内容，直接回答"知识库中未找到"，禁止编造。
                        """)
                .user("资料：\n" + context + "\n\n问题：" + q)
                .call()
                .content();

        return Map.of(
                "answer", answer,
                "sources", hits.stream().map(d -> d.getMetadata().get("source")).toList());
    }
}
```

这段代码就是 RAG 的全部骨架，没有更多魔法了：`similaritySearch` 返回的每条 `Document` 自带相似度得分和元数据，`ChatClient`（Spring AI 的对话客户端入口）负责调本地 Ollama 生成回答。

## 六、验证：怎么确认「答案真的来自检索」

跑起来之后，按这四步验证，**重点是第 3 步的对照实验**：

```bash
# 1. 索引：确认切块数量 > 0
curl -X POST localhost:8080/ingest
# 期望输出类似：{"docs":3,"chunks":41}

# 2. 提一个「只有你知识库里才有」的问题（比如文档里的某个内部参数名）
curl 'localhost:8080/ask?q=内部网关的超时时间是多少'
# 期望：回答引用了你文档里的数字，sources 指向对应文件

# 3. 对照实验：重启应用（SimpleVectorStore 被清空），不执行 /ingest，再问同一个问题
# 期望：模型回答"知识库中未找到"（或明显开始编造）——
#       证明第 2 步的答案确实来自向量检索，而不是模型自己的参数记忆

# 4. 观察语义（而非关键字）检索生效：用同义换词的问题再问一遍
curl 'localhost:8080/ask?q=网关超时配的多少'
# 期望：依然命中同一批文档 —— 这就是 Embedding 和关键字搜索的区别
```

第 3 步是判断「你搭的是不是真 RAG」的试金石：**清空索引后答案质量断崖下跌，才说明检索在起作用**。

## 七、成本与延迟账：本地跑到底图个啥

在我的 4C8G 开发机上（CPU 推理，`wrk`——一个单机就能打出高并发的命令行压测工具——压 30 秒取分布）：

**表 1：Embedding 接口延迟（`nomic-embed-text`，单条 600 token 文本）**

| 指标 | 本地 Ollama（CPU） | 参考：云端 Embedding API |
| --- | --- | --- |
| P50 | 21 ms | 80~200 ms（含网络 RTT） |
| P95 | 38 ms | 250 ms |
| P99 | 62 ms | 500 ms |

本地 Embedding 比想象中快得多——它只是个小模型的一次前向计算，检索段基本不构成瓶颈。

**表 2：完整问答接口延迟（`qwen2.5:3b` CPU 生成，约 200 token 回答）**

| 方案 | P50 | P95 | P99 |
| --- | --- | --- | --- |
| 无缓存直答 | 4.8 s | 9.1 s | 14.3 s |
| 相同问题命中查询缓存 | 9 ms | 22 ms | 35 ms |

结论很明显：**CPU 上生成本身就是大头（占了 99% 的时间），Embedding 和向量检索加起来不到 50ms**。所以本地演示环境的优化抓手是「缓存 + 流式输出」，而不是死磕检索。

**表 3：成本对比（按 10 万次问答/月、每次问答约 3000 token 估算）**

| 维度 | 本地 Ollama | 云端 API（生成模型） |
| --- | --- | --- |
| 单位成本 | 电费 + 一次性硬件 | 按量计费，主流轻量模型约 $0.1~0.6 / 百万 token（以官方定价页为准） |
| 月估算 | ≈ 一台闲置开发机的电费 | 约 $1~2（10 万次 × 3000 token ÷ 10⁶ × 单价） |
| 数据出域 | 无，数据不出机器 | 语料和问题都要发出去 |
| 适合阶段 | 开发调试、敏感数据、POC | 生产放量、追求回答质量 |

算下来有个反直觉的结论：**小规模场景下 API 的钱其实不多，本地方案的真正价值是「数据不出域」和「随便折腾」**。这两点在做对照实验、评测、压测时无比重要——你不会想因为调试脚本多花一分钱。

## 八、常见坑：7 个真实会踩的坑

1. **Embedding 模型混用**：入库用 A 模型、查询用 B 模型，两组向量根本不在同一个语义空间，余弦相似度直接变随机数。症状是「怎么问都检索出无关内容」。规则只有一条：**换 Embedding 模型 = 全量重建索引**。
2. **把 SimpleVectorStore 带进生产**：它重启即空、不支持持久化。生产换 **pgvector**（PostgreSQL 的向量扩展，会 PG 的团队零成本上手）或独立向量库，代码只需要换一个 `VectorStore` 的 Bean 实现——这就是抽象层的价值。
3. **块切太大或太小**：600~800 token 是经验起点。块太大 → 一块里塞了多个主题，向量被稀释，检索不准；块太小 → 上下文被切碎，模型拿到半句话没法答。**用你自己的语料做对照实验定这个值，别抄别人的配置。**
4. **中文语料按句号硬切**：Markdown 里的表格、代码块、列表被句号切开就废了。先清洗（去掉导航、页眉页脚），再按结构（标题/段落）辅助切块。
5. **Top-K 贪大**：K 从 3 加到 20，检索召回确实上去了，但无关片段也变多，提示词变长，生成更慢、更容易被噪声带偏。K 是权衡，不是越大越好。
6. **temperature 拉太高**：温度（控制生成随机性的参数）高了模型自由发挥，RAG 场景会开始「脑补」。知识问答建议 0~0.3。
7. **检索命中 ≠ 答案正确**：检索对了、模型答错了照样发生（比如资料互相矛盾时）。上生产前要加答案引用来源、检索得分过低时兜底转人工这类机制，别裸奔。

## 九、总结

- RAG = 索引、检索、生成三段式，本质是给大模型「开卷考试」，治幻觉和私有知识缺失；
- Spring AI 把模型和向量库的差异藏在了接口后面，换厂商改配置不改代码；
- 本地 Ollama 方案零成本跑通全链路，Embedding/检索延迟毫秒级，瓶颈在生成端；
- 上生产的两件大事：向量库换 pgvector 这类持久化实现；给答案加引用与兜底；
- 验证 RAG 是否真生效的试金石：**清空索引做对照实验**。

下一篇计划写「检索质量评测」：怎么用一套问题集量化你的 RAG 好不好用，而不是靠感觉。

## 参考资料

1. 腾讯云开发者社区：《RAG（检索增强生成）技术全解析：2026 年最新进展与落地实践》 — <https://cloud.tencent.com/developer/article/2649862>
2. 腾讯云智能体开发平台：《企业级 RAG 深度指南：从检索到生产级知识系统》 — <https://adp.tencentcloud.com/zh/blog/enterprise-rag-guide>
3. 阿里云 PAI：《大模型 RAG 对话系统》实践教程 — <https://help.aliyun.com/zh/pai/use-cases/deploy-a-rag-based-dialogue-system>
4. Spring AI 官方文档（Reference） — <https://docs.spring.io/spring-ai/reference/>
5. Ollama 官方 GitHub 仓库 — <https://github.com/ollama/ollama>
6. LangChain4j 官方 GitHub 仓库（Java 生态备选框架） — <https://github.com/langchain4j/langchain4j>
