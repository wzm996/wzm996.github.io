---
title: LangChain4j 实战：用 Java 搭一个最小可用的 RAG，并算清它的延迟与成本账
date: 2026-09-06 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - LangChain4j
  - RAG
  - Embedding
  - 向量检索
  - AI工程化
  - Java
---

<hr>
<blockquote>
<p><strong>RAG</strong>（Retrieval-Augmented Generation，检索增强生成）说白了就是"答题前先翻书"：先把用户的问题在自家知识库里检索一遍，把查到的资料喂给大模型，再让它组织答案——模型不再靠记忆瞎编。这篇用 <strong>LangChain4j</strong>（Java 生态的 LLM 应用框架）从零搭一个<strong>最小可用</strong>的 RAG 检索链路，并用同一套基准代码实测两个方案的真实延迟与成本：<strong>本地 ONNX 小模型 vs 云端 Embedding API</strong>。照着做，你 30 分钟内就能在自己机器上跑通，还能拿到属于你自己环境的 P50/P95/P99。</p>
</blockquote>

<!-- more -->

<h1>一、背景：大模型不知道你公司的私货</h1>

<p>场景很常见：想给团队做个"值班问答机器人"，把运维手册、接口文档、故障案例都喂给它，让新人直接提问。你兴冲冲接了个大模型 API，结果它一本正经地回答"建议您查阅相关文档"——模型训练时根本没见过你们公司的文档，它只能靠通用知识<strong>幻觉</strong>（Hallucination，指模型一本正经地编造事实）硬撑。</p>

<p>解法有两条路：一是<strong>微调</strong>（Fine-tuning，拿自己的数据继续训练模型，贵、慢、更新难）；二是 <strong>RAG</strong>，文档放外面，回答前先检索。工程上九成场景选后者，理由很朴素：<strong>文档改了立即生效，不用重新训练</strong>。</p>

<p>第二个问题：为什么用 Java？因为很多团队的线上资产就是一摞 Spring Boot 服务，为一个检索功能再引入一套 Python 服务，部署、监控、权限都要重新搞一遍。<strong>LangChain4j</strong> 的价值就在这：它把"文档切分、向量化、向量检索、模型调用"这些零件统一成了 Java 接口，让你在现有 JVM 技术栈里把 RAG 拼出来。</p>

<p>先说清楚本文的边界：<strong>这篇聚焦 RAG 里的"R"（检索）</strong>。查到片段之后怎么拼 Prompt、怎么调 LLM 生成答案，那是"G"的事，LangChain4j 里用 <code>AiServices</code> 几行就能接上，而且那部分延迟成本的大头在 LLM 侧，值得单独开一篇算账。检索链路本身才是这套系统的地基，也是最容易踩坑的地方。</p>

<p>目标读者：会用 Java 和 Maven、知道 HTTP 怎么发请求的后端同学。<strong>不需要任何机器学习背景</strong>——下面 5 分钟补课保证你能看懂每一个零件。</p>

<h1>二、5 分钟补课：这条链路上的新名词</h1>

<p>先看全景，RAG 检索链路一共就四步：</p>

```
离线建库：文档 ──切分──▶ 片段 ──Embedding──▶ 向量 ──▶ 向量库
在线查询：问题 ──Embedding──▶ 查询向量 ──相似度计算──▶ Top-K 最相关片段
```

<p>每个名词第一次出现，都用一句话说清它是啥、解决啥问题：</p>

<ul>
<li><strong>Embedding（向量化）</strong>：把一段文字变成一串固定长度的数字（比如 512 个小数），这串数字就是这段话的"语义坐标"。解决的问题：计算机没法直接算"两句话像不像"，但算两个坐标的距离很快——语义相近的文字，坐标也挨得近。</li>
<li><strong>向量检索</strong>：拿"问题的向量"去向量库里找出离得最近的 K 个片段。解决了"关键词匹配搜不到同义表述"的问题——你搜"接口老是超时"，它能命中写着"调用超时的处理方案"的段落，一个关键词都没重合也能搜到。</li>
<li><strong>余弦相似度</strong>（CosineSimilarity）：衡量两个向量方向有多一致，越接近 1 越像。一句话：把"像不像"变成了一个能算的数。</li>
<li><strong>Chunking（切分）</strong>：把长文档切成几百字的小片段再向量化。为什么不整篇算一个向量？因为一篇文档压成一个坐标，语义就"平均"没了，检索精度会稀烂。</li>
<li><strong>LangChain4j</strong>：Java 版的 LLM 应用框架（对标 Python 的 LangChain）。解决的痛点：每家模型厂商、每家向量库的 API 都不一样，它统一抽象出 <code>EmbeddingModel</code>、<code>EmbeddingStore</code>、<code>DocumentSplitter</code> 等接口，换实现只改一行。</li>
<li><strong>ONNX Runtime</strong>：微软开源的模型推理引擎，有 Java 版。一句话：让 JVM 进程不依赖 Python 就能把一个神经网络模型跑起来，模型文件（.onnx）直接打进 jar 包。</li>
<li><strong>bge-small-zh-v1.5</strong>：北京智源（BAAI）开源的中文 Embedding 小模型，输出 512 维向量，专门在中文语料上训练过。<strong>langchain4j-embeddings-bge-small-zh-v15</strong> 这个依赖就是它的 ONNX 封装——引个依赖就能在 JVM 里离线跑中文向量化，不联网、不花钱。</li>
<li><strong>InMemoryEmbeddingStore</strong>：LangChain4j 自带的内存向量库，就是个数组加暴力余弦计算。别小看它：1024 个片段检索一次不到 1 毫秒，几十万片段以下完全够用，是"最小可用"的最佳拍档。</li>
</ul>

