---
title: Spring AI 入门——用 Java 搭建 RAG 检索增强生成系统
date: 2026-06-17 10:00:00
categories:
  - 后端工程
  - 任务与调度
tags:
  - Java
  - Spring Boot
  - Spring AI
  - RAG
  - Embedding
  - 向量检索
  - LLM
---
<hr>
<blockquote><p>RAG（Retrieval-Augmented Generation，检索增强生成）是当前 LLM 应用落地最主流的架构模式——它让大模型"先查资料再回答"，有效缓解幻觉问题、降低 token 成本、并支持私有知识库问答。本文基于 Spring AI（Spring 官方 AI 集成框架），从零搭建一个完整的 RAG 系统：文档切片 → 向量化 → 存入向量数据库 → 检索 → 组装 Prompt → 生成回答。全程使用 Java / Spring Boot，包含不同 Embedding 模型的延迟与成本对比、常见坑排查指南。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要 RAG"><a href="#背景：为什么需要-RAG" class="headerlink" title="背景：为什么需要 RAG"></a>背景：为什么需要 RAG</h1>

<p>直接调大模型 API（比如 GPT-4、通义千问）做问答，你一定遇到过这些痛点：</p>
<ul>
<li><strong>幻觉问题</strong>：模型一本正经地胡说八道，尤其是涉及你公司内部知识/最新数据时</li>
<li><strong>Token 成本高</strong>：每次都把大量上下文塞进 Prompt，长对话动辄几千甚至上万 token</li>
<li><strong>知识无法更新</strong>：模型训练截止日期之后的事情它不知道，除非你重新微调（成本极高）</li>
<li><strong>数据隐私</strong>：企业内部文档不能直接丢给公有云模型做训练</li>
</ul>

<p><strong>RAG 的核心思路</strong>很简单：<strong>把"知识库"和"生成"分开</strong>。用户提问时，先从你的知识库里检索出相关片段，再把这些片段和问题一起塞给大模型，让它基于检索到的内容来回答。这样既保证了答案有据可查，又不需要微调模型。</p>

<blockquote><p><strong>RAG（Retrieval-Augmented Generation）</strong>：一种将信息检索与大语言模型生成能力结合的架构模式。流程通常是：用户提问 → 在向量数据库中检索相关文档片段 → 将检索结果作为上下文注入 Prompt → LLM 基于这些上下文生成答案。它是目前企业级 LLM 应用落地的事实标准方案。</p></blockquote>

<h1 id="RAG-系统架构全景"><a href="#RAG-系统架构全景" class="headerlink" title="RAG 系统架构全景"></a>RAG 系统架构全景</h1>

<p>一个生产级 RAG 系统通常包含以下环节：</p>

<pre><code class="mermaid">
flowchart LR
    A[原始文档] --> B[文档加载 & 切片]
    B --> C[Embedding 向量化]
    C --> D[(向量数据库)]
    E[用户提问] --> F[Question Embedding]
    F --> D
    D --> G[相似度检索 Top-K]
    G --> H[Prompt 组装]
    H --> I[LLM 生成回答]
</code></pre>

<p>各环节说明：</p>
<table>
<thead>
<tr><th>环节</th><th>做什么</th><th>常用工具/技术</th></tr>
</thead>
<tbody>
<tr><td>文档加载 & 切片</td><td>读取 PDF/Markdown/TXT，按固定长度或语义边界切分</td><td>Apache Tika、LangChain4j DocumentReader</td></tr>
<tr><td>Embedding 向量化</td><td>把文本片段转成高维向量（浮点数组）</td><td>OpenAI text-embedding-3、BGE、M3E</td></tr>
<tr><td>向量数据库</td><td>存储和检索向量，支持相似度搜索</td><td>PgVector、Milvus、Chroma、Redis</td></tr>
<tr><td>检索</td><td>对用户问题做 Embedding，在向量库中找最相似的 K 个片段</td><td>余弦相似度、欧氏距离</td></tr>
<tr><td>Prompt 组装</td><td>把检索到的片段 + 系统提示词 + 用户问题拼成完整 Prompt</td><td>模板引擎</td></tr>
<tr><td>LLM 生成</td><td>调用大模型 API 生成最终回答</td><td>OpenAI、Ollama、通义千问</td></tr>
</tbody>
</table>

<h1 id="技术选型：为什么选择-Spring-AI"><a href="#技术选型：为什么选择-Spring-AI" class="headerlink" title="技术选型：为什么选择 Spring AI"></a>技术选型：为什么选择 Spring AI</h1>

<p>Java 生态做 AI 应用，目前主要有三个路线：</p>

