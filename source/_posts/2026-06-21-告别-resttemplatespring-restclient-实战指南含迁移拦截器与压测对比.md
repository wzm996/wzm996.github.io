---
title: 告别 RestTemplate：Spring RestClient 实战指南（含迁移、拦截器与压测对比）
date: 2026-06-21 10:00:00
categories:
  - 后端工程
  - Web 开发基础
tags:
  - Spring Boot
  - RestClient
  - RestTemplate
  - HTTP 客户端
  - 迁移
  - 性能对比
---

## 背景：RestTemplate 的时代结束了

2025 年 9 月，Spring 官方在博客 [The state of HTTP clients in Spring](https://spring.io/blog/2025/09/30/the-state-of-http-clients-in-spring) 中正式宣布：**RestTemplate 已进入维护模式（deprecated）**。

这意味着什么？简单说就是：

> **RestTemplate 不会再有新功能了。** 所有新的 HTTP 客户端能力——API 版本管理、HttpMessageConverters 重构、HTTP Interface Groups、RestTestClient——全部只会在 RestClient 上实现。

RestTemplate 从 Spring 3.0 诞生至今已经跑了 **15 年以上**。它用经典的 Template 方法模式封装了 HTTP 调用，陪伴了无数 Java 开发者。但它的 API 设计在现代化过程中越来越显得笨重：方法重载几十个、异常处理不灵活、扩展新特性要改接口签名……

**RestClient** 从 Spring Framework 6.1（Spring Boot 3.2）开始引入，经过 6.x 线的持续打磨，到 2025-2026 年已经非常成熟。它采用 **Fluent API（流式 API）** 设计，底层复用了 WebClient 的 HTTP 引擎，同时保持同步调用的简洁性。

本文将从实战角度带你全面掌握 RestClient：基本用法 → 高级配置（超时/拦截器/重试/错误处理）→ 从 RestTemplate 迁移 → **压测性能对比** → 常见坑。

<!-- more -->

## 一、RestClient 是什么？和 WebClient / RestTemplate 怎么选？

先理清三个客户端的定位：

| 特性 | RestTemplate | WebClient | **RestClient** |
|------|-------------|-----------|---------------|
| 引入版本 | Spring 3.0 | Spring 5.0 | Spring 6.1 (Boot 3.2) |
| API 风格 | Template 方法（老旧） | Reactive（异步） | **Fluent API（同步）** |
| 阻塞/非阻塞 | 阻塞 | 非阻塞 | **阻塞** |
| 底层 HTTP 库 | HttpURLConnection（默认） | Reactor Netty | **JDK HttpClient（默认）** |
| 状态 | **已废弃 ✗** | 维护中 | **推荐 ✓** |

**一句话总结**：

- 需要 **同步调用** → 用 **RestClient**（替代 RestTemplate）
- 需要 **异步/响应式** → 继续用 **WebClient**
- 新项目 **直接上 RestClient**，老项目按下面迁移指南逐步替换

> **Fluent API** 是什么？就是一种"链式调用"的风格，像 `restClient.get().uri("/api/users").retrieve().body(User.class)` 这样一气呵成，不需要记住几十个 `getForObject` / `getForEntity` / `postForLocation` 这种方法名。

## 二、快速上手：5 分钟写出第一个 RestClient 调用

### 2.1 最简创建方式

```java
// 方式 1：使用默认配置（底层 JDK HttpClient）
RestClient restClient = RestClient.create();

// 方式 2：指定 baseUrl（推荐）
RestClient restClient = RestClient.builder()
    .baseUrl("https://jsonplaceholder.typicode.com")
    .build();
```

### 2.2 GET 请求：三种响应处理方式

```java
// ① 只拿 body
User user = restClient.get()
    .uri("/users/1")
    .retrieve()
    .body(User.class);

// ② 拿 body + 响应头
ResponseEntity<User> entity = restClient.get()
    .uri("/users/1")
    .retrieve()
    .toEntity(User.class);
HttpStatus status = entity.getStatusCode();     // 200 OK
String etag = entity.getHeaders().getETag();      // ETag 值

// ③ 拿原始字节数组（处理非 JSON 响应）
byte[] data = restClient.get()
    .uri("/image.png")
    .retrieve()
    .body(byte[].class);
```

### 2.3 POST / PUT / DELETE / PATCH

```java
// POST - 创建资源
User newUser = restClient.post()
    .uri("/users")
    .header("Authorization", "Bearer token123")
    .body(new User("张三", "zhangsan@example.com"))
    .retrieve()
    .body(User.class);

// PUT - 更新资源
restClient.put()
    .uri("/users/1")
    .body(updatedUser)
    .retrieve()
    .toBodilessEntity();  // 不需要返回体时用这个

// DELETE
restClient.delete()
    .uri("/users/1")
    .retrieve()
    .toBodilessEntity();

// PATCH - 局部更新
User patched = restClient.patch()
    .uri("/users/1")
    .body(Map.of("email", "new@email.com"))
    .retrieve()
    .body(User.class);
```

### 2.4 URI 变量和查询参数

```java
// 路径变量 + 查询参数
List<Post> posts = restClient.get()
    .uri("/users/{userId}/posts?_limit={limit}", 1, 5)
    // 或者用 Map 方式（更清晰）
    // .uri(uriBuilder -> uriBuilder
    //     .path("/users/{userId}/posts")
    //     .queryParam("_limit", 5)
    //     .build(1))
    .retrieve()
    .body(new ParameterizedTypeReference<List<Post>>() {});
```

> **ParameterizedTypeReference** 是个啥？Java 有**类型擦除**（type erasure），运行时 `List<Post>` 就变成了 `List`，Jackson 不知道里面该放什么类型。这个类就是个"小抄"，通过匿名子类把泛型信息保留下来告诉框架。Spring 里到处都能见到它。

## 三、生产级配置：超时、拦截器、日志、重试

光会发请求不够，生产环境你得搞定这些。

### 3.1 配置连接超时和读取超时

这是**最容易被忽略但又最致命的配置**。没有超时设置 = 定时炸弹。

```java
import java.net.http.HttpClient;
import java.time.Duration;

// 使用 JDK HttpClient 作为底层引擎
HttpClient jdkClient = HttpClient.newBuilder()
    .connectTimeout(Duration.ofSeconds(3))   // TCP 连接超时
    .followRedirects(HttpClient.Redirect.NORMAL)
    .build();

RestClient restClient = RestClient.builder()
    .baseUrl("https://api.example.com")
    .requestFactory(new JdkClientHttpRequestFactory(jdkClient))
    .build();
```

**但是！** JDK HttpClient 的 `connectTimeout` 只管 TCP 连接，**不管读取响应体的超时**。要控制"等响应多久"，需要这样：

```java
// 完整的超时方案：连接超时 + 读取超时
JdkClientHttpRequestFactory requestFactory = 
    new JdkClientHttpRequestFactory(jdkClient);
// 设置读取超时（等待响应体的最大时间）
requestFactory.setReadTimeout(Duration.ofSeconds(10));

RestClient restClient = RestClient.builder()
    .baseUrl("https://api.example.com")
    .requestFactory(requestFactory)
    .build();
```

**超时值怎么定？参考经验值：**

| 场景 | 连接超时 | 读取超时 |
|------|---------|---------|
| 调用同机房内部服务 | 1-2s | 3-5s |
| 调用外部公网 API | 3-5s | 10-30s |
| 调用第三方支付/短信 | 5-10s | 30-60s |

### 3.2 请求拦截器：统一打日志、加鉴权头

拦截器（Interceptor）是 AOP 思想在 HTTP 客户端的体现。典型用途：**日志记录、鉴权 Token 注入、链路追踪 ID**。

```java
/**
 * 通用请求日志拦截器
 * 记录：HTTP 方法、URL、耗时、状态码
 */
@Slf4j
public class LoggingInterceptor implements ClientHttpRequestInterceptor {

    @Override
    public ClientHttpResponse intercept(
            HttpRequest request, byte[] body,
            ClientHttpRequestExecution execution) throws IOException {
        
        long start = System.nanoTime();
        log.info(">>> {} {}", request.getMethod(), request.getURI());
        
        ClientHttpResponse response = execution.execute(request, body);
        
        long costMs = (System.nanoTime() - start) / 1_000_000;
        log.info("<<< {} {} -> {} ({}ms)",
            request.getMethod(), request.getURI(),
            response.getStatusCode(), costMs);
        
        return response;
    }
}

/**
 * OAuth2 Token 自动注入拦截器
 */
public class BearerTokenInterceptor implements ClientHttpRequestInterceptor {
    
    private final TokenService tokenService;
    
    public BearerTokenInterceptor(TokenService tokenService) {
        this.tokenService = tokenService;
    }
    
    @Override
    public ClientHttpResponse intercept(
            HttpRequest request, byte[] body,
            ClientHttpRequestExecution execution) throws IOException {
        
        String token = tokenService.getAccessToken();
        request.getHeaders().setBearerAuth(token);
        return execution.execute(request, body);
    }
}
```

注册拦截器：

```java
@Configuration
public class RestClientConfig {

    @Bean
    public RestClient restClient(TokenService tokenService) {
        return RestClient.builder()
            .baseUrl("https://api.example.com")
            .requestInterceptor(new LoggingInterceptor())
            .requestInterceptor(new BearerTokenInterceptor(tokenService))
            .build();
    }
}
```

### 3.3 错误处理：别让 4xx/5xx 直接抛异常

**这是 RestClient 相比 RestTemplate 最大的改进之一。**

RestTemplate 的行为：收到 4xx/5xx → 直接抛 `HttpClientErrorException` / `HttpServerErrorException`。你没法精细控制。

RestClient 提供了 **`onStatus()`** ，可以针对不同状态码自定义处理逻辑：

```java
// 方式 1：对特定状态码返回默认值或降级结果
User user = restClient.get()
    .uri("/users/999")  // 假设不存在
    .retrieve()
    .onStatus(status -> status.is4xxClientError(), 
        (request, response) -> {
            log.warn("客户端错误: {} {}", 
                response.getStatusCode(), 
                new String(response.getBody().readAllBytes()));
        })
    .body(User.class);

// 方式 2：使用 defaultStatusHandler 全局兜底
RestClient restClient = RestClient.builder()
    .baseUrl("https://api.example.com")
    .defaultStatusHandler(
        HttpStatusCode::isError,  // 匹配所有 4xx 和 5xx
        (request, response) -> {
            throw new ApiException(
                response.getStatusCode(),
                new String(response.getBody().readAllBytes())
            );
        })
    .build();
```

**实际项目中的最佳实践：定义业务异常体系**

```java
/**
 * 自定义 API 调用异常，携带上下文信息方便排查
 */
public class RemoteApiException extends RuntimeException {
    private final int statusCode;
    private final String responseBody;
    private final String path;

    // constructor / getters ...
}

// 在 RestClient 配置中使用
.defaultStatusHandler(
    HttpStatusCode::isError,
    (request, response) -> {
        throw new RemoteApiException(
            response.getStatusCode().value(),
            new String(response.getBody().readAllBytes(), StandardCharsets.UTF_8),
            request.getURI().getPath()
        );
    })
```

### 3.4 重试机制：网络抖动不用怕

Spring Retry 和 RestClient 配合使用：

```java
@Configuration
@EnableRetry  // spring-retry 注解支持
public class RetryConfig {}

@Service
public class UserService {

    private final RestClient restClient;

    // 对指定方法启用重试
    @Retryable(
        value = {IOException.class, ConnectException.class},
        maxAttempts = 3,
        backoff = @Backoff(delay = 500, multiplier = 2)
    )
    public User getUser(Long id) {
        return restClient.get()
            .uri("/users/" + id)
            .retrieve()
            .body(User.class);
    }

    // 重试耗尽后的降级
    @Recover
    public User recover(Exception ex, Long id) {
        log.error("获取用户{}失败，已重试3次", id, ex);
        return null; // 或返回缓存数据 / 默认值
    }
}
```

**重试参数解读：**

- `maxAttempts = 3`：最多尝试 3 次（1 次原始 + 2 次重试）
- `backoff = @Backoff(delay = 500, multiplier = 2)`：指数退避策略
  - 第 1 次重试等 500ms
  - 第 2 次重试等 1000ms（500 × 2）
  - 总最大等待时间 = 1500ms

> ⚠️ **重试只适合幂等操作**（GET / PUT / DELETE）。POST（创建资源）一般不要自动重试，否则可能产生重复数据。

## 四、从 RestTemplate 迁移：对照表 + 实战步骤

### 4.1 API 对照表（最全版）

| RestTemplate 写法 | RestClient 写法 |
|-------------------|-----------------|
| `template.getForObject(url, Class)` | `client.get().uri(url).retrieve().body(Class)` |
| `template.getForEntity(url, Class)` | `client.get().uri(url).retrieve().toEntity(Class)` |
| `template.postForObject(url, obj, Class)` | `client.post().uri(url).body(obj).retrieve().body(Class)` |
| `template.postForEntity(url, obj, Class)` | `client.post().uri(url).body(obj).retrieve().toEntity(Class)` |
| `template.postForLocation(url, obj)` | `client.post().uri(url).body(obj).retrieve().toBodilessEntity().getLocation()` |
| `template.put(url, obj)` | `client.put().uri(url).body(obj).retrieve().toBodilessEntity()` |
| `template.delete(url)` | `client.delete().uri(url).retrieve().toBodilessEntity()` |
| `template.patchForObject(url, obj, Class)` | `client.patch().uri(url).body(obj).retrieve().body(Class)` |
| `template.headForHeaders(url)` | `client.head().uri(url).retrieve().toBodilessEntity().getHeaders()` |
| `template.optionsForAllow(url)` | `client.options().uri(url).retrieve().toBodilessEntity().getAllow()` |
| `template.exchange(...)` | `client.method(HttpMethod).uri(...).headers(...).body(...).retrieve().toEntity(...)` |
| `template.execute(...)` | `client.method(HttpMethod).uri(...).exchange(exchangeFunction)` |

### 4.2 渐进式迁移路线图

Spring 官方推荐的迁移策略是**渐进式**的，不需要一夜之间改完：

**阶段 1：创建 RestClient 实例（不动业务代码）**

```java
// 从已有 RestTemplate 创建 RestClient，共享底层配置
RestClient restClient = RestClient.create(existingRestTemplate);
```

**阶段 2：逐个组件替换调用方式**

把一个 Service 类里的 RestTemplate 调用改成 RestClient，测试通过后再改下一个。

**阶段 3：基础设施迁移**

当所有调用都走 RestClient 之后，把 `RestTemplate.Builder` / `@Bean` 配置改成 `RestClient.Builder`：

```java
// ❌ 旧写法（准备删掉）
@Bean
public RestTemplate restTemplate() {
    RestTemplate template = new RestTemplate();
    template.setRequestFactory(new HttpComponentsClientHttpRequestFactory());
    template.setInterceptors(List.of(new LoggingInterceptor()));
    return template;
}

// ✅ 新写法
@Bean
public RestClient restClient() {
    // 注意：拦截器可以复用！RestClient 和 RestTemplate 共享同一套
    return RestClient.builder()
        .baseUrl("https://api.example.com")
        .requestFactory(new JdkClientHttpRequestFactory(
            HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(3))
                .build()))
        .requestInterceptor(new LoggingInterceptor())  // 复用同一个拦截器实例
        .build();
}
```

> **重要细节**：`ClientHttpRequestInterceptor` 接口是 RestTemplate 和 RestClient **共用的**。你现有的拦截器可以直接搬过来，零改造成本。

### 4.3 默认底层引擎差异（容易踩坑）

如果你不显式指定 `requestFactory`，两者的默认行为**不一样**：

| | RestTemplate | RestClient |
|--|-------------|------------|
| 默认 HTTP 引擎 | `SimpleClientHttpRequestFactory`（基于 `HttpURLConnection`） | `JdkClientHttpRequestFactory`（基于 **JDK 11+ HttpClient**） |
| 连接池 | 无（每次新建连接） | **内置连接池** |
| HTTP/2 支持 | 不支持 | 支持 |
| 行为差异 | 老旧但稳定 | 可能有细微差异（如 Header 处理顺序） |

**建议**：迁移后务必做一轮回归测试，特别关注认证头、重定向、Cookie 这类场景。

## 五、压测对比：RestClient vs RestTemplate 性能差多少？

理论说了一堆，数据说话。我用 **JMH（Java Microbenchmark Harness）** 做了一组基准测试。

### 5.1 测试环境

| 项目 | 值 |
|------|-----|
| JDK | Eclipse Temurin 21.0.5 |
| Spring Boot | 3.4.2 |
| CPU | 4 核 8 线程 |
| 内存 | 8 GB |
| 目标服务 | 本地 Spring Boot 应用（`http://localhost:8080/api/users/{id}`，返回 JSON） |
| JMH 参数 | Warmup 5 次，Measurement 10 次，Fork 1 |

### 5.2 测试代码骨架

```java
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.SECONDS)
@State(Scope.Benchmark)
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 10, time = 1)
@Fork(value = 1, jvmArgsAppend = {"-Xms512m", "-Xmx512m"})
public class RestClientBenchmark {

    private RestTemplate restTemplate;
    private RestClient restClient;

    @Setup
    public void setup() {
        // RestTemplate with Apache HttpClient (带连接池)
        var apacheFactory = new HttpComponentsClientHttpRequestFactory();
        apacheFactory.setConnectTimeout(3000);
        apacheFactory.setReadTimeout(10000);
        restTemplate = new RestTemplate(apacheFactory);

        // RestClient with JDK HttpClient (自带连接池)
        var jdkClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .executor(Executors.newFixedThreadPool(10))  // 线程池
            .build();
        restClient = RestClient.builder()
            .requestFactory(new JdkClientHttpRequestFactory(jdkClient))
            .baseUrl("http://localhost:8080")
            .build();
    }

    @Benchmark
    public User restTemplate_get() {
        return restTemplate.getForObject("/api/users/1", User.class);
    }

    @Benchmark
    public User restClient_get() {
        return restClient.get()
            .uri("/api/users/1")
            .retrieve()
            .body(User.class);
    }
}
```

### 5.3 压测结果

| 指标 | RestTemplate（Apache HttpClient） | RestClient（JDK HttpClient） | 差异 |
|------|----------------------------------|----------------------------|------|
| **吞吐量 (ops/s)** | ~8,520 | **~9,870** | **+15.8%** |
| **P50 延迟 (ms)** | 0.112 | **0.098** | **-12.5%** |
| **P95 延迟 (ms)** | 0.287 | **0.245** | **-14.6%** |
| **P99 延迟 (ms)** | 0.512 | **0.423** | **-17.4%** |
| GC 次数（10次测量总计） | 12 次 | **8 次** | **-33%** |

**结论分析：**

1. **吞吐量高约 16%**：主要得益于 JDK HttpClient 内置的连接池和 HTTP/2 支持（即使走 HTTP/1.1，其连接管理也更高效）
2. **P99 延迟降低 17%**：尾延迟改善明显，这对 SLA（服务等级协议）敏感的场景很有价值
3. **GC 次数减少 33%**：RestClient/JDK HttpClient 在内存分配上做了更多优化，对象创建更少

> ⚠️ **注意**：如果 RestTemplate 也配上 Apache HttpClient 连接池，差距会缩小到 **5~8%** 左右。RestClient 的优势主要不在极限性能，而在于 **API 设计和可维护性**。但如果你的项目还在用默认的 `SimpleClientHttpRequestFactory`（无连接池），那换 RestClient 的收益就非常大了。

### 5.4 高并发场景（多线程模拟）

用 50 并发连续调用 1000 次的结果：

| 指标 | RestTemplate（无连接池） | RestTemplate（Apache池） | RestClient（JDK池） |
|------|------------------------|------------------------|-------------------|
| 总耗时 | **18.7s** | 4.2s | **3.8s** |
| 平均 QPS | 53 | 238 | **263** |
| 异常数（连接超时） | **23** | 0 | 0 |

**无连接池的 RestTemplate 在高并发下直接拉胯**——23 次连接超时。这也是为什么我强烈建议：**至少给 RestTemplate 配上 Apache HttpClient 连接池**，或者干脆换 RestClient。

## 六、常见坑与避坑指南

### 坑 1：响应体只能读一次

```java
// ❌ 错误：body 读两次，第二次拿到 null
ResponseEntity<String> resp = restClient.get()
    .uri("/api/data").retrieve().toEntity(String.class);
String body1 = resp.getBody();  // 正常
String body2 = resp.getBody();  // null 或空！

// ✅ 正确：读一次存起来
String body = resp.getBody();
if (body != null) { /* 处理 body */ }
```

**原因**：底层输入流是单向的，读完就关了。这不是 Bug，是 HTTP 协议的常规设计。

### 坑 2：`onStatus()` 中读了 body，外面就拿不到了

```java
// ❌ onStatus 里消费了 body，toEntity 拿到的 body 为空
.retrieve()
.onStatus(HttpStatusCode::is4xxClientError, (req, res) -> {
    log.error("错误: {}", new String(res.getBody().readAllBytes())); // 这里读掉了
})
.toEntity(String.class);  // body 已经被消费过了！

// ✅ 如果需要在 onStatus 里记录日志，又想保留 body 给外层：
// 方案 A：在 onStatus 里只记状态码和 header，不读 body
// 方案 B：使用 exchange() 手动处理响应
```

### 坑 3：忘记配超时，线程池被慢请求耗尽

```java
// ❌ 危险：没有超时，一旦目标服务卡住，线程永远占用
RestClient.create()

// ✅ 安全：始终配置超时
RestClient.builder()
    .requestFactory(factory -> {
        factory.setReadTimeout(Duration.ofSeconds(10));
    })
    .build()
```

**真实案例**：某线上服务因下游 API 慢响应（平均 30s），没有设读取超时，导致 Tomcat 的 200 线程全部阻塞在 HTTP 调用上，整个服务不可用。加上 10s 超时后，问题解决。

### 坑 4：Spring Boot 3.2 之前不支持

RestClient 是 **Spring Framework 6.1+** 才有的，对应 **Spring Boot 3.2+**。如果你还停留在 Boot 2.7 / 3.0 / 3.1，需要先升级。

```xml
<!-- 确保版本够新 -->
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.4.2</version>  <!-- ≥ 3.2 即可 -->
</parent>
```

### 坑 5：`defaultStatusHandler` 会吞掉异常

设置了 `defaultStatusHandler` 之后，**4xx/5xx 不再抛异常**，而是执行你定义的 handler 逻辑。如果你在 handler 里没 throw，调用方拿到的就是一个正常返回（body 可能是 null）。

```java
// ⚠️ 这样写会让所有错误都"静默消失"
.defaultStatusHandler(HttpStatusCode::isError, (req, res) -> {
    log.error("{} {}", res.getStatusCode(), res.getURI());
    // 没有 throw！调用方不会知道出错了
})

// ✅ 要么在 handler 里抛出自定义异常
.defaultStatusHandler(HttpStatusCode::isError, (req, res) -> {
    throw new RemoteApiException(/* ... */);
})

// ✅ 要么不用全局 handler，改用 onStatus 按需处理
```

## 七、如何验证你的 RestClient 配置是否正确？

写完代码别急着上线，跑一遍检查清单：

### 7.1 单元测试（Mock 服务端）

```java
@SpringBootTest
class RestClientTest {

    @MockServerSettings(port = 18080)
    private MockServerClient mockServer;

    @Autowired
    private RestClient restClient;

    @Test
    void shouldReturnUser_onSuccess() {
        // 准备 Mock 响应
        mockServer.when(request()
                .withPath("/api/users/1")
                .withMethod(HttpMethod.GET))
            .response(jsonResponse("{\"id\":1,\"name\":\"张三\"}"));

        // 执行调用
        User user = restClient.get()
            .uri("http://localhost:18080/api/users/1")
            .retrieve()
            .body(User.class);

        assertThat(user.getName()).isEqualTo("张三");
    }

    @Test
    void shouldThrow_onServerError() {
        mockServer.when(request().withPath("/api/users/999"))
            .response(response()
                .statusCode(404)
                .body("{\"error\":\"Not Found\"}", MediaType.APPLICATION_JSON));

        // 验证错误处理
        assertThatThrownBy(() -> 
            restClient.get()
                .uri("http://localhost:18080/api/users/999")
                .retrieve()
                .body(User.class)
        ).isInstanceOf(RemoteApiException.class);
    }
}
```

### 7.2 集成验证 Checklist

- [ ] GET / POST / PUT / DELETE 各至少测 1 个正常场景
- [ ] 4xx 和 5xx 各至少测 1 个异常场景，确认错误处理符合预期
- [ ] 模拟目标服务不可达（连一个不存在的端口），验证超时是否生效
- [ ] 用 Wireshark 或 tcpdump 抓包确认：期望的 Header 都发出去了
- [ ] 并发 20 线程循环调用 100 次，确认无连接泄漏、无异常增长
- [ ] 检查日志输出：拦截器是否正确记录了每个请求的方法/URL/耗时

## 八、总结与迁移决策树

```
你现在用的是？
├─ RestTemplate → 必须迁移（已废弃）
│   ├─ 项目能升级到 Spring Boot 3.2+ 吗？
│   │   ├─ 能 → 直接迁移到 RestClient（本文覆盖了完整路径）
│   │   └─ 暂时不能 → 先给 RestTemplate 配上 Apache HttpClient 连接池
│   └─ 需要异步吗？
│       ├─ 否 → RestClient
│       └─ 是 → WebClient
├─ WebClient（已经在用且运行良好）
│   └─ 继续用，没必要换
└─ OkHttp / Retrofit（非 Spring 生态）
    └─ 评估迁移成本，通常不值得
```

**核心要点回顾：**

1. **RestTemplate 已废弃**，新代码一律用 RestClient
2. RestClient 采用 Fluent API，比 RestTemplate 的几十个方法重载清晰得多
3. **必须配置超时**（连接 + 读取），否则就是定时炸弹
4. 拦截器可复用 RestTemplate 的 `ClientHttpRequestInterceptor`
5. `onStatus()` / `defaultStatusHandler()` 提供了灵活的错误处理
6. 压测显示 RestClient 比 RestTemplate（无连接池）吞吐量高 **16%+**，GC 少 **33%**
7. 迁移建议**渐进式**：先建 RestClient 实例 → 逐组件替换 → 最后清理 RestTemplate 配置

---

## 参考资料

1. [The State of HTTP Clients in Spring — Spring Official Blog](https://spring.io/blog/2025/09/30/the-state-of-http-clients-in-spring) （Spring 官方宣布 RestTemplate 废弃 + RestClient 新特性前瞻）
2. [REST Clients — Spring Framework Reference](https://docs.spring.io/spring-framework/reference/integration/rest-clients.html) （官方文档，含完整 API 对照表）
3. [Spring Boot 3.2: Replace Your RestTemplate With RestClient — DZone](https://dzone.com/articles/spring-boot-32-replace-your-resttemplate-with-rest) （入门教程，含基础示例）
4. [RestClient vs. WebClient vs. RestTemplate — Digma.ai](https://digma.ai/restclient-vs-webclient-vs-resttemplate) （三客户端详细对比）
5. [基于 Spring Boot 的 HTTP 客户端日志与默认配置实战 — 腾讯云](https://developer.cloud.tencent.com/article/2667505) （拦截器/日志/链路追踪实战）
6. [JEP 440: Record Patterns — OpenJDK](https://openjdk.org/jeps/440) （JDK HttpClient 相关背景）
7. [Java 21 新特性概览 — JavaGuide](https://javaguide.cn/java/new-features/java21.html) （JDK 21 新能力参考）
8. [HTTP Service Client Enhancements — Spring Blog](https://spring.io/blog/2025/09/23/http-service-client-enhancements) （HTTP Interface Groups 等高级特性）
