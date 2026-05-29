---
title: Spring AI 入门：用 Java 搭建一个支持文档问答的 RAG 应用
date: 2026-05-29 10:00:00
categories:
  - 后端工程
  - 任务与调度
tags:
  - Java
  - Spring Boot
  - Spring AI
  - RAG
  - 向量检索
  - Embedding
---

<hr>
<blockquote>
<p>RAG（Retrieval-Augmented Generation，检索增强生成）不是让大模型"背答案"，而是让它"先查资料再回答"。本文用 Spring AI 从零搭一个能读文档、存向量、回答问题的完整应用，并给出每一步的验证方法和常见坑。</p>
</blockquote>

<!-- more -->

<h1 id="为什么要聊-RAG"><a href="#为什么要聊-RAG" class="headerlink" title="为什么要聊 RAG"></a>为什么要聊 RAG</h1>

大模型（LLM）很能聊，但直接拿它当业务助手会有几个让人头疼的问题：

- **知识有截止日期**：模型训练数据是某个时间点之前的，问它昨天发的公告它不知道。
- **会一本正经胡说八道**：专业领域里，模型可能编造不存在的 API 名、错误的配置项。
- **私有数据进不去**：你的内部文档、代码库、运维手册，模型从来没见过。

**RAG** 的思路很简单：用户提问时，先从一个"知识库"里检索相关内容，再把检索到的内容和问题一起塞给大模型，让它基于这些材料来回答。口语化一点说：**就像开卷考试——先翻书找相关章节，再基于书上的内容作答。**

Spring AI 是 Spring 官方推出的 AI 应用开发框架，目标是让 Java 开发者用熟悉的 Spring 编程模型（Auto-Configuration、Template 模式、流式输出等）来调用大模型、做向量检索、构建 Agent 和 RAG 流水线。本文用的是 Spring AI 1.0.0-M6 版本（截至写作时的较新里程碑版本），API 可能随正式版调整，但核心概念不变。

本文要回答四个问题：

1. RAG 的基本流程是什么？每个环节在干什么？
2. 怎么用 Spring AI 搭一个最小可用的 RAG 应用？
3. 怎么验证检索质量和回答准确性？
4. 落地时有哪些坑？

<h1 id="先讲清楚几个名词"><a href="#先讲清楚几个名词" class="headerlink" title="先讲清楚几个名词"></a>先讲清楚几个名词</h1>

| 名词 | 一句话解释 | 什么时候会用到 |
| --- | --- | --- |
| **RAG** | 检索增强生成：先查资料再让 LLM 回答，减少幻觉、利用私有数据 | 私有文档问答、知识库助手、客服机器人 |
| **Embedding（嵌入向量）** | 把一段文本变成一组浮点数（向量），语义相近的文本在向量空间里距离更近 | 检索阶段的核心：把问题和文档都变成向量才能算相似度 |
| **Vector Store（向量数据库）** | 专门存和查向量的数据库，支持高效近似最近邻搜索 | 存储文档切片后的向量，查询时快速找到最相关的几条 |
| **Document ETL** | 把原始文档加载、切分成小块、生成 Embedding、写入向量库的全流程 | 准备知识库时的数据处理流水线 |
| **Chunk（文本块）** | 把长文档切成固定或语义边界的短片段，作为检索的基本单位 | 切太大检索不准，切太小丢失上下文 |
| **Top-K** | 检索时取相似度最高的 K 条结果送给 LLM | 控制"参考资料"的数量，影响回答质量和 token 消耗 |
| **Spring AI** | Spring 官方的 AI 应用框架，提供 LLM 调用、向量检索、RAG 管道等抽象 | 用 Java/Spring Boot 构建 AI 应用的首选方案 |

<h1 id="RAG-流程全景"><a href="#RAG-流程全景" class="headerlink" title="RAG 流程全景"></a>RAG 流程全景</h1>

RAG 分为两个阶段：**准备阶段（离线）** 和 **查询阶段（在线）**。