<h1>三、动手：30 分钟搭一个最小可用 RAG</h1>

<h2>3.1 技术选型与依赖</h2>

<p>本文的组合拳：</p>

<table>
<thead><tr><th>组件</th><th>选型</th><th>说明</th></tr></thead>
<tbody>
<tr><td>应用框架</td><td>LangChain4j 1.x</td><td>统一接口，版本迭代快，以 Maven Central 最新稳定版为准</td></tr>
<tr><td>本地向量模型</td><td>bge-small-zh-v1.5（ONNX）</td><td>进程内运行，512 维，离线可用</td></tr>
<tr><td>云端向量模型</td><td>text-embedding-3-small</td><td>OpenAI，1536 维，用于对比实测</td></tr>
<tr><td>向量存储</td><td>InMemoryEmbeddingStore</td><td>内存数组 + 暴力计算，小规模够用</td></tr>
</tbody>
</table>

<p>Maven 依赖（<strong>LangChain4j 迭代很快，版本号以 Maven Central 搜到的最新稳定版为准</strong>，下面是我写这篇时用的）：</p>

```xml
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j</artifactId>
    <version>1.8.0</version>
</dependency>
<!-- 本地中文 Embedding：ONNX 模型打包在 jar 里，进程内运行，无需联网 -->
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-embeddings-bge-small-zh-v15</artifactId>
    <version>1.8.0-beta15</version>
</dependency>
<!-- 对比云端 API 时才需要 -->
<dependency>
    <groupId>dev.langchain4j</groupId>
    <artifactId>langchain4j-open-ai</artifactId>
    <version>1.8.0</version>
</dependency>
```

<h2>3.2 准备知识库</h2>

<p>放三个 Markdown 文件到 <code>docs/</code> 目录，模拟值班手册。举个例子（<code>docs/oncall-faq.md</code> 节选）：</p>

```markdown
【重试】调用下游服务遇到可重试错误（连接超时、读超时、HTTP 502/503、429）时，
使用指数退避重试：初始 100ms，每次翻倍，最多 3 次，并加入随机抖动避免惊群。
不可重试错误（400、401、业务校验失败）禁止重试，直接告警。
```

<h2>3.3 建库：把文档变成向量</h2>

```java
public class IngestDemo {
    public static void main(String[] args) {
        EmbeddingModel embeddingModel = new BgeSmallZhV15EmbeddingModel();

        Path storeFile = Path.of("vector-store.json");
        // 已有存量则续建，否则新建
        InMemoryEmbeddingStore<TextSegment> store = Files.exists(storeFile)
                ? InMemoryEmbeddingStore.fromFile(storeFile)
                : new InMemoryEmbeddingStore<>();

        EmbeddingStoreIngestor ingestor = EmbeddingStoreIngestor.builder()
                // 递归切分：目标每段 300 token，重叠 30 token
                .documentSplitter(DocumentSplitters.recursive(300, 30))
                .embeddingModel(embeddingModel)
                .embeddingStore(store)
                .build();

        long t0 = System.currentTimeMillis();
        ingestor.ingest(FileSystemDocumentLoader.loadDocument(Path.of("docs/oncall-faq.md")));
        ingestor.ingest(FileSystemDocumentLoader.loadDocument(Path.of("docs/api-timeout.md")));
        ingestor.ingest(FileSystemDocumentLoader.loadDocument(Path.of("docs/rate-limit.md")));
        System.out.printf("ingest done in %d ms%n", System.currentTimeMillis() - t0);

        // 序列化到磁盘，重启进程不用重建
        store.serializeToFile(storeFile);
    }
}
```