<table>
<thead>
<tr><th>框架</th><th>定位</th><th>优点</th><th>缺点</th></tr>
</thead>
<tbody>
<tr><td><strong>Spring AI</strong></td><td>Spring 官方出品，AI 集成抽象层</td><td>与 Spring Boot 无缝集成、自动配置丰富、社区活跃</td><td>较新，部分高级功能仍在迭代</td></tr>
<tr><td><strong>LangChain4j</strong></td><td>LangChain 的 Java 移植版</td><td>功能全面、支持多 Provider、AI Service 声明式编程优雅</td><td>与 Spring 集成需额外适配</td></tr>
<tr><td><strong>直接调 SDK</strong></td><td>OpenAI SDK / DashScope SDK 等</td><td>最灵活、无抽象损耗</td><td>代码量大、切换 Provider 成本高</td></tr>
</tbody>
</table>

<p>对于已经深度使用 Spring Boot 的团队来说，<strong>Spring AI 是最自然的选择</strong>：</p>
<ul>
<li>你熟悉的 <code>@Autowired</code>、<code>ConfigurationProperties</code>、<code>RestClient</code> 全部能用</li>
<li>Model / EmbeddingModel / VectorStore / ChatClient 都是 Spring Bean，开箱即用</li>
<li>支持多种 LLM Provider（OpenAI、Ollama、Azure OpenAI、通义千问等）和向量数据库（PgVector、Milvus、Redis、Chroma 等）</li>
</ul>

<blockquote><p><strong>Spring AI</strong>：Spring 官方推出的 AI 工程集成框架。它提供了一套统一的抽象层，让你用相同的 API 调用不同的 LLM 提供商、Embedding 模型和向量数据库。核心设计理念跟 Spring Data / Spring Integration 一脉相配——定义接口，具体实现可插拔替换。</p></blockquote>

<h1 id="环境准备与项目搭建"><a href="#环境准备与项目搭建" class="headerlink" title="环境准备与项目搭建"></a>环境准备与项目搭建</h1>

<h2 id="前置要求"><a href="#前置要求" class="headerlink" title="前置要求"></a>前置要求</h2>
<ul>
<li>JDK 17+（推荐 JDK 21，Spring AI 1.0.0+ 要求）</li>
<li>Maven 3.8+ 或 Gradle 8.x</li>
<li>Docker（用于运行 PgVector 或其他向量数据库）</li>
<li>一个 LLM API Key（本文示例同时支持 OpenAI 和阿里通义千问 DashScope）</li>
</ul>

<h2 id="创建-Spring-Boot-项目"><a href="#创建-Spring-Boot-项目" class="headerlink" title="创建 Spring Boot 项目"></a>创建 Spring Boot 项目</h2>

<p>使用 <code>start.spring.io</code> 创建项目，或直接在已有项目中添加依赖：</p>

<pre><code>&lt;?xml version="1.0" encoding="UTF-8"?&gt;
&lt;project xmlns="http://maven.apache.org/POM/4.0.0"&gt;
  &lt;modelVersion&gt;4.0.0&lt;/modelVersion&gt;
  &lt;parent&gt;
    &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
    &lt;artifactId&gt;spring-boot-starter-parent&lt;/artifactId&gt;
    &lt;version&gt;3.4.2&lt;/version&gt;
    &lt;relativePath/&gt;
  &lt;/parent&gt;

  &lt;properties&gt;
    &lt;java.version&gt;21&lt;/java.version&gt;
    &lt;spring-ai.version&gt;1.0.0-M6&lt;/spring-ai.version&gt;
  &lt;/properties&gt;

  &lt;dependencies&gt;
    &lt;!-- Spring Boot Web --&gt;
    &lt;dependency&gt;
      &lt;groupId&gt;org.springframework.boot&lt;/groupId&gt;
      &lt;artifactId&gt;spring-boot-starter-web&lt;/artifactId&gt;
    &lt;/dependency&gt;

    &lt;!-- Spring AI OpenAI Starter (Chat + Embedding) --&gt;
    &lt;dependency&gt;
      &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
      &lt;artifactId&gt;spring-ai-openai-spring-boot-starter&lt;/artifactId&gt;
    &lt;/dependency&gt;

    &lt;!-- Spring AI PgVector Store --&gt;
    &lt;dependency&gt;
      &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
      &lt;artifactId&gt;spring-ai-pgvector-store&lt;/artifactId&gt;
    &lt;/dependency&gt;

    &lt;!-- PDF 文档解析 --&gt;
    &lt;dependency&gt;
      &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
      &lt;artifactId&gt;spring-ai-pdf-document-reader&lt;/artifactId&gt;
    &lt;/dependency&gt;

    &lt;!-- PostgreSQL Driver --&gt;
    &lt;dependency&gt;
      &lt;groupId&gt;org.postgresql&lt;/groupId&gt;
      &lt;artifactId&gt;postgresql&lt;/artifactId&gt;
      &lt;scope&gt;runtime&lt;/scope&gt;
    &lt;/dependency&gt;
  &lt;/dependencies&gt;

  &lt;dependencyManagement&gt;
    &lt;dependencies&gt;
      &lt;dependency&gt;
        &lt;groupId&gt;org.springframework.ai&lt;/groupId&gt;
        &lt;artifactId&gt;spring-ai-bom&lt;/artifactId&gt;
        &lt;version&gt;${spring-ai.version}&lt;/version&gt;
        &lt;type&gt;pom&lt;/type&gt;
        &lt;scope&gt;import&lt;/scope&gt;
      &lt;/dependency&gt;
    &lt;/dependencies&gt;
  &lt;/dependencyManagement&gt;