```
准备阶段（离线，通常做一次或定期更新）：
  原始文档 → 加载器读取 → 文本分块 → Embedding 模型转向量 → 写入 Vector Store

查询阶段（在线，每次用户提问）：
  用户问题 → Embedding 转向量 → Vector Store 相似度检索 → 取 Top-K 结果 →
  拼装 Prompt（问题 + 检索到的文档片段）→ LLM 生成回答 → 返回给用户
```

理解这个流程很重要，因为后面每一节代码都对应这里的一个环节。如果回答质量不好，你可以沿着这个链条逐段排查：是文档没切好？Embedding 不准？检索没召回来？还是 Prompt 给 LLM 的上下文不够？

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<h2 id="基础依赖"><a href="#基础依赖" class="headerlink" title="基础依赖"></a>基础依赖</h2>

```bash
java -version
# 需要 JDK 17+（建议 21）

mvn -version
# Maven 3.8+
```

本文示例使用以下关键依赖版本：

- Spring Boot 3.4.0
- Spring AI 1.0.0-M6（BOM 管理）
- OpenAI 作为 LLM 和 Embedding 提供方（你也可以换成其他兼容 OpenAI API 格式的服务）
- SimpleVectorStore（内存向量库，适合学习和开发验证；生产建议用 PgVector / Milvus / Elasticsearch 等）

> 注：如果你没有 OpenAI API Key，可以用任何兼容 OpenAI 接格式的服务（比如国内各种中转/代理），只需要把 `spring.ai.openai.api-key` 和 `base-url` 指向对应地址即可。Spring AI 的抽象层切换模型提供商只需要改配置，不用改代码。

<h2 id="新建项目"><a href="#新建项目" class="headerlink" title="新建项目"></a>新建项目</h2>

`pom.xml`：

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.4.0</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>spring-ai-rag-demo</artifactId>
    <version>0.0.1-SNAPSHOT</version>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.ai</groupId>
                <artifactId>spring-ai-bom</artifactId>
                <version>1.0.0-M6</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <!-- Spring AI OpenAI 启动器（包含 ChatClient + EmbeddingModel） -->
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-openai</artifactId>
        </dependency>

        <!-- Spring AI 向量存储：SimpleVectorStore（内存，开发用） -->
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-vector-store-simple</artifactId>
        </dependency>

        <!-- PDF 文档读取器 -->
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-pdf-document-reader</artifactId>
        </dependency>

        <!-- Web -->
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
    </dependencies>
</project>
```

`application.yml`：

```yaml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY:sk-your-key-here}
      # 如果使用中转/代理服务，取消下面注释并修改：
      # base-url: https://your-proxy.example.com/v1
      chat:
        options:
          model: gpt-4o-mini
          temperature: 0.7
      embedding:
        options:
          model: text-embedding-3-small

server:
  port: 8080
```

启动类：

```java
package com.example.rag;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class RagApplication {
    public static void main(String[] args) {
        SpringApplication.run(RagApplication.class, args);
    }
}
```

<h1 id="第一步：文档加载与分块"><a href="#第一步：文档加载与分块" class="headerlink" title="第一步：文档加载与分块"></a>第一步：文档加载与分块</h1>

先写一个服务类，负责把文档加载进来、切成小块。

```java
package com.example.rag.service;

import org.springframework.ai.document.Document;
import org.springframework.ai.reader PdfReader;import org.springframework.ai.transformer.splitter.TextSplitter;
import org.springframework.ai.transformer.splitter.TokenTextSplitter;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class DocumentLoaderService {

    private final TextSplitter textSplitter;

    public DocumentLoaderService() {
        // TokenTextSplitter 按 token 数切分，默认 chunkSize=800,
        // chunkOverlap=200（相邻块有重叠，避免切断语义）
        this.textSplitter = new TokenTextSplitter();
    }

    /**
     * 加载 PDF 并分块。
     *
     * @param resource Spring Resource（支持 classpath:/file:/http: 等前缀）
     * @return 分块后的 Document 列表
     */
    public List<Document> loadAndSplit(Resource resource) {
        // 1. 用 PdfReader 读取 PDF，每页变成一个 Document
        PdfReader pdfReader = new PdfReader();
        List<Document> rawDocs = pdfReader.get(resource);

        // 2. 用 TextSplitter 将长文档切成小块
        return textSplitter.apply(rawDocs);
    }
}
```

**验证方法**：写一个临时测试或者 CommandLineRunner 打印分块结果：

```java
package com.example.rag.service;

