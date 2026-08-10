---
title: Spring AI RAG 实战——从零搭建企业知识库问答系统
date: 2026-08-10 10:00:00
categories:
  - 后端工程
  - 任务与调度
tags:
  - Spring AI
  - RAG
  - 向量数据库
  - Embedding
  - ChatClient
  - Spring Boot
---
<hr>
<blockquote><p>RAG（检索增强生成）是让大模型"读懂你私有数据"的核心技术。本文基于 Spring AI 1.0，手把手完成一个完整的 RAG 知识库问答系统：文档导入→切分→向量化→检索→生成，全程可复现，并给出生产环境必须注意的坑与优化策略。</p></blockquote>

<!-- more -->

<h1 id="背景：为什么需要-RAG"><a href="#背景：为什么需要-RAG" class="headerlink" title="背景：为什么需要 RAG"></a>背景：为什么需要 RAG</h1>

<p>先说痛点：<strong>直接拿大模型（如 GPT-4、DeepSeek）问公司内部问题，它要么胡说八道（幻觉），要么告诉你"我不知道"</strong>。原因很简单——你的私有数据从来没进过它的训练集。</p>

<p>传统做法有两条路，都不太好走：</p>
<ul>
<li><strong>微调（Fine-tuning）</strong>：成本高、周期长、知识更新后要重新训练</li>
<li><strong>硬塞 Prompt</strong>：上下文窗口有限，塞多了 token 费用爆炸还容易截断</li>
</ul>

<p><strong>RAG（Retrieval-Augmented Generation，检索增强生成）</strong>的思路是："不训练、不全塞，用的时候按需查"。流程就三步：</p>
<ol>
<li>把你的文档切成小块，变成<strong>向量</strong>（Embedding）存进向量数据库</li>
<li>用户提问时，先把问题也变成向量，去库里<strong>检索</strong>最相关的几块内容</li>
<li>把检索到的内容拼到 Prompt 里，再让 LLM <strong>生成</strong>回答</li>
</ol>

<pre><code class="mermaid">graph LR
    A[用户问题] --> B[Embedding 向量化]
    B --> C[向量数据库 相似度检索]
    C --> D[拼接 Prompt 上下文]
    D --> E[LLM 生成回答]
    F[私有文档] --> G[文档切分]
    G --> H[Embedding 向量化]
    H --> C
</code></pre>

<blockquote>
<p><strong>名词解释 —— Embedding（嵌入/向量化）</strong>：把一段文字（一句话、一段文档）变成一串数字（比如 768 维或 1536 维的浮点数组）。语义相近的文字，变成向量后的"距离"也更近。这样计算机就能通过"算距离"来理解"这段话跟那个问题有没有关系"，而不是傻傻地做关键词匹配。</p>
</blockquote>

<h1 id="核心概念：Spring-AI-RAG-架构拆解"><a href="#核心概念：Spring-AI-RAG-架构拆解" class="headerlink" title="核心概念：Spring AI RAG 架构拆解"></a>核心概念：Spring AI RAG 架构拆解</h1>

<p>Spring AI 1.0 把 RAG 拆成了几个清晰的模块，理解它们你就理解了整个框架：</p>

<table>
<thead>
<tr>
<th style="text-align:left">模块</th>
<th style="text-align:center">接口/类</th>
<th style="text-align:left">职责</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left"><strong>DocumentReader</strong></td>
<td style="text-align:center"><code>TextReader</code>, <code>PdfReader</code></td>
<td style="text-align-left">读取文件内容，转成 <code>Document</code> 对象列表</td>
</tr>
<tr>
<td style="text-align:left"><strong>TextSplitter</strong></td>
<td style="text-align:center"><code>TokenTextSplitter</code></td>
<td style="text-align-left">把长文档切成固定大小的块（chunk），避免超出 Embedding 模型限制</td>
</tr>
<tr>
<td style="text-align:left"><strong>EmbeddingModel</strong></td>
<td style="text-align:center"><code>OpenAiEmbeddingModel</code> 等</td>
<td style="text-align-left">将文本块转为向量（浮点数组）</td>
</tr>
<tr>
<td style="text-align:left"><strong>VectorStore</strong></td>
<td style="text-align-center"><code>SimpleVectorStore</code>, <code>PgVectorStore</code></td>
<td style="text-align-left">存储和检索向量，支持相似度搜索</td>
</tr>
<tr>
<td style="text-align:left"><strong>QuestionAnswerAdvisor</strong></td>
<td style="text-align:center"><code>QuestionAnswerAdvisor</code></td>
<td style="text-align-left">Spring AI 的 Advisor API，自动完成"检索→拼Prompt→调用LLM"全流程</td>
</tr>
</tbody>
</table>

<h1 id="环境准备"><a href="#环境准备" class="headerlink" title="环境准备"></a>环境准备</h1>