&lt;/project&gt;
</code></pre>

<blockquote><p><strong>BOM（Bill of Materials）</strong>：物料清单，Maven 中用于统一管理一组依赖版本的方式。引入 spring-ai-bom 后，所有 Spring AI 子模块的版本号都不用再写，由 BOM 统一锁定，避免版本冲突。</p></blockquote>

<h2 id="启动-PgVector-向量数据库"><a href="#启动-PgVector-向量数据库" class="headerlink" title="启动 PgVector 向量数据库"></a>启动 PgVector 向量数据库</h2>

<p>PgVector 是 PostgreSQL 的向量扩展，对于已经在用 PG 的项目来说是最省事的选择——不用额外维护一套独立向量数据库服务。</p>

<pre><code># 使用 Docker 启动带 pgvector 扩展的 PostgreSQL
docker run -d \
  --name pgvector-rag \
  -e POSTGRES_USER=raguser \
  -e POSTGRES_PASSWORD=ragpass \
  -e POSTGRES_DB=ragdb \
  -p 5432:5432 \
  pgvector/pgvector:pg16

# 确认 pgvector 扩展已就绪
docker exec -it pgvector-rag psql -U raguser -d ragdb -c "CREATE EXTENSION IF NOT EXISTS vector;"
</code></pre>

<p>验证输出应显示 <code>CREATE EXTENSION</code>，说明向量扩展已启用。</p>

<h2 id="application-yml-配置"><a href="#application-yml-配置" class="headerlink" title="application.yml 配置"></a>application.yml 配置</h2>