import org.springframework.ai.document.Document;
import org.springframework.boot.CommandLineRunner;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class VerifyChunking implements CommandLineRunner {

    private final DocumentLoaderService loader;

    public VerifyChunking(DocumentLoaderService loader) {
        this.loader = loader;
    }

    @Override
    public void run(String... args) throws Exception {
        // 在 src/main/resources/ 下放一个测试 PDF
        Resource pdf = new ClassPathResource("test-doc.pdf");
        List<Document> chunks = loader.loadAndSplit(pdf);

        System.out.println("=== 分块验证 ===");
        System.out.println("总块数: " + chunks.size());
        for (int i = 0; i < Math.min(5, chunks.size()); i++) {
            Document d = chunks.get(i);
            System.out.printf("--- Chunk %d ---%n", i);
            System.out.println("长度: " + d.getContent().length() + " 字符");
            System.out.println("前100字: " + d.getContent().substring(
                0, Math.min(100, d.getContent().length())));
            System.out.println();
        }
    }
}
```

启动后观察控制台输出，确认：
- 块数是否合理（一份 10 页文档大概切出 30~80 块，取决于内容密度）
- 每块大小是否在预期范围内（TokenTextSplitter 默认约 800 token/块）
- 是否有特别短或特别长的异常块

<h1 id="第二步：生成-Embedding-并存入向量库"><a href="#第二步：生成-Embedding-并存入向量库" class="headerlink" title="第二步：生成 Embedding 并存入向量库"></a>第二步：生成 Embedding 并存入向量库</h1>

Spring AI 的 `VectorStore` 抽象封装了"接收 Document 列表 → 自动调 Embedding 模型 → 存入向量库"的全过程。你不需要手动调用 Embedding API。

```java
package com.example.rag.service;

import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class IngestionService {

    private final DocumentLoaderService loader;
    private final VectorStore vectorStore;

    public IngestionService(DocumentLoaderService loader, VectorStore vectorStore) {
        this.loader = loader;
        this.vectorStore = vectorStore;
    }

    /**
     * 将文档摄入到向量库（加载 → 分块 → Embedding → 存储）。
     */
    public void ingest(Resource resource) {
        List<Document> chunks = loader.loadAndSplit(resource);
        vectorStore.add(chunks);
        System.out.println("✅ 已摄入 " + chunks.size() + " 个文档块");
    }
}
```

然后暴露一个 REST 接口来触发摄入：

```java
package com.example.rag.controller;

import com.example.rag.service.IngestionService;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class IngestController {

    private final IngestionService ingestionService;

    public IngestController(IngestionService ingestionService) {
        this.ingestionService = ingestionService;
    }

    /**
     * 摄入文档到向量库。
     * 用法：POST /ingest?filePath=classpath:my-doc.pdf
     *       POST /ingest?filePath=file:///tmp/report.pdf
     */
    @PostMapping("/ingest")
    public String ingest(@RequestParam String filePath) {
        Resource resource;
        if (filePath.startsWith("classpath:")) {
            resource = new ClassPathResource(filePath.substring("classpath:".length()));
        } else if (filePath.startsWith("file:")) {
            resource = new org.springframework.core.io.UrlResource(filePath);
        } else {
            resource = new ClassPathResource(filePath);
        }
        ingestionService.ingest(resource);
        return "✅ 摄入完成";
    }
}
```

**验证方法**：

```bash
# 1. 启动应用
mvn -q -DskipTests package && java -jar target/spring-ai-rag-demo-0.0.1-SNAPSHOT.jar

# 2. 在 src/main/resources/ 下放一个 PDF 文件（比如项目 README 导出的 PDF）

# 3. 调用摄入接口
curl -X POST 'http://127.0.0.1:8080/ingest?filePath=classpath:test-doc.pdf'

