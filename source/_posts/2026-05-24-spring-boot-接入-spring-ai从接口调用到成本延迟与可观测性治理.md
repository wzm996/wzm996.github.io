---
title: Spring Boot 接入 Spring AI：从接口调用到成本、延迟与可观测性治理
date: 2026-05-24 10:00:00
categories:
  - 后端工程
  - 可观测性
tags:
  - Spring AI
  - Java
  - LLM
  - 可观测性
  - 成本优化
---
<hr>
<blockquote>
<p>把大模型接进 Spring Boot 项目并不难，难的是上线后回答慢、费用飘、错误不好查。本文用一个可运行的 Spring AI 示例，把 <strong>LLM 调用</strong>、缓存、超时、指标采集和压测串起来，重点看清楚：一次模型请求到底慢在哪里、贵在哪里，以及怎么验证优化有没有真的生效。</p>
</blockquote>

<!-- more -->

<h1 id="为什么这篇要从工程化讲起"><a href="#为什么这篇要从工程化讲起" class="headerlink" title="为什么这篇要从工程化讲起"></a>为什么这篇要从工程化讲起</h1>

在 Java 项目里接入大模型，很多教程会停在“调通一个 Chat 接口”。这当然是第一步，但离生产环境还差很远：用户问一句话，接口可能要等 3 秒、8 秒甚至更久；模型价格按 token 计费，流量一上来账单会很实在；模型服务偶尔超时、限流、返回格式不稳定，排查时如果没有日志和指标，基本只能靠猜。

本文选一个很典型的场景：在 Spring Boot 中通过 Spring AI 暴露一个 `/api/ask` 接口，并逐步加上 **缓存**、**超时控制**、**Micrometer 指标** 和 **压测验证**。这里的 **Spring AI** 可以理解为 Spring 生态里访问大模型、Embedding、向量库的一层统一抽象；它解决的是“不要在业务代码里到处手写不同厂商 SDK 调用细节”的问题。**Micrometer** 是 Spring Boot 常用的指标门面，作用类似日志门面 SLF4J：业务只打一套指标，后面可以接 Prometheus、Datadog 等监控系统。

<h2 id="目标读者与先修"><a href="#目标读者与先修" class="headerlink" title="目标读者与先修"></a>目标读者与先修</h2>

本文默认你已经熟悉：

- Java 17+ 基础语法；
- Spring Boot Controller / Service 的常见写法；
- Maven 基础命令；
- 知道 HTTP 接口压测是什么。

不要求你已经用过 Spring AI。文中的新名词第一次出现时都会解释一句。

<h1 id="先把最小可运行版本搭起来"><a href="#先把最小可运行版本搭起来" class="headerlink" title="先把最小可运行版本搭起来"></a>先把最小可运行版本搭起来</h1>

下面示例基于 Spring Boot 3.3.x、Java 21。Java 17 也能跑，但如果后续要做虚拟线程等优化，Java 21 更顺手。

<h2 id="pom-依赖"><a href="#pom-依赖" class="headerlink" title="pom 依赖"></a>pom 依赖</h2>

```xml
<properties>
    <java.version>21</java.version>
    <spring-ai.version>1.0.0</spring-ai.version>
</properties>

<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-bom</artifactId>
            <version>${spring-ai.version}</version>
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
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-cache</artifactId>
    </dependency>
    <dependency>
        <groupId>com.github.ben-manes.caffeine</groupId>
        <artifactId>caffeine</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.ai</groupId>
        <artifactId>spring-ai-openai-spring-boot-starter</artifactId>
    </dependency>
</dependencies>
```

这里用 OpenAI starter 举例，不代表只能接 OpenAI。Spring AI 的价值之一就是把 ChatClient、EmbeddingModel 这类概念抽象出来，后续替换模型供应商时，业务层改动会少一些。

<h2 id="配置文件"><a href="#配置文件" class="headerlink" title="配置文件"></a>配置文件</h2>

```yaml
server:
  port: 8080

spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4o-mini
          temperature: 0.2
  cache:
    type: caffeine
    caffeine:
      spec: maximumSize=1000,expireAfterWrite=10m

management:
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus
  metrics:
    tags:
      application: spring-ai-demo
```

**temperature** 是控制生成随机性的参数，越低越稳定，越高越发散。知识问答、分类、摘要这类工程场景，一般先从 0.1~0.3 开始。

<h2 id="Controller-和-Service"><a href="#Controller-和-Service" class="headerlink" title="Controller 和 Service"></a>Controller 和 Service</h2>

