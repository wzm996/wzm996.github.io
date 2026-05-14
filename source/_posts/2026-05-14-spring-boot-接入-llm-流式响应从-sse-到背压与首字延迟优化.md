---
title: Spring Boot 接入 LLM 流式响应：从 SSE 到背压与首字延迟优化
date: 2026-05-14 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - Spring Boot
  - SSE
  - LLM
  - 背压
  - 性能优化
---
<hr>
<blockquote>
<p>LLM 接口接进业务系统以后，最容易被低估的不是“能不能调通”，而是“高并发下还能不能稳定地把第一个字尽快吐给用户”。这篇文章用一个可运行的 Spring Boot 示例，把 SSE 流式响应、线程模型、背压、连接池和首字延迟放到一起讲清楚。</p>
</blockquote>

<!-- more -->

<h1 id="为什么-LLM-接口一上线就容易卡"><a href="#为什么-LLM-接口一上线就容易卡" class="headerlink" title="为什么 LLM 接口一上线就容易卡"></a>为什么 LLM 接口一上线就容易卡</h1>

很多 Java 项目第一次接入大模型时，会先写一个最朴素的接口：后端收到用户问题，调用模型 API，等模型完整返回，再一次性把答案塞给前端。这个方案在 Demo 阶段很舒服，但一到真实业务就会暴露几个问题：

1. 用户体感很差：模型可能 5~20 秒才完整返回，页面像“死了”一样。
2. 服务端线程被长期占住：每个请求都在等远端模型慢慢吐结果。
3. 峰值流量时排队严重：连接池、Servlet 线程池、下游 API 限流会互相放大。
4. 失败不好定位：到底是模型慢、网络慢、连接池满，还是前端读得慢？

所以生产环境通常会用 **流式响应**。流式响应就是模型每生成一小段 token，后端就立刻转发给前端，用户能边看边等。本文选择 **SSE（Server-Sent Events）** 来实现：SSE 是浏览器原生支持的一种“服务端持续向浏览器推消息”的 HTTP 机制，适合文本流、通知、进度条、AI 逐字输出这类场景。

本文目标读者：

- 已经会写 Spring Boot REST 接口；
- 知道基本的 HTTP 请求响应模型；
- 准备把 Java 后端接入 LLM / RAG / Agent 类应用；
- 关心首字延迟、吞吐、线程池和稳定性。

<h1 id="候选选题与最终选择"><a href="#候选选题与最终选择" class="headerlink" title="候选选题与最终选择"></a>候选选题与最终选择</h1>

按照每日技术专栏的选题规则，本次先给出 4 个候选：

| 候选 | 主线 | 分类 | 亮点 |
| --- | --- | --- | --- |
| Spring Boot 接入 LLM 流式响应：从 SSE 到背压与首字延迟优化 | AI / 工程实践 | 后端工程 / 性能与高并发 | 可运行 Demo、wrk 压测、首字延迟对比、常见生产坑 |
| MySQL 覆盖索引为什么能减少回表：用 EXPLAIN ANALYZE 看一次真实执行计划 | 数据库与数据建模 | 数据库与存储 / MySQL | SQL 实验、执行计划、优化前后对比 |
| Java 线程池不是越大越好：一次队列堆积到接口超时的复盘 | 工程实践 | 后端工程 / 性能与高并发 | 线程池参数、压测、拒绝策略、监控指标 |
| HTTP/2 多路复用真能提升接口性能吗：用 curl 和 nghttp2 做个小实验 | 计算机网络 | 计算机网络 / HTTP/HTTPS | 抓包、延迟对比、队头阻塞解释 |

最终选择第一个题目，原因很直接：Java × AI 是当前更值得持续建设的方向，而且 SSE + 背压 + 首字延迟不是空泛概念，能用很小的实验复现出来，读者可以直接迁移到 Spring AI、LangChain4j 或自研模型网关里。

<h1 id="先把几个新名词说人话"><a href="#先把几个新名词说人话" class="headerlink" title="先把几个新名词说人话"></a>先把几个新名词说人话</h1>

- **LLM（Large Language Model）**：大语言模型，可以理解成会按上下文生成文本的模型服务，常见用途是问答、摘要、代码生成、Agent 推理。
- **Token**：模型处理文本的基本片段，可以粗略理解成“字/词/子词”的混合单位；模型通常不是一次生成整段答案，而是一个 token 一个 token 往外吐。
- **首字延迟（Time To First Token, TTFT）**：从用户发起请求，到看到第一个有效输出之间的时间；AI 产品里它比总耗时更影响体感。
- **SSE（Server-Sent Events）**：服务端通过一个 HTTP 长连接不断向浏览器发送事件；浏览器端用 `EventSource` 就能接收。
- **背压（Backpressure）**：下游处理不过来时，系统要有办法让上游慢一点或丢弃/排队，而不是无限堆内存；一句话，背压就是“别让快的一端把慢的一端撑爆”。
- **P95 / P99 延迟**：把所有请求耗时排序后，95% / 99% 的请求都不超过这个值；它比平均值更能暴露长尾问题。

<h1 id="整体架构：不要把模型流直接裸奔给前端"><a href="#整体架构：不要把模型流直接裸奔给前端" class="headerlink" title="整体架构：不要把模型流直接裸奔给前端"></a>整体架构：不要把模型流直接裸奔给前端</h1>

一个最小可用的流式 AI 接口大概长这样：

```text
Browser/EventSource
        |
        |  GET /api/chat/stream?q=...
        v
Spring Boot Controller
        |
        |  调用模型网关 / 模型 API
        v
LLM Provider Stream
        |
        |  token chunk
        v
SseEmitter / WebFlux Flux
        |
        v
Browser 逐段渲染
```

这里有一个工程经验：**前端不应该直接连外部模型 API**。原因包括：

1. API Key 不能暴露给浏览器；
2. 需要统一鉴权、审计、限流、计费；
3. 需要把不同模型供应商的返回格式适配成统一协议；
4. 需要做超时、重试、降级和敏感词处理；
5. 需要打点：首字延迟、总耗时、token 数、失败原因。

本文不依赖真实模型 API，而是先写一个“模拟模型流”。这反而更适合做实验：可控、可复现，不受外部模型波动影响。

<h1 id="可运行示例：Spring-Boot-SSE-流式输出"><a href="#可运行示例：Spring-Boot-SSE-流式输出" class="headerlink" title="可运行示例：Spring Boot SSE 流式输出"></a>可运行示例：Spring Boot SSE 流式输出</h1>

下面示例基于 JDK 21 + Spring Boot 3.x。JDK 21 的 **虚拟线程（Virtual Thread）** 是一种轻量级线程，适合大量 I/O 等待场景；它不是让 CPU 变快，而是让“等网络、等文件、等下游”的线程成本更低。

<h2 id="1-创建项目依赖"><a href="#1-创建项目依赖" class="headerlink" title="1. 创建项目依赖"></a>1. 创建项目依赖</h2>

`pom.xml`：

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <groupId>com.example</groupId>
    <artifactId>llm-sse-demo</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.3.5</version>
    </parent>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
        </dependency>
    </dependencies>
</project>
```

`application.yml`：

```yaml
server:
  port: 8080
  tomcat:
    threads:
      max: 200
spring:
  threads:
    virtual:
      enabled: true
management:
  endpoints:
    web:
      exposure:
        include: health,metrics
```

<h2 id="2-实现一个模拟模型流"><a href="#2-实现一个模拟模型流" class="headerlink" title="2. 实现一个模拟模型流"></a>2. 实现一个模拟模型流</h2>

`FakeLlmClient.java`：

```java
package com.example.demo;

import java.time.Duration;
import java.util.List;
import java.util.function.Consumer;

public class FakeLlmClient {

    private static final List<String> TOKENS = List.of(
            "你好，", "这是一个 ", "Spring Boot ", "SSE ", "流式响应 ",
            "示例。", "它会模拟 ", "LLM ", "逐段输出。"
    );

    public void stream(String prompt, Consumer<String> onToken) {
        sleep(Duration.ofMillis(350)); // 模拟模型首 token 前的推理时间
        for (String token : TOKENS) {
            onToken.accept(token);
            sleep(Duration.ofMillis(120)); // 模拟后续 token 输出间隔
        }
    }

    private static void sleep(Duration duration) {
        try {
            Thread.sleep(duration);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException(e);
        }
    }
}
```

`DemoApplication.java`：

```java
package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class DemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }

    @Bean
    FakeLlmClient fakeLlmClient() {
        return new FakeLlmClient();
    }
}
```

<h2 id="3-Controller：用-SseEmitter-输出"><a href="#3-Controller：用-SseEmitter-输出" class="headerlink" title="3. Controller：用 SseEmitter 输出"></a>3. Controller：用 SseEmitter 输出</h2>

`ChatController.java`：

```java
package com.example.demo;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@RestController
public class ChatController {

    private final FakeLlmClient fakeLlmClient;
    private final ExecutorService streamExecutor = Executors.newVirtualThreadPerTaskExecutor();

    public ChatController(FakeLlmClient fakeLlmClient) {
        this.fakeLlmClient = fakeLlmClient;
    }

    @GetMapping(value = "/api/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@RequestParam String q) {
        SseEmitter emitter = new SseEmitter(Duration.ofSeconds(30).toMillis());
        Instant start = Instant.now();

        streamExecutor.submit(() -> {
            try {
                fakeLlmClient.stream(q, token -> {
                    try {
                        long costMs = Duration.between(start, Instant.now()).toMillis();
                        emitter.send(SseEmitter.event()
                                .name("token")
                                .data(new TokenChunk(token, costMs)));
                    } catch (IOException e) {
                        throw new ClientGoneException(e);
                    }
                });
                emitter.send(SseEmitter.event().name("done").data("[DONE]"));
                emitter.complete();
            } catch (ClientGoneException e) {
                emitter.complete();
            } catch (Exception e) {
                emitter.completeWithError(e);
            }
        });

        return emitter;
    }

    record TokenChunk(String text, long elapsedMs) {}

    static class ClientGoneException extends RuntimeException {
        ClientGoneException(Throwable cause) {
            super(cause);
        }
    }
}
```

这段代码有几个关键点：

- `produces = MediaType.TEXT_EVENT_STREAM_VALUE` 会把响应 Content-Type 设置成 `text/event-stream`。
- `SseEmitter` 是 Spring MVC 提供的 SSE 封装，适合在 Servlet 模型里渐进式写响应。
- `Executors.newVirtualThreadPerTaskExecutor()` 让每个流式请求有一个虚拟线程去等待“模型输出”。
- 捕获 `IOException` 是必要的，因为用户关闭页面后，服务端继续 `send` 就可能报错。

<h2 id="4-用-curl-验证流式输出"><a href="#4-用-curl-验证流式输出" class="headerlink" title="4. 用 curl 验证流式输出"></a>4. 用 curl 验证流式输出</h2>

启动项目：

```bash
mvn spring-boot:run
```

请求接口：

```bash
curl -N 'http://localhost:8080/api/chat/stream?q=hello'
```

`-N` 的意思是关闭 curl 的输出缓冲，否则你可能以为服务端没有流式返回。预期能看到类似输出：

```text
event:token
data:{"text":"你好，","elapsedMs":356}

event:token
data:{"text":"这是一个 ","elapsedMs":480}

event:done
data:[DONE]
```

如果第一段 `elapsedMs` 大约在 350ms 左右，说明首 token 没有等完整答案结束才返回。

<h1 id="压测：一次性返回-vs-流式返回"><a href="#压测：一次性返回-vs-流式返回" class="headerlink" title="压测：一次性返回 vs 流式返回"></a>压测：一次性返回 vs 流式返回</h1>

为了对比，我们再补一个非流式接口：

```java
@GetMapping("/api/chat/blocking")
public String blocking(@RequestParam String q) {
    StringBuilder sb = new StringBuilder();
    fakeLlmClient.stream(q, sb::append);
    return sb.toString();
}
```

然后用 `wrk` 做一个轻量压测。`wrk` 是一个 HTTP 压测工具，适合快速看吞吐和延迟分布；它不是完整的容量评估平台，但足够做本地对比实验。

安装后执行：

```bash
wrk -t4 -c50 -d30s 'http://localhost:8080/api/chat/blocking?q=hello'
wrk -t4 -c50 -d30s 'http://localhost:8080/api/chat/stream?q=hello'
```

在一台 8C / 16G 的普通开发机上，模拟模型总耗时约 1.4s，示例数据可能类似下面这样（不同机器会有差异，重点看趋势）：

| 接口 | 并发 | 平均响应耗时 | P95 | P99 | 用户首字延迟 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/api/chat/blocking` | 50 | 1.43s | 1.58s | 1.72s | 约 1.43s |
| `/api/chat/stream` | 50 | 1.45s | 1.61s | 1.78s | 约 0.35s |

这里有个很重要的结论：**流式响应不一定会显著降低请求总耗时，但会显著降低用户体感的等待时间**。模型该生成多少 token 还是要生成多少 token，总账单不会凭空消失；只是用户更早看到了结果。

<h2 id="如何验证结论"><a href="#如何验证结论" class="headerlink" title="如何验证结论"></a>如何验证结论</h2>

至少做三类验证：

1. **功能验证**：用 `curl -N` 看是否逐段输出，而不是最后一次性输出。
2. **首字延迟验证**：在每个 token 里带上 `elapsedMs`，或在服务端打点 `first_token_elapsed_ms`。
3. **并发验证**：用 `wrk` / `hey` 观察 P95、P99、错误率、连接数、CPU 和堆内存。

推荐补充 JVM 侧观察：

```bash
jcmd <pid> Thread.print | head -80
jcmd <pid> GC.heap_info
jcmd <pid> JFR.start name=llm-sse settings=profile duration=60s filename=/tmp/llm-sse.jfr
```

**JFR（Java Flight Recorder）** 是 JDK 自带的低开销运行时分析工具，可以记录线程、锁、分配、GC、I/O 等事件；排查线上性能问题时，它比“看日志猜”靠谱得多。

JFR 文件可以用 JDK Mission Control 打开，重点看：

- 线程是否大量阻塞在模型 HTTP 调用上；
- 是否出现频繁 GC 或大对象分配；
- `SseEmitter.send` 是否因为客户端慢读而耗时异常；
- 虚拟线程是否出现 pinning。

**Pinning** 指虚拟线程因为进入 `synchronized` 或某些 native / 阻塞区域，导致底层平台线程被“钉住”不能释放；它会削弱虚拟线程的扩展性。

<h1 id="背压：流式接口最容易忽略的一环"><a href="#背压：流式接口最容易忽略的一环" class="headerlink" title="背压：流式接口最容易忽略的一环"></a>背压：流式接口最容易忽略的一环</h1>

上面的 `SseEmitter` 示例能跑，但它不是完整生产方案。最大问题是：如果模型输出很快，客户端网络很慢，服务端怎么办？

常见错误写法是把模型 token 先塞进无界队列：

```java
BlockingQueue<String> queue = new LinkedBlockingQueue<>(); // 危险：默认近似无界
```

这在压测里很容易把堆内存撑高。更稳妥的做法是使用有界队列，并明确超时/丢弃/终止策略：

```java
BlockingQueue<String> queue = new ArrayBlockingQueue<>(128);
boolean offered = queue.offer(token, 200, TimeUnit.MILLISECONDS);
if (!offered) {
    throw new IllegalStateException("client is too slow, backpressure triggered");
}
```

这段逻辑的意思是：最多允许积压 128 个 token，如果 200ms 内还塞不进去，就认为下游太慢，主动中断本次流。看起来有点“狠”，但比把整台机器拖死要健康。

生产里通常会按业务选择策略：

| 策略 | 适用场景 | 风险 |
| --- | --- | --- |
| 等待 | 内部系统、低并发 | 慢客户端会占资源 |
| 丢弃中间 token | 日志/进度类消息 | AI 正文不适合，容易语义断裂 |
| 主动断开 | 公开接口、高并发 | 用户体验受影响，但保护系统 |
| 降级为非流式 | 网络不稳定场景 | 首字延迟变差 |

<h1 id="连接池与超时：别让慢模型拖垮自己"><a href="#连接池与超时：别让慢模型拖垮自己" class="headerlink" title="连接池与超时：别让慢模型拖垮自己"></a>连接池与超时：别让慢模型拖垮自己</h1>

如果把 `FakeLlmClient` 换成真实模型 API，还要补齐 HTTP 客户端配置。以 JDK `HttpClient` 或 OkHttp 为例，至少要关心：

- 连接超时：连不上模型服务时多久放弃；
- 读取超时：模型长时间不吐 token 时多久中断；
- 最大连接数：避免瞬时请求把对端和自己都打爆；
- 重试策略：流式输出已经开始后，不要盲目重试，否则前端会收到重复内容；
- 请求取消：用户关闭页面时，要尽量取消下游模型请求。

一个常见的经验值是：

```text
connectTimeout: 1s ~ 3s
firstTokenTimeout: 5s ~ 15s
idleTokenTimeout: 10s ~ 30s
maxConcurrentStreams: 按模型限流和成本预算设置
```

这里的 **idleTokenTimeout** 指“已经开始流式返回后，如果连续一段时间没有新 token，就认为这条流卡住了”。它和总超时不一样，更适合处理模型服务中途挂住的情况。

<h1 id="成本与延迟权衡：不是所有问题都要实时生成"><a href="#成本与延迟权衡：不是所有问题都要实时生成" class="headerlink" title="成本与延迟权衡：不是所有问题都要实时生成"></a>成本与延迟权衡：不是所有问题都要实时生成</h1>

LLM 接口还有一个传统后端不太习惯的问题：**每次生成都可能是真金白银**。所以性能优化不能只看 QPS，还要看 token 成本。

可以从这些维度做对比：

| 优化手段 | 首字延迟 | 总成本 | 适用场景 |
| --- | --- | --- | --- |
| Prompt 精简 | 降低 | 降低 | 所有场景 |
| 缓存相同问题 | 极低 | 显著降低 | FAQ、固定知识库 |
| 小模型预判 + 大模型生成 | 可能降低 | 中等 | 分类、路由、意图识别 |
| RAG 召回裁剪 | 降低 | 降低 | 知识库问答 |
| 流式输出 | 显著降低体感等待 | 不直接降低 | 长答案生成 |

**RAG（Retrieval-Augmented Generation）** 是“先检索资料，再让模型基于资料回答”的模式，常用于企业知识库问答。它能减少模型胡说，但如果召回内容太多，也会增加 token 成本和延迟。

<h1 id="生产化建议：至少把这几个指标打出来"><a href="#生产化建议：至少把这几个指标打出来" class="headerlink" title="生产化建议：至少把这几个指标打出来"></a>生产化建议：至少把这几个指标打出来</h1>

如果要上线，我建议至少埋这些指标：

```text
llm.request.count
llm.request.error.count
llm.stream.first_token.latency
llm.stream.total.latency
llm.stream.token.count
llm.stream.client_abort.count
llm.stream.backpressure.count
llm.provider.rate_limit.count
llm.provider.timeout.count
```

其中 `client_abort` 很有用：用户关闭页面、切换问题、刷新浏览器都会导致连接断开。如果这个指标很高，不一定是服务端错了，可能是首字太慢、答案太长，或者前端交互让用户频繁取消。

<h1 id="常见坑与误区"><a href="#常见坑与误区" class="headerlink" title="常见坑与误区"></a>常见坑与误区</h1>

<h2 id="1-curl-不用-N-导致误判"><a href="#1-curl-不用-N-导致误判" class="headerlink" title="1. curl 不用 -N 导致误判"></a>1. curl 不用 `-N` 导致误判</h2>

curl 默认可能缓冲输出，测试 SSE 时请使用：

```bash
curl -N 'http://localhost:8080/api/chat/stream?q=hello'
```

否则你会以为服务端没流式返回。

<h2 id="2-Nginx-默认缓冲导致前端还是一次性看到"><a href="#2-Nginx-默认缓冲导致前端还是一次性看到" class="headerlink" title="2. Nginx 默认缓冲导致前端还是一次性看到"></a>2. Nginx 默认缓冲导致前端还是一次性看到</h2>

如果前面挂了 Nginx，记得关闭代理缓冲：

```nginx
location /api/chat/stream {
    proxy_pass http://app;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

<h2 id="3-已经输出一半后不要随便重试"><a href="#3-已经输出一半后不要随便重试" class="headerlink" title="3. 已经输出一半后不要随便重试"></a>3. 已经输出一半后不要随便重试</h2>

非流式接口失败可以重试，流式接口不一样。前端已经收到半段答案后，后端重试可能造成重复、跳字、语义断裂。更稳妥的方式是把错误事件发给前端，让用户决定是否重新生成。

<h2 id="4-只盯平均耗时会被骗"><a href="#4-只盯平均耗时会被骗" class="headerlink" title="4. 只盯平均耗时会被骗"></a>4. 只盯平均耗时会被骗</h2>

AI 接口的体验往往毁在长尾：少量请求 20 秒没首字，用户就会觉得系统不稳定。要看 P95、P99、首字延迟和失败率，不要只看平均值。

<h2 id="5-以为虚拟线程能解决所有问题"><a href="#5-以为虚拟线程能解决所有问题" class="headerlink" title="5. 以为虚拟线程能解决所有问题"></a>5. 以为虚拟线程能解决所有问题</h2>

虚拟线程能降低 I/O 等待成本，但不能替你解决下游限流、网络抖动、CPU 密集计算、无界队列和错误的锁使用。该限流还是要限流，该超时还是要超时。

<h1 id="小结"><a href="#小结" class="headerlink" title="小结"></a>小结</h1>

这篇文章把 Spring Boot 接入 LLM 流式响应的核心链路跑了一遍：

- SSE 适合 AI 文本逐段输出，能明显改善首字体验；
- 流式响应不等于总耗时变短，它主要优化用户体感；
- 高并发下要关注背压，别用无界队列硬扛；
- 真实模型 API 必须配置连接池、超时、取消和限流；
- 上线后要看 P95/P99、首字延迟、client abort、backpressure 等指标；
- JFR 可以帮助排查线程、I/O、GC 和虚拟线程 pinning 问题。

如果只记一句话：**AI 流式接口不是把模型返回值原样转发给前端，而是一个要认真设计的高并发长连接接口。**

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

1. Spring Framework Reference：Web MVC Async Requests / SSEEmitter，https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-async.html
2. Spring Boot Reference：Virtual Threads，https://docs.spring.io/spring-boot/reference/features/spring-application.html#features.spring-application.virtual-threads
3. MDN：Using server-sent events，https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
4. OpenJDK JEP 444：Virtual Threads，https://openjdk.org/jeps/444
5. Oracle Docs：Java Flight Recorder Runtime Guide，https://docs.oracle.com/javacomponents/jmc-5-5/jfr-runtime-guide/
6. Nginx Documentation：proxy_buffering，https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering
7. 阿里云开发者社区：Java 应用性能诊断与 JFR 相关实践文章，https://developer.aliyun.com/
8. 美团技术团队：系统性能优化与可观测性相关实践文章，https://tech.meituan.com/
