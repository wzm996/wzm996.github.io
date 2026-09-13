---
title: HTTPS 首次连接为什么慢？用 openssl 和 tcpdump 拆解 TLS 1.2 与 1.3 握手，附 TTFB 实测对比
date: 2026-09-13 10:00:00
categories:
  - 计算机网络
  - HTTP/HTTPS
tags:
  - TLS
  - HTTPS
  - tcpdump
  - Wireshark
  - 网络排障
---

<hr>
<blockquote>
<p><strong>TLS 握手</strong> 是浏览器/客户端和服务器在加密通信前协商密钥的过程，也是"HTTPS 首次请求慢"的最大嫌疑人。<br>本文用 <strong>openssl s_client</strong> 看握手结构、<strong>tcpdump + Wireshark</strong> 看往返时序、<strong>curl -w</strong> 量化耗时，把 TLS 1.2 和 TLS 1.3 的握手 RTT 账算清楚，并给出可一键复现的实验脚本。</p>
</blockquote>

<!-- more -->

# 一、背景：为什么"第一次请求"总是格外慢

你可能遇到过这类现象：

- 接口压测时，**新连接**的 P99 明显高于**复用连接**；
- 用户反馈"你们网站打开要等 1 秒，点了之后反而很快"；
- 网关日志里，同一个接口的 TTFB（Time To First Byte，首字节时间）忽高忽低。

这些现象背后，往往不是业务代码慢，而是**连接建立阶段**的成本：TCP 三次握手要 1 个 RTT，TLS 握手还要再花 1~2 个 RTT。RTT（Round-Trip Time，往返时延）是数据包从客户端到服务器再回来的时间——跨城访问通常 30~60ms，跨国 200ms+，每一次"一来一回"都是实打实的等待。

这篇文章要回答三个问题：

1. 一次 HTTPS 首次请求，时间到底花在哪几个 RTT 上？
2. TLS 1.2 和 TLS 1.3 的握手差在哪，为什么说 1.3"更快"？
3. 怎么用命令行工具把这笔账**亲手算出来**，而不是背八股？

> 注：本文所有实验都可以在一台 Linux 机器上复现（需要 root 权限用 `tc` 注入延迟），不需要公网服务器。

# 二、先给结论：一笔 RTT 的账

设 RTT = 50ms，服务器处理时间忽略不计。一个 HTTP GET 请求拿到首字节的总耗时：

| 场景 | TCP | TLS 握手 | HTTP 请求 | 总 RTT 数 | 理论耗时 |
| --- | --- | --- | --- | --- | --- |
| HTTP（非加密） | 1 RTT | — | 1 RTT | 2 | ~100ms |
| HTTPS + TLS 1.2 全握手 | 1 RTT | 2 RTT | 1 RTT | 4 | ~200ms |
| HTTPS + TLS 1.2 会话复用 | 1 RTT | 1 RTT | 1 RTT | 3 | ~150ms |
| HTTPS + TLS 1.3 全握手 | 1 RTT | 1 RTT | 1 RTT | 3 | ~150ms |
| HTTPS + TLS 1.3 + 0-RTT | 1 RTT | 0 RTT* | 合并进握手 | ~2 | ~100ms* |

\* 0-RTT（Early Data）指客户端在第一个握手包里就"夹带"HTTP 请求，但它有**重放风险**，只能用于幂等请求，且依赖客户端和服务器同时支持，本文只做简要介绍，实测数据视客户端而定。

一句话总结：**从 TLS 1.2 到 1.3，全握手的 RTT 从 2 降到 1；配合会话复用和长连接，握手成本才能被彻底摊薄。**

# 三、术语速览（口语版）

第一次出现的新名词，都先用人话解释一遍：

- **RTT**：一个包发出去再收到回应的时间。握手慢的本质就是"来回次数太多"。
- **TTFB**：发出请求到收到第一个响应字节的时间。它包含 DNS + TCP + TLS + 服务器处理。
- **ECDHE**：一种密钥交换算法，通俗说是"双方各自出一个临时随机数，公开交换后各自算出同一个密钥，第三方看到了也算不出来"。名字里的 E（Ephemeral，临时的）保证了**前向保密**——就算日后私钥泄露，历史流量也解不开。
- **PSK**（Pre-Shared Key，预共享密钥）：上次连接结束时双方留下的"暗号"，下次见面直接用暗号派生密钥，省去完整的密钥交换，这是"会话复用"的核心。
- **Session ID / Session Ticket**：会话复用的两种载体。Session ID 是"服务器保管存折"，Session Ticket 是"服务器把加密的存折发给客户端自己保管"。
- **SNI**（Server Name Indication）：客户端在 ClientHello 里携带"我要访问哪个域名"，让同一 IP 上的多张证书都能正常工作。
- **tcpdump / Wireshark**：抓包工具，前者是命令行"录音机"，后者是图形化"音频分析台"。
- **BPF 过滤器**：tcpdump 的过滤语法，比如 `host example.com and port 443`，意思是"只录这台主机 443 端口的流量"。

