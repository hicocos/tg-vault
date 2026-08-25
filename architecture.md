---
title: 工作原理
description: TG Vault 的上传、Telegram、任务与存储目标架构
---

{% include nav.html %}

# 工作原理

TG Vault 采用**服务器中转**：浏览器、Telegram 和 yt-dlp 不直接持有云存储密钥，而是把任务交给后端；后端完成校验、临时落盘、媒体处理、目标写入和数据库登记。

## 组件

```text
浏览器 ───────┐
Telegram Bot ─┼─→ Backend / 任务队列 ─→ 本地临时空间 ─→ 存储目标
账号级客户端 ─┤                              ├─ Local
yt-dlp ───────┘                              ├─ OneDrive / Google Drive
                                             ├─ Aliyun OSS / S3
                                             └─ WebDAV

Web 前端 ←──────────── API / 文件索引 / 预览 ────────────┘
                         │
                     PostgreSQL
```

Docker Compose 中：

- `frontend`：React/TypeScript 构建的静态 Web 界面
- `backend`：Node.js API、Telegram、任务与存储适配层
- `postgres`：文件索引、账户配置、任务、会话和业务状态
- `file-storage`：上传临时空间、本地文件、缩略图、session 与内部密钥

## Web 上传

```text
浏览器选择文件
  → 小文件上传或大文件分片协议
  → 后端校验会话、Origin、大小与磁盘预算
  → 写入临时区域并生成/恢复上传状态
  → 按任务目标写入存储提供商
  → 数据库登记文件与存储账户
  → 生成缩略图/预览信息
  → 前端刷新列表
```

服务器中转的代价是占用服务器流量和临时磁盘；好处是云存储凭据不进入浏览器，所有提供商共享一致的校验、任务和索引逻辑。

## Telegram 文件链路

Bot 基础链路：

```text
用户给 Bot 发送文件
  → 身份与限流检查
  → 捕获聊天目标和保存目录
  → 创建持久化任务
  → Telegram 下载
  → 写入目标存储
  → 数据库登记
  → Bot 发送结果或失败原因
```

账号级下载器在此基础上增加频道/群组读取、按日期或标签扫描、媒体组整理和订阅同步。它不是 Bot 基础能力的前置条件。

## 存储目标快照

TG Vault 把“选择哪个账户”分成两个层级：

- **系统默认存储**：Web 设置或 `/storage_switch` 修改，作为新任务的默认值。
- **聊天目标**：`/target once` 或 `/target session`，只作用于对应 Telegram 聊天。

任务创建时会捕获 `provider + accountId`。之后切换默认账户不会改变已经提交的任务，避免排队期间把文件写到意外位置。

## 任务状态与恢复

Web 上传、Telegram 下载和 yt-dlp 都会产生可追踪的任务状态。任务支持等待、运行、暂停、继续、取消、失败重试以及服务重启后的恢复处理。

关键安全原则：

- 取消请求与实际 worker 终止分开记录，避免“界面显示取消但后台仍写入”。
- 外部存储写入结果不明确时进入对账状态，不盲目重试。
- 存储账户删除、冷却或失效会影响新写入，但任务目标不会被静默改成别的账户。
- 多个 worker 通过持久化租约和状态条件避免重复领取同一任务。

## yt-dlp 链路

```text
URL 安全校验
  → 探测元数据
  → 用户确认最佳视频/仅音频
  → 独立临时目录下载与合并
  → 写入捕获的存储目标
  → 登记结果
  → 清理临时目录
```

每个任务使用独立目录，避免并发任务输出互相覆盖。目标写入结果不确定时会阻止不安全的自动重复上传。

## 文件读取与预览

数据库保存文件所属提供商和账户。读取时，后端按原始 `source + storage_account_id` 找到对应适配器：

- 本地文件从受限目录读取。
- 云存储通过提供商 API 获取流或临时访问地址。
- 下载、预览与分享能力按提供商实际支持情况暴露。
- OneDrive 和 Google Drive 可报告远端配额；分享细节能力并不完全相同。

因此切换系统默认存储不会让旧文件“找不到”：旧文件仍按其原账户读取。

## 安全与持久化边界

- PostgreSQL 不是全部状态：内部密钥、session、本地文件和中间状态位于 `file-storage`。
- `file-storage` 也不是全部状态：文件索引、任务和账户元数据位于 PostgreSQL。
- 可恢复备份必须在同一维护窗口同时覆盖两者。
- 浏览器只获得会话 Cookie；云存储 Secret、Refresh Token 与 Telegram session 留在后端。

## 进一步阅读

- [快速部署](./quick-start.html)
- [Telegram 配置与命令](./telegram.html)
- [存储源配置](./storage.html)
- [安全说明](./security.html)
- [运维、备份与恢复](./operations.html)
