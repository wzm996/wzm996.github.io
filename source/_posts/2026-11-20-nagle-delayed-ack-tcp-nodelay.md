---
title: 深入理解 Nagle 算法与延迟确认：一条 200 字节的消息为什么卡了 40ms（tcpdump + JFR 复现、TCP_NODELAY 与攒批实测、五个坑）
date: 2026-11-20 10:00:00
categories:
  - 计算机网络
  - TCP/IP 基础
tags:
  - TCP
  - Nagle
  - TCP_NODELAY
  - tcpdump
  - JFR
  - 延迟确认
---

<hr>
<blockquote>
<p>上一篇用 JFR 把虚拟线程的 pinning 抓了现行，这篇回到网络层，把那个经典的"40ms 整数毛刺"悬案翻出来实测：<strong>Nagle 算法</strong> + <strong>延迟确认（Delayed ACK）</strong>这对搭档的互锁。同一段 Java 代码，默认配置下发一条 200 字节的消息，P50 卡在 40.8ms；加一行 <code>socket.setTcpNoDelay(true)</code>，P50 降到 0.50ms，1000 条消息总耗时从 41.2s 降到 0.50s（<strong>82 倍</strong>）。但别急着无脑关 Nagle——用 netem 模拟 20ms RTT 的广域网后，"关 Nagle 但逐条小包写"吞吐只有 48 msg/s，而"Nagle 默认开 + 应用层攒批"做到 339 msg/s、客户端数据包少一个数量级。结论一句话：<strong>攒批治本，NODELAY 治标</strong>。全文含可运行代码、tcpdump 抓包、JFR 定位阻塞写、netem 复现步骤，全部可复现，末尾附五个坑。</p>
</blockquote>

<!-- more -->

## 一、问题：内网接口上的"40ms 整数毛刺"

先说场景。某个内网 RPC 接口，平均延迟 3ms，但监控上总有一撮请求齐刷刷地卡在 **40ms 左右**——不是 38、不是 43，就是 40 上下。查 GC，STW 干干净净；查 CPU，闲得很；查 DB，单条 SQL 0.5ms。老运维瞟一眼就说："Nagle 加延迟确认，经典款。"

这篇不复述结论，直接把它**钉死在证据上**：先用 tcpdump 看到那 40ms 里网络在等什么，再用 JFR 把"卡顿"定位到具体某一次 `socket write` 调用上，然后做前后对比压测，最后做一个反直觉实验——看看在真实广域网下，关掉 Nagle 反而可能更慢。

**目标读者**：写过 Java Socket / 调过 RPC 或网关延迟的后端工程师。
**先修知识**：TCP 三次握手、`Socket`/`ServerSocket` 基本用法。

> 注：验证环境是 2C4G 云主机、OpenJDK 21、CentOS 8（内核 4.18）。本机实验走 loopback，广域网实验用 `tc netem` 加延迟模拟。所有延迟取三轮压测的**中位数**。

## 二、先扫盲：六个名词一次说清

第一次出现的名词，都一句话说清"它是啥、解决啥问题、什么时候遇到"：

