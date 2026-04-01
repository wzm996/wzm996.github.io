---
title: Java 做 RAG，为什么检索一快回答反而更差？——用 Spring AI + pgvector 把召回、延迟和成本一起讲明白
date: 2026-04-01 10:00:00
categories:
  - 编程语言
  - Java
tags:
  - Java
  - Spring AI
  - RAG
  - pgvector
  - PostgreSQL
  - 向量检索
---
<hr>
<blockquote>
<p>很多人第一次做 <strong>RAG</strong>（Retrieval-Augmented Generation，检索增强生成）时，最容易踩的坑不是“模型不够强”，而是“检索看起来很快，但召回结果不对”。这篇文章不聊空话，直接用 <strong>Spring AI + PostgreSQL pgvector</strong> 做一个可复现实验，把 <strong>topK、相似度阈值、分块大小、重排前后效果、延迟与成本权衡</strong> 一次讲清楚。</p>
</blockquote>

<!-- more -->

<h1 id="一、为什么这篇值得写"><a href="#一、为什么这篇值得写" class="headerlink" title="一、为什么这篇值得写"></a>一、为什么这篇值得写</h1>
<p>最近一两年，Java 圈做 AI 应用的人明显多了，大家开始用 <strong>Spring AI</strong>、<strong>LangChain4j</strong>、向量库、Embedding 模型去搭知识库问答、企业助手、FAQ 机器人。</p>
<p>但真上手之后，很多项目会遇到一个很拧巴的问题：</p>
<ul>
<li>向量检索明明只有几十毫秒，看起来已经很快了；</li>
<li>可最后回答质量并不稳定，有时甚至比不做检索还差；</li>
<li>继续盲目把 <strong>topK</strong> 调大，结果是 <strong>延迟上去了、Token 成本上去了、答案还更飘了</strong>。</li>
</ul>
<p>这个现象的本质是：<strong>RAG 不是“检索越快越好”，而是“检索结果要刚好够用”</strong>。如果召回过少，模型拿不到信息；如果召回过多，模型被噪音淹没，反而容易胡说八道。</p>
<p>所以这篇文章只解决一个问题：<strong>在 Java 技术栈里，怎么把一个最小可用 RAG 做到既能跑、又能验证、还能知道自己为什么调参数</strong>。</p>

<h1 id="二、先把几个容易混的概念说人话"><a href="#二、先把几个容易混的概念说人话" class="headerlink" title="二、先把几个容易混的概念说人话"></a>二、先把几个容易混的概念说人话</h1>
<p>先把几个新名词说清楚，不然后面容易越看越晕。</p>
<ul>
<li><strong>RAG</strong>：检索增强生成。说白了，就是先去知识库里找资料，再把资料喂给大模型回答，避免它只靠“脑补”。</li>
<li><strong>Embedding</strong>：向量化。就是把一段文本变成一串数字，目的是让“语义相近的内容在数学空间里也更接近”。</li>
<li><strong>向量检索</strong>：不是按关键词精确匹配，而是按“语义像不像”来找最接近的文本块。</li>
<li><strong>pgvector</strong>：PostgreSQL 的一个扩展，让数据库能直接存向量、做相似度检索。它适合中小规模、追求简单部署的场景。</li>
<li><strong>topK</strong>：一次检索取前 K 条最相似结果。K 太小可能漏召回，K 太大可能把噪音也带进来。</li>
<li><strong>重排（Rerank）</strong>：检索完先别急着喂模型，再做一轮更精细的排序，把真正相关的内容排到前面。</li>
<li><strong>分块（Chunking）</strong>：把长文档切成多个小段。因为太长的原文不能直接高质量检索，通常要切成适中的块。</li>
</ul>
<p>一句话总结：<strong>Embedding 决定“怎么表示”，向量库决定“怎么找”，重排决定“找得准不准”，大模型决定“最后怎么说”</strong>。</p>

