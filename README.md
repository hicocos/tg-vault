<div align="center">

<img src="https://raw.githubusercontent.com/hicocos/tg-vault/main/backend/logo.png" alt="TG Vault Logo" width="132" />

# TG Vault

**自托管的 Telegram 多账号文件转存、频道订阅与多云归档平台**

<p>
  <a href="https://github.com/hicocos/tg-vault/releases"><img src="https://img.shields.io/badge/release-v3.0.0-326fe8?style=flat-square" alt="Release" /></a>
  <a href="https://tgvault.pages.dev/"><img src="https://img.shields.io/badge/docs-tgvault.pages.dev-27a979?style=flat-square" alt="Documentation" /></a>
  <img src="https://img.shields.io/badge/docker-ready-2496ed?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/MCP-AI_Agent-6e56cf?style=flat-square" alt="MCP Ready" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-475569?style=flat-square" alt="License" /></a>
</p>

<p>
  <strong>简体中文</strong> · <a href="README_EN.md">English</a>
</p>

<p>
  <a href="https://tgvault.pages.dev/">在线文档</a> ·
  <a href="#快速部署">快速部署</a> ·
  <a href="#存储支持">存储支持</a> ·
  <a href="#bot-常用命令">Bot 命令</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="https://github.com/hicocos/tg-vault/releases">Releases</a>
</p>

</div>

## ✨ 核心特性

| 功能&#8288;模块 | 核心能力 |
| :--- | :--- |
| **👥&nbsp;多&#8288;账&#8288;号&#8288;调&#8288;度** | 扫码或手机号接入多个 Telegram 个人账号，按来源权限、冷却状态与**加权最少连接**策略自动分配下载，单文件独立拉取并支持断线自愈。 |
| **📡&nbsp;频&#8288;道&#8288;与&#8288;订&#8288;阅** | 支持按**日期范围**或**话题标签**批量拉取频道/群组历史文件，或创建定时订阅持续同步新增媒体；内置文件类型筛选与广告过滤。 |
| **🤖&nbsp;Bot&nbsp;与&#8288;任&#8288;务** | 私聊转发文件或媒体组即刻入队；在 Web 与 Bot 统一查看实时进度、传输速率与失败明细，支持随时暂停、继续与一键重试。 |
| **🗂️&nbsp;Web&nbsp;文&#8288;件&#8288;库** | 提供现代化网页管理端，支持大文件分片续传、全局搜索、收藏夹、目录移动重命名，以及音视频流式播放与图片在线预览。 |
| **☁️&nbsp;七&#8288;类&#8288;存&#8288;储&#8288;源** | 原生接入 **本地磁盘、OneDrive、Google Drive、S3 / R2、阿里云 OSS、WebDAV、OpenList**，支持多账户并存、连接测试与按任务指定目标。 |
| **🔌&nbsp;MCP&nbsp;与&nbsp;BT** | 内置 **MCP Server**（Streamable HTTP / stdio），赋能 Claude、Codex、Rikka 等 AI 助手检索与归档文件；可选联动同机 **qBittorrent** 下载后自动转存。 |
| **🔐&nbsp;安&#8288;全&#8288;与&#8288;多&#8288;语** | 支持管理员强密码、TOTP 两步验证、Bot 允许列表与凭据加密存储；Web 与 Bot 均支持**简体中文、English、Русский**。 |

## 🧩 工作流架构

| 阶段 | 处理链路 |
| :--- | :--- |
| **1.&nbsp;来&#8288;源&#8288;接&#8288;入** | **Telegram 端**：Bot 私聊转发 · 频道历史按日期/标签拉取 · 频道定时订阅<br>**Web & 扩展端**：网页分片上传 · MCP AI Agent 协议调用 · qBittorrent 磁力/种子联动 |
| **2.&nbsp;调&#8288;度&#8288;队&#8288;列** | **多账号调度池**：来源权限校验 → FloodWait 冷却规避 → 空闲账号优先 → 加权最少连接分配<br>**持久任务引擎**：PostgreSQL 状态持久化 · 媒体组聚合 · 类型与广告过滤 · 本地暂存与断点续传 |
| **3.&nbsp;归&#8288;档&#8288;消&#8288;费** | **七类目标存储**：本地磁盘 · OneDrive · Google Drive · S3 / R2 · 阿里云 OSS · WebDAV · OpenList<br>**统一文件索引**：跨存储全文搜索 · 在线流媒体预览 · 目录整理与分享 · MCP 文本读取 |

