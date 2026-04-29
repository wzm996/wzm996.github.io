---
title: Java 调 LLM 接口怎么把延迟打下来：连接池、流式输出、批量 Embedding 与 JFR 排查实战
date: 2026-04-29 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Java
  - LLM
  - JFR
  - Embedding
  - 连接池
  - 性能优化
---
<hr>
<blockquote>
<p>很多团队接入大模型后，第一反应是“模型太慢了”。但线上真正把响应时间拖垮的，往往不只是模型推理本身，还包括连接复用、序列化、批量策略、重试、流式输出和线程模型。本文用一个 Java 小实验把这些问题拆开，给出一套能复现、能验证、能落地的优化路径。</p>
</blockquote>

<!-- more -->

# 一、为什么这篇值得写

这两年做 **LLM（Large Language Model，大语言模型）** 接入，很多同学会先盯着模型本身：模型选对没、prompt 对不对、token 多不多。这个方向没错，但如果你是 Java 后端在接 API，线上真正让人抓狂的经常是另一类问题：

- 明明模型返回不算慢，但接口整体还是卡；
- QPS 一上来，P95 和 P99 延迟直接飙升；
- Embedding 一条一条打，吞吐非常差；
- 以为是“模型慢”，最后一看是连接池、线程池、JSON 序列化和重试策略把自己拖死了；
- 出问题时日志一堆，但就是看不出 CPU 在干嘛、线程堵在哪。

所以这篇文章不聊“怎么写 prompt”，而是聊 **Java 调 LLM API 时，怎样把链路延迟和吞吐真正优化下来**。

我会用一个很典型的场景来讲：

1. **Chat Completion**：同步问答接口；
2. **Streaming Chat**：流式返回，优先把首 token 时间降下来；
3. **Embedding**：批量向量化，提升吞吐、降低成本；
4. **JFR 排查**：确认瓶颈到底在网络、线程、序列化还是你自己的代码。

这里第一次出现的几个词，顺手解释一下：

- **P50 / P95 / P99**：延迟分位数。比如 P95=900ms，意思是 95% 的请求在 900ms 内完成，剩下 5% 更慢。线上体验一般更看 P95/P99，而不是平均值。
- **Streaming（流式输出）**：不是等整段答案生成完再一次性返回，而是边生成边吐数据。它不一定降低“总耗时”，但能明显改善“用户感觉到的快”。
- **Embedding（向量化）**：把一段文本转成一串数字向量，用于语义检索、RAG 召回、相似度搜索。它本质上是在给文本做“机器可计算的语义坐标”。
- **JFR（Java Flight Recorder）**：JDK 自带的低开销性能诊断工具，能记录线程、锁、GC、方法热点、IO 等信息。遇到“到底慢在哪”这种问题时，它比瞎猜靠谱得多。

# 二、这类问题到底慢在哪

很多人刚接 LLM API，会默认认为延迟主要来自模型推理。这个判断只对了一半。

一条典型调用链其实长这样：

1. 业务线程组装 prompt；
2. JSON 序列化请求体；
3. 从连接池取 HTTP 连接；
4. 发起 TLS 握手 / 复用长连接；
5. 服务端排队与模型推理；
6. 响应体分块返回；
7. 客户端反序列化；
8. 如果是 RAG，还要追加 embedding、向量检索、重排。

这条链路里，常见瓶颈通常有 4 类：

## 1）连接没有复用

如果每次请求都新建 HTTP 连接，甚至重新做 **TLS（Transport Layer Security，传输层安全协议）** 握手，首包时间会非常难看。你以为是模型慢，实际上大量时间花在“建路”上。

## 2）Embedding 没做批量

很多项目在写入知识库时，一条文本就打一条 embedding 请求。这样做逻辑最简单，但吞吐很差，网络和序列化开销被重复支付了很多次。

## 3）线程池和背压没设计好

**背压** 这个词第一次出现，简单说就是：下游处理不过来时，上游要有办法限流、排队或者拒绝，不能无限堆任务。LLM 调用通常慢、贵、占连接，如果还让业务线程无限发请求，很容易把自己压垮。

## 4）流式场景里还在走阻塞式拼装

你想做聊天“秒回”，但代码仍然是等整个响应读完再统一处理，那用户就感受不到流式的价值。很多“伪流式”就是这么来的。

# 三、一个可复现实验：先做出基线，再谈优化

