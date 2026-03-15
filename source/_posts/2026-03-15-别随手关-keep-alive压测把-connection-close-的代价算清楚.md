---
title: 别随手关 Keep-Alive：压测把 Connection: close 的代价算清楚
date: 2026-03-15 10:00:00
categories:
  - 后端工程
  - 性能与高并发
tags:
  - HTTP
  - Keep-Alive
  - 性能压测
  - autocannon
  - 延迟
  - 吞吐
---

<hr>
<blockquote>
<p>很多同学遇到“连接复用/连接池/长连接”相关问题时，第一反应是先把 <strong>Keep-Alive</strong> 关掉，图个省事（例如强制 <code>Connection: close</code>）。这篇我用一个可复现的小实验把账算清楚：在本机压测里，把 Keep-Alive 关掉后，吞吐直接掉到原来的 <strong>~1/7</strong>，延迟从<strong>毫秒级</strong>被拉到<strong>秒级</strong>，还会出现一堆连接错误。</p>
<p>结论不玄学：<strong>新建连接</strong>本身就贵（握手、慢启动、内核状态、TIME_WAIT、端口/FD 压力……），Keep-Alive/连接池的价值就是把这些成本摊薄。</p>
</blockquote>

<!-- more -->

## 0. 先把名词说人话（不然后面全是黑话）

- **Keep-Alive**：直译“保持连接”。在 HTTP/1.1 里，默认就是“一个 TCP 连接可以发多次 HTTP 请求/响应”，不必每次请求都新建连接。
- **Connection: close**：告诉对端“这次响应发完我就要关连接”。它经常意味着“每个请求都是短连接”。
- **长连接 / 短连接**：这里说的是 **TCP 连接**的寿命，不是业务层“WebSocket 那种长连接”。
- **RPS/QPS**：每秒请求数（requests per second）。
- **P50/P90/P99 延迟**：把所有请求的延迟排序后，位于 50%/90%/99% 位置的那个值。P99 更贴近“尾延迟”。
- **TIME_WAIT**：TCP 连接关闭后会进入的一种等待状态（你可以理解为：为了让网络里的旧包彻底消失、避免新旧连接混淆，操作系统会把这条连接“冷静一会儿”）。短连接多了就容易把系统资源拖垮。
- **autocannon**：Node 社区常用的压测工具（类似 wrk/hey）。
- **pipelining（流水线）**：autocannon 的一个参数，表示“一个连接上允许同时在途多少个请求”。它不是我们日常写业务代码会直接用到的“HTTP pipelining”，但能模拟“连接复用+并发”的效果。

> 注：本文所有数据来自同一台机器的本机回环（127.0.0.1）压测，目的是做“机制验证”。真实线上会更复杂（有网络、有 TLS、有 LB），但<strong>方向性的结论更强</strong>：网络/握手越贵，Keep-Alive 越重要。

## 1. 实验准备：一个最小 HTTP 服务 + 两种压测方式

### 1.1 环境

- Node.js：v24.13.1
- autocannon：v8.x（通过 `npx autocannon` 直接运行）
- 压测目标：`http://127.0.0.1:3018/`

### 1.2 服务端代码（可直接复制运行）

把下面代码保存为 `/tmp/keepalive-server.js`：

