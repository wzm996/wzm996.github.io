---
title: Redis 大 key 实战：一条 DEL 把 Redis 冻住 400ms，从 redis-cli 排查到 lazyfree 治理
date: 2026-09-17 10:10:00
categories:
  - 数据库与存储
  - Redis
tags:
  - Redis
  - 大key
  - lazyfree
  - SCAN
  - 内存优化
---

<hr>
<blockquote>
<p><strong>大 key</strong> 不是报错，是慢性病：平时没事，一到 DEL、集中过期、主从同步就爆发。这篇用一台 4C8G 云主机 + Redis 7 复现了一次"事故现场"——100 万元素的 Hash（约 153MB），一条 <code>DEL</code> 让所有请求排队 408ms；换成 <code>UNLINK</code>（lazyfree）后长尾直接消失，内存 3 秒内被后台线程回收。全文附完整复现命令、探针脚本和一套线上排查/治理清单。</p>
</blockquote>

<!-- more -->

## 一、从一个再常见不过的"Redis 变卡"说起

先说个场景。缓存里躺着一个大对象——可能是爬虫攒的一个月流水、一个用户的全量标签、或者某个"当时觉得放 Redis 里挺方便"的大 JSON。业务下线了要清理，工程师顺手一句 `DEL big:hash`，然后：监控上炸出一根毛刺，一堆接口超时告警。

为什么一条删除命令能打出事故？因为 **Redis 是单线程模型**处理命令的——所有"动数据"的命令都在同一根线程里排队执行，一条慢命令执行时，后面所有人陪跑。这是 Redis 快的原因（没有锁、没有上下文切换），也是它的阿喀琉斯之踵。

这里说的 **大 key**（big key），指的不是 key 字符串本身长，而是 value 太肥：一个 string 几百 KB，或者一个 hash/list/set/zset 里塞了几十万个元素。它不会立刻出事，属于典型的慢性病——直到某一次删除、过期、全量同步，一次性引爆。

大 key 的危害主要是四件套：

1. **阻塞主线程**：`DEL`、过期删除、`HGETALL` 全量读取，都是 O(N) 操作，N 一大主线程就卡住，所有请求排队。
2. **主从同步被拖垮**：全量同步要生成和传输 RDB，大 key 让 RDB 变肥、传输变慢；从库回放删除命令时，主线程一样要阻塞。
3. **集群数据倾斜**：集群模式下某个分片因为一个大 key 内存和流量独高，扩缩容时这块"搬不动的石头"还会卡住 slot 迁移。
4. **内存与成本**：本文这条 key 一个就占 153MB，费用是真金白银，还挤占其他 key 的生存空间。

下面用实验把第 1 条危害量化出来：一条 DEL，到底卡多久？

## 二、多大的 key 算"大"？

先给一个可操作的口径，别拍脑袋。业界常用的经验阈值（参考阿里 Redis 开发规范 + 通用实践）：

| 类型 | 经验阈值 | 说明 |
| --- | --- | --- |
| string | 单值 > 10 KB | 该放对象存储/压缩的，别塞 Redis |
| hash / list / set / zset | 元素数 > 5000，或总大小 > 10 MB | 元素多和单元素大都要看 |
| 任意类型 | `MEMORY USAGE` > 1 MB 就该关注 | 精确口径，建议进巡检 |

我的观点是：阈值可以背，但更要记住一句判断原则——**看操作复杂度**。Redis 命令文档里每个命令都标了复杂度，凡是 O(N) 的命令（DEL、EXPIRE、HGETALL、SMEMBERS、ZRANGE 全量…）碰上大 N，就是潜在事故。单线程模型下，"慢"从来不是一个人的事，是全队陪跑。

## 三、先把"作案现场"搭出来（可复现）

实验环境：一台 4C8G 云主机（CentOS 8 内核），Docker 起一个 Redis 7 单实例，**关闭持久化**（排除 RDB/AOF 干扰，让数据更纯粹）：

```bash
docker run -d --name blog-redis-bench -p 127.0.0.1:6399:6379 \
  redis:7-alpine redis-server --save '' --appendonly no
```