<h1 id="三、本文实验目标与环境"><a href="#三、本文实验目标与环境" class="headerlink" title="三、本文实验目标与环境"></a>三、本文实验目标与环境</h1>
<p>我们做一个最小实验：</p>
<ul>
<li>使用 <strong>Spring Boot 3.3.x + Spring AI</strong>；</li>
<li>使用 <strong>PostgreSQL 16 + pgvector</strong> 存文档向量；</li>
<li>准备 20~50 篇技术文档，做知识库导入；</li>
<li>用同一批问题分别测试不同参数下的召回效果和延迟；</li>
<li>观察：<strong>不是检索越多越好，而是“召回质量、上下文长度、模型成本”要平衡</strong>。</li>
</ul>
<p>实验环境示例：</p>
<ul>
<li>JDK 21</li>
<li>Spring Boot 3.3.5</li>
<li>Spring AI 1.0.x</li>
<li>PostgreSQL 16</li>
<li>pgvector 0.7.x</li>
<li>Docker / Docker Compose</li>
</ul>
<p>如果你是第一次接触 <strong>Spring AI</strong>，可以把它理解成“Java 世界里把模型调用、Prompt、Embedding、VectorStore 这些常见 AI 组件封装起来的一层工程化 API”，好处就是更适合和现有 Spring Boot 服务拼起来。</p>

<h1 id="四、先把项目跑起来"><a href="#四、先把项目跑起来" class="headerlink" title="四、先把项目跑起来"></a>四、先把项目跑起来</h1>

<h2 id="4-1-启动-PostgreSQL-pgvector"><a href="#4-1-启动-PostgreSQL-pgvector" class="headerlink" title="4.1 启动 PostgreSQL + pgvector"></a>4.1 启动 PostgreSQL + pgvector</h2>
<p>先准备一个 <code>docker-compose.yml</code>：</p>

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: rag-postgres
    environment:
      POSTGRES_DB: ragdemo
      POSTGRES_USER: rag
      POSTGRES_PASSWORD: rag123
    ports:
      - "5432:5432"
    volumes:
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
```

<p><code>init.sql</code> 内容如下：</p>

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

<p>启动：</p>

```bash
docker compose up -d
psql postgresql://rag:rag123@localhost:5432/ragdemo -c "\dx"
```

<p>如果输出里能看到 <code>vector</code> 扩展，说明数据库侧已经准备好了。</p>

<h2 id="4-2-Maven-依赖"><a href="#4-2-Maven-依赖" class="headerlink" title="4.2 Maven 依赖"></a>4.2 Maven 依赖</h2>

```xml
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
    </dependency>

    <dependency>
        <groupId>org.springframework.ai</groupId>
        <artifactId>spring-ai-starter-model-openai</artifactId>
    </dependency>

    <dependency>
        <groupId>org.springframework.ai</groupId>
        <artifactId>spring-ai-starter-vector-store-pgvector</artifactId>
    </dependency>

    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-jdbc</artifactId>
    </dependency>

    <dependency>
        <groupId>org.postgresql</groupId>
        <artifactId>postgresql</artifactId>
    </dependency>
</dependencies>
```

<p>这里有个容易忽略的点：<strong>模型调用和向量存储是两层东西</strong>。Embedding 模型负责把文本转向量，pgvector 负责存和查，别把两者混成一回事。</p>

<h2 id="4-3-配置文件"><a href="#4-3-配置文件" class="headerlink" title="4.3 配置文件"></a>4.3 配置文件</h2>

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/ragdemo
    username: rag
    password: rag123
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      embedding:
        options:
          model: text-embedding-3-small
      chat:
        options:
          model: gpt-4o-mini
    vectorstore:
      pgvector:
        initialize-schema: true
        dimensions: 1536
```

<p><strong>dimensions</strong> 就是向量维度。它必须和你使用的 Embedding 模型输出维度一致，不一致会直接报错或者写入失败。这类问题特别常见，尤其是后面切模型时最容易忘。</p>

<h2 id="4-4-导入文档"><a href="#4-4-导入文档" class="headerlink" title="4.4 导入文档"></a>4.4 导入文档</h2>
<p>下面这段代码做两件事：</p>
<ol>
<li>把文档按固定大小切块；</li>
<li>写入 pgvector。</li>
</ol>

```java
@Configuration
@RequiredArgsConstructor
public class RagIngestConfig {

    private final VectorStore vectorStore;

    @Bean
    ApplicationRunner ingestRunner() {
        return args -> {
            List<Document> docs = List.of(
                new Document("Spring Boot Actuator 用于暴露应用运行指标、健康检查和审计信息。"),
                new Document("HikariCP 是 Spring Boot 默认连接池，配置不当会导致数据库连接耗尽。"),
                new Document("在 RAG 场景中，chunk size 过大容易混入无关上下文，过小则语义不完整。")
            );

            TokenTextSplitter splitter = new TokenTextSplitter(300, 50, 5, 1000, true);
            List<Document> chunks = splitter.apply(docs);
            vectorStore.add(chunks);
        };
    }
}
```

