---
title: Hexo 7 + GitHub Actions：用缓存把构建时间从分钟降到秒（含验证与坑）
date: 2026-03-12 10:00:00
categories:
  - 软件工程与系统设计
  - CI/CD
tags:
  - Hexo
  - GitHub Actions
  - GitHub Pages
  - 缓存
  - CI
---

GitHub Pages + Hexo 的站点部署，很多人第一次配好工作流后都会遇到一个现实问题：**每次 PR / push 都要等 2~5 分钟**，而且十有八九其中大部分时间都耗在「重复安装依赖」「重复生成缓存」上。

这篇文章用一个可复现的小实验，带你把 Hexo 的 Actions 构建时间从「分钟级」压到「秒级 ~ 1 分钟以内」（取决于命中率），并给出**验证方法、常见坑、以及参考资料**。

<!-- more -->

## 目标与前提

### 目标

- PR / push 触发的构建尽量快（尤其是 PR 校验）
- 不改动你写文章的方式（依然 `npm ci` + `hexo generate`）
- 缓存命中可验证、可度量（不是“感觉快了”）

### 前提

- 站点使用 **Hexo 7**（其他版本思路一致）
- CI 使用 **GitHub Actions**
- 包管理器为 **npm**（后文也会说明 pnpm/yarn 的差异点）

## 为什么 Hexo 构建会慢（以及该缓存什么）

Hexo 的典型构建流程：

1. 安装依赖（`npm ci`）
2. 生成站点（`npx hexo generate`）

其中慢点主要来自：

- **npm 下载/解压依赖**：网络 + 解压 IO
- **Node 生态的缓存**：npm 自己的缓存（`~/.npm`）
- **Hexo 生成过程**：对大量 markdown 渲染、主题资源处理

在 GitHub Actions 里最“划算”的缓存通常是两类：

- npm 缓存目录（`~/.npm`）
-（可选）构建产物/中间缓存（例如某些工具的缓存目录）

注意：**不要缓存 `node_modules/`**（对 `npm ci` 语义不友好，且跨 OS/Node 版本容易踩坑）。

## 小实验：给工作流加缓存，并量化收益

下面给出一个最小可用的配置片段，你可以直接加到工作流里（建议先在 PR 分支上验证）。

### 1) 工作流示例（带 npm 缓存）

如果你的工作流大致是这样：

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 20
- run: npm ci
- run: npm run build
```

把 `setup-node` 改成启用内置缓存：

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 20
    cache: npm
    cache-dependency-path: package-lock.json
```

完整关键片段（可直接复制）：

```yaml
name: Build Hexo

on:
  pull_request:
  push:
    branches: [master]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: package-lock.json

      - name: Install deps
        run: npm ci

      - name: Build
        run: npm run build
```

这里的核心是：

- `cache: npm` 会缓存 npm 的下载缓存（默认 `~/.npm`）
- 缓存 key 会跟 `package-lock.json` 强关联，lockfile 变化就自动 miss

### 2) 如何验证缓存是否生效

最可靠的方式：看 Actions 日志里 `actions/setup-node` 的输出。

你应该能看到类似：

- `Cache restored successfully`（命中）
- 或 `Cache not found`（未命中）

同时，第二次跑同样的 workflow，`npm ci` 步骤耗时应该显著下降。

你也可以加一个简单的时间统计：

```bash
/usr/bin/time -v npm ci
```

（注意：`-v` 输出较多，建议只在验证阶段临时打开。）

## 进阶：避免“缓存看似命中但还是慢”

有时你会遇到：日志显示 cache restored，但 `npm ci` 还是 1~2 分钟。常见原因：

1. **lockfile 频繁变化**：每次依赖变动都会导致缓存重新生成
2. **使用了不同 Node 版本**：缓存 key 会跟 Node 版本/架构有关
3. **网络/registry 波动**：即使有缓存，仍可能需要访问 registry 做校验或补齐

### 建议 1：固定 Node 主版本

```yaml
with:
  node-version: 20
```

不要在不同 job/工作流里一个用 18 一个用 20，否则缓存命中率直接腰斩。

### 建议 2：确认 registry 一致

如果你在 CI 中切换过 npm registry（例如公司镜像），缓存 key 不变但下载行为可能变化。

你可以显式指定：

```bash
npm config set registry https://registry.npmjs.org/
```

或保持和本地一致。

## 常见坑 / 误区

### 误区 1：缓存 `node_modules/`

很多文章会教你缓存 `node_modules/`，但对 `npm ci` 来说，它的设计目标是：

- 严格按 lockfile 重建依赖树
- 先删后装，保证干净

缓存 `node_modules/` 往往会造成：

- 体积大、恢复慢
- Node ABI/OS 差异导致诡异报错
- 你以为快了，实际上 restore 也要几十秒

结论：**优先缓存 npm cache（`~/.npm`），而不是 node_modules。**

### 误区 2：只缓存一次就觉得“已经优化完了”

缓存的价值来自“持续命中”。建议你在 PR、push 两个触发器上都观察几次：

- PR 构建（常改 md）是否也能命中
- push 到 master（部署）是否能命中

### 误区 3：缓存命中但 build 仍慢，就盲目缓存更多目录

缓存不是越多越好。缓存目录越多：

- 上传/下载时间增加
- key 维护复杂
- 还可能引入“脏缓存”问题

建议只从 **npm cache** 开始，收益最大、风险最小。

## 复现步骤（你可以照着做）

1. 在你的仓库中找到 Hexo 部署工作流：`.github/workflows/*.yml`
2. 在 `actions/setup-node@v4` 中加入：

   - `cache: npm`
   - `cache-dependency-path: package-lock.json`

3. 提交 PR，观察 Actions 日志：第一次大概率 cache miss
4. **再次触发同一工作流**（例如重新运行 job），观察：

   - `Cache restored successfully`
   - `npm ci` 耗时是否明显下降

## 附：pnpm / yarn 怎么办？

- pnpm：通常用 `actions/setup-node` 的 `cache: pnpm`，并确保 `pnpm-lock.yaml`
- yarn：用 `cache: yarn`，并确保 `yarn.lock`

思路一致：**缓存下载缓存目录 + key 绑定 lockfile**。

## 参考资料

1. GitHub Actions - `actions/setup-node` 文档（缓存说明）：https://github.com/actions/setup-node
2. GitHub Docs - Caching dependencies in workflows：https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/caching-dependencies-to-speed-up-workflows
3. npm CLI - `npm ci` 文档：https://docs.npmjs.com/cli/v10/commands/npm-ci
4. Hexo 文档 - Commands（generate/clean）：https://hexo.io/docs/commands
5. GitHub Pages + Actions 部署思路（概览）：https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages
