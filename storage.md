---
title: 存储源配置
description: 配置 TG Vault 支持的本地与云存储账户
---

{% include nav.html %}

# 存储源配置

登录 TG Vault 后进入 **设置 → 存储源**。系统支持本地磁盘、OneDrive、Google Drive、阿里云 OSS、S3 兼容存储和 WebDAV，并允许为云存储添加多个账户。

<div class="callout">
“系统默认存储”只影响之后创建的新任务。任务提交时会保存目标快照；切换默认账户不会把已经排队或正在执行的任务改投到另一个账户。Telegram 还可用 <code>/target</code> 为当前聊天设置一次性或会话级目标。
</div>

## 本地存储

本地存储无需额外凭据，文件保存在 Docker 的 `file-storage` 卷中。该卷也包含临时文件、缩略图、Telegram session 和内部安全密钥，因此迁移或恢复时必须整体备份。

适合：低延迟、同机读取、先在本地验证部署。

## OneDrive

### Microsoft Entra 中创建应用

1. 打开 [Microsoft Entra 管理中心](https://entra.microsoft.com/)并进入 **应用注册**。
2. 新建注册，记录 **Application (client) ID** 和 **Directory (tenant) ID**。
3. 添加 Web 重定向 URI：

```text
https://api.example.com/api/storage/onedrive/callback
```

4. 如果使用客户端密码，在 **证书和密码** 中创建 Client Secret，并立即安全保存其值。
5. 在 TG Vault 的 OneDrive 表单中填写账户名称、Client ID、Tenant ID，以及可选的 Client Secret，然后点击 **保存并授权**。

回调地址必须与 TG Vault 设置页显示的地址、`.env` 中的 `OAUTH_CALLBACK_BASE_URL` 和 Microsoft 平台登记值完全一致。

## Google Drive

### Google Cloud 中创建 OAuth 客户端

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)并创建或选择项目。
2. 在 **API 和服务 → 库** 中启用 **Google Drive API**。
3. 配置 OAuth 同意屏幕；测试阶段把自己的 Google 账户加入测试用户。
4. 创建 **Web 应用**类型的 OAuth 客户端。
5. 添加已授权的重定向 URI：

```text
https://api.example.com/api/storage/google-drive/callback
```

6. 在 TG Vault 中填写账户名称、Client ID 与 Client Secret，点击 **保存并授权**。
7. 如需写入共享云端硬盘，填写共享云端硬盘 ID；留空则使用“我的云端硬盘”。授权账户必须已经加入该共享盘并拥有创建文件权限。

如果 Google 返回 `403: access_denied`，先检查 OAuth 应用是否仍为测试状态，以及当前账号是否已加入测试用户。

## 阿里云 OSS

1. 在 [OSS 控制台](https://oss.console.aliyun.com/)创建私有 Bucket。
2. 记录 Region，例如 `oss-cn-hangzhou`。
3. 建议创建专用 RAM 用户并授予该 Bucket 所需的最小读写权限，而不是使用主账号 AccessKey。
4. 在 TG Vault 中填写账户名称、Region、AccessKey ID、AccessKey Secret 和 Bucket。

不要把 AccessKey 写进仓库或截图公开。连接成功后再切换为系统默认账户。

## S3 兼容存储

适用于 AWS S3、Cloudflare R2、Backblaze B2、MinIO 和其他兼容服务。

| 字段 | 说明 |
| --- | --- |
| Endpoint | 服务商给出的 HTTPS API 地址 |
| Region | 区域标识；按服务商要求填写 |
| Access Key ID / Secret | 专用访问密钥 |
| Bucket | 已创建的存储桶名称 |
| Force Path Style | MinIO 或要求路径式寻址的服务通常需要勾选 |

默认只允许 HTTPS Endpoint。只有可信内网测试才考虑把 `ALLOW_INSECURE_STORAGE_ENDPOINTS` 设置为 `true`。

## WebDAV

填写：

- 账户名称
- WebDAV URL，例如服务商给出的 HTTPS DAV 入口
- 用户名
- 密码或应用专用口令

坚果云等服务通常要求应用专用密码，而不是网站登录密码。自建 WebDAV 应优先使用有效 HTTPS 证书；超大文件可根据网络状况调整 `.env` 中的 WebDAV 无活动与上传超时。

### 飞牛等局域网 WebDAV

默认安全策略会拒绝 HTTP、回环、私有网段和保留地址。在 **设置 → 安全 → 网络与存储安全** 开启“允许内网和不安全的 WebDAV 地址”后，可添加并实际读写可信局域网 WebDAV。此开关有 SSRF 和 HTTP 明文传输风险，启用时会要求二次确认。

连接地址必须从 **backend 容器的网络视角**可达：

- `127.0.0.1` 指 backend 容器自身，不是 Docker 宿主机。
- 如果 WebDAV 只监听宿主机 `127.0.0.1`，容器通常无法连接。
- 优先填写容器可访问的宿主机局域网地址或同一 Docker 网络中的服务名，并检查端口、防火墙和路由。
- 开关只放宽安全准入，不会绕过网络连通性限制。

## 测试、切换与删除账户

1. 添加账户后先执行连接测试。
2. 测试成功，再选择 **切换到此账户**。
3. 新任务会使用新的系统默认目标，旧任务保持原目标。
4. 删除账户前，先阅读系统给出的影响预览。账户删除和云端实体文件删除是不同操作，不要在未确认影响时执行。

不同存储的产品能力不同：

- OneDrive 支持分享链接、密码、过期时间和远端配额。
- Google Drive 支持分享链接和远端配额，但不提供 TG Vault 内的分享密码或过期时间。
- 其他存储在界面中不会假装支持提供商未实现的分享能力，可改用下载。

## 常见问题

### OAuth 授权后窗口没有完成

检查：

- `OAUTH_CALLBACK_BASE_URL` 是否是 API 的精确 HTTPS origin
- `OAUTH_FRONTEND_ORIGIN` 是否是 Web 的精确 HTTPS origin
- 平台登记的 callback 是否与设置页显示值逐字一致
- 浏览器是否拦截了授权弹窗

### 连接测试失败

检查 Endpoint、Region、Bucket、权限、DNS、TLS 证书和服务器出站网络。后端日志会给出比浏览器弹窗更完整的原因：

```bash
docker compose logs --tail=200 backend
```

---

[返回文档中心](./) · [查看安全说明](./security.html)