# 预期返回：✅ 摄入完成，控制台打印块数
```

> 注意：SimpleVectorStore 是纯内存实现，应用重启后数据丢失。生产环境应替换为 PgVectorStore、MilvusVectorStore 或 ElasticsearchVectorStore，只需改依赖和配置，IngestionService 代码不用变——这就是 Spring AI 抽象层的价值。

<h1 id="第三步：检索与问答"><a href="#第三步：检索与问答" class="headerlink" title="第三步：检索与问答"></a>第三步：检索与问答</h1>

核心部分来了：用 `ChatClient` + `QuestionAnswerAdvisor` 实现"检索 + 回答"一体化。

```java
package com.example.rag.controller;

import com.example.rag.service.IngestionService;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.ai.chat.client.advisor.QuestionAnswerAdvisor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
public class RagController {

    private final ChatClient chatClient;

    public RagController(ChatClient.Builder chatClientBuilder, VectorStore vectorStore) {
        // QuestionAnswerAdvisor 自动完成：
        // 1. 把用户问题转成 Embedding 向量
        // 2. 去 VectorStore 做相似度检索（默认 top-k=4）
        // 3. 把检索到的文档片段拼装到 system prompt 里
        // 4. 把带上下文的问题发给 LLM
        this.chatClient = chatClientBuilder
                .defaultAdvisors(new QuestionAnswerAdvisor(vectorStore))
                .build();
    }

    /**
     * RAG 问答接口。
     */
    @GetMapping("/rag/ask")
    public Map<String, Object> ask(@RequestParam String question) {
        String answer = chatClient.prompt()
                .user(question)
                .call()
                .content();

        return Map.of(
                "question", question,
                "answer", answer
        );
    }
}
```

**验证方法**：

```bash
# 先确保已完成文档摄入（上一步的 /ingest 接口）

# 然后针对文档内容提问：
curl 'http://127.0.0.1:8080/rag/ask?question=这个项目的主要功能是什么？'

# 返回示例：
# {"question":"这个项目的主要功能是什么？","answer":"根据文档内容，该项目主要功能是..."}