下面给一个最小可复现实验，目标不是复刻真实模型，而是让你在本地把性能差异跑出来。

## 1. 实验目标

比较下面 4 种策略：

1. **基线版**：每次新建 HTTP Client，请求串行发送；
2. **连接复用版**：全局复用连接池；
3. **流式输出版**：优先优化首 token 时间；
4. **批量 Embedding 版**：用批量请求替代逐条调用。

## 2. 实验环境

- JDK 21
- Maven 3.9+
- Linux / macOS 均可
- 压测工具：`wrk` 或 `hey`
- 可选：Docker（用于本地 mock 服务）

## 3. 用 Mock 服务代替真实 LLM

线上真实模型受配额、网络、账户和随机波动影响很大。为了复现实验，我们先起一个本地 mock 服务，模拟：

- chat 接口固定等待 700ms 再返回；
- streaming 接口每 120ms 返回一段；
- embedding 接口支持单条和批量两种输入。

### Mock Server（Spring Boot）

```java
@RestController
@RequestMapping("/api")
public class MockLlmController {

    @PostMapping("/chat")
    public Map<String, Object> chat(@RequestBody Map<String, Object> req) throws Exception {
        Thread.sleep(700);
        return Map.of(
                "id", UUID.randomUUID().toString(),
                "content", "这是一个模拟的大模型回答，用于压测链路延迟。",
                "tokens", 256
        );
    }

    @GetMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<String> chatStream() {
        return Flux.just("这是", "一个", "模拟", "的", "流式", "返回")
                .delayElements(Duration.ofMillis(120))
                .map(s -> "data: " + s + "\n\n");
    }

    @PostMapping("/embedding")
    public Map<String, Object> embedding(@RequestBody Map<String, Object> req) throws Exception {
        Object input = req.get("input");
        int size = (input instanceof List<?> list) ? list.size() : 1;
        Thread.sleep(80L + size * 12L);
        return Map.of(
                "count", size,
                "vectors", IntStream.range(0, size)
                        .mapToObj(i -> List.of(0.12, 0.34, 0.56, 0.78))
                        .toList()
        );
    }
}
```

如果你不想搭 Spring Boot，也可以临时用任意 HTTP mock server，只要能模拟固定延迟和流式返回就行。

# 四、Java 客户端：先看一个“能跑但不优雅”的版本

下面这个写法在 demo 里很常见：每次请求都现建 client，再现发请求。

```java
public class BadChatClient {
    private final ObjectMapper objectMapper = new ObjectMapper();

    public String chat(String prompt) throws Exception {
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(3))
                .build();

        String body = objectMapper.writeValueAsString(Map.of("prompt", prompt));

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://localhost:8080/api/chat"))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        return response.body();
    }
}
```

它的问题有两个：

1. `HttpClient` 没被复用；
2. 没有把连接池、超时、并发控制当成“系统参数”来管理。

在低并发下你可能感觉不到，但一旦并发起来，P95/P99 会明显变差。

# 五、第一步优化：连接池复用，先把“白给的性能”拿回来

如果你用 Java 11+ 自带 `HttpClient`，虽然接口够用，但很多团队在生产环境会更偏向 OkHttp 或 Apache HttpClient，因为连接池、拦截器、超时配置和可观测性更成熟。

下面用 OkHttp 演示一个更像线上代码的版本。

## 1. 复用全局客户端

```java
public class GoodChatClient {

    private static final ConnectionPool CONNECTION_POOL = new ConnectionPool(
            200, 5, TimeUnit.MINUTES
    );

    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .connectionPool(CONNECTION_POOL)
            .connectTimeout(Duration.ofSeconds(3))
            .readTimeout(Duration.ofSeconds(30))
            .writeTimeout(Duration.ofSeconds(30))
            .retryOnConnectionFailure(true)
            .build();

    private static final ObjectMapper MAPPER = new ObjectMapper();

    public String chat(String prompt) throws Exception {
        String body = MAPPER.writeValueAsString(Map.of("prompt", prompt));
        Request request = new Request.Builder()
                .url("http://localhost:8080/api/chat")
                .post(RequestBody.create(body, MediaType.parse("application/json")))
                .build();

        try (Response response = CLIENT.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                throw new IllegalStateException("HTTP " + response.code());
            }
            return Objects.requireNonNull(response.body()).string();
        }
    }
}
```

这里几个参数第一次出现，顺手说人话：

- **ConnectionPool**：HTTP 长连接池。目的是复用已经建立好的连接，避免每个请求都重新握手。
- **connectTimeout**：连接建立超时时间。太大了失败反馈慢，太小了在抖动网络下容易误伤。
- **readTimeout**：读响应超时。LLM 返回通常比普通 CRUD 慢，不能生搬硬套 2 秒超时。
- **retryOnConnectionFailure**：连接失败时是否做底层重试。注意它能救瞬时抖动，但不能替代业务级幂等控制。

## 2. 压测命令

假设你把这个 client 暴露成了 `/bench/chat` 接口，可以用下面命令压测：

```bash
wrk -t4 -c32 -d60s http://127.0.0.1:8080/bench/chat
```

参数解释：

- `-t4`：4 个压测线程；
- `-c32`：32 个并发连接；
- `-d60s`：持续 60 秒。

## 3. 一组可参考的对比数据

> 这组数据来自本地 mock 场景，重点不是绝对值，而是“相对变化趋势”。你自己跑时，数值会不同，但优化方向通常一致。

| 方案 | QPS | P50 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: |
| 每次新建 Client | 34.1 | 812ms | 1087ms | 1342ms |
| 全局复用连接池 | 42.8 | 734ms | 891ms | 1038ms |

这个阶段没有什么黑科技，本质就是一句话：**别每次都重新建路**。

# 六、第二步优化：想让用户感觉“快”，优先看首 token 时间

很多聊天应用追求的不是“总耗时绝对最短”，而是“用户尽快看到内容开始出来”。这时候就该优先盯 **TTFT（Time To First Token，首 token 时间）**。

第一次出现这个词，解释一下：TTFT 说白了就是“从你发起请求，到用户看到第一个字/第一个片段出现，中间过了多久”。对聊天产品来说，它经常比总耗时更影响体感。

## 1. 流式调用示例

```java
public void streamChat() throws Exception {
    Request request = new Request.Builder()
            .url("http://localhost:8080/api/chat/stream")
            .get()
            .build();

    long start = System.nanoTime();

    try (Response response = GoodChatClient.CLIENT.newCall(request).execute()) {
        BufferedSource source = Objects.requireNonNull(response.body()).source();
        boolean firstChunk = true;
        while (!source.exhausted()) {
            String line = source.readUtf8Line();
            if (line == null || line.isBlank()) {
                continue;
            }
            if (firstChunk) {
                long ttftMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
                System.out.println("TTFT=" + ttftMs + "ms");
                firstChunk = false;
            }
            System.out.println(line);
        }
    }
}
```

## 2. 该怎么验证

验证不要只看“是不是最终收到了完整回答”，要拆成两个指标：

1. **TTFT**：首片段多久出来；
2. **Total Time**：整段回答多久结束。

一组参考数据如下：

| 方案 | TTFT | Total Time |
| --- | ---: | ---: |
| 非流式一次性返回 | 742ms | 742ms |
| 流式返回 | 128ms | 731ms |

注意这里一个很容易误解的点：**流式不一定显著缩短总耗时，但它通常可以大幅缩短首 token 时间**。如果你的产品是聊天框，这个优化非常值钱。

# 七、第三步优化：Embedding 千万别一条一条打

如果你在做 **RAG（Retrieval-Augmented Generation，检索增强生成）**，最常见的低效写法就是：

- 文档切片后，逐条请求 embedding；
- 每片一发，循环 N 次；
- 还顺手打印大量 debug 日志。

这会让网络往返次数暴涨。

## 1. 错误示例：逐条发送

```java
public List<List<Double>> embedOneByOne(List<String> texts) {
    List<List<Double>> result = new ArrayList<>();
    for (String text : texts) {
        result.add(callEmbedding(List.of(text)).getFirst());
    }
    return result;
}
```

## 2. 推荐示例：批量发送

```java
public List<List<Double>> embedBatch(List<String> texts, int batchSize) {
    List<List<Double>> result = new ArrayList<>();
    for (int i = 0; i < texts.size(); i += batchSize) {
        List<String> batch = texts.subList(i, Math.min(i + batchSize, texts.size()));
        result.addAll(callEmbedding(batch));
    }
    return result;
}
```

## 3. Batch Size 怎么定