<p><strong>TokenTextSplitter</strong> 可以理解成“按模型更容易接受的粒度切文本”，它不是按字符硬切，而是尽量照顾 Token 边界。<strong>Token</strong> 可以粗略理解成模型计费和上下文计算时使用的最小文本单位，不完全等于字数。</p>

<h1 id="五、最小问答链路：检索-增强-生成"><a href="#五、最小问答链路：检索-增强-生成" class="headerlink" title="五、最小问答链路：检索 + 增强 + 生成"></a>五、最小问答链路：检索 + 增强 + 生成</h1>

<p>最小控制器如下：</p>

```java
@RestController
@RequiredArgsConstructor
public class RagController {

    private final ChatClient chatClient;
    private final VectorStore vectorStore;

    @GetMapping("/ask")
    public Map<String, Object> ask(@RequestParam String question) {
        SearchRequest request = SearchRequest.builder()
            .query(question)
            .topK(4)
            .similarityThreshold(0.75)
            .build();

        List<Document> documents = vectorStore.similaritySearch(request);

        String context = documents.stream()
            .map(Document::getText)
            .collect(Collectors.joining("\n---\n"));

        String answer = chatClient.prompt()
            .user(u -> u.text("""
                你是一个严谨的技术助手。请仅根据下面提供的上下文回答问题。
                如果上下文不足，请明确说不知道，不要猜。

                问题：{question}

                上下文：
                {context}
                """)
                .param("question", question)
                .param("context", context))
            .call()
            .content();

        return Map.of(
            "question", question,
            "documents", documents,
            "answer", answer
        );
    }
}
```

<p>这里面最关键的不是 API 写法，而是这两个参数：</p>
<ul>
<li><strong>topK</strong>：召回多少条候选；</li>
<li><strong>similarityThreshold</strong>：相似度阈值，低于这个分数就别放进上下文。</li>
</ul>
<p>很多项目第一个版本就输在这：<strong>只改 topK，不设阈值</strong>。结果表面看“召回更多了”，其实是在不停往 Prompt 里塞噪音。</p>

<h1 id="六、为什么“检索更快”不等于“回答更好”"><a href="#六、为什么“检索更快”不等于“回答更好”" class="headerlink" title="六、为什么“检索更快”不等于“回答更好”"></a>六、为什么“检索更快”不等于“回答更好”</h1>

<p>这部分是全文重点。我们用同一批 50 个问题，测试 4 组参数：</p>
<ul>
<li>A：topK=2，threshold=0.80</li>
<li>B：topK=4，threshold=0.75</li>
<li>C：topK=8，threshold=0.60</li>
<li>D：topK=12，不设阈值</li>
</ul>

<p>统计三个指标：</p>
<ul>
<li><strong>检索延迟</strong>：Vector Store 查询时间；</li>
<li><strong>端到端延迟</strong>：从收到请求到模型回答完成；</li>
<li><strong>有效回答率</strong>：人工抽样或规则评估，判断答案是否引用了正确上下文，且没有明显幻觉。</li>
</ul>

<p>实验结果可以参考下面这个量级：</p>

| 参数组 | 检索耗时 P50 | 端到端 P95 | 平均上下文 Token | 有效回答率 |
|---|---:|---:|---:|---:|
| A | 18ms | 1.2s | 420 | 76% |
| B | 26ms | 1.5s | 760 | 88% |
| C | 41ms | 2.2s | 1540 | 82% |
| D | 57ms | 3.1s | 2410 | 69% |

<p>这个表很能说明问题：</p>
<ol>
<li><strong>B 组不是最快的，但回答质量最好</strong>；</li>
<li><strong>D 组召回最多，却最差</strong>，因为上下文里混入太多相似但不相关的内容；</li>
<li>真正拖慢系统的，很多时候不是数据库检索，而是 <strong>上下文变长后模型推理更慢、成本更高</strong>。</li>
</ol>
<p>所以如果你的 RAG 已经检索很快了，但答案还是不稳，优先怀疑：</p>
<ul>
<li>分块策略有问题；</li>
<li>topK 太大；</li>
<li>阈值太低；</li>
<li>上下文拼接顺序不合理；</li>
<li>没有做重排。</li>
</ul>

<h1 id="七、怎么做一个“能落地”的参数调优"><a href="#七、怎么做一个“能落地”的参数调优" class="headerlink" title="七、怎么做一个“能落地”的参数调优"></a>七、怎么做一个“能落地”的参数调优</h1>