# 四、实验环境与工具准备

```bash
# 工具检查（Debian/Ubuntu 为例）
openssl version        # 需要 1.1.1+ 才支持 TLS 1.3，推荐 3.x
tcpdump --version
curl --version | head -1   # 建议 7.88+，8.x 更好

# 实验对象：任意支持 TLS 1.3 的公网站点，例如
TARGET=cloudflare.com
```

为了把"网络延迟"变成可控变量，用 **tc netem**（内核自带的网络模拟器）注入固定 50ms 延迟：

```bash
# 对发往目标的所有流量注入 50ms 单向延迟（RTT 变为 100ms 左右，
# 因为出方向 50ms + 入方向默认不走 qdisc 时，往返合计按实测为准）
sudo tc qdisc add dev eth0 root netem delay 50ms

# ……做完全部实验后，务必删掉！
# sudo tc qdisc del dev eth0 root
```

> 注：云主机网卡名可能是 `eth0`、`ens5`、`ens192` 等，用 `ip route get 1.1.1.1` 查看默认网卡名。**实验后忘记删 netem 是新手第一大坑**——整台机器的网络都会变慢。

**如何验证延迟注入生效**：`ping -c 3 $TARGET`，对比注入前后的 RTT 数值是否上升了预期幅度。

# 五、实验 1：openssl s_client 看握手结构

先看 TLS 1.2 的握手过程：

```bash
openssl s_client -connect $TARGET:443 -servername $TARGET -tls1_2 </dev/null
```

关键输出（节选）：

```text
New, TLSv1.2, Cipher is ECDHE-RSA-AES128-GCM-SHA256
Server public key is 2048 bit
Verification: OK
```

加上 `-msg` 参数可以看到每条握手消息的往返顺序：

```bash
openssl s_client -connect $TARGET:443 -servername $TARGET -tls1_2 -msg </dev/null 2>&1 \
  | grep -E '>>|<<' | grep -iE 'hello|certificate|finished|ServerKeyExchange'
```

TLS 1.2 的消息顺序是：

```text
>> ClientHello                      # 客户端：我要握手（第 1 个 RTT 开始）
<< ServerHello
<< Certificate
<< ServerKeyExchange
<< ServerHelloDone                  # 服务器一口气发完（第 1 个 RTT 结束）
>> ClientKeyExchange
>> ChangeCipherSpec
>> Finished                         # 客户端发完密钥材料（第 2 个 RTT 开始）
<< ChangeCipherSpec
<< Finished                         # 服务器确认（第 2 个 RTT 结束）
```

可以看到：**TLS 1.2 全握手需要两轮"一来一回"= 2 个 RTT**。ClientHello 发出去，服务器回一大包（这是第 1 个 RTT）；客户端再算密钥发 Finished，服务器确认（这是第 2 个 RTT）。

再看 TLS 1.3：

```bash
openssl s_client -connect $TARGET:443 -servername $TARGET -tls1_3 -msg </dev/null 2>&1 \
  | grep -E '>>|<<' | grep -iE 'hello|certificate|finished'
```

```text
>> ClientHello
<< ServerHello
<< EncryptedExtensions
<< Certificate
<< CertificateVerify
<< Finished                          # 服务器一个包发完所有握手消息（第 1 个 RTT 结束）
>> Finished                          # 客户端确认；此后即可发数据
```

TLS 1.3 把服务器的所有握手消息压进了**一个**来回：ServerHello 一到，密钥其实已经算出来了，剩下的消息全部加密发送。**这就是"1-RTT 握手"的本质**。

**验证方法**：数一下 `>>` 和 `<<` 交替的"回合数"——TLS 1.2 里 ClientHello 到能发 Finished 之间隔了两个服务端响应批次，TLS 1.3 里只有一批。

# 六、实验 2：tcpdump 抓包，亲眼数 RTT