```js
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end('ok');
});

// 显式设置超时，避免“默认值差异”导致不好对齐讨论
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

const port = Number(process.env.PORT || 3018);
server.listen(port, '127.0.0.1', () => {
  console.log(`listening on http://127.0.0.1:${port}`);
});
```

启动：

```bash
PORT=3018 node /tmp/keepalive-server.js
```

你可以先用 curl 验证它确实通：

```bash
curl -v http://127.0.0.1:3018/
```

### 1.3 两种压测命令

（1）**Keep-Alive（默认）**：

```bash
npx -y autocannon -c 100 -d 10 -p 10 http://127.0.0.1:3018 --json > /tmp/ka.json
```

（2）**强制短连接（Connection: close）**：

```bash
npx -y autocannon -c 100 -d 10 -p 10 -H 'Connection: close' http://127.0.0.1:3018 --json > /tmp/close.json
```

参数解释：

- `-c 100`：并发连接数 100
- `-d 10`：压测 10 秒
- `-p 10`：每个连接允许最多 10 个“在途请求”（更接近“连接复用 + 并发”）
- `--json`：用 JSON 输出，方便你自己算指标/画图

## 2. 结果：关掉 Keep-Alive，吞吐掉 7 倍，延迟上秒级

下面是我这次压测的核心结果（同机回环，10 秒窗口，`-c 100 -p 10`）：

| 模式 | RPS（avg） | P50 延迟 | P99 延迟 | errors |
|---|---:|---:|---:|---:|
| Keep-Alive（默认） | 59,401.6 | 16 ms | 43 ms | 0 |
| Connection: close | 7,735.2 | 4,370 ms | 8,829 ms | 3,461 |

直观翻译一下：

- **吞吐**：Keep-Alive 大约是短连接的 **7.68 倍**
- **中位延迟（P50）**：短连接把 P50 从 **16ms 拉到 4.37s**（大约 **273 倍**）
- **错误**：短连接压测里出现了几千个 errors（连接建立/关闭太频繁导致的失败）

如果你想看“更贴近日常业务（不搞 pipelining）”的版本，也可以把 `-p 10` 改成 `-p 1` 再跑一次，你通常会看到同样的趋势：短连接仍然会显著拉低吞吐、拉高延迟。

### 2.1 如何验证这些数字是“真的”而不是压测工具瞎报

建议你做 3 个自检：

1) **重复跑 3 次**（取中位数）：

```bash
for i in 1 2 3; do
  npx -y autocannon -c 100 -d 10 -p 10 http://127.0.0.1:3018 --json > /tmp/ka-$i.json
  npx -y autocannon -c 100 -d 10 -p 10 -H 'Connection: close' http://127.0.0.1:3018 --json > /tmp/close-$i.json
  jq '.requests.average, .latency.p50, .latency.p99, .errors' /tmp/ka-$i.json
  jq '.requests.average, .latency.p50, .latency.p99, .errors' /tmp/close-$i.json
done
```

2) **观察服务端连接复用**（最粗暴但有效）：

在服务端加一个 `connection` 事件计数（新建 TCP 连接才会触发）。如果你用 Keep-Alive，连接数增长会慢很多；如果你强制 close，连接数会疯狂增长。

3) **看系统层的 socket 数量**：

```bash
# 把 <pid> 换成 node 进程 PID
lsof -p <pid> | wc -l
```

短连接模式下，你会看到 FD（文件描述符）数量更容易飙升。

## 3. 原因拆解：短连接到底贵在哪？

把“每个请求一次新连接”拆成账单，大概是这些：

1) **TCP 三次握手**：至少 1 个 RTT（往返时间）。在本机回环 RTT 很小；线上跨 AZ/跨地域时，这一项会被放大。

2) **（如果是 HTTPS）TLS 握手**：TLS 1.2 可能 2-RTT，TLS 1.3 通常 1-RTT，还可能有证书校验等 CPU 开销。你越是“每个请求新建连接”，越是在白白重复这套流程。

3) **慢启动（slow start）**：新连接的拥塞窗口小，前几个包会更保守。高延迟网络上，短连接对吞吐的杀伤很大。

4) **内核状态与调度开销**：每条连接都要维护 socket、队列、定时器、状态机；accept/read/write/close 都会有系统调用与内核路径。

5) **TIME_WAIT 与端口/FD 压力**：连接关闭后，主动关闭的一方会产生 TIME_WAIT。短连接多了，容易遇到：
   - 临时端口耗尽（ephemeral port）
   - 文件描述符耗尽（ulimit）
   - accept backlog 被打满（表现为连接失败/重置）

所以 Keep-Alive/连接池本质上是在做一件事：

> **把“建连接”的一次性成本，摊到多次请求上。**

## 4. 生产落地：哪些地方最容易“以为有 Keep-Alive，其实没有”？

这里给你一个排查 checklist（从客户端到服务端一条链路）：

### 4.1 Java 客户端：有没有连接池？

- 你用的 HTTP 客户端是否有连接池（Apache HttpClient / OkHttp / Reactor Netty / JDK HttpClient）？
- 连接池有没有被你关掉？比如“每次 new 一个 client 实例”，等价于“每次新建连接”。
- 连接池上限（max connections / per route）是否太小？太小会导致排队、尾延迟上升。

### 4.2 Nginx / 网关：到 upstream 的 keepalive 开没开？

很多系统“客户端到 Nginx 有 keep-alive”，但“Nginx 到 upstream（你的应用）”是短连接。后者一样会把你的应用打爆。

### 4.3 负载均衡/网关的 idle timeout 是否和应用匹配？

常见问题：

- 你的应用 keep-alive 设 65s，但 LB 60s 就把连接掐了
- 于是客户端复用连接时，突然遇到“对端已关”，开始重试
- 表现为：偶发尖刺、连接重置、P99 上升

这类问题的典型解法是：**整条链路的 idle timeout 对齐**（客户端 < 网关 < 上游/下游），不要各配各的。

## 5. 再硬核一点：用 CPU profile 看“短连接把 CPU 花在哪”

如果你在排查线上“RPS 上不去/CPU 奇怪地高/大量连接波动”，建议不要只看应用代码火焰图，也要看“连接相关的系统开销”。

在 Node 里最简单的方式是用 V8 内置 CPU profiler：

```bash
# 运行服务并开启 CPU profile
PORT=3018 node --cpu-prof --cpu-prof-dir /tmp --cpu-prof-name keepalive.cpuprofile /tmp/keepalive-server.js
```

然后跑一轮压测（Keep-Alive 或 Connection: close 都行），结束服务后会在 `/tmp/keepalive.cpuprofile` 生成 profile 文件。

怎么验证：

- 用 Chrome 打开 `chrome://inspect`（或 DevTools）导入 `.cpuprofile`
- 观察热点是否集中在 `http`/`net` 的连接处理路径上

