---
title: TG Vault 文档中心
description: Telegram 转存、媒体归档与多存储源私有云系统
permalink: /
---

{% include nav.html %}

<img class="docs-logo" src="{{ '/assets/logo.png' | relative_url }}" alt="TG Vault Logo">

<p class="doc-lead"><strong>把 Telegram 变成你的自动化私有云入口。</strong><br>从 Telegram、Web 或视频链接接收内容，转存到本地磁盘或多个云存储账户，并在同一个 Web 控制台中检索和管理。</p>

<div class="callout">
本网站记录 <strong>TG Vault 当前项目</strong>的部署与使用方法。TG Vault 源自 FoomClous，但已经扩展了账号级 Telegram 下载器、频道订阅、任务中心、Google Drive、多账户目标、首次初始化登录和更完整的生产运维能力；配置时请以本站和 TG Vault 仓库为准。
</div>

## 从这里开始

<div class="doc-grid">
  <a class="doc-card" href="{{ '/quick-start.html' | relative_url }}"><strong>🚀 快速部署</strong>准备域名和环境变量，使用 Docker Compose 启动 Web、API 与 PostgreSQL。</a>
  <a class="doc-card" href="{{ '/storage.html' | relative_url }}"><strong>☁️ 存储源配置</strong>配置本地、OneDrive、Google Drive、阿里云 OSS、S3 和 WebDAV。</a>
  <a class="doc-card" href="{{ '/telegram.html' | relative_url }}"><strong>🤖 Telegram</strong>配置 Bot、账号级下载器、允许用户、频道抓取、订阅和命令。</a>
  <a class="doc-card" href="{{ '/ytdlp.html' | relative_url }}"><strong>🎬 yt-dlp</strong>在 Bot 中解析链接，确认最佳视频或仅音频，然后转存到目标账户。</a>
  <a class="doc-card" href="{{ '/security.html' | relative_url }}"><strong>🔐 安全说明</strong>了解首次初始化、Cookie、Origin、TOTP、凭据加密和备份边界。</a>
  <a class="doc-card" href="{{ '/operations.html' | relative_url }}"><strong>🧰 运维与恢复</strong>更新、健康检查、日志、备份、恢复验证和安全清理。</a>
  <a class="doc-card" href="{{ '/architecture.html' | relative_url }}"><strong>🧠 工作原理</strong>理解服务器中转、任务目标快照、持久化队列和存储写入流程。</a>
  <a class="doc-card" href="https://github.com/hicocos/tg-vault"><strong>💻 GitHub 仓库</strong>查看源码、README、提交历史和问题反馈。</a>
</div>

## 能做什么

- **Web 文件管理**：上传、分片续传、文件夹、搜索、收藏、预览、移动、重命名、批量删除与受支持存储的分享链接。
- **六类存储目标**：本地磁盘、OneDrive、Google Drive、阿里云 OSS、S3 兼容存储和 WebDAV；支持多个云存储账户。
- **Telegram 自动化**：Bot 收文件、选择存储目标、管理任务、检索文件、查看诊断状态和运行 yt-dlp。
- **账号级下载器**：按日期或标签抓取频道/群组媒体，建立订阅并持续同步，也可处理 Bot 通道不适合的大文件。
- **可恢复任务链路**：持久化任务状态，支持暂停、继续、取消、失败重试和服务重启后的恢复处理。
- **生产安全基础**：首次初始化管理员、HttpOnly Cookie、Origin 校验、TOTP、加密保存第三方存储凭据和健康检查。

## 选择一条使用路径

| 你的目标 | 需要配置 |
| --- | --- |
| 只使用 Web 管理文件 | 基础部署 + 至少一个存储目标；本地存储开箱即用 |
| 让 Bot 接收文件和运行 yt-dlp | 基础部署 + Bot Token + Telegram API ID/Hash |
| 抓取频道/群组历史媒体 | 在 Bot 配置基础上，再生成账号级 session |
| 自动同步频道新内容 | 账号级 session + `/tg_sub` 订阅 |
| 使用 OneDrive/Google Drive | 对应平台 OAuth 应用和精确回调地址 |

## 重要边界

- TG Vault 是自托管服务，GitHub Pages **只托管这套静态文档**，不会替你运行 TG Vault。
- Web 上传、Telegram 下载和 yt-dlp 都会经过部署 TG Vault 的服务器；服务器需要足够的临时磁盘、带宽和内存。
- 第三方存储凭据只应在自己的 TG Vault 设置页或服务器环境中填写，不要提交到 GitHub。
- 生产环境应使用 HTTPS，并备份 PostgreSQL 与完整 `file-storage` 卷。

---

[查看源码](https://github.com/hicocos/tg-vault) · [提交问题](https://github.com/hicocos/tg-vault/issues) · [MIT License](https://github.com/hicocos/tg-vault/blob/main/LICENSE)
