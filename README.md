---
title: TG Vault 文档中心
description: Telegram 转存、媒体归档与多存储源私有云系统
permalink: /
---

{% include nav.html %}

<img class="docs-logo" src="{{ '/assets/logo.png' | relative_url }}" alt="TG Vault Logo">

<p class="doc-lead"><strong>把 Telegram 变成你的自动化私有云入口。</strong><br>从 Telegram、Web 或视频链接接收内容，转存到本地磁盘或多个云存储账户，并在同一个 Web 控制台中检索和管理。</p>

<div class="callout">
本网站记录 <strong>TG Vault 当前项目</strong>的部署与使用方法。当前版本支持安装脚本快速部署、Web 管理 Telegram Bot 凭据、网页登录账号级下载器、统一任务中心、Web/Telegram yt-dlp、多存储账户以及完整备份恢复。
</div>

## 从这里开始

<div class="doc-grid">
  <a class="doc-card" href="{{ '/quick-start.html' | relative_url }}"><strong>🚀 快速部署</strong>只改两个地址，使用安装脚本自动生成密钥并启动 Web、API 与 PostgreSQL。</a>
  <a class="doc-card" href="{{ '/telegram.html' | relative_url }}"><strong>🤖 Telegram</strong>在 Web 中连接 Bot、设置 PIN 与允许用户，并登录账号级下载器。</a>
  <a class="doc-card" href="{{ '/storage.html' | relative_url }}"><strong>☁️ 存储源配置</strong>配置本地、OneDrive、Google Drive、阿里云 OSS、S3 和 WebDAV。</a>
  <a class="doc-card" href="{{ '/ytdlp.html' | relative_url }}"><strong>🎬 yt-dlp</strong>从 Web 或 Bot 创建最佳视频/仅音频任务，统一查看进度。</a>
  <a class="doc-card" href="{{ '/security.html' | relative_url }}"><strong>🔐 安全说明</strong>了解首次初始化、Cookie、Origin、TOTP、凭据加密和备份边界。</a>
  <a class="doc-card" href="{{ '/operations.html' | relative_url }}"><strong>🧰 运维与恢复</strong>更新、健康检查、日志、备份、恢复验证和安全清理。</a>
  <a class="doc-card" href="{{ '/architecture.html' | relative_url }}"><strong>🧠 工作原理</strong>理解服务器中转、任务目标快照、持久化队列和存储写入流程。</a>
  <a class="doc-card" href="https://github.com/hicocos/tg-vault"><strong>💻 GitHub 仓库</strong>查看源码、README、提交历史和问题反馈。</a>
</div>

## 能做什么

- **Web 文件管理**：上传、分片续传、文件夹、分类筛选、搜索、收藏、预览、移动、重命名和批量删除。
- **六类存储目标**：本地、OneDrive、Google Drive、阿里云 OSS、S3 兼容存储和 WebDAV，支持多个账户。
- **Telegram 网页配置**：测试并加密保存 Bot 凭据、设置 PIN、维护允许用户，无需编辑 `.env` 或重启。
- **账号级下载器**：直接在 Web 用手机号、验证码和可选两步验证登录；支持频道/群组抓取、订阅与大文件。
- **统一任务中心**：集中查看 Web 上传、Telegram、频道和 yt-dlp 任务，并安全取消、重试或移除终态记录。
- **Web 与 Bot yt-dlp**：粘贴单个媒体链接，选择最佳视频或 MP3，仅处理公网地址且默认拒绝播放列表。
- **可恢复任务链路**：持久化任务状态，支持暂停、继续、取消、失败重试和服务重启后的恢复。
- **生产安全基础**：首次初始化管理员、HttpOnly Cookie、Origin 校验、TOTP、凭据加密和健康检查。

## 选择一条使用路径

| 你的目标 | 需要配置 |
| --- | --- |
| 只使用 Web 管理文件 | 基础部署；本地存储开箱即用 |
| 让 Bot 接收文件 | 基础部署 + Web 中配置 Bot Token、API ID/Hash、Bot PIN 和允许用户 |
| 抓取频道/群组历史媒体 | 在 Bot 配置基础上，再从 Web 登录 Telegram 用户账号 |
| 自动同步频道新内容 | 账号级下载器 + `/tg_sub` 订阅 |
| 使用 yt-dlp | Web 直接添加任务，或配置 Bot 后使用 `/ytdlp` |
| 使用 OneDrive/Google Drive | 对应平台 OAuth 应用和精确回调地址 |

## 重要边界

- TG Vault 是自托管服务，GitHub Pages **只托管静态文档**，不会替你运行服务。
- Web 上传、Telegram 下载和 yt-dlp 都经过部署 TG Vault 的服务器，需要足够的临时磁盘、带宽和内存。
- Bot Token、API Hash、Telegram session 和第三方存储凭据只应在自己的设置页或服务器环境中填写。
- 生产环境应使用 HTTPS，并在同一维护窗口备份 PostgreSQL 与完整 `file-storage` 卷。

---

[查看源码](https://github.com/hicocos/tg-vault) · [提交问题](https://github.com/hicocos/tg-vault/issues) · [MIT License](https://github.com/hicocos/tg-vault/blob/main/LICENSE)
