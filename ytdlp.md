---
title: yt-dlp 下载
description: 通过 Telegram Bot 解析媒体链接并转存到 TG Vault
---

{% include nav.html %}

# yt-dlp 下载

TG Vault 把 yt-dlp 接入 Telegram Bot：先解析链接并展示预览，再由用户确认“最佳视频”或“仅音频”，随后下载到服务器临时目录并写入选定的存储目标。

## 使用方法

1. 先通过 `/start` 完成身份验证。
2. 如需改变存储账户，可先使用 `/target`；否则使用当前系统默认存储。
3. 发送一个链接：

```text
/ytdlp https://example.com/video
```

4. Bot 返回标题、来源和目标信息后，选择：
   - **最佳视频**：下载可用的最佳视频结果。
   - **仅音频**：提取音频结果。
   - **取消**：不创建下载任务。
5. 使用 `/tasks` 查看进度。
6. 完成后在 Web 的 **YT-DLP** 分区查看文件。

<div class="callout warning">
每次命令只接受一个以 <code>http://</code> 或 <code>https://</code> 开头的链接。不要把 yt-dlp 当作绕过版权、付费访问或平台权限控制的工具；请只下载你有权保存的内容。
</div>

## 存储位置与目标

后端使用 `YTDLP_WORK_DIR` 作为临时工作目录，并把完成文件归类到 `ytdlp`。Web 中的 YT-DLP 分区会直接展示这些结果。

存储目标在任务提交时确定：

1. 当前聊天的一次性 `/target once`（如有）
2. 当前聊天的 `/target session`（如有）
3. 系统默认存储

任务提交后再切换默认存储，不会改变该任务的目标。

## 环境变量

```dotenv
YTDLP_BIN=yt-dlp
YTDLP_WORK_DIR=/data/uploads/ytdlp
YTDLP_MAX_CONCURRENT=1
```

官方后端构建应提供 `yt-dlp` 与 `ffmpeg`。自定义镜像必须确保二者在容器 PATH 中可执行。

## 执行流程

```text
用户发送链接
  → 后端安全校验 URL
  → yt-dlp 探测元数据
  → Bot 展示预览并等待确认
  → 创建持久化传输任务
  → 下载/合并到独立临时目录
  → 写入任务捕获的存储目标
  → 记录文件并生成可用的预览信息
  → 清理临时目录并通知结果
```

失败任务不会伪装成成功；如果外部存储写入结果不明确，系统会进入需要对账的状态，避免盲目自动重试造成重复文件。

## 常见问题

### 链接无法解析

可能原因：平台不受当前 yt-dlp 版本支持、内容需要登录、内容已删除、地区限制、链接不是单个媒体页面，或服务器无法访问目标站点。

```bash
docker compose logs --tail=250 backend
```

### 下载后没有缩略图或不能预览

检查：

- 容器内 `ffmpeg` 是否可执行
- 后端是否识别出正确的 `video/*`、`audio/*` 或 `image/*` MIME 类型
- 后端日志中是否有缩略图或媒体探测错误

### 任务一直等待

使用 `/tasks` 和 `/status` 查看：

- `YTDLP_MAX_CONCURRENT` 是否已有任务占用
- 目标存储是否处于冷却或连接失败状态
- 服务器临时磁盘是否低于安全水位
- 是否有任务被暂停或需要人工对账

### 下载速度慢

速度取决于源站、服务器网络、媒体合并、磁盘和目标存储上传链路。不要仅通过提高并发解决问题；先看 `/status` 和后端日志判断瓶颈。

---

[返回文档中心](./) · [Telegram 配置](./telegram.html) · [工作原理](./architecture.html)