<table>
<thead>
<tr>
<th style="text-align:center">组件</th>
<th style="text-align:center">版本要求</th>
<th style="text-align:left">说明</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:center">JDK</td>
<td style="text-align:center">21+</td>
<td style="text-align:left">Spring AI 1.0 要求 JDK 21</td>
</tr>
<tr>
<td style="text-align:center">Spring Boot</td>
<td style="text-align:center">3.4+</td>
<td style="text-align-left">本文使用 3.4.1</td>
</tr>
<tr>
<td style="text-align:center">Spring AI</td>
<td style="text-align:center">1.0.0+</td>
<td style="text-align-left">通过 BOM 统一版本管理</td>
</tr>
<tr>
<td style="text-align:center">LLM / Embedding</td>
<td style="text-align:center">OpenAI 或兼容接口</td>
<td style="text-align-left">也可用 DeepSeek / Ollama 本地模型</td>
</tr>
<tr>
<td style="text-align:center">向量数据库</td>
<td style="text-align:center">PgVector / SimpleVectorStore</td>
<td style="text-align-left">开发用 SimpleVectorStore（内存），生产用 PgVector</td>
</tr>
</tbody>
</table>

<h2 id="pom.xml-关键依赖"><a href="#pom.xml-关键依赖" class="headerlink" title="pom.xml 关键依赖"></a>pom.xml 关键依赖</h2>

<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br></pre></td><td class="code"><pre><span class="line"><span class="tag">&lt;<span class="name">parent</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-parent<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">version</span>&gt;</span>3.4.1<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">parent</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">properties</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">java.version</span>&gt;</span>21<span class="tag">&lt;/<span class="name">java.version</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">spring-ai.version</span>&gt;</span>1.0.0<span class="tag">&lt;/<span class="name">spring-ai.version</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">properties</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">dependencyManagement</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependencies</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">            <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.ai<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">            <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-ai-bom<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">            <span class="tag">&lt;<span class="name">version</span>&gt;</span>${spring-ai.version}<span class="tag">&lt;/<span class="name">version</span>&gt;</span></span><br><span class="line">            <span class="tag">&lt;<span class="name">type</span>&gt;</span>pom<span class="tag">&lt;/<span class="name">type</span>&gt;</span></span><br><span class="line">            <span class="tag">&lt;<span class="name">scope</span>&gt;</span>import<span class="tag">&lt;/<span class="name">scope</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependencies</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependencyManagement</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">dependencies</span>&gt;</span></span><br><span class="line">    <span class="comment">&lt;!-- Spring Web --&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.boot<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-boot-starter-web<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line">    <span class="comment">&lt;!-- Spring AI OpenAI Starter (含 ChatClient + EmbeddingModel) --&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.ai<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-ai-openai-spring-boot-starter<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line">    <span class="comment">&lt;!-- 向量存储 (开发环境用 SimpleVectorStore) --&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.ai<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">        <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-ai-transformer-simple<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependencies</span>&gt;</span></span><br></pre></td></table></figure>

<h2 id="application.yml-配置"><a href="#application.yml-配置" class="headerlink" title="application.yml 配置"></a>application.yml 配置</h2>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br></pre></td><td class="code"><pre><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">ai:</span></span><br><span class="line">    <span class="attr">openai:</span></span><br><span class="line">      <span class="attr">api-key:</span> <span class="string">${OPENAI_API_KEY:sk-your-key-here}</span></span><br><span class="line">      <span class="attr">base-url:</span> <span class="string">${OPENAI_BASE_URL:https://api.openai.com}</span></span><br><span class="line">      <span class="attr">chat:</span></span><br><span class="line">        <span class="attr">options:</span></span><br><span class="line">          <span class="attr"># 使用 gpt-4o-mini 降低成本，也可换成 deepseek-chat</span></span><br><span class="line">          <span class="attr">model:</span> <span class="string">gpt-4o-mini</span></span><br><span class="line">          <span class="attr">temperature:</span> <span class="number">0.7</span></span><br><span class="line">      <span class="attr">embedding:</span></span><br><span class="line">        <span class="attr">options:</span></span><br><span class="line">          <span class="attr">model:</span> <span class="string">text-embedding-ada-002</span></span><br></pre></td></table></figure>

<blockquote>
<p><strong>注：</strong>如果想用 DeepSeek 替代 OpenAI，只需改 <code>base-url</code> 为 DeepSeek 的 endpoint，<code>model</code> 改为 <code>deepseek-chat</code> / <code>deepseek-embedder</code>。Spring AI 的 OpenAI 兼容层会自动适配。</p>
</blockquote>

<h1 id="Step-1-构建知识库：文档导入与向量化"><a href="#Step-1-构建知识库：文档导入与向量化" class="headerlink" title="Step 1: 构建知识库：文档导入与向量化"></a>Step 1: 构建知识库：文档导入与向量化</h1>