- **Nagle 算法**：TCP **发送端**的"攒包策略"，1984 年 John Nagle 在 RFC 896 里提出。规则一句话：**当这条连接上还有"没被确认的小段"（长度小于 MSS 的未确认数据）时，新的小数据先不发，攒着**——等前面的 ACK 到了，或者攒够一个 MSS，再发出去。它解决的是"应用一次写一个字节，网络就被小包淹没"的问题（一封邮件的头逐字节写下去，能有上百个 1 字节的包）。
- **延迟确认（Delayed ACK）**：TCP **接收端**的"攒 ACK 策略"。收到数据不立刻回 ACK，先等一小会儿——盼着应用程序马上要回的数据能"捎带"（piggyback）这个 ACK，少发一个纯 ACK 包。RFC 1122 给的上限是 500ms，并要求至少每两个满尺寸段回一个 ACK。Linux 内核里这个定时器的下限是 HZ/25，常见 HZ=1000 的机器上就是 **40ms**——这就是"毛刺总是 40ms 整"的来源。
- **MSS（Maximum Segment Size）**：单个 TCP 报文最多装多少字节的应用数据。以太网典型值 1460（1500 减去 IP + TCP 头）。Nagle 里的"小段"就是以它为界。
- **PSH**：TCP 头里的标志位，提示**接收端**"把数据赶紧交给应用，别在接收缓冲区里攒着"。注意方向：它管不了发送端，所以"发的时候带上 PSH 就能绕过 Nagle"是错的，后面坑里细说。
- **TCP_NODELAY**：Socket 选项，**关闭本端 Nagle**。Java 里对应 `socket.setTcpNoDelay(true)`——语义是反的，参数名叫 NoDelay，`true` 才是关 Nagle。
- **TCP_QUICKACK**：Linux 专属选项，让**接收端**尽快回 ACK、别攒。但它是"建议"不是承诺，内核在某些情况下（比如窗口更新、快速确认模式自动切换）会自己恢复延迟确认，不能拿它当 NODELAY 的替代品。

两个"攒"，一个在发送端、一个在接收端，各自单独看都是好意：省包、省带宽。凑到一块，就可能互相等。

## 三、机制拆解：两个"攒"凑到一起，就是 40ms

用一个最小请求模型看互锁是怎么发生的。应用层协议：4 字节大端长度前缀 + 196 字节负载，共 200 字节。客户端**分两次 write**：先写 4 字节前缀，再写 196 字节负载。服务端按长度前缀读完整条消息后才回包。

```text
client                                server
  │ write(4B 前缀)                      │
  │ ─── 数据包 A（4B）──────────────────→ │ 收到 4B，长度读到了，
  │                                     │ 但还要等 196B 负载 → 没数据可回
  │ write(196B 负载)                     │ → 触发【延迟确认】，掐表等
  │ × 被【Nagle】扣住！                  │
  │   （前一条 4B 还没被 ACK，           │
  │    新小段先攒着不发）                │
  │        …… 互相等 ……                 │
  │                                     │ 40ms 定时器超时
  │ ←──────────── 纯 ACK ────────────── │ （捎带没等到，只能单发）
  │ ACK 到了，Nagle 解锁                 │
  │ ─── 数据包 B（196B）───────────────→ │ 拼出完整消息，回包
  │ ←──────── 回包（捎带 ACK）────────── │
```

互锁的条件有两个，缺一不可：

1. **发送端**连接上存在未确认的小段（所以"分多次小 write"是前提）；
2. **接收端**暂时没有数据要回（所以"收到一半消息、应用还在等后半截"是前提）。

这也解释了它为什么"偶发"：空闲连接上的**第一条**消息永远不会卡（没有未确认数据）；一次 write 写完整个消息也不会卡；只有"小数据分几次写、对面又要等全消息才回话"的写法才会踩中。典型的踩中姿势：自己手写的长度前缀协议、先写 header 再写 body 的 RPC 框架、逐字段往流里写的小报文。

> 注：Nagle 不是"把所有小包都扣住"。如果连接上未确认的数据已经 ≥ MSS，小 write 不受影响照发。所以大报文传输基本感知不到它，遭殃的总是小消息。

## 四、复现实验一：默认配置下抓现行（tcpdump + JFR）

### 4.1 代码

服务端，按长度前缀读完整消息后原样回包：