```java
package com.example.ai;

import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class AskController {

    private final AskService askService;

    public AskController(AskService askService) {
        this.askService = askService;
    }

    @PostMapping("/ask")
    public ResponseEntity<Map<String, String>> ask(@RequestBody AskRequest request) {
        String answer = askService.ask(request.question());
        return ResponseEntity.ok(Map.of("answer", answer));
    }

    public record AskRequest(String question) {}
}

@Service
class AskService {

    private final ChatClient chatClient;
    private final MeterRegistry meterRegistry;

    AskService(ChatClient.Builder builder, MeterRegistry meterRegistry) {
        this.chatClient = builder
                .defaultSystem("你是一个严谨的 Java 后端助手，回答要简洁、可验证。")
                .build();
        this.meterRegistry = meterRegistry;
    }

    @Cacheable(cacheNames = "llmAnswer", key = "#question")
    public String ask(String question) {
        Timer.Sample sample = Timer.start(meterRegistry);
        try {
            String answer = chatClient.prompt()
                    .user(question)
                    .call()
                    .content();
            meterRegistry.counter("llm.request", "result", "success").increment();
            return answer;
        } catch (Exception ex) {
            meterRegistry.counter("llm.request", "result", "error", "exception", ex.getClass().getSimpleName()).increment();
            throw ex;
        } finally {
            sample.stop(Timer.builder("llm.latency")
                    .description("LLM call latency")
                    .publishPercentileHistogram()
                    .serviceLevelObjectives(
                            Duration.ofMillis(500),
                            Duration.ofSeconds(1),
                            Duration.ofSeconds(3),
                            Duration.ofSeconds(8))
                    .register(meterRegistry));
        }
    }
}
```

**P50/P95/P99** 是延迟分位数：P95=1000ms 表示 95% 请求不超过 1000ms，比平均值更能反映用户体验。因为模型请求常常有长尾，平均值很容易骗人。

<h1 id="先压一次不要凭感觉判断慢不慢"><a href="#先压一次不要凭感觉判断慢不慢" class="headerlink" title="先压一次：不要凭感觉判断慢不慢"></a>先压一次：不要凭感觉判断慢不慢</h1>

本文用 `wrk` 压测。**wrk** 是一个轻量 HTTP 压测工具，适合快速看吞吐和延迟分布；如果你要更复杂的链路编排，可以换成 k6 或 JMeter。

<h2 id="启动服务"><a href="#启动服务" class="headerlink" title="启动服务"></a>启动服务</h2>

```bash
export OPENAI_API_KEY=你的_key
mvn spring-boot:run
```

准备请求体：

```bash
cat > ask.lua <<'LUA'
wrk.method = "POST"
wrk.body   = '{"question":"用三句话解释 Java volatile 的可见性，不要超过 120 字"}'
wrk.headers["Content-Type"] = "application/json"
LUA
```

压测命令：

```bash
wrk -t2 -c10 -d60s -s ask.lua http://127.0.0.1:8080/api/ask
```

<h2 id="示例结果"><a href="#示例结果" class="headerlink" title="示例结果"></a>示例结果</h2>

不同网络、模型、地区的结果会差很多，下面是一组示例数据，重点看对比方法，不要照抄成你的生产结论。

| 场景 | QPS | 平均延迟 | P50 | P95 | P99 | 备注 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 无缓存，每次真实调用模型 | 2.8 | 3560ms | 3310ms | 6810ms | 9240ms | 成本最高，长尾明显 |
| Caffeine 命中相同问题 | 850 | 11ms | 7ms | 28ms | 53ms | 适合 FAQ/固定提示词 |
| 缓存命中率约 60% | 7.1 | 1390ms | 42ms | 5280ms | 8100ms | 用户体验取决于未命中长尾 |

这张表至少说明两件事：

1. LLM 接口慢，不一定是 Spring Boot 慢。绝大部分时间花在远端模型推理和网络等待上。
2. 缓存对“重复问题”极其有效，但对开放式问答不能盲目缓存，否则可能答非所问或者缓存脏数据。

<h2 id="验证指标"><a href="#验证指标" class="headerlink" title="验证指标"></a>验证指标</h2>

压测时同时看 Actuator 指标：

```bash
curl 'http://127.0.0.1:8080/actuator/metrics/llm.latency'
curl 'http://127.0.0.1:8080/actuator/metrics/llm.request'
```

如果接了 Prometheus，可以查询：