<p>三个点说一下：<code>recursive(300, 30)</code> 表示尽量按 300 token 切一段、相邻段重叠 30 token（<strong>重叠</strong>是为了避免关键句子被一刀切成两半，两边都读不懂）；<code>serializeToFile</code> 把向量库落盘成 JSON；跑完会看到类似 <code>ingest done in 486 ms</code>——57 个片段，本地模型半秒搞定。</p>

<h2>3.4 查询：检索 Top-3</h2>

```java
public class SearchDemo {
    public static void main(String[] args) {
        EmbeddingModel embeddingModel = new BgeSmallZhV15EmbeddingModel();
        InMemoryEmbeddingStore<TextSegment> store =
                InMemoryEmbeddingStore.fromFile(Path.of("vector-store.json"));

        String question = "调第三方接口偶发超时，重试应该怎么配？";
        Embedding queryEmbedding = embeddingModel.embed(question).content();

        EmbeddingSearchResult<TextSegment> result = store.search(
                EmbeddingSearchRequest.builder()
                        .queryEmbedding(queryEmbedding)
                        .maxResults(3)
                        .minScore(0.5)   // 相似度低于 0.5 的不要
                        .build());

        for (EmbeddingMatch<TextSegment> match : result.matches()) {
            System.out.printf("score=%.3f  %s...%n---%n",
                    match.score(), match.embedded().text().substring(0, 40));
        }
    }
}
```

<p>注意查询里没有一个词跟文档原文完全一样（"偶发超时" vs 文档里的"读超时"），但输出依然精准命中：</p>

```
score=0.784  【重试】调用下游服务遇到可重试错误（连接超时、读超时、HTTP 502/503、429）时...
---
score=0.613  【超时分级】连接超时建议 500ms，读超时按下游 P99 的 2 倍设置...
---
score=0.542  【限流】被下游限流（429）时不要立即重试，先读 Retry-After 头...
---
```

<h2>3.5 功能验证：它到底有没有在瞎说</h2>

<p>"能跑"不等于"能用"，验证清单四条，建议做成单元测试放进 CI：</p>

<ul>
<li><strong>正例命中</strong>：准备 3 个口语化提问（如"接口老超时怎么办""被限流了咋整"），断言 Top-1 分数 ≥ 0.6 且内容语义正确。</li>
<li><strong>负例拒答</strong>：问一个知识库里没有的问题（如"今天午饭吃什么"），断言被 <code>minScore</code> 过滤后返回空列表——<strong>RAG 系统必须会说"我不知道"</strong>。</li>
<li><strong>持久化验证</strong>：重启进程直接 <code>fromFile</code> 加载，检索结果与重启前完全一致。</li>
<li><strong>稳定性抽查</strong>：同一个问题问 10 遍，结果排序应完全一致（Embedding 推理是确定性的，出现抖动说明代码有问题）。</li>
</ul>

<h1>四、延迟实测：本地 ONNX vs 云端 API</h1>

<p>同一个基准方法：先预热 50 次（把 JIT 编译、模型初始化这些一次性成本排除掉），再测 500 轮取分位数。<strong>分位数</strong>（P50/P95/P99）一句话：把 500 次耗时排序，第 50%、95%、99% 位置的值——P99 代表最慢的那 1% 请求有多惨，线上告警看的是它不是平均值。</p>

```java
static void bench(String name, Runnable task, int warmup, int rounds) {
    for (int i = 0; i < warmup; i++) task.run();
    long[] costs = new long[rounds];
    for (int i = 0; i < rounds; i++) {
        long t0 = System.nanoTime();
        task.run();
        costs[i] = (System.nanoTime() - t0) / 1_000_000;
    }
    Arrays.sort(costs);
    System.out.printf("%-28s P50=%4dms  P95=%4dms  P99=%4dms%n", name,
            costs[rounds / 2], costs[(int) (rounds * 0.95)], costs[(int) (rounds * 0.99)]);
}
```

<p>云端模型用同一个接口测（LangChain4j 的抽象这时候就值钱了，换实现只改两行）：</p>

```java
EmbeddingModel openAi = OpenAiEmbeddingModel.builder()
        .apiKey(System.getenv("OPENAI_API_KEY"))  // 密钥只走环境变量，别硬编码进代码
        .modelName("text-embedding-3-small")
        .build();
```

<p>实测环境：4C8G 云主机、JDK 21、CentOS，云端 API 走公网。<strong>声明：下面的数字是我这台机器跑出来的，你的环境必然不同</strong>——但量级关系和结论在同类环境里是稳定的，这正是要你自己跑一遍基准的原因。</p>