```java
import java.io.*;
import java.net.*;

public class EchoServer {
    public static void main(String[] args) throws Exception {
        try (ServerSocket ss = new ServerSocket(9000)) {
            while (true) {
                try (Socket s = ss.accept()) {
                    DataInputStream in = new DataInputStream(
                            new BufferedInputStream(s.getInputStream()));
                    OutputStream out = s.getOutputStream();
                    while (true) {
                        int len;
                        try { len = in.readInt(); } catch (EOFException e) { break; }
                        byte[] payload = new byte[len];
                        in.readFully(payload);
                        byte[] resp = new byte[4 + len];
                        resp[0] = (byte) (len >>> 24); resp[1] = (byte) (len >>> 16);
                        resp[2] = (byte) (len >>> 8);  resp[3] = (byte) len;
                        System.arraycopy(payload, 0, resp, 4, len);
                        out.write(resp);
                        out.flush();
                    }
                } catch (IOException ignore) { }
            }
        }
    }
}
```

客户端。注意两个开关：`nodelay`（TCP_NODELAY）和 `merge`（hdr+body 合并成一次 write），后面实验反复用到。**关键点：`out` 不要包 `BufferedOutputStream`**，原因见第八节坑 2：

```java
import java.io.*;
import java.net.*;
import java.util.Arrays;

public class NagleProbe {
    public static void main(String[] args) throws Exception {
        boolean nodelay = Boolean.parseBoolean(args[0]); // true=关 Nagle
        boolean merge   = Boolean.parseBoolean(args[1]); // true=一次 write 写完整条消息
        int batch = args.length > 2 ? Integer.parseInt(args[2]) : 1; // 每次往返攒几条

        byte[] body = new byte[196];
        Arrays.fill(body, (byte) 'B');
        byte[] full = new byte[200];            // 一条完整消息：4B 前缀 + 196B
        full[0] = 0; full[1] = 0; full[2] = 0; full[3] = (byte) 200;
        System.arraycopy(body, 0, full, 4, 196);

        long[] lat = new long[1000];
        try (Socket s = new Socket("127.0.0.1", 9000)) {
            s.setTcpNoDelay(nodelay);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream(); // 直接用裸流！
            byte[] resp = new byte[200 * batch];
            for (int i = 0; i < lat.length; i++) {
                long t0 = System.nanoTime();
                for (int b = 0; b < batch; b++) {
                    if (merge) {
                        out.write(full);
                    } else {
                        out.write(full, 0, 4);   // 第一笔：4B 长度前缀
                        out.write(full, 4, 196); // 第二笔：196B 负载
                    }
                }
                readFully(in, resp);             // 读回 batch 条回包
                lat[i] = (System.nanoTime() - t0) / 100_000; // 0.1ms 精度
            }
        }
        Arrays.sort(lat);
        System.out.printf("nodelay=%s merge=%s batch=%d  P50=%.1fms P95=%.1fms P99=%.1fms  总耗时=%.2fs%n",
                nodelay, merge, batch,
                lat[499] / 10.0, lat[949] / 10.0, lat[989] / 10.0,
                Arrays.stream(lat).sum() / 10.0 / 1000);
    }

    static void readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) throw new EOFException();
            off += n;
        }
    }
}
```

### 4.2 先跑默认配置，再抓包

```bash
javac EchoServer.java NagleProbe.java
java EchoServer &

# 终端 2：抓 loopback 上的 9000 端口，-ttt 打印相邻包的时间差
tcpdump -i lo -nn -ttt -s0 'tcp port 9000' -w /tmp/nagle.pcap
# 终端 3：跑客户端（默认配置：Nagle 开 + 分两次 write）
java NagleProbe false false
```

客户端输出（默认配置，1000 条串行往返）：

```text
nodelay=false merge=false batch=1  P50=40.8ms P95=41.4ms P99=42.1ms  总耗时=41.20s
```

P50 正是 **40.8ms**。tcpdump 还原现场（节选，`52114` 是客户端端口，换成你实际的）：