```bash
# 终端 A：开始抓包
sudo tcpdump -i any -nn -w tls13.pcap "host $(dig +short $TARGET | head -1) and port 443"

# 终端 B：发起一次握手
openssl s_client -connect $TARGET:443 -servername $TARGET -tls1_3 </dev/null >/dev/null 2>&1

# 回到终端 A：Ctrl+C 停止，用 Wireshark 打开
wireshark tls13.pcap
```

Wireshark 里按 `tls.handshake.type == 1` 过滤可以定位 ClientHello。对照时间列，能看到清晰的时间轴：

```text
t=0.000   SYN            →
t=0.050   ← SYN-ACK      # TCP 握手 1 个 RTT（50ms）
t=0.050   ACK
t=0.060   ClientHello    →
t=0.110   ← ServerHello…Finished   # TLS 1.3 握手 1 个 RTT
t=0.120   → Finished + HTTP GET    # 请求和握手第三段一起发出
t=0.180   ← HTTP 200               # HTTP 请求 1 个 RTT
```

如果是 TLS 1.2，你会看到 ClientHello 之后要多等一个来回才能发出 HTTP 请求——**总 RTT 数和第二节的理论表完全对得上**，这就是"验证结论"的过程。

> 注：Wireshark 能直接解出 TLS 握手明文（证书、扩展字段），但握手之后的应用数据是密文。想在 Wireshark 里看 HTTP 明文，需要配置 TLS 密钥日志（浏览器场景设置 `SSLKEYLOGFILE` 环境变量，curl 场景较麻烦），日常排障抓"时序和重传"其实不需要解密。

# 七、实验 3：curl -w 量化每个阶段的耗时

`curl -w` 可以在请求结束后打印各阶段时间戳：

```bash
curl -s -o /dev/null \
  -w 'dns=%{time_namelookup}s tcp=%{time_connect}s tls=%{time_appconnect}s ttfb=%{time_starttransfer}s\n' \
  https://$TARGET/
```

字段含义（先减再算，别直接比大小）：

| 字段 | 含义 | 阶段耗时 = 与前一项的差 |
| --- | --- | --- |
| time_namelookup | DNS 解析完成 | DNS |
| time_connect | TCP 握手完成 | TCP = connect − dns |
| time_appconnect | TLS 握手完成 | TLS = appconnect − connect |
| time_starttransfer | 首字节到达 | TTFB = starttransfer − appconnect |

在注入 50ms netem 延迟的实验机上，三类场景的**参考实测**如下（你的数字会略有出入，但 RTT 倍数关系应一致）：

| 场景 | TCP 耗时 | TLS 耗时 | TTFB 合计 | 与理论值对照 |
| --- | --- | --- | --- | --- |
| TLS 1.2 全握手（强制 `-tls-max 1.2`） | ~52ms | ~105ms（2 RTT） | ~210ms | 4 RTT ≈ 200ms ✅ |
| TLS 1.3 全握手 | ~52ms | ~55ms（1 RTT） | ~160ms | 3 RTT ≈ 150ms ✅ |
| 同进程复用连接（一条 curl 打两个 URL） | 第 2 个请求 ~0ms | ~0ms | ~55ms | 长连接直连 ✅ |

复现命令：

```bash
# TLS 1.2
curl -s -o /dev/null --tls-max 1.2 \
  -w 'tcp=%{time_connect}s tls=%{time_appconnect}s ttfb=%{time_starttransfer}s\n' https://$TARGET/

# TLS 1.3
curl -s -o /dev/null \
  -w 'tcp=%{time_connect}s tls=%{time_appconnect}s ttfb=%{time_starttransfer}s\n' https://$TARGET/

# 连接复用：同一条命令请求两次，看第二次的数字
curl -s -o /dev/null -o /dev/null \
  -w 'req1 ttfb=%{time_starttransfer}s\n' -w 'req2 ttfb=%{time_starttransfer}s\n' \
  https://$TARGET/ https://$TARGET/
```

TLS 1.2 与 1.3 的差距约等于 **1 个 RTT**：RTT 50ms 的跨城链路省 50ms，RTT 200ms 的跨国链路就省 200ms。这就是为什么 CDN 和大厂网关都在推 TLS 1.3——**它省的不是 CPU，是物理距离造成的光速税**。

**验证方法**：把 netem 的延迟从 50ms 改成 100ms 重跑一遍，TLS 1.2 和 1.3 的差距应当从 ~50ms 变成 ~100ms。如果你的实测差值始终不变，说明延迟瓶颈不在握手（比如 DNS 慢了），回头查 `time_namelookup`。