<table>
<thead><tr><th>指标</th><th>本地 bge-small-zh-v1.5（ONNX/CPU）</th><th>云端 text-embedding-3-small（公网）</th></tr></thead>
<tbody>
<tr><td>首次调用（含初始化）</td><td>~1900 ms</td><td>~700 ms</td></tr>
<tr><td>单条 embed P50</td><td>8 ms</td><td>240 ms</td></tr>
<tr><td>单条 embed P95</td><td>13 ms</td><td>460 ms</td></tr>
<tr><td>单条 embed P99</td><td>21 ms</td><td>980 ms</td></tr>
<tr><td>批量 32 条 P50</td><td>165 ms</td><td>610 ms</td></tr>
<tr><td>Top-5 检索（1024 片段）P50</td><td>0.9 ms</td><td>—（向量都在本地，此步相同）</td></tr>
<tr><td>端到端查询（embed + 检索）P50</td><td>~9 ms</td><td>~241 ms</td></tr>
</tbody>
</table>

<p>三个解读：</p>

<ul>
<li><strong>查询侧差了一个数量级</strong>：端到端 P50 是 9ms vs 241ms。差在哪？差在物理距离——云端方案每一跳都要过一个公网 RTT，这个延迟是光速和路由跳数决定的，代码优化不了。</li>
<li><strong>冷启动是个刺客</strong>：本地方案第一次调用要加载 ONNX 模型，约 2 秒。谁碰上谁倒霉，所以必须在服务启动时预热（见第七节坑 2）。</li>
<li><strong>建库侧云端反而可能更慢</strong>：100 万个片段按每批 32 条算要 3 万多次调用，云端串行 5 个小时起步，开 8 并发也得 40 分钟；本地单线程约 1.5 小时，多线程（吃满 CPU）能压到 20 分钟左右。</li>
</ul>

<h1>五、成本账：建库、增量、查询各花多少钱</h1>

<p>假设规模：100 万个片段，平均每段 200 token，那么建库总量是 2 亿 token。日增 1 万片段（200 万 token）。算给你看（<strong>云端价格以各家官网实时价格为准</strong>，下表是我写这篇时的牌价）：</p>

<table>
<thead><tr><th>项目</th><th>本地 ONNX</th><th>OpenAI text-embedding-3-small</th><th>阿里 text-embedding-v3</th></tr></thead>
<tbody>
<tr><td>建库 2 亿 token</td><td>¥0（CPU 时间）</td><td>$4 ≈ ¥29</td><td>≈ ¥140</td></tr>
<tr><td>每日增量 200 万 token</td><td>¥0</td><td>≈ ¥0.3</td><td>≈ ¥1.4</td></tr>
<tr><td>单次查询</td><td>¥0</td><td>忽略不计</td><td>忽略不计</td></tr>
<tr><td>100 万条向量内存</td><td>512 维 ≈ 2 GB</td><td>1536 维 ≈ 6 GB</td><td>1024 维 ≈ 4 GB</td></tr>
</tbody>
</table>

<p>结论可能反直觉：<strong>Embedding 的钱几乎可以忽略</strong>，2 亿 token 也就一杯奶茶钱。真正的账在两处：一是<strong>内存</strong>——float32 下每条向量 = 维度 × 4 字节，百万级片段轻轻松松吃掉几个 GB；二是<strong>查询延迟</strong>——这是每天每个请求都要付的利息，而且用户直接感知。所以选型时别盯着 API 单价纠结，先问自己两个问题：数据能不能出内网？用户能不能忍 200ms？</p>

<h1>六、怎么选：一张决策表</h1>

<table>
<thead><tr><th>你的场景</th><th>建议</th></tr></thead>
<tbody>
<tr><td>数据敏感，不能出内网</td><td>本地 ONNX，没得商量</td></tr>
<tr><td>在线查询、延迟敏感</td><td>本地（P50 差 20 倍以上）</td></tr>
<tr><td>追求效果上限、多语言</td><td>云端大模型（或本地部署大模型，但 CPU 扛不动，得有 GPU）</td></tr>
<tr><td>千万级以上片段</td><td>本地小模型产向量 + pgvector/Milvus 存储检索，内存向量库会 OOM</td></tr>
<tr><td>就想先跑通看看效果</td><td>本地 ONNX：零成本、零网络依赖、半小时出活</td></tr>
</tbody>
</table>

<h1>七、常见坑：每一条都值得一次半夜的排查</h1>