造数据：一个 100 万 field 的 hash，每个 value 100 字节。先生成命令文件，再用 `redis-cli --pipe` 一次性灌进去——`--pipe` 模式是把一大批命令打包塞给 Redis、逐条吞响应，比一条一条 `HSET` 快一个数量级，适合灌测试数据：

```bash
# 1. 生成 100 万条 HSET 命令（约 119MB 文本）
python3 -c "
v = 'x'*100
with open('/tmp/bigfill.txt','w') as f:
    for i in range(1000000):
        f.write(f'HSET big:hash f:{i} {v}\n')
"

# 2. 管道灌入
time docker exec -i blog-redis-bench redis-cli --pipe < /tmp/bigfill.txt
```

实测灌入结果：`errors: 0, replies: 1000000`，耗时约 7.5s。验证一下现场：

```bash
docker exec blog-redis-bench redis-cli HLEN big:hash
# 1000000

docker exec blog-redis-bench redis-cli MEMORY USAGE big:hash
# 160388720        （约 153MB）

docker exec blog-redis-bench redis-cli INFO memory | grep used_memory:
# used_memory:161419248   （约 154MB）
```

这里出现 **MEMORY USAGE**——它是 Redis 4.0 起自带的"量体重"命令，不遍历元素就能估算一个 key 占用的内存字节数，O(1) 完成，线上可以放心用。

## 四、实验一：DEL 这条大 key，Redis 到底卡多久？

测"卡多久"需要一个探针。思路：用 Python 裸 socket 直连 Redis，每 2ms 发一条 PING 并记录耗时。它是单连接探针，所以当主线程被某条命令冻住时，PING 会排队，测到的延迟就约等于主线程被冻结的时长。脚本只有十几行：

```python
# prober.py —— 用法: python3 prober.py <持续秒数>
import socket, time, sys

host, port = '127.0.0.1', 6399
duration = float(sys.argv[1]) if len(sys.argv) > 1 else 10.0
s = socket.create_connection((host, port))
s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
lat = []
t_end = time.time() + duration
while time.time() < t_end:
    t0 = time.perf_counter()
    s.sendall(b'*1\r\n$4\r\nPING\r\n')   # RESP 协议的 PING
    s.recv(100)
    t1 = time.perf_counter()
    lat.append((t1 - t0) * 1000)
    time.sleep(0.002)
lat.sort()

def pct(p):
    return lat[min(int(len(lat) * p), len(lat) - 1)]

print(f"n={len(lat)} p50={pct(0.50):.2f}ms p95={pct(0.95):.2f}ms "
      f"p99={pct(0.99):.2f}ms max={lat[-1]:.2f}ms")
```

**第一步，测空载基线**（5 秒）：

```text
n=2299 p50=0.09ms p95=0.13ms p99=0.38ms max=10.06ms
```

很健康：P50 不到 0.1ms，max 也只有 10ms 量级。

**第二步，后台开探针，中途执行 DEL**：

```bash
python3 prober.py 12 &    # 探针跑 12 秒
sleep 1
time docker exec blog-redis-bench redis-cli DEL big:hash
```

实测：`DEL` 命令耗时 **0.46s**（`time` 统计含 docker exec 启动开销，纯阻塞时长看探针）。探针结果：

```text
n=5317 p50=0.09ms p95=0.13ms p99=0.45ms max=408.66ms
```

放一张对照表：

| 探针指标 | 空载基线 | DEL 期间 |
| --- | --- | --- |
| P50 | 0.09 ms | 0.09 ms |
| P95 | 0.13 ms | 0.13 ms |
| P99 | 0.38 ms | 0.45 ms |
| **max** | 10.06 ms | **408.66 ms** |

这张表是全文最重要的一张图，请注意一个反直觉的现象：**P50/P95/P99 几乎纹丝不动，但 max 冲到了 409ms**。

也就是说，大 key 的危害是**长尾，不是均值**。你的均值监控、甚至 P99 监控，都可能完全看不见它——直到某个倒霉用户的请求正好撞上那条 DEL，一次性吃掉 400ms 排队。这也解释了很多团队的经典困惑："压测都正常，怎么上线就炸毛？"——因为压测看均值和 P99，事故藏在 max 里。

## 五、实验二：UNLINK + lazyfree，把"删除"挪出主线程