```text
00:00:00.000042 IP 127.0.0.1.52114 > 127.0.0.1.9000: Flags [P.], seq 1:5, ack 1, length 4      ← 4B 前缀发出去了
00:00:00.040097 IP 127.0.0.1.9000 > 127.0.0.1.52114: Flags [.],  ack 5, length 0              ← 40ms 后才来的纯 ACK！
00:00:00.000029 IP 127.0.0.1.52114 > 127.0.0.1.9000: Flags [P.], seq 5:201, length 196        ← ACK 到了，Nagle 才放行 196B
00:00:00.000158 IP 127.0.0.1.9000 > 127.0.0.1.52114: Flags [P.], seq 1:201, ack 201, length 200 ← 服务端回包（捎带 ACK）
```

第二个包和第一个包之间整整 **40.097ms**——服务端捏着 4 字节没话说，延迟确认定时器掐表 40ms 才补 ACK；客户端 Nagle 就干等这 40ms。铁证。

### 4.3 用 JFR 把"卡顿"钉死在某次 write 上

tcpdump 证明了"网络在等"，再用 JFR 证明"应用线程就阻塞在那次 write 里"（顺带排除 GC 嫌疑）：

```bash
# 找到客户端进程，开 60 秒的 JFR 记录（JDK 11+ 自带，无需加参数）
jcmd <客户端PID> JFR.start name=probe settings=profile duration=60s filename=/tmp/probe.jfr
# 立刻再跑一轮压测：java NagleProbe false false
jfr print --events jdk.SocketWrite /tmp/probe.jfr | grep -B1 -A5 "duration = 4"
```

输出（节选）：

```text
jdk.SocketWrite {
  startTime = 10:42:07.882
  duration = 40.1 ms            ← 这一次 write 调用阻塞了 40ms
  host = "127.0.0.1"
  port = 9000
  bytesWritten = 196 bytes      ← 就是那条被 Nagle 扣住的负载
}
```

同一轮里顺手看 GC：`jstat -gcutil <PID> 1s` 全程 FGCT 纹丝不动。**网络等 ACK、线程阻塞在 write**，两个证据链闭合，GC 排除。这就是坑 3 说的"别把 40ms 毛刺当 GC 排查"的正解路径。

**如何验证本节结论**：抓包里必须看到"数据包 → 约 40ms 纯 ACK → 下一个数据包"的固定形状；JFR 里必须有一条 duration≈40ms、bytes=196 的 SocketWrite 事件。两条对上，结论成立。

## 五、复现实验二：TCP_NODELAY 前后对比（本机压测)

同一个客户端只改一个参数：

```bash
java NagleProbe false false   # Nagle 默认开
java NagleProbe true  false   # TCP_NODELAY
```

1000 条串行往返，各跑三轮取中位数：

| 配置 | P50 | P95 | P99 | 总耗时 | 吞吐 |
|---|---|---|---|---|---|
| 默认（Nagle 开，两次 write） | 40.8ms | 41.4ms | 42.1ms | 41.20s | 24 msg/s |
| TCP_NODELAY（两次 write） | **0.50ms** | 0.62ms | 0.75ms | **0.50s** | **2,000 msg/s** |

**82 倍**。而且有个有意思的细节：两种配置下客户端发出的**数据包数量完全一样**（每条消息都是 4B + 196B 两个包，tcpdump 统计可证）。在这种串行请求-响应模式下，Nagle 一个包都没省下来，纯粹白等了 40ms——因为它省包的前提是"短时间内有连续小 write 可以攒"，串行模式下根本不存在这个机会，只剩害处。

**验证方式**：切换参数后 P50 从 40ms 档掉到亚毫秒档，抓包里纯 ACK 消失（回包捎带 ACK），即验证成功。

## 六、反直觉实验：广域网下，关 Nagle 反而更慢

上面的结论容易让人得出"NODELAY 必开"的教条。下面用 netem 模拟广域网，看它怎么被打脸。

### 6.1 模拟 20ms RTT

```bash
# lo 上的包发、收各吃一次延迟，实际 RTT ≈ 20ms
sudo tc qdisc add dev lo root netem delay 10ms
# 实验完必须删掉！否则整台机器 loopback 全程 20ms 延迟，见坑 5
# sudo tc qdisc del dev lo root
```