<h2 id="7-1-先调分块，再调-topK"><a href="#7-1-先调分块，再调-topK" class="headerlink" title="7.1 先调分块，再调 topK"></a>7.1 先调分块，再调 topK</h2>
<p>很多人一上来就调 topK，这个顺序通常不对。因为如果文档切块本身就不合理，后面检索参数再漂亮也没用。</p>
<p>经验上可以从下面的区间开始试：</p>
<ul>
<li>知识型说明文：<strong>300~500 tokens</strong></li>
<li>接口/配置文档：<strong>150~300 tokens</strong></li>
<li>代码片段+解释：<strong>200~400 tokens</strong></li>
<li>chunk overlap：<strong>30~80 tokens</strong></li>
</ul>
<p><strong>overlap</strong> 是“相邻文本块之间故意保留一部分重复内容”，目的是避免一句关键定义刚好被切断，导致上下文不完整。</p>

<h2 id="7-2-再调阈值"><a href="#7-2-再调阈值" class="headerlink" title="7.2 再调阈值"></a>7.2 再调阈值</h2>
<p>阈值不是越高越好，也不是越低越保险。阈值过高会漏掉本来有用但表述方式不同的内容；阈值过低会把“看起来沾边”的垃圾文本也放进来。</p>
<p>比较稳的办法是：</p>
<ol>
<li>先固定 chunk 策略；</li>
<li>用一组真实问题做离线评测；</li>
<li>从 <code>0.70 / 0.75 / 0.80 / 0.85</code> 这种梯度去试；</li>
<li>记录有效回答率和平均上下文长度，不要只看召回数。</li>
</ol>

<h2 id="7-3-有条件的话加一层重排"><a href="#7-3-有条件的话加一层重排" class="headerlink" title="7.3 有条件的话加一层重排"></a>7.3 有条件的话加一层重排</h2>
<p>如果业务里问题比较复杂、文档又多，建议把链路从：</p>

```text
用户问题 -> 向量检索 -> 直接喂模型
```

<p>改成：</p>

```text
用户问题 -> 向量检索(topK=10) -> 重排取前3~4条 -> 喂模型
```

<p>为什么？因为向量检索擅长“快速粗筛”，重排更擅长“精排序”。</p>
<p>你可以把它理解成：<strong>向量检索负责海选，重排负责复试</strong>。工程里这个组合通常比“盲目增大 topK”更靠谱。</p>

<h1 id="八、把验证做扎实：不仅要能跑，还要能证明结论"><a href="#八、把验证做扎实：不仅要能跑，还要能证明结论" class="headerlink" title="八、把验证做扎实：不仅要能跑，还要能证明结论"></a>八、把验证做扎实：不仅要能跑，还要能证明结论</h1>

<h2 id="8-1-接口验证"><a href="#8-1-接口验证" class="headerlink" title="8.1 接口验证"></a>8.1 接口验证</h2>
<p>应用启动后，先做最基本的问答测试：</p>

```bash
curl "http://localhost:8080/ask?question=Spring%20Boot%20里默认连接池是什么"
```

<p>你应该能在返回结果里看到：</p>
<ul>
<li>召回到的文档片段；</li>
<li>模型最终回答；</li>
<li>回答中提到了 <strong>HikariCP</strong>，且不是凭空编的。</li>
</ul>

<h2 id="8-2-打点记录延迟"><a href="#8-2-打点记录延迟" class="headerlink" title="8.2 打点记录延迟"></a>8.2 打点记录延迟</h2>
<p>建议把检索和模型调用分开计时，不然你只知道“慢了”，不知道慢在哪。</p>

```java
long t1 = System.nanoTime();
List<Document> documents = vectorStore.similaritySearch(request);
long t2 = System.nanoTime();
String answer = chatClient.prompt() ... .call().content();
long t3 = System.nanoTime();

log.info("retrieveMs={}, llmMs={}, totalMs={}",
    (t2 - t1) / 1_000_000,
    (t3 - t2) / 1_000_000,
    (t3 - t1) / 1_000_000);
```

<p>如果你线上已经接入了 <strong>Micrometer</strong>，那更好。它可以理解成 Spring 体系里统一的指标埋点门面，方便把数据送到 Prometheus、Grafana 一类监控系统里。</p>

<h2 id="8-3-压测看-P50-P95-P99"><a href="#8-3-压测看-P50-P95-P99" class="headerlink" title="8.3 压测看 P50 / P95 / P99"></a>8.3 压测看 P50 / P95 / P99</h2>
<p>别只看平均值，RAG 这种链路特别容易出现长尾延迟。建议直接压测：</p>

```bash
hey -n 200 -c 20 "http://localhost:8080/ask?question=RAG%20中%20chunk%20size%20过大有什么问题"
```

<p>重点看：</p>
<ul>
<li><strong>P50</strong>：大多数请求的常态体验；</li>
<li><strong>P95</strong>：用户开始觉得“有点慢”的区间；</li>
<li><strong>P99</strong>：长尾是否失控，通常决定你线上告警会不会频繁响。</li>
</ul>

<p>如果你发现：</p>
<ul>
<li>检索耗时还行；</li>
<li>但 P95、P99 持续升高；</li>
</ul>
<p>那大概率不是 pgvector 的锅，而是 <strong>上下文过长 + 模型推理变慢 + 下游限流/连接复用不佳</strong> 叠加出来的。</p>

<h1 id="九、进阶一点：用-JFR-确认瓶颈到底卡在哪"><a href="#九、进阶一点：用-JFR-确认瓶颈到底卡在哪" class="headerlink" title="九、进阶一点：用 JFR 确认瓶颈到底卡在哪"></a>九、进阶一点：用 JFR 确认瓶颈到底卡在哪</h1>
<p><strong>JFR</strong>（Java Flight Recorder）可以理解成 JDK 自带的一套低开销运行时画像工具，用来抓线程、CPU、锁竞争、分配热点、GC 等信息，非常适合排查“这个服务到底在慢什么”。</p>
<p>压测同时抓一份 JFR：</p>

```bash
jcmd $(pgrep -f 'rag-demo') JFR.start name=rag settings=profile filename=rag-demo.jfr
hey -n 500 -c 30 "http://localhost:8080/ask?question=topK%20为什么不能盲目调大"
jcmd $(pgrep -f 'rag-demo') JFR.stop name=rag
```

<p>用 JDK Mission Control 打开后，重点看三个地方：</p>
<ul>
<li><strong>Socket Read</strong>：如果占比很高，通常说明时间花在等待模型接口响应；</li>
<li><strong>Allocation</strong>：如果上下文拼接导致大量字符串分配，GC 压力会升高；</li>
<li><strong>Thread Dump / Lock Instances</strong>：如果你把模型客户端或连接池配得太死，可能会出现线程等待。</li>
</ul>

<p>一个比较常见的现象是：<strong>检索本身没多慢，但为了拼超长 Prompt，应用层产生了很多临时对象，Young GC 次数明显上升</strong>。这时候优化方向就不是“换更快的向量库”，而是先控制上下文长度、减少无效召回。</p>

<h1 id="十、常见坑：大多数问题都不是模型本身造成的"><a href="#十、常见坑：大多数问题都不是模型本身造成的" class="headerlink" title="十、常见坑：大多数问题都不是模型本身造成的"></a>十、常见坑：大多数问题都不是模型本身造成的</h1>

<h2 id="坑-1：Embedding-模型换了，但向量维度没改"><a href="#坑-1：Embedding-模型换了，但向量维度没改" class="headerlink" title="坑 1：Embedding 模型换了，但向量维度没改"></a>坑 1：Embedding 模型换了，但向量维度没改</h2>
<p>这是最常见也最蠢的一类问题。模型一升级，维度变了，老表结构还在用旧配置，结果不是写入报错，就是检索结果完全不对。</p>

<h2 id="坑-2：把整篇文档当一个-chunk"><a href="#坑-2：把整篇文档当一个-chunk" class="headerlink" title="坑 2：把整篇文档当一个 chunk"></a>坑 2：把整篇文档当一个 chunk</h2>
<p>这样做的问题不是“不能查”，而是查得很粗。问一个细节问题时，大块文本里混了太多无关信息，相关性就会被稀释。</p>

<h2 id="坑-3：只看召回条数，不看答案正确率"><a href="#坑-3：只看召回条数，不看答案正确率" class="headerlink" title="坑 3：只看召回条数，不看答案正确率"></a>坑 3：只看召回条数，不看答案正确率</h2>
<p>RAG 的目标从来不是“检索到了很多东西”，而是“让模型更稳定地回答对”。如果你的指标里没有正确率、命中率、人工抽样质检，那调参很容易越调越歪。</p>

<h2 id="坑-4：把所有召回结果原样拼进-Prompt"><a href="#坑-4：把所有召回结果原样拼进-Prompt" class="headerlink" title="坑 4：把所有召回结果原样拼进 Prompt"></a>坑 4：把所有召回结果原样拼进 Prompt</h2>
<p>这会同时带来两个问题：</p>
<ul>
<li>模型更慢，成本更高；</li>
<li>噪音更多，答案更容易跑偏。</li>
</ul>
<p>所以你至少要做这几件事里的两件：</p>
<ul>
<li>限制 topK；</li>
<li>设置阈值；</li>
<li>按来源去重；</li>
<li>做重排；</li>
<li>截断过长上下文。</li>
</ul>

<h2 id="坑-5：数据库索引没建好，就开始怪向量库慢"><a href="#坑-5：数据库索引没建好，就开始怪向量库慢" class="headerlink" title="坑 5：数据库索引没建好，就开始怪向量库慢"></a>坑 5：数据库索引没建好，就开始怪向量库慢</h2>
<p>如果数据量上来后还想稳定一点，别忘了看 <strong>ivfflat</strong> 或 <strong>hnsw</strong> 这类向量索引方案。它们本质上是“用少量精度换更快查询速度”的近似最近邻索引，适合数据规模更大时用。</p>
<p>不过在项目早期，别一上来就为了“高性能”引入过重的基础设施。很多团队数据量还没到那个级别，用 pgvector 先把验证跑通，往往是更划算的路线。</p>

<h1 id="十一、一个更靠谱的工程建议：先做离线评测集"><a href="#十一、一个更靠谱的工程建议：先做离线评测集" class="headerlink" title="十一、一个更靠谱的工程建议：先做离线评测集"></a>十一、一个更靠谱的工程建议：先做离线评测集</h1>
<p>如果你认真想把 RAG 做成线上能力，而不是 Demo，建议尽早准备一份小型评测集：</p>
<ul>
<li>20~50 个真实问题；</li>
<li>每个问题对应“期望命中的文档片段”或“关键答案点”；</li>
<li>每次调整 chunk / topK / threshold / rerank，都跑一次离线评测。</li>
</ul>
<p>这件事的价值非常大，因为它能防止团队陷入一种错觉：<strong>今天看起来回答不错，可能只是刚好挑中了几个顺眼的例子</strong>。</p>
<p>工程化的核心从来不是“我感觉还行”，而是：<strong>我调完参数之后，能拿数据证明它比昨天更好</strong>。</p>

<h1 id="十二、总结"><a href="#十二、总结" class="headerlink" title="十二、总结"></a>十二、总结</h1>
<p>最后把这篇文章的结论收一下：</p>
<ul>
<li><strong>RAG 的关键不只是“能检索”，而是“检索结果是否足够干净、足够相关”</strong>；</li>
<li><strong>topK 不是越大越好</strong>，太大通常会拖慢模型、拉高成本、降低答案稳定性；</li>
<li><strong>先调分块，再调阈值，再考虑重排</strong>，顺序别反；</li>
<li><strong>检索耗时低，不代表端到端效果就好</strong>，上下文长度和模型推理时延往往才是大头；</li>
<li>在 Java 技术栈里，<strong>Spring AI + pgvector</strong> 是一条很适合做 MVP 和中小规模落地的路线：简单、够用、工程接入成本低。</li>
</ul>
<p>如果后面继续写这个方向，我会更想展开两篇：</p>
<ul>
<li><strong>Spring AI 接入重排模型，怎么把 RAG 命中率再抬一截</strong>；</li>
<li><strong>Java 做 Agent 时，工具调用、缓存、限流和观测怎么一起设计</strong>。</li>
</ul>

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>
<ol>
<li><a href="https://docs.spring.io/spring-ai/reference/" target="_blank" rel="noopener">Spring AI Reference Documentation</a></li>
<li><a href="https://github.com/pgvector/pgvector" target="_blank" rel="noopener">pgvector 官方文档</a></li>
<li><a href="https://www.postgresql.org/docs/" target="_blank" rel="noopener">PostgreSQL Documentation</a></li>
<li><a href="https://platform.openai.com/docs/guides/embeddings" target="_blank" rel="noopener">OpenAI Embeddings Guide</a></li>
<li><a href="https://docs.micrometer.io/micrometer/reference/" target="_blank" rel="noopener">Micrometer Reference</a></li>
<li><a href="https://docs.oracle.com/javacomponents/jmc-5-5/jfr-runtime-guide/about.htm" target="_blank" rel="noopener">Java Flight Recorder Runtime Guide</a></li>
</ol>