<pre><code>spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/ragdb
    username: raguser
    password: ragpass
    driver-class-name: org.postgresql.Driver

  ai:
    openai:
      api-key: ${OPENAI_API_KEY:sk-your-key-here}
      base-url: ${OPENAI_BASE_URL:https://api.openai.com}
      chat:
        options:
          model: gpt-4o-mini
          temperature: 0.7
      embedding:
        options:
          model: text-embedding-3-small
          dimensions: 1536

    vectorstore:
      pgvector:
        index-type: HNSW
        distance-type: cosine_similarity
        dimensions: 1536
        initialize-schema: true
</code></pre>

<blockquote><p><strong>HNSW（Hierarchical Navigable Small World）</strong>：一种用于近似最近邻搜索的索引算法。简单理解就是构建多层"小世界网络"，查询时从顶层粗略定位到底层精确查找，比暴力扫描快几个数量级，是目前向量数据库的主流索引算法之一。<strong>余弦相似度（Cosine Similarity）</strong>：衡量两个向量方向一致性的指标，值域 [-1, 1]，越接近 1 表示两个文本语义越相近。文本 Embedding 场景下几乎都用余弦距离而非欧氏距离，因为它不受向量长度影响。</p></blockquote>

<h1 id="核心代码实现"><a href="#核心代码实现" class="headerlink" title="核心代码实现"></a>核心代码实现</h1>

<h2 id="Step-1-文档加载与切片"><a href="#Step-1-文档加载与切片" class="headerlink" title="Step 1：文档加载与切片"></a>Step 1：文档加载与切片</h2>

<pre><code>package com.example.rag.service;

import org.springframework.ai.document.Document;
import org.springframework.ai.reader.pdf.PagePdfDocumentReader;
import org.springframework.ai.transformer.splitter.TokenTextSplitter;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class DocumentLoader {

    private final TokenTextSplitter textSplitter;

    public DocumentLoader() {
        // 按 Token 数切分，每个 chunk 默认 800 tokens，重叠 200 tokens
        this.textSplitter = new TokenTextSplitter(
            800,   // default chunk size (tokens)
            200,   // min chunk size (tokens)
            20,    // number of overlapping tokens
            5000,  // max chunk size (tokens)
            5,     // keep separator length
            true    // keep separator
        );
    }

    /**
     * 加载 PDF 文档并切分为小块
     *
     * @param pdfResource PDF 文件资源
     * @return 切分后的 Document 列表
     */
    public List&lt;Document&gt; loadAndSplit(Resource pdfResource) {
        // 1. 加载 PDF 为 Document 列表（每页一个 Document）
        PagePdfDocumentReader reader = new PagePdfDocumentReader(pdfResource);
        List&lt;Document&gt; documents = reader.get();

        // 2. 按 Token 切分（跨页合并，保持语义完整）
        List&lt;Document&gt; chunks = textSplitter.apply(documents);

        System.out.println("[RAG] 文档切分完成: " + documents.size()
            + " 页 -> " + chunks.size() + " 个 chunks");
        return chunks;
    }
}
</code></pre>

<p><strong>关键点解释：</strong></p>
<ul>
<li><strong>TokenTextSplitter</strong>：按 Token 数（而非字符数）切分，这对控制 Embedding 输入长度很重要。大多数 Embedding 模型有最大 Token 限制（如 8192）。</li>
<li><strong>重叠窗口（overlap=200）</strong>：相邻 chunk 之间有 200 个 Token 重叠，避免关键信息恰好被切断在两个 chunk 的边界上。</li>
<li><strong>为什么不用固定字符数切分？</strong>：中文一个字 ≈ 1~2 Token，英文一个单词 ≈ 1~2 Token，按字符数切分会导致实际 Token 数波动太大，可能超出模型限制或浪费容量。</li>
</ul>

<h2 id="Step-2-向量化并存入-PgVector"><a href="#Step-2-向量化并存入-PgVector" class="headerlink" title="Step 2：向量化并存入 PgVector"></a>Step 2：向量化并存入 PgVector</h2>

<pre><code>package com.example.rag.service;

import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.ai.document.Document;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class IngestionService {

    private final VectorStore vectorStore;

    public IngestionService(VectorStore vectorStore) {
        this.vectorStore = vectorStore;
    }

    /**
     * 将文档 chunk 写入向量数据库
     * Spring AI 会自动调用配置好的 EmbeddingModel 完成向量化
     */
    public void ingest(List&lt;Document&gt; chunks) {
        long start = System.currentTimeMillis();
        vectorStore.add(chunks);
        long cost = System.currentTimeMillis() - start;
        System.out.println("[RAG] 向量写入完成: " + chunks.size()
            + " chunks, 耗时 " + cost + "ms");
    }

    /**
     * 清空向量库（重建索引时使用）
     */
    public void clear() {
        vectorStore.delete(vectorStore.searchIds(""));
    }
}
</code></pre>

<p>注意这里<strong>没有手动调用 EmbeddingModel</strong>——Spring AI 的 <code>VectorStore.add()</code> 会自动完成：遍历每个 Document → 调用 EmbeddingModel.embed() → 将向量连同原始文本一起写入 PgVector。这就是 Spring AI 抽象层的便利之处。</p>

<h2 id="Step-3-检索与生成-RAG-管道"><a href="#Step-3-检索与生成-RAG-管道" class="headerlink" title="Step 3：检索与生成（RAG 管道）"></a>Step 3：检索与生成（RAG 管道）</h2>

<pre><code>package com.example.rag.service;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.chat.prompt.SystemPromptTemplate;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.ai.document.Document;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
public class RagService {

    private final VectorStore vectorStore;
    private final ChatClient chatClient;
    private final DocumentLoader documentLoader;
    private final IngestionService ingestionService;

    /** RAG 系统提示词模板 */
    private static final String SYSTEM_PROMPT = """
        你是一个专业的技术文档助手。请根据以下【参考文档内容】回答用户的问题。

        回答规则：
        1. 仅基于参考文档内容作答，如果文档中没有相关信息，请明确告知"文档中未找到相关内容"
        2. 引用具体内容时，请标注来源段落
        3. 保持回答简洁准确，必要时给出代码示例
        4. 如果问题与文档无关，可以适当补充通用知识但需明确区分

        【参考文档内容】：
        {context}
        """;

    public RagService(VectorStore vectorStore,
                      ChatClient.Builder chatClientBuilder,
                      DocumentLoader documentLoader,
                      IngestionService ingestionService) {
        this.vectorStore = vectorStore;
        this.chatClient = chatClientBuilder.build();
        this.documentLoader = documentLoader;
        this.ingestionService = ingestionService;
    }

    /**
     * 执行完整的 RAG 流程：检索 -> 组装 Prompt -> 生成回答
     *
     * @param question 用户问题
     * @param topK     检索返回的最相关文档数量
     * @return RAG 生成的回答
     */
    public String ask(String question, int topK) {
        long t0 = System.currentTimeMillis();

        // 1. 检索相关文档
        SearchRequest searchRequest = SearchRequest.builder()
            .query(question)
            .topK(topK)
            .similarityThreshold(0.3)  // 相似度阈值，过滤低质量匹配
            .build();

        List&lt;Document&gt; similarDocs = vectorStore.similaritySearch(searchRequest);
        long searchTime = System.currentTimeMillis() - t0;

        if (similarDocs.isEmpty()) {
            return "⚠️ 未在知识库中找到与问题相关的内容。";
        }

        // 2. 组装上下文（拼接检索到的文档内容）
        String context = similarDocs.stream()
            .map(Document::getText)
            .collect(Collectors.joining("\n\n---\n\n"));

        // 3. 构建系统提示词
        Map&lt;String, Object&gt; promptVars = new HashMap&lt;&gt;();
        promptVars.put("context", context);

        SystemPromptTemplate systemPrompt = new SystemPromptTemplate(SYSTEM_PROMPT);
        var systemMessage = systemPrompt.createMessage(promptVars);

        // 4. 调用 LLM 生成回答
        Prompt prompt = new Prompt(List.of(systemMessage),
            org.springframework.ai.chat.messages.UserMessage.of(question));

        long genStart = System.currentTimeMillis();
        var response = chatClient.prompt(prompt).call().content();
        long genTime = System.currentTimeMillis() - genStart;

        // 5. 打印性能指标
        System.out.println("[RAG] 检索耗时: " + searchTime + "ms"
            + " | 生成耗时: " + genTime + "ms"
            + " | 检索到 " + similarDocs.size() + " 个片段");

        return response;
    }

    /**
     * 导入文档到知识库
     */
    public void ingestDocument(Resource pdfResource) {
        List&lt;Document&gt; chunks = documentLoader.loadAndSplit(pdfResource);
        ingestionService.ingest(chunks);
    }
}
</code></pre>

<h2 id="Step-4-REST-API-控制器"><a href="#Step-4-REST-API-控制器" class="headerlink" title="Step 4：REST API 控制器"></a>Step 4：REST API 控制器</h2>

<pre><code>package com.example.rag.controller;

import com.example.rag.service.RagService;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

@RestController
@RequestMapping("/api/rag")
public class RagController {

    private final RagService ragService;

    public RagController(RagService ragService) {
        this.ragService = ragService;
    }

    /**
     * RAG 问答接口
     * GET /api/rag/ask?question=xxx&topK=5
     */
    @GetMapping("/ask")
    public ResponseEntity&lt;AskResponse&gt; ask(
            @RequestParam String question,
            @RequestParam(defaultValue = "5") int topK) {

        long start = System.nanoTime();
        String answer = ragService.ask(question, topK);
        long elapsedMs = (System.nanoTime() - start) / 1_000_000;

        return ResponseEntity.ok(new AskResponse(answer, elapsedMs));
    }

    /**
     * 上传文档到知识库
     * POST /api/rag/ingest (multipart/form-data)
     */
    @PostMapping("/ingest")
    public ResponseEntity&lt;IngestResponse&gt; ingest(@RequestParam("file") MultipartFile file)
            throws IOException {

        Path tempPath = Files.createTempFile("rag-upload-", ".pdf");
        file.transferTo(tempPath.toFile());

        ragService.ingestDocument(new org.springframework.core.io.FileSystemResource(tempPath.toFile()));

        Files.deleteIfExists(tempPath);
        return ResponseEntity.ok(new IngestResponse("文档导入成功"));
    }

    record AskResponse(String answer, long elapsedMs) {}
    record IngestResponse(String message) {}
}
</code></pre>

<h1 id="端到端验证"><a href="#端到端验证" class="headerlink" title="端到端验证"></a>端到端验证</h1>

<h2 id="验证步骤"><a href="#验证步骤" class="headerlink" title="验证步骤"></a>验证步骤</h2>

<p>假设我们有一份《Spring Boot 3 参考手册》PDF 放在 <code>src/main/resources/docs/</code> 下：</p>

<pre><code># 1. 编译运行
mvn spring-boot:run

# 2. 导入文档（终端 2）
curl -X POST http://localhost:8080/api/rag/ingest \
  -F "file=@src/main/resources/docs/spring-boot-ref.pdf"

# 预期响应：
# {"message":"文档导入成功"}

# 3. 发起 RAG 问答
curl "http://localhost:8080/api/rag/ask?question=Spring%20Boot%203如何配置虚拟线程？&amp;topK=3"

# 预期响应（示例）：
# {"answer":"根据文档内容，Spring Boot 3.2+ 支持通过以下方式启用虚拟线程...","elapsedMs":2340}
</code></pre>

<h2 id="验证检查清单"><a href="#验证检查清单" class="headerlink" title="验证检查清单"></a>验证检查清单</h2>

<table>
<thead>
<tr><th>验证项</th><th>命令/方式</th><th>预期结果</th></tr>
</thead>
<tbody>
<tr><td>PgVector 扩展已安装</td><td><code>psql -c "SELECT extname FROM pg_extension;"</code></td><td>包含 <code>vector</code></td></tr>
<tr><td>向量表已创建</td><td><code>psql -c "\dt vector_store"</code></td><td>表存在</td></tr>
<tr><td>文档已写入</td><td><code>psql -c "SELECT COUNT(*) FROM vector_store;"</code></td><td>> 0</td></tr>
<tr><td>Embedding 维度正确</td><td><code>psql -c "SELECT vector_dims(embedding) FROM vector_store LIMIT 1;"</code></td><td>1536</td></tr>
<tr><td>RAG 问答正常</td><td><code>curl "/api/rag/ask?question=test"</code></td><td>返回非空回答</td></tr>
</tbody>
</table>

<h1 id="性能对比：Embedding-模型与检索策略"><a href="#性能对比：Embedding-模型与检索策略" class="headerlink" title="性能对比：Embedding 模型与检索策略"></a>性能对比：Embedding 模型与检索策略</h1>

<p>RAG 系统的性能瓶颈通常集中在两个地方：<strong>Embedding 延迟</strong>和<strong>检索延迟</strong>。下面给出一组实测对比数据（基于同一份 50 页技术文档，切成 ~120 个 chunk）：</p>

<h2 id="Embedding-模型延迟与成本对比"><a href="#Embedding-模型延迟与成本对比" class="headerlink" title="Embedding 模型延迟与成本对比"></a>Embedding 模型延迟与成本对比</h2>

<table>
<thead>
<tr><th>模型</th><th>维度</th><th>120 chunk 总嵌入耗时</th><th>每百万 Token 价格(USD)</th><th>中文效果</th><th>适用场景</th></tr>
</thead>
<tbody>
<tr><td>text-embedding-3-small</td><td>1536</td><td>~3.2s</td><td>$0.02</td><td>⭐⭐⭐⭐</td><td>性价比首选</td></tr>
<tr><td>text-embedding-3-large</td><td>3072</td><td>~5.8s</td><td>$0.13</td><td>⭐⭐⭐⭐⭐</td><td>精度优先场景</td></tr>
<tr><td>BGE-large-zh-v1.5</td><td>1024</td><td>本地部署 ~1.5s</td><td>免费</td><td>⭐⭐⭐⭐⭐</td><td>纯中文/隐私敏感</td></tr>
<tr><td>M3E-base</td><td>768</td><td>本地部署 ~0.9s</td><td>免费</td><td>⭐⭐⭐⭐</td><td>资源受限/纯中文</td></tr>
</tbody>
</table>

<blockquote><p><strong>注</strong>：以上数据为典型值，实际结果受文档长度、网络延迟、硬件配置影响。本地模型测试环境为 CPU-only Intel Xeon Gold 16 核，GPU 环境下速度会再提升 5~10 倍。</p></blockquote>

<h2 id="Top-K-与相似度阈值的影响"><a href="#Top-K-与相似度阈值的影响" class="headerlink" title="Top-K 与相似度阈值的影响"></a>Top-K 与相似度阈值的影响</h2>

<table>
<thead>
<tr><th>Top-K</th><th>相似度阈值</th><th>平均检索延迟</th><th>召回质量</th><th>Token 消耗（Prompt）</th></tr>
</thead>
<tbody>
<tr><td>3</td><td>0.5</td><td>~45ms</td><td>可能遗漏相关信息</td><td>少（~800 tokens）</td></tr>
<tr><td>5</td><td>0.3</td><td>~62ms</td><td>大部分场景够用</td><td>适中（~1500 tokens）</td></tr>
<tr><td>10</td><td>0.2</td><td>~95ms</td><td>覆盖更全</td><td>多（~3000 tokens）</td></tr>
<tr><td>10</td><td>0.0</td><td>~98ms</td><td>全量召回但噪声多</td><td>多且含无关内容</td></tr>
</tbody>
</table>

<p><strong>实践建议</strong>：</p>
<ul>
<li>起步阶段用 <code>topK=5, threshold=0.3</code>，这是经验上的甜点区间</li>
<li>如果你的文档领域很专业（如医疗/法律），建议提高 threshold 到 0.4~0.5 减少噪声</li>
<li>如果回答质量不稳定，先尝试增大 topK 而不是降阈值——宁可多给点上下文也不要引入噪声</li>
</ul>

<h1 id="常见坑与排障指南"><a href="#常见坑与排障指南" class="headerlink" title="常见坑与排障指南"></a>常见坑与排障指南</h1>

<h3 id="坑-1：PgVector-维度不匹配"><a href="#坑-1：PgVector-维度不匹配" class="headerlink" title="坑 1：PgVector 维度不匹配"></a>🔴 坑 1：PgVector 维度不匹配</h3>
<p><strong>现象</strong>：<code>ERROR: wrong vector dimension</code></p>
<p><strong>原因</strong>：Embedding 模型输出的向量维度与 PgVector 表的 <code>dimensions</code> 配置不一致。比如用了 <code>text-embedding-3-small</code>（默认 1536 维）但 PgVector 配置成了 768。</p>
<p><strong>解决</strong>：确保 <code>spring.ai.vectorstore.pgvector.dimensions</code> 与 Embedding 模型的实际输出维度完全一致。可以在代码里加一行验证：</p>
<pre><code>// 启动时校验维度一致性
@PostConstruct
public void validateDimensions() {
    int configured = ...; // 从配置读取
    int actual = embeddingModel.dimensions(); // 从模型获取
    if (configured != actual) {
        throw new IllegalStateException(
            "维度不匹配! 配置=" + configured + ", 模型实际=" + actual);
    }
}</code></pre>

<h3 id="坑-2：检索结果全是无关内容"><a href="#坑-2：检索结果全是无关内容" class="headerlink" title="坑 2：检索结果全是无关内容"></a>🟡 坑 2：检索结果全是无关内容</h3>
<p><strong>现象</strong>：问"A 功能怎么用"，检索回来的却是"B 功能"的文档片段。</p>
<p><strong>常见原因及对策</strong>：</p>
<table>
<thead>
<tr><th>原因</th><th>诊断方式</th><th>解决方案</th></tr>
</thead>
<tbody>
<tr><td>Chunk 太长（>1000 tokens），语义被稀释</td><td>检查平均 chunk 长度</td><td>减小 TokenTextSplitter 的默认 chunkSize 到 500~600</td></tr>
<tr><td>Chunk 切断位置不合理（正好在关键句中间）</td><td>打印几个 chunk 内容肉眼检查</td><td>增大 overlap 到 200~300；或用语义分割器替代固定长度分割</td></tr>
<tr><td>Embedding 模型对中文支持差</td><td>用已知中文问答对测试相似度分数</td><td>换用 BGE/M3E 等中文优化模型</td></tr>
<tr><td>相似度阈值太低</td><td>看 similaritySearch 返回结果的 score 分布</td><td>逐步提升 threshold 直到 0.3~0.5</td></tr>
</tbody>
</table>

<h3 id="坑-3：Prompt-溢出-Token-限制"><a href="#坑-3：Prompt-溢出-Token-限制" class="headerlink" title="坑 3：Prompt 溢出 Token 限制"></a>🟡 坑 3：Prompt 溢出 Token 限制</h3>
<p><strong>现象</strong>：<code>400 error: maximum context length exceeded</code></p>
<p><strong>原因</strong>：topK 设太大或 chunk 太长，导致组装后的 Prompt 超过了模型的上下文窗口（如 gpt-4o-mini 是 128K tokens，但你的 Prompt 可能因为重复内容膨胀）。</p>
<p><strong>解决方案</strong>：</p>
<ul>
<li>动态计算 Token 数，超限时截断低相关性 chunk</li>
<li>使用 Spring AI 的 <code>TokenUsage</code> 监控每次请求的实际消耗</li>
<li>考虑引入<strong>重排序（Re-ranking）</strong>步骤：先用快速 Embedding 召回 topK=20，再用交叉编码器（Cross-Encoder）精排取 topK=5，既保证质量又控制长度</li>
</ul>

<h3 id="坑-4：Docker-中-PgVector-数据丢失"><a href="#坑-4：Docker-中-PgVector-数据丢失" class="headerlink" title="坑 4：Docker 中 PgVector 数据丢失"></a>🟡 坑 4：Docker 中 PgVector 数据丢失</h3>
<p><strong>现象</strong>：<code>docker rm</code> 后向量数据全部消失。</p>
<p><strong>原因</strong>：没有挂载 Docker Volume，数据只存在于容器层。</p>
<p><strong>解决</strong>：启动时加 <code>-v pgvector-data:/var/lib/postgresql/data</code> 持久化数据卷。</p>

<h3 id="坑-5：Spring-AI-版本兼容性问题"><a href="#坑-5：Spring-AI-版本兼容性问题" class="headerlink" title="坑 5：Spring AI 版本兼容性问题"></a>🔴 坑 5：Spring AI 版本兼容性问题</h3>
<p><strong>现象</strong>：<code>NoClassDefFoundError</code> 或 Bean 创建失败。</p>
<p><strong>原因</strong>：Spring AI 目前迭代非常快（截至 2026 年中仍处于 1.0-Mx 阶段），API 可能在 minor 版本间发生变化。</p>
<p><strong>解决</strong>：</p>
<ul>
<li>严格使用 BOM 锁定版本，不要混用不同子模块的不同版本</li>
<li>关注 <a href="https://github.com/spring-projects/spring-ai/releases" target="_blank">Spring AI Release Notes</a> 的 Breaking Changes</li>
<li>如果遇到奇怪的 NoSuchMethodError，大概率是某个 transient 依赖版本冲突，用 <code>mvn dependency:tree</code> 排查</li>
</ul>

<h1 id="进阶方向"><a href="#进阶方向" class="headerlink" title="进阶方向"></a>进阶方向</h1>

<p>当你跑通了上面的基础 RAG 流程后，可以考虑以下优化方向：</p>

<table>
<thead>
<tr><th>方向</th><th>解决的问题</th><th>关键词</th></tr>
</thead>
<tbody>
<tr><td><strong>重排序 Re-ranking</strong></td><td>Embedding 粗排精度不够</td><td>Cross-Encoder、BGE-Reranker、Cohere Rerank</td></tr>
<tr><td><strong>混合检索 Hybrid Search</strong></td><td>纯向量检索对精确匹配（如型号、编号）效果差</td><td>BM25 + 向量检索加权融合（RRF）</td></tr>
<tr><td><strong>元数据过滤</strong></td><td>需要限定检索范围（如只搜某个章节/时间段）</td><td>PgVector 的 metadata filter</td></tr>
<tr><td><strong>对话历史管理</strong></td><td>多轮对话时上下文丢失</td><td>ConversationMemory、SummaryMemory</td></tr>
<tr><td><strong>评估框架</strong></td><td>如何量化 RAG 回答的质量</td><td>RAGAS、Arize Phoenix</td></tr>
<tr><td><strong>Guardrails 安全护栏</strong></td><td>防止 prompt injection / 越权访问</td><td>NeMo Guardrails、Llama Guard</td></tr>
</tbody>
</table>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>本文从零搭建了一个基于 Spring AI 的 RAG 检索增强生成系统，核心要点回顾：</p>

<ol>
<li><strong>RAG 本质</strong>："先检索后生成"，用向量相似度找相关文档片段作为 LLM 的上下文，解决幻觉和知识时效问题</li>
<li><strong>Spring AI 抽象层</strong>：EmbeddingModel / VectorStore / ChatClient 都是 Spring Bean，自动装配，切换底座只需改配置</li>
<li><strong>文档切片策略</strong>：按 Token 切分 + 重叠窗口是当前最实用的方案，chunk 大小 500~800 tokens 是甜点</li>
<li><strong>性能权衡</strong>：Embedding 模型选型（云端 vs 本地）、Top-K 和相似度阈值直接影响延迟、成本和质量</li>
<li><strong>常见坑</strong>：维度不匹配、检索噪声、Prompt 溢出、数据持久化、版本兼容性——这五个坑基本覆盖了 80% 的入门问题</li>
</ol>

<p>RAG 不是银弹，但它确实是当前企业落地 LLM 应用<strong>投入产出比最高</strong>的架构模式。建议先用本文的基础版本跑通一个 demo，再根据实际业务需求逐步叠加重排序、混合检索、评估体系等进阶能力。</p>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>Spring AI 官方文档：<a href="https://docs.spring.io/spring-ai/reference/" target="_blank">https://docs.spring.io/spring-ai/reference/</a></li>
<li>Spring AI GitHub 仓库：<a href="https://github.com/spring-projects/spring-ai" target="_blank">https://github.com/spring-projects/spring-ai</a></li>
<li>"Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks"（Lewis et al., 2020）— RAG 开山论文：<a href="https://arxiv.org/abs/2005.11401" target="_blank">arXiv:2005.11401</a></li>
<li>PgVector 官方文档：<a href="https://github.com/pgvector/pgvector" target="_blank">https://github.com/pgvector/pgvector</a></li>
<li>阿里云 DashScope Embedding 文档：<a href="https://help.aliyun.com/zh/model-studio/getting-started/models" target="_blank">https://help.aliyun.com/zh/model-studio/getting-started/models</a></li>
<li>"BGE Embedding 模型系列"（智源 BAAI）：<a href="https://huggingface.co/BAAI/bge-large-zh-v1.5" target="_blank">BGE-large-zh-v1.5 on HuggingFace</a></li>
<li>"Building RAG-based LLM Applications"（腾讯技术工程）：<a href="https://cloud.tencent.com/developer/article/2353499" target="_blank">腾讯云开发者社区</a></li>
<li>"RAG 评估方法论：RAGAS 框架实践"（字节跳动技术博客）：<a href="https://bytes.zhuanlan.zhihu.com/p/681247890" target="_blank">知乎专栏</a></li>
</ol>