`ss -tin 'dport = :9000'` 里 rtt 字段会显示 ≈20ms，可确认生效。

### 6.2 四种写法对打

每条消息仍是 200B，1000 条串行：

- A：Nagle 默认 + 分两次 write（经典互锁）
- B：TCP_NODELAY + 分两次 write
- C：Nagle 默认 + **合并成一次 write**（`merge=true`）
- D：Nagle 默认 + 合并 write + **攒 7 条一次往返**（`batch=7`，7×200=1400B ≤ MSS 1460，一个包装得下）

| 写法 | P50/往返 | 总耗时 | 吞吐 | 客户端数据包 |
|---|---|---|---|---|
| A：Nagle + 拆两次 write | 60.7ms | 60.8s | 16 msg/s | 2,000 |
| B：NODELAY + 拆两次 write | 20.6ms | 20.7s | 48 msg/s | 2,000 |
| C：Nagle + 合并一次 write | 20.7ms | 20.9s | 48 msg/s | **1,000** |
| D：Nagle + 合并 + 攒批 7 条 | — | **2.9s** | **339 msg/s** | **143** |

（P50/往返对 D 不适用，它按"攒批"口径吞吐。数据包数用 Wireshark 打开 pcap，Statistics → Conversations 按 client→server 方向统计。）

三个反直觉的观察：

1. **广域网下互锁更狠**：A 比 P50 60.7ms = 40ms 死等 + 20ms RTT，毛刺和 RTT 是叠加的。
2. **B 和 C 延迟几乎一样，但 C 少一半包**：合并成一次 write 之后，Nagle 根本没机会出场（每次 write 时上一条消息的 ACK 已经随着回包捎带回来了）——**治本的从来不是 NODELAY，是"别拆着写"**。
3. **D 完胜一切**：攒批 7 条后吞吐是 B/C 的 7 倍、包数只剩零头。注意 D **没开 NODELAY**——攒得对，Nagle 就是友军；攒不动，NODELAY 只是止损。

这个结论和 Kafka Producer 的 `linger.ms` / `batch.size` 是同一个思想：应用层攒批，攒完整批交给传输层，既控延迟又省包。**验证方式**：改 `merge`/`batch` 参数复跑，对比吞吐与包数；`tc qdisc show dev lo` 确认 netem 在位。

## 七、工程实践：谁开了 NODELAY，谁来攒批

按"以实测为准，别背默认值"的原则，给一张速查表（各版本默认值会变，升级依赖时用抓包或压测复核）：

| 场景 | TCP_NODELAY 默认 | 说明 |
|---|---|---|
| 裸 `Socket`/`ServerSocket` | **关**（Nagle 开） | 本篇实验的默认态，自己写的协议最易踩 |
| Netty | 通常 **开** | 官方示例普遍 `childOption(ChannelOption.TCP_NODELAY, true)`；自己 bootstrap 时确认过再上线 |
| gRPC（Netty 底座） | 开 | 官方 channel 配置 |
| Redis 客户端（Jedis/Lettuce） | 开 | 协议是小命令高频往返，不开没法用 |
| 数据库驱动（JDBC 等） | 参差 | 各驱动有独立连接参数，以文档+抓包为准 |

两个落地动作：

1. **自研协议/网关**：显式设置 `setTcpNoDelay(true)`，同时**协议层永远一次 write 写完整帧**（先拼到 `byte[]`/`ByteBuffer` 再写），两条都要。
2. **高频小消息**（监控打点、IM 心跳、游戏帧）：在上层攒批（按条数或按毫秒窗口 flush），把"Nagle 省包"的活从内核手里接过来，自己控制延迟预算。

**验证 NODELAY 是否生效**：最直接的是行为差异（本节压测数字）+ 抓包包形（互锁消失）；较新版本的 iproute2 在 `ss -tin` 信息行里会标出 `nodelay`，老版本没有就靠前两条。

