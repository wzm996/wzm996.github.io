---
title: Hexo 7 + GitHub Actions：PR 构建与 Pages 部署的最小可复现清单
date: 2026-03-12 18:39:00
categories:
  - 软件工程与系统设计
  - CI/CD
tags:
  - Hexo
  - GitHub Actions
  - GitHub Pages
  - Node.js
  - CI
---

很多个人博客的“线上能访问”背后，最容易出问题的其实不是 Hexo，而是 CI：

- PR 能不能提前把构建跑通？
- 合并到 master 后能不能稳定部署到 GitHub Pages？
- 本地能跑，CI 失败到底该怎么定位？

这篇文章给出一套**最小可复现**的 GitHub Actions 配置清单（适配 Hexo 7 / Node 20+），并且用“能验证/能复现”的方式，把常见坑一口气踩完。

<!-- more -->

## 目标与前提

目标：

1. 每次 `pull_request` 触发**构建校验**（不部署）。
2. 每次 push 到 `master` 触发**构建 + 部署到 GitHub Pages**。
3. 任意一步失败都能快速定位（依赖安装、Hexo generate、主题配置、Node 版本、缓存等）。

前提：

- 你使用的是 **Hexo 7**
- 站点源码在 GitHub 仓库中
- 使用 GitHub Pages（官方 Pages）托管静态站点

本文示例约定：

- 基线分支：`master`
- Node：`20`
- 包管理：`npm ci`

## 最小可复现目录结构

只要你满足如下关键文件，CI 就能跑起来：

```text
.
├── package.json
├── package-lock.json
├── _config.yml
├── source/
├── themes/ (可选，或使用 npm 安装主题)
└── .github/workflows/
    ├── pages.yml
    └── pr-build.yml
```

其中：

- `package-lock.json`：强烈建议提交，否则 `npm ci` 无法保证一致性
- `_config.yml`：必须包含 `url/root/permalink` 等基础配置

## 工作流 1：PR Build（只构建，不部署）

新建文件：`.github/workflows/pr-build.yml`

```yml
name: PR Build (Hexo)

on:
  pull_request:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: |
          npx hexo clean
          npx hexo generate
```

### 验证方式

1. 开一个分支，随便改一处文章内容提交。
2. 发起 PR。
3. 在 PR 页面看到 Checks：`PR Build (Hexo)` 成功。

### 常见坑（PR Build）

#### 1）`npm ci` 报错：lockfile 不匹配/缺失

现象：

- `npm ci` 要求 `package-lock.json` 必须存在，并且与 `package.json` 同步

修复：

```bash
npm install
git add package-lock.json
git commit -m "chore: update lockfile"
```

#### 2）CI 上 `hexo generate` 找不到主题

现象：

- 本地能跑，CI 报 `theme next not found` 或类似错误

原因：

- 主题没有纳入依赖（例如你本地有，但仓库里没提交，也没在 `package.json` 里声明）

修复建议（二选一）：

- 方案 A：把主题作为 npm 依赖（推荐）
- 方案 B：把主题目录提交到仓库（不太推荐，容易大）

## 工作流 2：Pages Deploy（push master 自动部署）

新建文件：`.github/workflows/pages.yml`

```yml
name: Deploy Hexo site to Pages

on:
  push:
    branches: [ master ]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: |
          npx hexo clean
          npx hexo generate

      - name: Setup Pages
        uses: actions/configure-pages@v5

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: ./public

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

### 验证方式

1. 合并任意 PR 到 `master`（或直接 push 到 `master`，但建议都走 PR）。
2. 在 Actions 页面看到工作流 `Deploy Hexo site to Pages` 执行成功。
3. 打开仓库 Settings → Pages，确认 Source 使用 GitHub Actions。
4. 访问站点 URL，确认新内容已发布。

## 小实验：本地复刻 CI 的构建环境

很多“CI 失败但本地成功”其实是环境不一致导致。

你可以用下面命令把本地环境尽量贴近 CI：

```bash
# 建议 Node 20+
node -v

# 清理安装（贴近 npm ci）
rm -rf node_modules
npm ci

# 清理并生成
npx hexo clean
npx hexo generate

# 可选：本地预览
npx hexo server
```

验证点：

- `public/` 是否生成
- 是否存在 404（主题资源路径、root 配置）
- `hexo generate` 过程中是否有 warning（模板缺文件、插件不兼容）

## 常见误区与排查清单

### 误区 1：把 `public/` 提交到仓库

如果你用 GitHub Actions 部署 Pages，通常不需要提交 `public/`。

推荐做法：

- `public/` 加入 `.gitignore`
- 构建产物通过 `upload-pages-artifact` 传递给部署 job

### 误区 2：`timezone` 没设置导致日期异常

如果不设置时区，文章日期可能在 CI 上出现偏移。

建议在 `_config.yml` 中明确：

```yml
timezone: Asia/Shanghai
```

### 误区 3：PR Build 与 Deploy 用了不同的生成命令

有些仓库会在 PR build 里用另一份 config（例如 NexT 的 `_data/next.yml`），导致 PR 通过但部署失败（或者相反）。

建议：

- PR Build 与 Deploy 的 `hexo generate` 尽量一致
- 如果确实需要额外 config，在两边都统一

示例：

```bash
npx hexo generate --config _config.yml,source/_data/next.yml
```

### 误区 4：依赖缓存导致“偶现”失败

`actions/setup-node` 的 npm cache 能加速，但如果 lockfile 改了，cache 行为可能让问题更难复现。

排查建议：

- 先临时去掉 `cache: 'npm'` 验证一轮
- 或者在日志里确认命中/未命中

## 参考资料

- Hexo 文档（Configuration）：https://hexo.io/docs/configuration
- GitHub Actions：actions/checkout：https://github.com/actions/checkout
- GitHub Actions：actions/setup-node：https://github.com/actions/setup-node
- GitHub Pages + Actions 官方文档：https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- upload-pages-artifact：https://github.com/actions/upload-pages-artifact
- deploy-pages：https://github.com/actions/deploy-pages