<ul>
<li><strong>坑 1：建库和查询用了不同的 Embedding 模型</strong>。现象：所有分数都低得离谱（0.2x），检索结果像随机抽签。原因：两个模型的"语义坐标系"完全不同，向量之间没有可比性。解法：模型名和版本写进片段的 metadata，建库查询同源，换模型必须全量重建。</li>
<li><strong>坑 2：没做预热</strong>。现象：上线后第一个用户请求莫名 2 秒。原因：ONNX 模型是懒加载的，首次调用背了全部初始化成本。解法：服务启动时 <code>embeddingModel.embed("预热")</code> 一次。</li>
<li><strong>坑 3：切分参数拍脑袋</strong>。切太碎（50 token），一句话被腰斩，语义断裂检索不准；切太大（2000 token），一段混了五个主题，向量语义被"平均"掉。解法：<code>recursive(300, 30)</code> 起步，拿 20 个真实问题做 3.5 节的验证清单来调。</li>
<li><strong>坑 4：内存向量库重启即失忆</strong>。进程一重启，向量全没，只好全量重建。解法：本文的 <code>serializeToFile</code> 是及格线；片段上万后换 <strong>pgvector</strong>（PostgreSQL 的向量检索插件，会 SQL 就会用）或 Milvus。</li>
<li><strong>坑 5：不设 minScore，有问必答变胡说八道</strong>。<code>maxResults(3)</code> 永远返回 3 条，哪怕知识库里根本没有相关内容。解法：设 <code>minScore</code> 阈值（我这边观察：命中相关片段 0.6~0.85，无关问题 0.35~0.45，阈值取 0.5；<strong>务必用自己的数据标定，别抄我的数</strong>）。</li>
<li><strong>坑 6：云端调用裸奔</strong>。网络抖动、限流（429）一来就异常满天飞。解法：显式设超时，配有限次数的指数退避重试，客户端加限流；密钥只走环境变量或密钥管理服务，<strong>永远不出现在代码和日志里</strong>。</li>
<li><strong>坑 7：内存账没算</strong>。float32 × 维度 × 条数，1024 维 100 万条就是 4GB，全堆里一放，GC 压力跟着上来。解法：规模大了上磁盘向量库，或用支持降维的模型（text-embedding-3 系列支持 <code>dimensions</code> 参数直接降到 512）。</li>
</ul>

<h1>八、总结</h1>

<ul>
<li>LangChain4j 把 RAG 三件套（切分、Embedding、检索）封装得足够薄，Java 同学 30 分钟能跑通一条可用链路，不用碰 Python。</li>
<li>本地 ONNX 中文小模型（bge-small-zh-v1.5）在查询延迟上比公网 API 低一个数量级（实测 P50：9ms vs 241ms），边际成本为零，几十万片段以下规模完全够用。</li>
<li>Embedding 的 API 费用可以忽略不计，真正的成本在内存（向量体积 = 维度 × 4 字节 × 条数）和查询延迟上——按这两个维度做选型，而不是按 API 单价。</li>
<li>换 Embedding 模型 = 全量重建向量库，模型名和版本要当作 schema 一样管理。</li>
<li>预热、持久化、minScore 拒答，三个小配置决定这套系统是"能跑的 demo"还是"能上线的服务"。</li>
</ul>

<p>下一篇预告：把本文检索到的片段拼进 Prompt，用 <code>AiServices</code> 接上对话模型，算一算"G"这一步的延迟和成本账。</p>

<h1>参考资料</h1>

<ul>
<li>LangChain4j 官方文档：<a href="https://docs.langchain4j.dev/">https://docs.langchain4j.dev/</a></li>
<li>LangChain4j GitHub 仓库：<a href="https://github.com/langchain4j/langchain4j">https://github.com/langchain4j/langchain4j</a></li>
<li>BAAI bge-small-zh-v1.5 模型卡：<a href="https://huggingface.co/BAAI/bge-small-zh-v1.5">https://huggingface.co/BAAI/bge-small-zh-v1.5</a></li>
<li>OpenAI Embeddings 官方指南：<a href="https://platform.openai.com/docs/guides/embeddings">https://platform.openai.com/docs/guides/embeddings</a></li>
<li>阿里云百炼通用文本向量文档：<a href="https://help.aliyun.com/zh/model-studio/embedding">https://help.aliyun.com/zh/model-studio/embedding</a></li>
<li>ONNX Runtime Java 入门：<a href="https://onnxruntime.ai/docs/get-started/with-java.html">https://onnxruntime.ai/docs/get-started/with-java.html</a></li>
<li>LangChain4j 向量库集成列表：<a href="https://docs.langchain4j.dev/integrations/embedding-stores/">https://docs.langchain4j.dev/integrations/embedding-stores/</a></li>
</ul>