**UNLINK** 是 DEL 的异步版：主线程只负责把 key 从键空间里摘掉，然后把真正的内存回收任务扔给后台线程——用大白话讲，不当场打扫房间，而是把垃圾袋扎好丢给保洁。

这套机制叫 **lazyfree**（惰性释放），Redis 4.0 引入。有个细节值得知道：只有元素数超过 64 的"大对象"才走异步回收，小对象仍然同步删——为 3 个字段开一次后台线程，调度开销反而比回收本身还贵，不划算。

重新灌入同一份数据（`--pipe < /tmp/bigfill.txt` 即可），重复实验，只把 `DEL` 换成 `UNLINK`：

```bash
python3 prober.py 15 &
sleep 1
time docker exec blog-redis-bench redis-cli UNLINK big:hash
```

实测结果：

```text
UNLINK 命令耗时: 0.06s（几乎全是 docker exec 开销，命令本身立即返回）
探针: n=6847 p50=0.08ms p95=0.14ms p99=0.84ms max=12.01ms

UNLINK 3 秒后查询内存:
used_memory:1207624     （161MB → 1.2MB，后台线程已回收完毕）
```

两个实验放一起看：

| 维度 | DEL | UNLINK（lazyfree） |
| --- | --- | --- |
| 主线程阻塞（探针 max） | **408.66 ms** | 12.01 ms（与空载同量级） |
| 命令返回时机 | 内存回收完才返回 | 摘掉 key 就返回 |
| 内存释放 | 同步，随命令完成 | 异步，实测 3 秒内完成 |

结论很直白：**把 DEL 换成 UNLINK，一行代码的改动，直接把 400ms 级长尾抹掉**。

顺手把配置层的兜底也做了（`redis.conf`）：

```text
lazyfree-lazy-user-del yes    # Redis 6.0+：客户端发 DEL 也自动走异步
lazyfree-lazy-expire yes      # key 过期删除走异步（线上大 key"集体到期"是大杀器）
lazyfree-lazy-server-del yes  # 内部隐式删除（如 RENAME 覆盖旧 key）走异步
```

但要泼一盆冷水：这些配置是**兜底，不是许可**。内存回收终究要占后台线程，如果你一边疯狂塞大 key、一边批量 UNLINK，后台线程一样可能跟不上，只是从"必卡"变成"偶卡"。病根在 key 太大，药方见第七节。

## 六、线上怎么提前发现大 key？（排查工具箱）

1. **`redis-cli --bigkeys`**：官方自带的大 key 扫描。原理是 **SCAN** 采样——SCAN 是渐进式遍历命令，每次只拿一小批 key、用游标续传，不会像 `KEYS *` 那样一次性卡死主线程。缺点：它报的是**每种类型里元素数最多**的 key，不是内存字节数——100 万元素 × 1 字节会排在 1 万元素 × 100KB 前面，而后者才是真凶。
2. **`MEMORY USAGE <key>`**：对 --bigkeys 疑似目标做精确确认，O(1) 安全。
3. **redis-rdb-tools**：一个离线解析 RDB 文件的开源工具（GitHub 可搜），能把全库 key 的内存占用导出成 CSV 排序盘点，适合做季度"体检报告"。缺点是要拿 RDB 文件，结论有滞后。
4. **SCAN + MEMORY USAGE 巡检脚本**：两者组合写个定时任务，按内存阈值告警，适合当成常态化巡检。

| 工具 | 原理 | 优点 | 局限 | 适用 |
| --- | --- | --- | --- | --- |
| --bigkeys | SCAN 采样 | 零依赖、官方自带 | 只看元素数、是采样 | 快速摸底 |
| MEMORY USAGE | O(1) 估算 | 精确、安全 | 只能查单个 key | 确认疑点 |
| redis-rdb-tools | 离线解析 RDB | 全量、可排序 | 拿 RDB 有滞后 | 定期体检 |
| 自写巡检脚本 | SCAN + MEMORY | 可定制阈值告警 | 自己维护 | 常态化 |

再强调一次：**`KEYS *` 在线上等于自杀**，O(N) 全量遍历，库一大当场卡死。

## 七、治理：真出了大 key 怎么办？（四板斧）

