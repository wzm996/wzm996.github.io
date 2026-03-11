# wzm996.github.io

个人博客站点（GitHub Pages）源码仓库。

- 站点地址：<https://wzm996.github.io/>
- 构建工具：[Hexo](https://hexo.io/)（本仓库使用 Hexo 7）
- 主题：NexT（legacy v5.1.4，Mist scheme）

## 本地开发

> 需要 Node.js（建议使用 Node 20+）。

```bash
npm ci
npx hexo server
```

访问：<http://localhost:4000/>

## 构建

```bash
npm run clean
npm run build
```

产物输出在 `public/`。

## 写新文章

```bash
npx hexo new post "文章标题"
```

文章会生成在：`source/_posts/`。

### 文章头部（Front-matter）约定

本仓库依赖文章 front-matter 来生成分类与标签：

- `categories`：建议使用 1 级或 2 级分类（层级分类）
- `tags`：关键词标签，可多个

示例：

```yaml
---
title: 示例文章
date: 2026-03-11 21:00:00
categories:
  - 编程语言
  - Java
tags:
  - 并发
  - JVM
---

<!-- more -->
```

## 分类体系（建议）

- 数据结构与算法
- 软件工程与系统设计
- 编程语言（Java / Go / Python / JavaScript / Rust ...）
- 人工智能
- 计算机网络
- 计算机系统（组成原理 / 操作系统 ...）

## 目录结构

- `source/_posts/`：文章
- `source/tags/`、`source/categories/`：标签/分类入口页
- `source/live2dw/`：Live2D 资源（站点“小猫”）
- `scaffolds/post.md`：新建文章模板（包含 `<!-- more -->`）
- `scripts/`：Hexo 脚本（例如注入 Live2D 脚本）

## 部署

通过 GitHub Actions 自动构建并部署到 GitHub Pages：

- 工作流：`.github/workflows/Deploy Hexo site to Pages`
- 触发：push 到 `master`

---

如需调整主题样式、菜单项、或分类体系，请直接提 PR 修改配置与文章 front-matter。
