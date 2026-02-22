# FoomClous 文档中心 🚀

欢迎来到 FoomClous 文档中心。FoomClous 是一个高性能、模块化的个人云存储中转方案，旨在为您提供便捷、安全的多端存储管理体验。

---

## 🗺️ 文档导航

### 🏁 快速开始
- **[存储源配置指南](./storage_configuration_guide.md)**
  *配置本地、OneDrive、阿里云 OSS、S3 及 WebDAV。*
- **[YT-DLP 下载专区](./ytdlp.md)**
  *通过 Telegram Bot 的 `/ytdlp` 一键解析链接并下载到存储源，前端提供独立分区查看。*
- **[Docker 维护与清理](./docker-cleanup-guide.md)**
  *如何保持容器环境整洁，定期清理上传缓存与冗余镜像。*

### 🧠 工作原理
- **[上传架构说明](./upload_architecture.md)**
  *了解 FoomClous 如何通过服务器中转确保您的数据安全与传输稳定。*
- **[Telegram Bot 逻辑](./bot_logic.md)**
  *解析机器人的消息队列、上传状态同步与自动化流转机制。*

### ✨ 功能说明
- **[收藏夹功能](./favorites-feature.md)**
  *收藏文件/文件夹并在前端侧边栏快速访问。*
- **[项目介绍](./introduction_optimized.md)**
  *FoomClous 的定位、能力边界与适用场景。*

---

## 🌟 项目亮点

- **多端上传**：支持 Web 后台管理与 Telegram 机器人一键转存。
- **广阔兼容**：原生适配本地磁盘、S3 兼容存储、WebDAV、OneDrive 等主流云端。
- **智能体验**：支持视频在线预览、GIF 动图自动播放及大文件断点续传。
- **隐私保护**：所有云端凭据仅本地保存，通过服务器代理模式避免密钥泄露。

---
*© 2026 FoomClous Team. Documentation updated at: 2026-02-21*