## 🚀 快速部署

一行命令完成交互式安装（已有部署执行同一命令即可更新）：

```bash
curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | bash
```

安装向导会自动生成配置、迁移数据库并启动容器。更多说明见[在线部署教程](https://tgvault.pages.dev/guide/quick-start)。

## 📦 存储支持

可在 **设置 → 存储** 中同时添加多个存储账户，并为默认上传、Bot 转存或单个频道订阅分别指定归档目标：

| 存储类型 | 接入方式 | 适用场景与特性 | 配置教程 |
| :--- | :--- | :--- | :--- |
| **本地磁盘** | 宿主机目录挂载 | 零外部依赖，适合本地大容量数据盘高速读写与直接预览 | [本地存储指南](https://tgvault.pages.dev/storage/local) |
| **OneDrive** | Microsoft OAuth 2.0 | 支持国际版个人/商业账户、大文件分块续传与多账户接入 | [OneDrive 指南](https://tgvault.pages.dev/storage/onedrive) |
| **Google Drive** | Google OAuth 2.0 | 支持个人盘与共享云端硬盘，Resumable 会话续传与回收站管理 | [Google Drive 指南](https://tgvault.pages.dev/storage/google-drive) |
| **S3 / Cloudflare R2** | S3 兼容 API | 兼容 AWS S3、Cloudflare R2、MinIO 等对象存储分片直传 | [S3 / R2 指南](https://tgvault.pages.dev/storage/s3) |
| **阿里云 OSS** | 阿里云对象存储 API | 支持 RAM 最小权限密钥与同地域内网高速写入 | [阿里云 OSS 指南](https://tgvault.pages.dev/storage/oss) |
| **WebDAV / NAS** | Basic / Digest 认证 | 对接群晖、威联通 NAS、Nextcloud 等标准 DAV 服务 | [WebDAV 指南](https://tgvault.pages.dev/storage/webdav) |
| **OpenList** | OpenList 原生 API | 直连已挂载多网盘的 OpenList 实例，无需额外协议转译 | [OpenList 指南](https://tgvault.pages.dev/storage/openlist) |

## 🤖 Bot 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `/start` | 绑定并认证当前 Telegram 账号 |
| `/tg_download` | 启动频道/群组历史文件下载向导（支持按日期范围或标签筛选） |
| `/tg_sub` / `/tg_subs` | 创建新频道订阅，或查看、暂停、恢复已有订阅 |
| `/tasks` | 查看当前活动任务进度，执行暂停、继续、取消或重试 |
| `/target` | 切换 Bot 默认接收文件的目标存储账户与目录 |
| `/status` | 查看实例运行状态、队列概览与存储连接情况 |

完整命令说明见 [Bot 命令速查](https://tgvault.pages.dev/usage/commands)。

## 🔌 扩展能力

- **MCP 连接 AI Agent**：通过 Streamable HTTP 或本地 stdio 桥接向 AI 客户端开放文件搜索、UTF-8 文本读取、分块上传、订阅管理与历史归档能力，采用独立 Bearer 令牌与存储范围隔离。详见 [MCP 接入指南](docs/mcp.md)。
- **qBittorrent 下载转存**：连接本机 qBittorrent WebUI，支持提交磁力链接或 `.torrent` 种子、勾选目标文件并在下载完成后自动转存至云端，可自由选择清理源文件或保留做种。详见 [qBittorrent 教程](https://tgvault.pages.dev/usage/qbittorrent)。

## 📚 文档导航

| 文档 | 内容概览 |
| :--- | :--- |
| **[在线文档中心](https://tgvault.pages.dev/)** | 完整使用指南、多账号调度、存储接入与常见问题排查 |
| **[服务器部署指南](deploy/DEPLOY.md)** | 安装向导参数、Nginx HTTPS 反代、数据库迁移与维护命令 |
| **[完整配置参考](docs/configuration.md)** | 环境变量说明、Telegram 连接、存储凭据与安全策略 |
| **[MCP 与 AI Agent](docs/mcp.md)** | 权限矩阵、客户端配置（Codex / Rikka）与工具调用示例 |
| **[本地存储说明](docs/local-storage.md)** | 目录挂载结构、路径核对与容器数据持久化 |
| **[开发与发布](docs/development.md)** | 本地开发环境、数据库 CLI 与构建校验流程 |

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源 · [hicocos/tg-vault](https://github.com/hicocos/tg-vault)