# 再问一个文档中没有的问题，看看模型是否会"编造"：
curl 'http://127.0.0.1:8080/rag/ask?question=文档中提到了哪些性能优化建议？'
```

验证 checklist：

- [ ] 回答内容是否来自文档（而不是模型瞎编）
- [ ] 对文档中明确提到的事实性问题，回答是否准确
- [ ] 如果问文档之外的问题，回答是否合理地表示"文档中没有相关信息"
- [ ] 响应时间是否可接受（通常应在 3~10 秒内，取决于 Embedding + LLM 延迟）

<h1 id="第四步：调参——让检索质量更高"><a href="#第四步：调参——让检索质量更高" class="headerlink" title="第四步：调参——让检索质量更高"></a>第四步：调参——让检索质量更高</h1>

RAG 不是配好就能用的，检索质量直接影响回答质量。这里有三个最关键的调节旋钮。

<h2 id="旋钮一：Top-K（检索几条）"><a href="#旋钮一：Top-K（检索几条）" class="headerlink" title="旋钮一：Top-K（检索几条）"></a>旋钮一：Top-K（检索几条）</h2>

`QuestionAnswerAdvisor` 默认取相似度最高的 4 条文档。你可以通过 `SearchRequest` 自定义：

```java
new QuestionAnswerAdvisor(vectorStore, SearchRequest.defaults()
        .withTopK(10)              // 检索前 10 条
        .withSimilarityThreshold(0.3)  // 相似度阈值，低于此值的结果不要
);
```

**Top-K 权衡**：

| Top-K | 优点 | 缺点 |
| --- | --- | --- |
| 太小（1~2） | Token 消耗少、响应快 | 可能漏掉关键信息 |
| 太大（15+） | 信息覆盖全 | 引入噪声、token 消耗大、可能混淆 LLM |
| 推荐 4~8 | 大多数场景的平衡点 | 需要根据实际文档测试调整 |

<h2 id="旋钮二：相似度阈值"><a href="#旋钮二：相似度阈值" class="headerlink" title="旋钮二：相似度阈值"></a>旋钮二：相似度阈值</h2>

`similarityThreshold` 过滤掉相关性太低的检索结果。默认值因 VectorStore 实现而异，一般 0.0~0.5 之间需要根据实验调整。

- 设太高（如 0.8）：很多合理匹配被过滤掉，导致 LLM 收到的上下文不足，回答"我不知道"
- 设太低（如 0.0）：噪声进入 prompt，干扰 LLM 判断

建议从 0.2~0.3 开始，逐步调高直到检索召回率明显下降为止。

<h2 id="旋钮三：Chunk-大小与重叠"><a href="#旋钮三：Chunk-大小与重叠" class="headerlink" title="旋钮三：Chunk 大小与重叠"></a>旋钮三：Chunk 大小与重叠</h2>

```java
// 自定义分块策略
new TokenTextSplitter(
    500,   // defaultChunkSize：每块最大 token 数（越小越精准但碎片化）
    100,   // minChunkSize：最小 token 数，低于此值的块会被合并或丢弃
    20,    // numTokensOverlap：相邻块重叠 token 数（保留跨块上下文）
    5000,  // keepSeparator：最大分隔符保留长度
    true   // padTextIfNoSeparator：无分隔符时是否强制切分
);
```

**Chunk 大小的经验法则**：

| 场景 | 建议 chunkSize | 原因 |
| --- | --- | --- |
| FAQ / 问答对 | 200~400 | 每块就是一个完整问答 |
| 技术文档 / API 说明 | 500~800 | 一个小节的内容 |
| 法律合同 / 论文 | 800~1200 | 保持段落完整性 |
| 代码仓库文件 | 300~600 | 通常按函数/类切分更合适 |

<h1 id="成本估算：一次-RAG-请求花多少钱"><a href="#成本估算：一次-RAG-请求花多少钱" class="headerlink" title="成本估算：一次 RAG 请求花多少钱"></a>成本估算：一次 RAG 请求花多少钱</h1>

以 OpenAI API 价格为例（2026 年参考价，实际以官方为准）：

| 环节 | 模型 | 单次请求消耗（估） | 单价 | 单次成本 |
| --- | --- | --- | --- | --- |
| Embedding | text-embedding-3-small | ~0.5k input tokens | $0.02/1M tokens | ~$0.00001 |
| LLM 生成 | gpt-4o-mini | ~1k input (含文档) + ~200 output | $0.15/1M in, $0.6/1M out | ~$0.00027 |
| **合计** | | | | **~$0.00028/次** |

也就是说，**每千次 RAG 问答大约 $0.28**（约 2 元人民币）。对于内部工具、客服辅助等场景，成本非常可控。

如果想进一步降低成本，可以考虑：

- Embedding 模型换用本地部署的开源模型（如 BGE-M3，通过 Ollama 本地运行）
- LLM 换用更便宜的模型（gpt-4o-mini 已经是性价比很高的选择）
- 对高频问题加缓存（相同或相似问题直接返回缓存答案，不走 LLM）

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="坑一：文档格式乱码或元数据丢失"><a href="#坑一：文档格式乱码或元数据丢失" class="headerlink" title="坑一：文档格式乱码或元数据丢失"></a>坑一：文档格式乱码或元数据丢失</h2>

PDF 读取器对扫描件（图片型 PDF）、加密 PDF、复杂排版的支持有限。如果 `PdfReader` 读出来的内容是空或乱码，可以尝试：

- 用 Apache Tika（Spring AI 也支持 `TikaDocumentReader`）作为备选读取器
- 对扫描件先用 OCR 处理
- 检查 PDF 是否有权限密码保护

<h2 id="坑二：检索到了但回答还是错的"><a href="#坑二：检索到了但回答还是错的" class="headerlink" title="坑二：检索到了但回答还是错的"></a>坑二：检索到了但回答还是错的</h2>

这是 RAG 最经典的问题。可能原因和排查思路：

1. **Top-K 太小，相关内容没送进去** → 加大 Top-K，检查相似度分数
2. **Chunk 切割把一个完整信息切散了** → 调整 chunkSize 和 overlap
3. **Prompt 里没有明确告诉 LLM"只基于给定文档回答"** → 在 system prompt 中加强约束
4. **Embedding 模型和语言不匹配**（比如中文文档用了英文优先的 Embedding 模型）→ 换用多语言或中文专用 Embedding

调试技巧：把检索到的原始文档片段打印出来人工审核，看是不是真的包含了正确答案。

<h2 id="坑三：SimpleVectorStore-不能用于生产"><a href="#坑三：SimpleVectorStore-不能用于生产" class="headerlink" title="坑三：SimpleVectorStore 不能用于生产"></a>坑三：SimpleVectorStore 不能用于生产</h2>

再次强调：`SimpleVectorStore` 数据在内存里，重启即失。生产环境至少要从以下选一个：

| 方案 | 特点 | 适用场景 |
| --- | --- | --- |
| **PgVectorStore** | 基于 PostgreSQL 扩展，运维友好 | 已有 PG 实例的团队 |
| **MilvusVectorStore** | 专用向量数据库，大规模高性能 | 亿级向量、需要毫秒级检索 |
| **ElasticsearchVectorStore** | ES 8.x+ 原生向量支持 | 已有 ES 日志/搜索栈 |
| **RedisVectorStore** | Redis Stack 的向量能力 | 低延迟、缓存+向量一体 |

切换方式通常是：换依赖 + 改配置 + 几行代码，Spring AI 的 `VectorStore` 接口屏蔽了底层差异。

<h2 id="坑四：忽略摄入耗时和增量更新"><a href="#坑四：忽略摄入耗时和增量更新" class="headerlink" title="坑四：忽略摄入耗时和增量更新"></a>坑四：忽略摄入耗时和增量更新</h2>

一个大 PDF（比如 100 页技术手册），Embedding 调用 + 写入可能要几十秒到几分钟。生产系统需要考虑：

- **异步摄入**：上传文档后放入队列，后台完成 ETL，完成后通知用户
- **增量更新**：只处理新增/修改的文档，而不是每次全量重建
- **摄入进度追踪**：记录哪些文档已摄入、何时更新、块数多少

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

本文从零搭了一个基于 Spring AI 的 RAG 应用，核心流程就四步：

1. **文档加载与分块**：`PdfReader` + `TokenTextSplitter`，把长文档切成语义块
2. **Embedding + 存储**：`VectorStore.add()` 一行搞定，自动调 Embedding 模型并持久化
3. **检索 + 问答**：`QuestionAnswerAdvisor` + `ChatClient`，自动完成"问题→向量→检索→拼 prompt→LLM 回答"
4. **调优**：Top-K、相似度阈值、Chunk 大小三个旋钮，决定检索质量和成本平衡

Spring AI 最大的价值在于**抽象层**：切换 LLM 提供商、换向量数据库、换 Embedding 模型，大多只需要改依赖和配置，核心业务代码不动。这对于需要多环境部署（开发用 SimpleVectorStore、生产用 Milvus）的团队尤其重要。

下一步可以探索的方向：

- 接入更多文档格式（Markdown、HTML、Word、Excel）
- 加入引用来源（告诉用户"答案来自文档第 X 页"）
- 对话记忆（多轮对话中保持上下文）
- 用 `AnnotationUtils` 给检索结果打分排序
- 接入 Spring AI 的 Agent 能力，让模型自主决定是否需要检索

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

1. Spring AI 官方 Reference Documentation：<https://docs.spring.io/spring-ai/reference/>
2. Spring AI GitHub（源码与示例）：<https://github.com/spring-projects/spring-ai>
3. OpenAI Embeddings API 文档：<https://platform.openai.com/docs/guides/embeddings>
4. LangChain Blog - Introduction to RAG：<https://www.langchain.com/resources/articles/what-is-retrieval-augmented-generation-rag>
5. NLP 领域经典论文：Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks (Lewis et al., 2020)：https://arxiv.org/abs/2005.11401
6. PgVector 官方文档（PostgreSQL 向量扩展）：https://pgvector.github.io/
7. BAAI/bge-m3 嵌入模型（多语言/中文推荐）：https://huggingface.co/BAAI/bge-m3