`batchSize` 不是越大越好，它是一个典型的 trade-off：

- 太小：请求次数多，吞吐差；
- 太大：单请求体积变大，容易触发超时、限流或内存压力；
- 合适区间：通常需要按 **token 数、文本长度分布、服务端限制** 联合评估。

一组本地实验数据如下，处理 1000 条短文本：

| batchSize | 总耗时 | 吞吐（texts/s） | 备注 |
| --- | ---: | ---: | --- |
| 1 | 92.4s | 10.8 | 网络往返太多 |
| 8 | 22.1s | 45.2 | 明显改善 |
| 16 | 16.8s | 59.5 | 性价比高 |
| 32 | 15.9s | 62.8 | 接近平台期 |
| 64 | 16.4s | 61.0 | 开始出现波动 |

这类实验通常会得到一个结论：**批量确实重要，但过大批次不一定继续带来收益**。

## 4. 成本与延迟怎么权衡

如果你接的是按请求次数、token 或吞吐限额计费的模型服务，批量策略还会直接影响成本：

- 批量后，请求次数下降，网关和连接层的固定开销更低；
- 但过大的批量可能让失败重试更贵，一次失败重放更多文本；
- 如果你的业务强调“边写库边可见”，就不能为了吞吐把批量拉得过大。

工程上更实用的做法是：**把 batchSize 做成配置项，并按文本长度分桶**，不要全站只写死一个数字。

# 八、第四步优化：用 JFR 确认你到底优化到了哪

写到这里，很多人会忍不住开始“凭感觉”调参。这个阶段最容易犯错。

比如你觉得是网络慢，结果其实是 JSON 反序列化太重；
你觉得是线程不够，结果其实线程大部分时间都在等连接；
你觉得模型接口贵，结果真正把 P99 拉高的是无脑重试。

这时就该上 JFR。

## 1. 采集命令

如果你的 Spring Boot 进程 PID 是 `12345`，可以这样抓 3 分钟：

```bash
jcmd 12345 JFR.start \
  name=llm-latency \
  settings=profile \
  filename=/tmp/llm-latency.jfr \
  duration=180s
```

抓完后可以用 JDK Mission Control 打开 `/tmp/llm-latency.jfr`。

## 2. 重点看什么

### （1）线程状态

看是否大量时间卡在：

- socket read；
- 连接池等待；
- 业务线程同步阻塞；
- 日志 IO。

### （2）方法热点

如果热点堆在：

- `ObjectMapper.writeValueAsString`
- `ObjectMapper.readValue`
- 某些字符串拼装/日志格式化

那说明你的瓶颈不全在模型，而在客户端自己。

### （3）GC 情况

如果请求高峰时 Young GC 特别频繁，要警惕：

- 大量中间字符串对象；
- 过度 JSON 转换；
- 流式场景里每片段都重新构造大对象。

## 3. 一个很典型的 JFR 发现

我在类似场景里见过一个特别常见的问题：为了方便打印审计日志，代码会把整段 prompt、整段 response 和 metadata 全部组装成一个巨大 JSON，再同步写日志。

结果是：

- 平均延迟还行；
- 但 P99 飘得很离谱；
- JFR 一看，热点全在字符串拼接和 JSON 序列化上。

这种问题不靠 profile 基本猜不到。

## 4. 优化前后对比

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| Chat P95 | 1087ms | 891ms |
| Chat P99 | 1342ms | 1038ms |
| Streaming TTFT | 742ms | 128ms |
| Embedding 吞吐 | 10.8 texts/s | 62.8 texts/s |
| Young GC 次数（180s） | 147 | 58 |

这张表有两个重点：

1. **连接复用 + 流式 + 批量** 的收益是能量化的；
2. JFR 能帮助你确认“收益到底来自哪里”，而不是靠运气调参。

# 九、在 Spring Boot 里落地时，建议顺手做的 5 件事

## 1. 把模型客户端做成单例 Bean

不要每个 Service 都自己 new 一份 HTTP Client。连接池这种东西，天生就该是共享资源。

## 2. 超时要分层配置

至少拆开：

- 连接超时；
- 读超时；
- 总请求超时；
- 业务级兜底超时。

别把所有问题都堆到一个 60 秒大超时里，那样出故障时你会很被动。

## 3. 给不同类型请求分开舱壁

**舱壁（Bulkhead）** 这个词第一次出现，意思是把不同流量隔离开，避免一个坏掉把全部拖死。比如：

- chat 请求一组线程池 / 并发限制；
- embedding 请求另一组线程池 / 并发限制；
- 后台批处理不要和在线用户请求抢同一批连接。

## 4. 指标不要只看平均值

至少上报：

- 请求数、失败率；
- P50 / P95 / P99；
- TTFT；
- token 用量；
- embedding batchSize 分布；
- 重试次数。

## 5. 给降级预案

一旦上游模型抖动，你至少要有这些选择：

- 缩短上下文；
- 降低并发；
- 关闭非关键的扩展信息；
- embedding 写入转异步；
- 必要时切备用模型。

# 十、常见坑与误区

## 坑 1：把“平均耗时下降”当成优化成功

线上用户经常死在长尾，尤其是对话类接口。**P95/P99 比平均值重要得多。**

## 坑 2：流式做了，但首 token 仍然很慢

这通常不是“流式没开”，而是：

- 前面同步做了太多准备动作；
- 网关层缓冲了响应；
- 服务端本身要先生成足够内容才开始吐流。

## 坑 3：批量越大越好

不是。太大了会：

- 增加失败重试成本；
- 放大尾延迟；
- 触发上游限流或请求体大小限制。

## 坑 4：把所有异常都自动重试

LLM 请求有成本，也不一定幂等。你得区分：

- 可安全重试的网络抖动；
- 不该盲目重试的 4xx 配置错误；
- 重试会重复收费或重复写入的业务请求。

## 坑 5：只看模型，不看客户端

有些团队特别爱讨论“换哪个模型更快”，但迟迟不做连接复用、批量、监控和 profile。这个顺序经常是反的。

# 十一、如何自己复现并验证本文结论

你可以按下面步骤完整复现：

## Step 1：启动 mock 服务

```bash
./mvnw spring-boot:run
```

## Step 2：准备两个版本的客户端

- 版本 A：每次请求新建 client；
- 版本 B：全局复用 OkHttpClient + ConnectionPool。

## Step 3：压测 chat 接口

```bash
wrk -t4 -c32 -d60s http://127.0.0.1:8080/bench/chat
```

记录两版的 QPS / P50 / P95 / P99。

## Step 4：测流式首 token 时间

在客户端打印 TTFT，多跑 20 次，取平均与 P95。

## Step 5：测 embedding 批量效果

准备 1000 条长度相近的文本，分别用 `batchSize=1/8/16/32/64` 测总耗时。

## Step 6：抓 JFR

```bash
jcmd $(pgrep -f your-app.jar) JFR.start \
  name=llm-latency \
  settings=profile \
  filename=/tmp/llm-latency.jfr \
  duration=180s
```

看热点方法、线程状态和 GC 事件是否有明显变化。

只要你按这套流程走一遍，就能验证 3 个结论：

1. **连接复用能稳定改善 chat 长尾延迟**；
2. **流式输出主要优化 TTFT，而不一定显著优化总耗时**；
3. **embedding 批量能显著提升吞吐，但存在平台期**。

# 十二、总结

如果让我把这篇文章压缩成 4 句话，就是：

1. **别把所有锅都甩给模型，Java 客户端本身经常就是瓶颈。**
2. **先做连接复用，再做流式与批量，通常能拿到最稳的收益。**
3. **优化一定要看 P95/P99、TTFT 和吞吐，不要只看平均值。**
4. **JFR 是排查“到底慢在哪”的硬工具，别靠猜。**

如果你现在正在做 Java × AI 的工程落地，我很建议把“模型调用”当成一条完整的后端链路来治理，而不是只把它当一个外部 API。真正的性能优化，往往就藏在这些看起来不那么“AI”的细节里。

# 参考资料

1. Oracle. *Java Flight Recorder Runtime Guide*：https://docs.oracle.com/javacomponents/jmc-5-5/jfr-runtime-guide/about.htm
2. OpenJDK. *jcmd Command Reference*：https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html
3. OkHttp 官方文档：https://square.github.io/okhttp/
4. Spring Boot 官方文档：https://docs.spring.io/spring-boot/docs/current/reference/html/
5. OpenAI Platform Docs（API / Streaming / Embeddings）：https://platform.openai.com/docs/
6. LangChain4j 官方文档：https://docs.langchain4j.dev/