1. **拆**：把大 hash 按业务键分片，`big:hash` 拆成 `big:hash:{uid%1000}` 一千个小片（`{}` 是集群模式下的 **hash tag** 语法，保证相关 key 落在同一 slot，方便 mget/mset）。写读两处同步改，改动其实不大。
2. **压**：value 能压缩先压缩（JSON → gzip/snappy，或换 protobuf 这类二进制序列化），100KB 的 JSON 压完常常只剩 10~20KB。
3. **异步删**：所有删除一律 UNLINK；配置层开上面三个 lazyfree 开关；千万别忘了"过期"也是删除——集中过期是隐形炸弹。
4. **渐进**：实在没法一次删的（比如业务不允许瞬时摘除），用 HSCAN/SSCAN 每批取 500 个元素删，批间 `sleep` 控制节奏，把一次性 O(N) 摊薄成无数次小 O(1)：

```bash
# 渐进式掏空一个大 hash（伪脚本思路）
cursor=0
while :; do
  reply=$(redis-cli --raw HSCAN big:hash $cursor COUNT 500)
  cursor=$(echo "$reply" | head -n 1)
  echo "$reply" | tail -n +2 | awk 'NR%2==1{print "HDEL big:hash "$0}' \
    | redis-cli --pipe
  redis-cli ping > /dev/null   # 摸一下延迟，高就多睡
  sleep 0.05
  [ "$cursor" == "0" ] && break
done
```

配套监控建议：对 `used_memory` 增速、慢日志（`SLOWLOG GET`，慢查询日志，自动记录超过阈值的慢命令）、主从延迟建告警；把"新代码禁止裸 DEL 大 key"写进 code review 清单。

## 八、常见坑与误区

1. **`KEYS *` 一把梭**：O(N) 阻塞主线程，线上禁用，巡检一律 SCAN。
2. **把 --bigkeys 的"元素数"当"内存"**：元素少但单元素巨大的 key 它看不见，必须用 MEMORY USAGE 二次确认。
3. **以为开了 lazyfree 就稳了**：后台线程也会饱和，写入风暴里批量 UNLINK 依然会抖。它是减震器，不是免责声明。
4. **只看主库**：DEL 会随复制传播，从库主线程一样阻塞；集群模式下大 key 还会卡 slot 迁移。主库删干净了，事可能还没完。
5. **used_memory 降了，机器内存没降**：内存分配器（jemalloc）不一定立刻把内存归还操作系统，还有碎片问题。看 `INFO memory` 里的 `mem_fragmentation_ratio`（内存碎片率，大于 1.5 就该警惕），必要时开 `activedefrag`（主动碎片整理）。
6. **大 key 设同一个过期时间**：整点同一秒过期 = 一波集中删除风暴，即使 lazyfree 也扛不住密集轰炸。过期时间加随机抖动（如 ±10%）是标配。

## 九、总结

- 大 key 危害的本质：**单线程模型下，O(N) 命令制造长尾阻塞**，危害藏在 max 里，均值和 P99 看不见。
- 实测数据：153MB 的 hash，`DEL` 让探针 max 从 10ms 冲到 **408.66ms**；换 `UNLINK` 后回到 **12.01ms**，内存 3 秒内由后台线程回收。
- 发现手段：`--bigkeys` 摸底 + `MEMORY USAGE` 确认 + RDB 离线盘点 + 定期巡检。
- 治理四板斧：**拆、压、异步删、渐进删**；lazyfree 配置做兜底，但别把它当成继续塞大 key 的理由。

一条可以带走的行动清单：今天就 `grep -r "DEL" 你的缓存层代码`，把所有可能的删除操作换成 UNLINK，再跑一次 `redis-cli --bigkeys`——大概率你会谢过这一小时。

## 参考资料

1. Redis 官方文档 · DEL：<https://redis.io/docs/latest/commands/del/>
2. Redis 官方文档 · UNLINK：<https://redis.io/docs/latest/commands/unlink/>
3. antirez · Lazy Redis: better late than never：<http://antirez.com/news/93>
4. Redis 官方文档 · SCAN：<https://redis.io/docs/latest/commands/scan/>
5. redis-rdb-tools（离线分析 RDB）：<https://github.com/sripathikrishnan/redis-rdb-tools>
6. 阿里云 Redis 开发规范（大 key 治理章节）：<https://developer.aliyun.com/article/531067>