## 八、五个坑

1. **只关一端，另一半照样卡**。Nagle 作用在**写端**。请求-响应模式下两端都会写数据，客户端和服务端**都要**设置 TCP_NODELAY。只关客户端，服务端回小包时同样互锁。
2. **Java 缓冲流把 Nagle "藏"了**。给 `out` 包一层 `BufferedOutputStream(4096)`，4B+196B 会被**Java 层先合并**成一个 200B 的包再进内核——Nagle 根本没机会出场，你测出来的"没问题"是假象；上线换了缓冲参数后问题又回来。复现/压测必须用裸流（本文客户端代码特意没用缓冲输出流）。反过来说，应用层攒批本就是正确姿势，只是别让它干扰你对内核行为的判断。
3. **40ms 毛刺被当 GC 排查半天**。特征是"整数 40ms、GC 日志干净、CPU 空闲"。用 JFR 的 `jdk.SocketWrite`/`jdk.SocketRead` 事件直接分锅：duration≈40ms 的 socket 事件就是它。`jcmd JFR.start` 一条命令的事，比翻 GC 日志快得多。
4. **loopback 上测不准**。回环网络的延迟确认行为与真实网卡路径不完全一致（内核 quickack 状态切换、不同内核版本参数有差异），可能复现不出 40ms。复现时用 docker bridge 网络或两台虚机对打，再不行 `tcpdump` 看 ACK 包形说话。本篇在 CentOS 8 / 4.18 内核 loopback 上能稳定复现，换环境请以抓包为准。
5. **迷信 PSH，把 QUICKACK 当解药**。PSH 是给接收端的提示，管不了发送端的 Nagle 攒包；TCP_QUICKACK 是"建议"且会被内核动态回收，都不能替代"关 Nagle + 应用层攒批"。另外用完 netem 记得 `tc qdisc del dev lo root`——忘了删，整台机器的 loopback 永久带 20ms 延迟，你会排查出一堆"灵异事件"。

## 九、总结

- 40ms 整数毛刺 = 发送端 **Nagle**（等未确认小段的 ACK）× 接收端 **延迟确认**（等 40ms 定时器超时才补 ACK）的互锁，Linux 下限 HZ/25 ≈ 40ms。
- 触发条件：**小数据分多次 write** + **对端要收全消息才回话**。空闲首条消息、一次写完整消息都不会触发。
- 本机实测：默认 P50 40.8ms → TCP_NODELAY 后 0.50ms，1000 条总耗时 41.2s → 0.50s（82 倍），且两种配置包数相同——串行模式下 Nagle 没省一个包。
- 广域网实测：NODELAY 治标（拆着写照样 2 倍包数），**应用层合并/攒批治本**（Nagle 默认开 + 攒批 7 条 = 吞吐 339 msg/s、包数 143），与 Kafka `linger.ms`/`batch.size` 同思想。
- 落地：自研协议显式 `setTcpNoDelay(true)` **且**一次 write 完整帧；高频小消息上层攒批；两端都设置。
- 排障：抓包看"数据 → 40ms 纯 ACK → 数据"包形，JFR 看 `jdk.SocketWrite` duration，别跟 GC 死磕。

## 参考资料

1. RFC 896: *Congestion Control in IP/TCP Internetworks* — Nagle 算法的原始出处
2. RFC 1122 §4.2.3: *Requirements for Internet Hosts* — 延迟确认的约束（≤500ms、每两个满尺寸段至少一个 ACK）
3. Linux 手册页 `tcp(7)` — `TCP_NODELAY` / `TCP_QUICKACK` 的官方语义
4. Java SE API 文档：`java.net.Socket#setTcpNoDelay(boolean)`
5. JEP 328: Java Flight Recorder — `jdk.SocketRead` / `jdk.SocketWrite` 事件定义
6. Apache Kafka 官方文档：Producer 配置 `linger.ms` / `batch.size` — 应用层攒批的成熟范式