# 八、会话复用：第二次握手怎么变快

TLS 1.2 复用会话（Session ID/Ticket）后，握手从 2 RTT 降为 1 RTT；TLS 1.3 的 PSK 复用 RTT 不变，但省掉了证书验证和非对称运算，**CPU 开销大幅下降**。用 `openssl s_client -reconnect` 直接观察：

```bash
openssl s_client -connect $TARGET:443 -servername $TARGET -reconnect </dev/null 2>&1 \
  | grep -E '^New|^Reused' | head -6
```

```text
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Reused, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Reused, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
...
```

第 1 次是全握手，后面连续 5 次默认会尝试复用。输出里出现 `Reused` 就证明服务器支持会话恢复。

服务端想让 TLS 1.3 生效 + 开启会话票证，Nginx 侧的关键配置其实很少：

```nginx
listen 443 ssl;
http2 on;
ssl_protocols TLSv1.2 TLSv1.3;   # 同时保留 1.2 兼容老客户端
ssl_session_cache shared:SSL:50m;
ssl_session_timeout 1d;
ssl_session_tickets on;
```

**验证方法**：改配置前后各跑一遍第七节的 curl 脚本，对比 `time_appconnect − time_connect`；或用 `openssl s_client -reconnect` 确认 `Reused`。

# 九、常见坑与误区

1. **实验完忘删 netem**。`tc qdisc del dev eth0 root` 必须执行，否则整台机器所有出网流量都带 50ms 延迟，你会怀疑人生。重置网卡的土办法是 `reboot`，但没必要。
2. **把 DNS 慢算成 TLS 慢**。看 TLS 耗时请用 `time_appconnect − time_connect`，直接拿 `time_appconnect` 当"TLS 耗时"会把 DNS 和 TCP 都算进去。
3. **证书链不完整**，握手照样成功，但部分老客户端会失败，或在验证环节多跑一次网络请求。用 `openssl s_client -showcerts -connect $TARGET:443 -servername $TARGET` 检查返回的证书数量，或到 SSL Labs 跑一次评分。
4. **TLS 1.3 不是"开了就快"**：客户端库（OpenSSL 1.1.1+）和中间设备都得支持；个别企业防火墙不认识 TLS 1.3 的握手形态会掐连接，灰度时要看握手失败率。
5. **0-RTT 有重放风险**：攻击者可以把捕获的 0-RTT 数据原样重放给服务器。只对幂等请求（GET、带幂等键的请求）放行 0-RTT，写操作一律等完整握手。
6. **测速机走了代理**：环境变量 `http_proxy/https_proxy` 会让 curl 的连接目标是代理而不是真实服务器，数据全废。测试前 `env | grep -i proxy` 检查。
7. **tcpdump 抓不到"明文 HTTP"就以为抓包没用**：排障 80% 的场景（重传、零窗、握手时序）只需要密文包的时序和大小，不需要解密。
8. **"慢"不一定是 TLS 的锅**：跨国访问的大头是 RTT 和丢包，TLS 1.3 只是把你必须付的路费打折，CDN 就近终接才是把路修短。

# 十、总结

- 一次 HTTPS 首次请求 = TCP 1 RTT + TLS 握手 1~2 RTT + HTTP 1 RTT，TLS 1.3 把全握手从 2 RTT 压到 1 RTT。
- `openssl s_client` 看握手**结构**（消息顺序），`tcpdump + Wireshark` 看**时序**（RTT 计数），`curl -w` 看**耗时**（阶段分解），三件套互相印证。
- 差距 = RTT 倍数 × RTT 值：链路越差，TLS 1.3 收益越大；CDN 省的是 RTT 本身，两者互补。
- 长连接 + 会话复用是摊薄握手成本的正道，0-RTT 是锦上添花但要防重放。

# 参考资料

1. RFC 8446: The Transport Layer Security (TLS) Protocol Version 1.3 — <https://datatracker.ietf.org/doc/html/rfc8446>
2. Cloudflare 博客：A Detailed Look at RFC 8446 (a.k.a. TLS 1.3)（中文版）— <https://blog.cloudflare.com/zh-cn/a-detailed-look-at-rfc-8446-a-k-a-tls-1-3-zh-cn/>
3. 阮一峰：《SSL/TLS 协议运行机制的概述》— <https://www.ruanyifeng.com/blog/2014/02/ssl_tls.html>
4. 罗剑锋：《透视 HTTP 协议》（极客时间专栏，TLS 握手与性能章节）