<p>RAG 的第一步是把你的私有文档"喂"进系统。我们创建一个 <code>IngestionService</code> 来完成整个 ETL 流程：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@Service</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">IngestionService</span> {</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">static</span> <span class="keyword">final</span> <span class="type">Logger</span> log = LoggerFactory.getLogger(IngestionService.class);</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">final</span> VectorStore vectorStore;</span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">final</span> EmbeddingModel embeddingModel;</span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">final</span> TokenTextSplitter textSplitter;</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Autowired</span></span><br><span class="line">    <span class="keyword">public</span> <span class="title class_">IngestionService</span>(VectorStore vectorStore,</span><br><span class="line">                              EmbeddingModel embeddingModel) {</span><br><span class="line">        <span class="built_in">this</span>.vectorStore = vectorStore;</span><br><span class="line">        <span class="built_in">this</span>.embeddingModel = embeddingModel;</span><br><span class="line">        <span class="comment">/**</span></span><br><span class="line"><span class="comment">         * TokenTextSplitter 参数说明：</span></span><br><span class="line"><span class="comment">         * - defaultChunkSize:   每块默认 800 token</span></span><br><span class="line"><span class="comment">         * - minChunkSize:      最小 100 token（太短的块没意义）</span></span><br><span class="line"><span class="comment">         * - overlapSize:       块间重叠 200 token（避免语义被截断）</span></span><br><span class="line"><span class="comment">         * - separator:         分隔符（默认空格，中文可用空字符串""）</span></span><br><span class="line"><span class="comment">         */</span></span><br><span class="line">        <span class="built_in">this</span>.textSplitter = <span class="keyword">new</span> <span class="title class_">TokenTextSplitter</span>(</span><br><span class="line">            <span class="number">800</span>, <span class="number">100</span>, <span class="number">200</span>, <span class="number">5000</span>, <span class="keyword">new</span> <span class="title class_">BpeTokenCountEstimator</span>()</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 导入文本文件到向量知识库</span></span><br><span class="line"><span class="comment">     *</span></span><br><span class="line"><span class="comment">     * <span class="doctag">@param filePath 文件路径（支持 classpath: 前缀）</span></span></span><br><span class="line"><span class="comment">     * <span class="doctag">@return 导入的文档块数量</span></span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="keyword">public</span> <span class="type">int</span> <span class="title function_">ingestTextFile</span><span class="params">(String filePath)</span> {</span><br><span class="line">        log.info(<span class="string">"开始导入文件: {}"</span>, filePath);</span><br><span class="line"></span><br><span class="line">        <span class="comment">// 1. 读取文件 → Document 列表</span></span><br><span class="line">        <span class="type">Resource</span> resource = <span class="keyword">new</span> <span class="title class_">ClassPathResource</span>(filePath);</span><br><span class="line">        <span class="type">TextReader</span> reader = <span class="keyword">new</span> <span class="title class_">TextReader</span>(resource);</span><br><span class="line">        reader.getCustomMetadata().put(<span class="string">"filename"</span>, filePath);</span><br><span class="line">        List&lt;Document&gt; documents = reader.get();</span><br><span class="line"></span><br><span class="line">        <span class="comment">// 2. 文档切分（chunking）</span></span><br><span class="line">        List&lt;Document&gt; splitDocuments = textSplitter.apply(documents);</span><br><span class="line">        log.info(<span class="string">"文档切分: {} → {} 块"</span>, documents.size(), splitDocuments.size());</span><br><span class="line"></span><br><span class="line">        <span class="comment">// 3. 存入向量数据库（自动完成 Embedding + 存储）</span></span><br><span class="line">        vectorStore.add(splitDocuments);</span><br><span class="line"></span><br><span class="line">        log.info(<span class="string">"导入完成! 共 {} 个文档块写入向量库"</span>, splitDocuments.size());</span><br><span class="line">        <span class="keyword">return</span> splitDocuments.size();</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<blockquote>
<p><strong>名词解释 —— TokenTextSplitter（文本分块器）</strong>：把一篇长文切成多个固定大小的"块"（chunk）。为什么要切？因为 Embedding 模型有输入长度限制（通常 512~8192 token），而且太长的段落会稀释语义焦点，导致检索精度下降。块与块之间保留一定重叠（overlap），避免一个完整意思被生硬切断。</p>
</blockquote>

<h2 id="准备测试数据"><a href="#准备测试数据" class="headerlink" title="准备测试数据"></a>准备测试数据</h2>

<p>在 <code>src/main/resources/data/</code> 下创建一个测试用的知识库文件：</p>