```promql
histogram_quantile(0.95, sum(rate(llm_latency_seconds_bucket[5m])) by (le))
sum(rate(llm_request_total{result="error"}[5m]))
```

**PromQL** 是 Prometheus 的查询语言，用来从时间序列指标里算 QPS、错误率、分位延迟等值。上线后不要只看日志，接口级别的 P95/P99 必须进监控面板。

<h1 id="成本怎么估别等到账单来了才复盘"><a href="#成本怎么估别等到账单来了才复盘" class="headerlink" title="成本怎么估：别等到账单来了才复盘"></a>成本怎么估：别等到账单来了才复盘</h1>

大模型通常按 token 计费。**token** 可以粗略理解为模型处理文本的最小片段，中文里一个字、一个词或标点都可能拆成 token；输入 prompt 和输出 answer 都会计费。

可以用一个简单公式先估算：

```text
单次成本 = 输入 token 数 * 输入单价 + 输出 token 数 * 输出单价
每日成本 = 单次成本 * 每日请求量 * 未命中缓存比例
```

举个保守估算：

| 项目 | 数值 |
| --- | ---: |
| 平均输入 | 600 tokens |
| 平均输出 | 300 tokens |
| 每日请求 | 50,000 次 |
| 缓存命中率 | 40% |
| 实际模型调用 | 30,000 次 |

如果后续引入 RAG，还要把召回文档拼进 prompt。**RAG** 是 Retrieval-Augmented Generation，中文常叫“检索增强生成”：先从知识库找相关资料，再让模型基于资料回答，解决模型不知道内部知识、容易胡编的问题。但 RAG 会增加输入 token，也会增加向量检索耗时，所以必须一起算成本和延迟。

<h1 id="超时重试与降级别让线程一直等"><a href="#超时重试与降级别让线程一直等" class="headerlink" title="超时、重试与降级：别让线程一直等"></a>超时、重试与降级：别让线程一直等</h1>

接模型服务最怕两件事：一是没有超时，请求一直挂着；二是无脑重试，把供应商限流打得更严重。

建议按这个顺序处理：

1. **超时**：给连接、读取、总耗时设置上限，例如 8~15 秒。
2. **有限重试**：只对网络抖动、429/5xx 做 1~2 次重试，并加指数退避。
3. **降级**：失败时返回“暂时不可用 + traceId”，或者走小模型/缓存答案。
4. **限流**：保护自己系统，也保护下游模型预算。

示意代码如下：

```java
public String safeAsk(String question) {
    try {
        return ask(question);
    } catch (Exception ex) {
        meterRegistry.counter("llm.fallback", "reason", ex.getClass().getSimpleName()).increment();
        return "当前 AI 服务响应较慢，请稍后重试。traceId=" + TraceId.current();
    }
}
```

这里的 `TraceId.current()` 只是示意。**traceId** 是一次请求在系统里的追踪编号，日志、指标、链路追踪都带上它，排障时才能把同一次请求串起来。

<h1 id="JFR-看一下线程到底卡在哪里"><a href="#JFR-看一下线程到底卡在哪里" class="headerlink" title="JFR 看一下：线程到底卡在哪里"></a>JFR 看一下：线程到底卡在哪里</h1>

**JFR** 全称 Java Flight Recorder，是 JDK 自带的运行时诊断工具，能记录线程、锁、GC、方法采样、Socket I/O 等事件。它适合回答“CPU 忙不忙、线程是不是在等网络、GC 有没有捣乱”这类问题。

压测时采集 60 秒 JFR：

```bash
jcmd $(pgrep -f 'spring-ai-demo') JFR.start name=ai-demo settings=profile duration=60s filename=/tmp/ai-demo.jfr
```

用 JDK Mission Control 打开 `/tmp/ai-demo.jfr`，重点看：

| 面板 | 重点观察 | 可能结论 |
| --- | --- | --- |
| Threads | 大量线程处于 Socket Read | 等下游模型返回，不是本机 CPU 瓶颈 |
| Method Profiling | 业务方法 CPU 占比很低 | 优化 JSON/字符串意义不大 |
| Garbage Collections | GC 暂停是否明显 | prompt 拼接过大可能增加内存压力 |
| Socket I/O | 远端调用耗时分布 | 判断是否需要超时、重试、区域优化 |

如果 JFR 显示 CPU 利用率很低、线程大多在等待 Socket，那盲目加机器通常收益不大。更该做的是：流式返回、缓存、缩短 prompt、换更近的模型区域、或者异步化处理。