> 注：本文示例服务逻辑非常轻，profile 的热点大概率在 Node runtime/内核交互上；真实业务服务里，短连接会让“连接开销 + 业务开销”叠加，尾延迟更难看。

## 6. 常见坑（我见过的真实翻车点）

1) **把“Keep-Alive=长连接”理解成“永不关闭”**：不是。Keep-Alive 是“可复用”，连接依然会因为 idle timeout、对端策略、网络抖动而被关闭。

2) **超时不对齐导致的“半开连接重试风暴”**：LB 60s 掐连接，客户端以为还能复用；一批请求同时失败重试，瞬间把 downstream 打穿。

3) **压测参数误读**：`-p 10` 的 pipelining 会放大“连接复用”的收益，但真实业务的收益仍然存在（HTTP/2 多路复用、连接池复用、减少握手等）。你要看的是“趋势”和“机制”，不是把数字当 SLA。

4) **短连接在低并发下看不出来，一上量就炸**：因为资源瓶颈是“连接生命周期管理”，低并发时它不显山露水。

5) **为了“避免粘包/读写错乱”而关 Keep-Alive**：这通常是协议实现有 bug。正确做法是修协议/修解析/修连接池使用方式，而不是让整个系统吞吐腰斩。

## 7. 总结（给老板/同事一句话版）

- 不要把 `Connection: close` 当成“省事开关”。它往往是把系统从“连接复用”退化成“每次请求都付握手/关闭成本”。
- 真要关 Keep-Alive，一定要<strong>用压测 + 观测数据</strong>证明“你扛得住”。
- 排查链路时要记住：Keep-Alive 不是只有客户端一端的事，<strong>网关到 upstream</strong> 同样关键。

## 参考资料

- Node.js HTTP: `server.keepAliveTimeout` / `server.headersTimeout`：https://nodejs.org/api/http.html
- Node.js 性能：CPU profiling（`--cpu-prof`）：https://nodejs.org/en/learn/performance/cpu-profiling
- autocannon（压测工具）：https://github.com/mcollina/autocannon
- RFC 9112（HTTP/1.1 语义与连接管理）：https://www.rfc-editor.org/rfc/rfc9112
- MDN：Connection 头（keep-alive/close）：https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Connection
- Chrome DevTools：Performance/Profiler（导入 cpuprofile）：https://developer.chrome.com/docs/devtools/performance/