<figure class="highlight text"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br></pre></td><td class="code"><pre><span class="line">XX 公司员工手册 v2.0</span><br><span class="line"></span><br><span class="line">## 第一章 考勤制度</span><br><span class="line"></span><br><span class="line">### 1.1 工作时间</span><br><span class="line">公司标准工作时间为每周一至周五，上午 9:00 至下午 18:00。</span><br><span class="line">午休时间为 12:00-13:00，不计入工作时间。</span><br><span class="line">弹性工作制员工可在 8:00-10:00 之间到岗，相应调整下班时间。</span><br><span class="line"></span><br><span class="line">### 1.2 请假流程</span><br><span class="line">病假需提前 1 小时在 OA 系统提交申请，附医院证明。</span><br><span class="line">年假需提前 3 个工作日申请，由直属主管审批。</span><br><span class="line">事假需提前 1 天申请，紧急情况例外但需当日补办手续。</span><br><span class="line"></span><span class="line">## 第二章 费用报销</span><br><span class="line"></span><br><span class="line">### 2.1 差旅费标准</span><br><span class="line">一线城市（北上广深）住宿补贴为 600 元/晚，二线城市 400 元/晚。</span><br><span class="line">交通费实报实销，高铁限二等座，飞机限经济舱（特殊情况需 VP 审批）。</span><br><span class="line">出差餐补为 100 元/天，无需发票。</span><br><span class="line"></span><br><span class="line">### 2.2 报销流程</span><br><span class="line">所有费用需在回公司后 5 个工作日内通过财务系统提交。</span><br><span class="line">单笔金额超过 5000 元需部门总监审批。</span><br></pre></td></table></figure>

<h1 id="Step-2-实现-RAG-问答接口"><a href="#Step-2-实现-RAG-问答接口" class="headerlink" title="Step 2: 实现 RAG 问答接口"></a>Step 2: 实现 RAG 问答接口</h1>