<h1 id="常见坑和误区"><a href="#常见坑和误区" class="headerlink" title="常见坑和误区"></a>常见坑和误区</h1>

<h2 id="误区一只看平均延迟"><a href="#误区一只看平均延迟" class="headerlink" title="误区一：只看平均延迟"></a>误区一：只看平均延迟</h2>

模型调用长尾很明显，平均 2 秒不代表用户体验好。生产监控至少看 P50、P95、P99，并把错误率、超时率单独拉出来。

<h2 id="误区二所有问题都缓存"><a href="#误区二所有问题都缓存" class="headerlink" title="误区二：所有问题都缓存"></a>误区二：所有问题都缓存</h2>

缓存适合 FAQ、分类标签、固定模板生成，不适合强上下文、强时效、强个性化的问题。缓存 key 也不能只用原始问题，必要时要包含用户角色、知识库版本、模型版本。

<h2 id="误区三把-prompt-越写越长"><a href="#误区三把-prompt-越写越长" class="headerlink" title="误区三：把 prompt 越写越长"></a>误区三：把 prompt 越写越长</h2>

prompt 越长，输入 token 成本越高，模型处理也更慢。RAG 场景里不要把召回文档一股脑塞进去，要做分段、去重、rerank 和截断。**rerank** 是对初步召回结果重新排序，目标是把真正相关的文档排到前面，减少无关上下文污染。

<h2 id="误区四没有评测集就谈优化"><a href="#误区四没有评测集就谈优化" class="headerlink" title="误区四：没有评测集就谈优化"></a>误区四：没有评测集就谈优化</h2>

成本和延迟优化不能牺牲答案质量。至少准备 30~100 条典型问题，记录期望答案要点，再比较不同模型、prompt、缓存策略下的正确率、拒答率和人工可接受率。

<h1 id="可复现实验清单"><a href="#可复现实验清单" class="headerlink" title="可复现实验清单"></a>可复现实验清单</h1>

你可以按下面步骤验证本文结论：

1. 用 Maven 创建 Spring Boot 3.3+ 项目，加入 Spring AI、Actuator、Caffeine 依赖。
2. 配置 `OPENAI_API_KEY` 和模型名称，启动服务。
3. 用 `curl` 调 `/api/ask`，确认接口返回正常。
4. 用 `wrk -t2 -c10 -d60s` 压测无缓存场景，记录 QPS、平均延迟、P95、P99。
5. 重复请求相同问题，观察缓存命中后的延迟变化。
6. 访问 `/actuator/metrics/llm.latency` 和 `/actuator/metrics/llm.request`，确认指标存在。
7. 压测期间采集 JFR，判断线程主要耗在 CPU、GC 还是 Socket I/O。
8. 改变 prompt 长度或缓存 TTL，再压一次，对比延迟和成本估算。

<h1 id="总结"><a href="#总结" class="headerlink" title="总结"></a>总结</h1>

Spring Boot 接入大模型，真正的难点不在“能不能调通”，而在“上线后能不能解释、能不能控住”。本文的核心结论是：

- LLM 调用要同时看 **延迟、错误率、token 成本、缓存命中率**，只看功能正确不够。
- 缓存能显著改善重复问题的吞吐和延迟，但必须控制适用范围和 cache key。
- P95/P99 比平均值更重要，模型服务的长尾会直接影响用户体验。
- JFR 能帮助判断瓶颈在本机 CPU/GC，还是在远端模型和网络等待。
- 没有评测集的优化不完整，成本降了但答案变差，本质上还是事故。

工程上建议先做一个最小闭环：接口可用、指标可见、压测可复现、失败可降级。这个闭环打稳了，再去做 RAG、Agent、工具调用，心里会踏实很多。

<h1 id="参考资料"><a href="#参考资料" class="headerlink" title="参考资料"></a>参考资料</h1>

1. Spring AI Reference Documentation：<https://docs.spring.io/spring-ai/reference/>
2. Spring Boot Actuator Documentation：<https://docs.spring.io/spring-boot/reference/actuator/>
3. Micrometer Documentation：<https://docs.micrometer.io/micrometer/reference/>
4. Prometheus Querying Basics：<https://prometheus.io/docs/prometheus/latest/querying/basics/>
5. OpenJDK JDK Mission Control / JFR：<https://openjdk.org/projects/jmc/>
6. Caffeine Cache Wiki：<https://github.com/ben-manes/caffeine/wiki>
7. wrk HTTP benchmarking tool：<https://github.com/wg/wrk>