<p>有了知识库，接下来就是核心的 RAG 问答逻辑。Spring AI 1.0 提供了 <strong>QuestionAnswerAdvisor</strong>，可以极大简化代码量：</p>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br><span class="line">18</span><br><span class="line">19</span><br><span class="line">20</span><br><span class="line">21</span><br><span class="line">22</span><br><span class="line">23</span><br><span class="line">24</span><br><span class="line">25</span><br><span class="line">26</span><br><span class="line">27</span><br><span class="line">28</span><br><span class="line">29</span><br><span class="line">30</span><br><span class="line">31</span><br><span class="line">32</span><br><span class="line">33</span><br><span class="line">34</span><br><span class="line">35</span><br><span class="line">36</span><br><span class="line">37</span><br><span class="line">38</span><br><span class="line">39</span><br><span class="line">40</span><br><span class="line">41</span><br><span class="line">42</span><br><span class="line">43</span><br><span class="line">44</span><br><span class="line">45</span><br><span class="line">46</span><br><span class="line">47</span><br><span class="line">48</span><br><span class="line">49</span><br><span class="line">50</span><br><span class="line">51</span><br><span class="line">52</span><br><span class="line">53</span><br><span class="line">54</span><br><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="meta">@RequestMapping("/api/rag")</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">RagController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">final</span> ChatClient chatClient;</span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">final</span> VectorStore vectorStore;</span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">final</span> IngestionService ingestionService;</span><br><span class="line"></span><br><span class="line">    <span class="meta">@Autowired</span></span><br><span class="line">    <span class="keyword">public</span> <span class="title class_">RagController</span>(ChatClient.Builder chatClientBuilder,</span><br><span class="line">                            VectorStore vectorStore,</span><br><span class="line">                            IngestionService ingestionService) {</span><br><span class="line">        <span class="built_in">this</span>.chatClient = chatClientBuilder.build();</span><br><span class="line">        <span class="built_in">this</span>.vectorStore = vectorStore;</span><br><span class="line">        <span class="built_in">this</span>.ingestionService = ingestionService;</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * RAG 问答接口</span></span><br><span class="line"><span class="comment">     *</span></span><br><span class="line"><span class="comment">     * QuestionAnswerAdvisor 自动完成：</span></span><br><span class="line"><span class="comment">     * 1. 将用户问题向量化</span></span><br><span class="line"><span class="comment">     * 2. 在 VectorStore 中做相似度搜索</span></span><br><span class="line"><span class="comment">     * 3. 将检索结果注入 Prompt</span></span><br><span class="line"><span class="comment">     * 4. 调用 LLM 生成回答</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@GetMapping("/ask")</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title function_">ask</span><span class="params">(@RequestParam String question)</span> {</span><br><span class="line">        <span class="keyword">return</span> chatClient.prompt()</span><br><span class="line">            .user(question)</span><br><span class="line">            .advisors(QuestionAnswerAdvisor.builder()</span><br><span class="line">                .vectorStore(vectorStore)</span><br><span class="line">                <span class="comment">// 自定义 System Prompt，告诉 LLM 它的角色和行为约束</span></span><br><span class="line">                .promptTemplate(<span class="string">"""</span></span><br><span class="line"><span class="string">                    你是 XX 公司的智能助手。请根据以下检索到的上下文信息回答用户的问题。</span></span><br><span class="line"><span class="string">                    要求：</span></span><br><span class="line"><span class="string">                    1. 仅基于上下文信息回答，不要编造内容</span></span><br><span class="line"><span class="line">                    2. 如果上下文中没有答案，请明确告知"我无法在知识库中找到相关信息"</span></span><br><span class="line"><span class="string">                    3. 回答简洁专业，引用具体条款</span></span><br><span class="line"><span class="string"></span></span><br><span class="line"><span class="string">                    上下文信息：</span></span><br><span class="line"><span class="string">                    {context}</span></span><br><span class="line"><span class="string">                    """</span>)</span><br><span class="line">                <span class="comment">// 只取相似度最高的 3 个文档块</span></span><br><span class="line">                .topK(<span class="number">3</span>)</span><br><span class="line">                .build())</span><br><span class="line">            .call()</span><br><span class="line">            .content();</span><br><span class="line">    }</span><br><span class="line"></span><br><span class="line">    <span class="comment">/**</span></span><br><span class="line"><span class="comment">     * 手动触发知识库导入</span></span><br><span class="line"><span class="comment">     */</span></span><br><span class="line">    <span class="meta">@PostMapping("/ingest")</span></span><br><span class="line">    <span class="keyword">public</span> Map&lt;String, Object&gt; <span class="title function_">ingest</span><span class="params">(@RequestParam(defaultValue = "data/handbook.txt") String file)</span> {</span><br><span class="line">        <span class="type">int</span> count = ingestionService.ingestTextFile(file);</span><br><span class="line">        <span class="keyword">return</span> Map.of(</span><br><span class="line">            <span class="string">"status"</span>, <span class="string">"ok"</span>,</span><br><span class="line">            <span class="string">"chunksImported"</span>, count,</span><br><span class="line">            <span class="string">"file"</span>, file</span><br><span class="line">        );</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h1 id="Step-3-运行与验证"><a href="#Step-3-运行与验证" class="headerlink" title="Step 3: 运行与验证"></a>Step 3: 运行与验证</h1>

<h2 id="启动应用"><a href="#启动应用" class="headerlink" title="启动应用"></a>启动应用</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 设置 API Key（如果没写在 yml 里）</span></span><br><span class="line">export OPENAI_API_KEY=sk-your-actual-key</span><br><span class="line">mvn spring-boot:run</span><br></pre></td></table></figure>

<h2 id="导入知识库"><a href="#导入知识库" class="headerlink" title="导入知识库"></a>导入知识库</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 导入知识库</span></span><br><span class="line">curl -X POST http://localhost:8080/api/rag/ingest?file=data/handbook.txt</span><br><span class="line"></span><br><span class="line"># 预期返回: {"status":"ok","chunksImported":3,"file":"data/handbook.txt"}</span><br></pre></td></table></figure>

<h2 id="提问测试"><a href="#提问测试" class="headerlink" title="提问测试"></a>提问测试</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 测试 1：考勤相关问题</span></span><br><span class="line">curl "http://localhost:8080/api/rag/ask?question=公司的标准工作时间是什么？"</span><br><span class="line"></span><br><span class="line"># 预期返回类似：</span><br><span class="line"># 根据员工手册，公司标准工作时间为周一至周五上午9:00至下午18:00，</span><br><span class="line"># 午休时间12:00-13:00不计入工作时间...</span><br><span class="line"></span><br><span class="line"><span class="comment"># 测试 2：费用报销相关问题</span></span><br><span class="line">curl "http://localhost:8080/api/rag/ask?question=去北京出差住宿补贴多少？"</span><br><span class="line"></span><br><span class="line"><span class="comment"># 预期返回类似：</span></span><br><span class="line"># 根据差旅费标准，北京属于一线城市，住宿补贴为600元/晚...</span><br><span class="line"></span><br><span class="line"><span class="comment"># 测试 3：知识库外的问题（应拒绝回答）</span></span><br><span class="line">curl "http://localhost:8080/api/rag/ask?question=怎么训练一只猫？"</span><br><span class="line"># 预期返回：我无法在知识库中找到相关信息</span><br></pre></td></table></figure>

<h2 id="验证要点清单"><a href="#验证要点清单" class="headerlink" title="验证要点清单"></a>验证要点清单</h2>

<table>
<thead>
<tr>
<th style="text-align:left">验证项</th>
<th style="text-align:center">方法</th>
<th style="text-align:left">预期结果</th>
</tr>
</thead>
tbody>
<tr>
<td style="text-align:left">知识库导入成功</td>
<td style="text-align:center">看启动日志 / POST /ingest 返回值</td>
<td style="text-align:left">chunksImported > 0</td>
</tr>
<tr>
<td style="text-align:left">能正确回答知识库内问题</td>
<td style="text-align:center">GET /ask?question=考勤相关</td>
<td style="text-align:left">回答基于手册内容，不编造</td>
</tr>
<tr>
<td style="text-align:left">对知识库外问题说不</td>
<td style="text-align:center">GET /ask?question=无关话题</td>
<td style="text-align:left">返回"无法找到相关信息"</td>
</tr>
<tr>
<td style="text-align:left">检索到了正确的文档块</td>
<td style="text-align:center">开启 DEBUG 日志看 advisor 输出</td>
<td style="text-align:left">topK 块的相关度分数合理</td>
</tr>
</tbody>
</table>

<h1 id="Step-4-进阶：从-SimpleVectorStore-升级到-PgVector"><a href="#Step-4-进阶：从-SimpleVectorStore-升级到-PgVector" class="headerlink" title="Step 4: 进阶：从 SimpleVectorStore 升级到 PgVector"></a>Step 4: 进阶：从 SimpleVectorStore 升级到 PgVector</h1>

<p>上面的例子用的是 <strong>SimpleVectorStore</strong>（纯内存，重启即失）。生产环境必须用持久化的向量数据库。<strong>PgVector</strong>是 PostgreSQL 的向量扩展，也是 Spring AI 官方推荐的生产方案之一。</p>

<h2 id="4-1-安装-PgVector"><a href="#4-1-安装-PgVector" class="headerlink" title="4.1 安装 PgVector"></a>4.1 安装 PgVector</h2>

<figure class="highlight bash"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># 使用 Docker 快速启动（含 pgvector 扩展）</span></span><br><span class="line">docker run -d \</span><br><span class="line">  --name pgvector \</span><br><span class="line">  -e POSTGRES_USER=rag \</span><br><span class="line">  -e POSTGRES_PASSWORD=rag123 \</span><br><span class="line">  -e POSTGRES_DB=ragdb \</span><br><span class="line">  -p 5432:5432 \</span><br><span class="line">  pgvector/pgvector:pg16</span><br><span class="line"></span><br><span class="line"><span class="comment"># 验证扩展已安装</span></span><br><span class="line">docker exec -it pgvector psql -U rag -d ragdb -c "CREATE EXTENSION IF NOT EXISTS vector;"</span><br></pre></td></table></figure>

<h2 id="4-2-切换配置"><a href="#4-2-切换配置" class="headerlink" title="4.2 切换配置"></a>4.2 切换配置</h2>

<figure class="highlight xml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment">&lt;!-- pom.xml 替换 SimpleVectorStore 为 PgVectorStore --&gt;</span></span><br><span class="line"><span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.springframework.ai<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>spring-ai-pgvector-store<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br><span class="line"></span><br><span class="line"><span class="tag">&lt;<span class="name">dependency</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">groupId</span>&gt;</span>org.postgresql<span class="tag">&lt;/<span class="name">groupId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">artifactId</span>&gt;</span>postgresql<span class="tag">&lt;/<span class="name">artifactId</span>&gt;</span></span><br><span class="line">    <span class="tag">&lt;<span class="name">scope</span>&gt;</span>runtime<span class="tag">&lt;/<span class="name">scope</span>&gt;</span></span><br><span class="line"><span class="tag">&lt;/<span class="name">dependency</span>&gt;</span></span><br></pre></td></table></figure>

<figure class="highlight yaml"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br></pre></td><td class="code"><pre><span class="line"><span class="comment"># application.yml 新增 PgVector 配置</span></span><br><span class="line"><span class="attr">spring:</span></span><br><span class="line">  <span class="attr">datasource:</span></span><br><span class="line">    <span class="attr">url:</span> <span class="string">jdbc:postgresql://localhost:5432/ragdb</span></span><br><span class="line">    <span class="attr">username:</span> <span class="string">rag</span></span><br><span class="line">    <span class="attr">password:</span> <span class="string">rag123</span></span><br><span class="line">  <span class="attr">ai:</span></span><br><span class="line">    <span class="attr">vectorstore:</span> <span class="string">pgvector</span></span><br></pre></td></table></figure>

<blockquote>
<p><strong>关键变化</strong>：代码层面<strong>零修改</strong>！只需换依赖 + 改配置，<code>VectorStore</code> 接口不变。这就是 Spring AI 抽象的价值。</p>
</blockquote>

<h1 id="Step-5-成本分析与优化策略"><a href="#Step-5-成本分析与优化策略" class="headerlink" title="Step 5: 成本分析与优化策略"></a>Step 5: 成本分析与优化策略</h1>

<p>RAG 不是免费午餐。每次问答涉及两次 API 调用：Embedding（向量化查询）+ LLM 生成。下面是一个典型的成本模型：</p>

<h2 id="单次问答成本拆解"><a href="#单次问答成本拆解" class="headerlink" title="单次问答成本拆解"></a>单次问答成本拆解</h2>

<table>
<thead>
<tr>
<th style="text-align:left">环节</th>
<th style="text-align:center">模型</th>
<th style="text-align:right">估算 Token 数</th>
<th style="text-align:right">估算成本（USD）</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align:left">Query Embedding</td>
<td style="text-align:center">text-embedding-ada-002</td>
<td style="text-align:right">~1 token</td>
<td style="text-align:right">$0.000001</td>
</tr>
<tr>
<td style="text-align:left">Context Retrieval</td>
<td style="text-align:center">—（本地计算）</td>
<td style="text-align:right">—</td>
<td style="text-align:right">$0</td>
</tr>
<tr>
<td style="text-align:left">LLM 生成回答</td>
<td style="text-align:center">gpt-4o-mini</td>
<td style="text-align:right">~150 input + ~200 output</td>
<td style="text-align:right">$0.00005</td>
</tr>
<tr>
<td style="text-align:left"><strong>合计/次</strong></td>
<td style="text-align:center">—</td>
<td style="text-align:right">—</td>
<td style="text-align:right"><strong>~$0.00005</strong></td>
</tr>
</tbody>
</table>

<p>看起来很便宜？但<strong>日请求量 10 万次</strong>时就是 <strong>$5/天 ≈ $150/月</strong>。如果用 GPT-4o（非 mini），成本直接翻 20 倍。</p>

<h2 id="优化策略（按投入产出比排序）"><a href="#优化策略（按投入产出比排序） class="headerlink" title="优化策略（按投入产出比排序）"></a>优化策略（按投入产出比排序）</h2>

<table>
<thead>
<tr>
<th style="text-align:left">#</th>
<th style="text-align:left">策略</th>
<th style="text-align:center">效果</th>
<th style="text-align:left">实现方式</th>
</tr>
</thead>
tbody>
<tr>
<td style="text-align:left">1</td>
<td style="text-align:left"><strong>缓存常见问题</strong></td>
<td style="text-align:center">⭐⭐⭐ 成本降 30~60%</td>
<td style="text-align-left">Redis 缓存 question→answer，TTL 设 24h</td>
</tr>
<tr>
<td style="text-align:left">2</td>
<td style="text-align:left"><strong>用便宜模型做 Embedding</strong></td>
<td style="text-align:center">⭐⭐ Embedding 成本降 70%+</td>
<td style="text-align-left">换用 bge-m3 / local Embedding 模型</td>
</tr>
<tr>
<td style="text-align:left">3</td>
<td style="text-align:left"><strong>减少 topK 和 context 长度</strong></td>
<td style="text-align:center">⭐⭐ Token 用量降 20~40%</td>
<td style="text-align-left">topK 从 5 降到 3；精简 system prompt</td>
</tr>
<tr>
<td style="text-align:left">4</td>
<td style="text-align:left"><strong>本地模型兜底</strong></td>
<td style="text-align:center">⭐⭐⭐ 成本趋近于零</td>
<td style="text-align-left">Ollama 部署 Qwen2.5 / DeepSeek 作为 fallback</td>
</tr>
<tr>
<td style="text-align:left">5</td>
<td style="text-align:left"><strong>查询预处理（Query Rewriting）</strong></td>
<td style="text-align:center">⭐ 检索准确率提升 10~25%</td>
<td style="text-align:left">先用 LLM 把用户口语化问题改写成精确查询</td>
</tr>
</tbody>
</table>

<h2 id="缓存实现示例"><a href="#缓存实现示例" class="headerlink" title="缓存实现示例"></a>缓存实现示例</h2>

<figure class="highlight java"><table><tr><td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br><span class="line">3</span><br><span class="line">4</span><br><span class="line">5</span><br><span class="line">6</span><br><span class="line">7</span><br><span class="line">8</span><br><span class="line">9</span><br><span class="line">10</span><br><span class="line">11</span><br><span class="line">12</span><br><span class="line">13</span><br><span class="line">14</span><br><span class="line">15</span><br><span class="line">16</span><br><span class="line">17</span><br></pre></td><td class="code"><pre><span class="line"><span class="meta">@RestController</span></span><br><span class="line"><span class="keyword">public</span> <span class="keyword">class</span> <span class="title class_">CachedRagController</span> {</span><br><span class="line"></span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">final</span> RagController ragController;</span><br><span class="line">    <span class="keyword">private</span> <span class="keyword">final</span> RedisTemplate&lt;String, String&gt; redis;</span><br><span class="line"></span><br><span class="line">    <span class="meta">@GetMapping("/cached-ask")</span></span><br><span class="line">    <span class="keyword">public</span> String <span class="title function_">cachedAsk</span><span class="params">(@RequestParam String question)</span> {</span><br><span class="line">        <span class="type">String</span> cacheKey = <span class="string">"rag:"</span> + DigestUtils.md5DigestAsHex(question.getBytes());</span><br><span class="line">        <span class="type">String</span> cached = redis.opsForValue().get(cacheKey);</span><br><span class="line">        <span class="keyword">if</span> (cached != <span class="literal">null</span>) {</span><br><span class="line">            <span class="keyword">return</span> cached; <span class="comment">// 命中缓存，零成本</span></span><br><span class="line">        }</span><br><span class="line">        <span class="type">String</span> answer = ragController.ask(question);</span><br><span class="line">        redis.opsForValue().set(cacheKey, answer, <span class="number">24</span>, TimeUnit.HOURS);</span><br><span class="line">        <span class="keyword">return</span> answer;</span><br><span class="line">    }</span><br><span class="line">}</span><br></pre></td></table></figure>

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<table>
<thead>
<tr>
<th style="text-align:left">#</th>
<th style="text-align:left">坑</th>
<th style="text-align:center">严重度</th>
<th style="text-align:left">解决方案</th>
</tr>
</thead>
tbody>
<tr>
<td style="text-align:left">1</td>
<td style="text-align:left"><strong>切分块太大或太小</strong>：太大导致噪声多、检索不准；太小导致语义不完整</td>
<td style="text-align:center">🔴 高</td>
<td style="text-align-left">一般 500~800 token + 10~25% overlap 是经验甜点区</td>
</tr>
<tr>
<td style="text-align:left">2</td>
<td style="text-align:left"><strong>System Prompt 太弱</strong>：LLM 忽略"仅基于上下文"的指令，开始编造</td>
<td style="text-align:center">🔴 高</td>
<td style="text-align-left">用更强的约束语："严禁编造，不确定就说不知道"</td>
</tr>
<tr>
<td style="text-align:left">3</td>
<td style="text-align:left"><strong>topK 设太高</strong>：塞入太多无关上下文，反而干扰 LLM 判断</td>
<td style="text-align:center">🟠 中</td>
<td style="text-align-left">一般 3~5 就够，配合相似度阈值（≥0.7）过滤</td>
</tr>
<tr>
<td style="text-align:left">4</td>
<td style="text-align:left"><strong>中文切分错误</strong>：英文按空格切没问题，中文按字数切可能断词</td>
<td style="text-align:center">🟠 中</td>
<td style="text-align-left">使用支持中文的分块器，或在切分前加句子级分割</td>
</tr>
<tr>
<td style="text-align:left">5</td>
<td style="text-align:left"><strong>忽略元数据（Metadata）</strong>：检索时不利用文档来源/章节等元信息</td>
<td style="text-align:center">🟡 低</td>
<td style="text-align-left">在 Document 中注入 filename、chapter 等 metadata，便于溯源</td>
</tr>
<tr>
<td style="text-align:left">6</td>
<td style="text-align:left"><strong>Embedding 与 LLM 不匹配</strong>：用中文领域 Embedding + 英文 LLM，语义空间不一致</td>
<td style="text-align:center">🟠 中</td>
<td style="text-align-left">Embedding 和 LLM 尽量用同一厂商或都支持中文的模型</td>
</tr>
<tr>
<td style="text-align:left">7</td>
<td style="text-align:left"><strong>知识库更新后旧向量残留</strong>：文档改了但向量库里还是旧的</td>
<td style="text-align:center">🟠 中</td>
<td style="text-align-left">实现增量更新或定期全量重建索引</td>
</tr>
</tbody>
</table>

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

<p>本文基于 Spring AI 1.0 从零完成了一个 RAG 知识库问答系统的搭建，核心要点回顾：</p>

<ul>
<li><strong>RAG 本质</strong>：文档→向量化→检索→增强 Prompt→LLM 生成，解决私有数据问答问题</li>
<li><strong>Spring AI 的抽象</strong>：<code>DocumentReader</code> → <code>TextSplitter</code> → <code>VectorStore</code> → <code>QuestionAnswerAdvisor</code>，每层都可替换</li>
<li><strong>开发用 SimpleVectorStore，生产用 PgVector</strong>：切换只需改依赖和配置，代码零修改</li>
<li><strong>成本不可忽视</strong>：缓存 > 便宜 Embedding > 减少上下文长度 > 本地模型兜底</li>
<li><strong>最大坑是切分和 Prompt 约束</strong>：块大小要合适（500~800 token），Prompt 要足够强防止幻觉</li>
<li><strong>下一步方向</strong>：查询重写（Query Rewriting）、混合检索（关键词+向量）、重排序（Reranker）</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

<ol>
<li>[Spring 官方] <a href="https://docs.spring.io/spring-ai/reference/api/retrieval-augmented-generation.html" target="_blank">Spring AI Reference: Retrieval Augmented Generation</a> — RAG 模块官方文档</li>
<li>[Spring 官方] <a href="https://docs.spring.io/spring-ai/reference/api/vectorstores.html" target="_blank">Spring AI Reference: Vector Stores</a> — 向量存储集成指南</li>
<li>[掘金] <a href="https://juejin.cn/post/7598447519823659049" target="_blank">Spring AI 全面解析（2026 版 · 基于 1.0.2）</a> — 中文生态全景 + 最佳实践</li>
<li>[Medium] <a href="https://medium.com/javarevisited/rag-with-spring-ai-3fe2920c0c46" target="_blank">RAG with Spring AI — Complete Tutorial</a> — 英文实战教程，含 ETL 全流程代码</li>
<li>[Piotr's TechBlog] <a href="https://piotrminkowski.com/2025/02/24/using-rag-and-vector-store-with-spring-ai" target="_blank">Using RAG and Vector Store with Spring AI</a> — 多种 RAG 模式对比与代码示例</li>
<li>[Google Cloud] <a href="https://cloud.google.com/use-cases/retrieval-augmented-generation?hl=zh-CN" target="_blank">什么是检索增强生成(RAG)？</a> — RAG 原理与 Google Cloud 实践视角</li>
<li>[Spring AI Alibaba] <a href="https://java2ai.com/en/docs/frameworks/agent-framework/advanced/rag" target="_blank">检索增强生成（RAG）— Spring AI Alibaba</a> — 中文 RAG 最佳实践与混合 RAG 架构</li>
</ol>
