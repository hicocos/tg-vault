---
title: 安全说明
description: TG Vault 的登录、会话、凭据、网络和备份安全边界
---

{% include nav.html %}

# 安全说明

TG Vault 会接触 Telegram session、云存储凭据和用户文件。生产部署的目标不是“把端口打开就能用”，而是保证只有预期用户能访问，并且迁移后仍能解密已有配置。

## 首次初始化

首次访问 Web 时始终创建网页管理员密码；如果此时已经通过环境变量配置了 Telegram Bot，还会同时要求创建 Bot PIN：

- **网页管理员密码**：至少 8 位，使用 `scrypt` 加盐哈希后保存。
- **Telegram Bot PIN**：4 位数字，用于 Bot `/start` 身份验证，使用加盐哈希保存。新安装也可以先完成网页初始化，之后在 **设置 → Telegram** 配置 Bot 时再创建 PIN。

两者同时存在时不要设置成相同值。网页登录成功后使用 HttpOnly Cookie，会话 token 不写入 `localStorage`。

## HTTPS、Cookie 与 Origin

生产环境建议：

```dotenv
VITE_API_URL=https://api.example.com
CORS_ORIGIN=https://cloud.example.com
COOKIE_SECURE=true
COOKIE_SECURE_FORCE=true
TRUST_PROXY=loopback
```

`OAUTH_CALLBACK_BASE_URL` 默认继承 `VITE_API_URL`，`OAUTH_FRONTEND_ORIGIN` 默认继承 `CORS_ORIGIN`；只有多入口或特殊反向代理部署才需要显式覆盖。修改类请求会校验 `Origin`，`CORS_ORIGIN` 必须使用精确 HTTPS origin，不要写路径或宽泛通配符。

正式安装脚本会设置 `COOKIE_SECURE=true` 和 `COOKIE_SECURE_FORCE=true`，确保浏览器只通过 HTTPS 发送登录 Cookie。本地纯 HTTP 调试必须同时将二者设为 `false`；不要把这个调试配置带到公网生产环境。

## 内部密钥和凭据加密

如果下面的变量留空，TG Vault 会在 `/data/secrets/` 自动生成并持久化内部密钥：

```dotenv
SESSION_SECRET=
STORAGE_CREDENTIALS_SECRET=
TOTP_SECRET=
TG_VAULT_SECRET_DIR=/data/secrets
```

Web 管理的 Bot 凭据与 Telegram 用户 session 也由 `STORAGE_CREDENTIALS_SECRET` 加密保存。

也可以显式提供至少 32 个随机字符的值。无论采用哪种方式，恢复时都必须保留同一套密钥，否则可能出现：

- 已有登录会话失效
- TOTP 无法读取
- 已保存的第三方存储凭据无法解密

因此备份不能只保存数据库；必须同时保存完整 `file-storage` 卷。

## Telegram 安全

- 推荐在 **设置 → Telegram → Telegram Bot 用户权限** 中显式维护允许用户，不要长期依赖“第一个正确 PIN 用户”机制；旧部署若设置 `TELEGRAM_ALLOWED_USER_IDS`，网页编辑会被锁定。
- 使用 `TELEGRAM_ALLOWED_SOURCES` 限制账号级下载器可以读取的频道/群组。
- 加密保存的 Telegram 用户 session 等同登录凭据；旧版明文 session 文件在迁移前也必须严密保护，禁止提交到 Git、公开网盘或聊天群。
- `/logout` 可以撤销当前 Telegram 用户的 Bot 认证。
- PIN 连续失败会触发限流和锁定；不要通过放宽限制来掩盖异常尝试。

## 双重验证

TG Vault 支持 TOTP：

- Web：在个人设置中扫码启用。
- Telegram：发送 `/setup_2fa` 并按提示完成。
- 启用后，网页登录和 Bot 使用均会要求动态验证码。

请把 TOTP 恢复信息保存在独立、安全的位置。不要只保存在同一台 TG Vault 服务器上。

## 存储 Endpoint

S3 和 WebDAV 默认只允许 HTTPS 公网 Endpoint。需要连接飞牛等可信局域网 WebDAV 时，可在 **设置 → 安全 → 网络与存储安全** 开启“允许内网和不安全的 WebDAV 地址”；系统会二次确认并标记为高风险模式。

旧部署或应急场景仍可使用：

```dotenv
ALLOW_INSECURE_STORAGE_ENDPOINTS=false
```

开启后只会放宽存储地址准入规则，不会绕过 Docker 网络、DNS、防火墙或服务监听限制。`127.0.0.1` 指 backend 容器自身，不是宿主机；HTTP 还会明文传输用户名、密码和文件内容。只在明确隔离、可信的局域网中使用，公网 Endpoint 始终应使用 HTTPS。

建议为 OSS/S3/WebDAV 创建 TG Vault 专用账户或访问密钥，并使用服务商支持的最小 Bucket/目录权限。

## 网络暴露

Compose 默认把前端和 API 绑定到 `127.0.0.1`，由宿主机反向代理暴露 HTTPS。这比直接把容器端口开放到公网更安全。

反向代理至少应：

- 只开放 HTTPS，HTTP 重定向到 HTTPS
- 正确传递 `Host`、`X-Forwarded-For`、`X-Forwarded-Proto`
- 为大文件配置请求体大小和超时
- 不缓存或公开带签名的私有文件响应
- 定期更新证书与 Nginx/Caddy

## 备份安全

备份中包含数据库、文件、Telegram session 和密钥，通常比运行服务器本身更集中。备份必须：

1. 加密保存
2. 限制读取权限
3. 异地存储
4. 使用 SHA-256 manifest 校验完整性
5. 在隔离环境执行恢复验证

仓库提供 `deploy/backup.sh` 与 `deploy/restore-verify.sh`；详见[运维与恢复](./operations.html)。

## 上线检查表

- [ ] Web/API 都使用 HTTPS
- [ ] `COOKIE_SECURE=true`
- [ ] Origin 与 OAuth 回调为精确域名
- [ ] 管理员密码与 Bot PIN 不相同
- [ ] 已配置 TOTP
- [ ] 已限制 Telegram 用户和频道来源
- [ ] 云存储使用专用、最小权限凭据
- [ ] Git 历史和公开日志中没有 Token、Secret 或 session
- [ ] 已加密备份数据库和完整 `file-storage` 卷
- [ ] 已完成一次隔离恢复验证

---

[返回文档中心](./) · [快速部署](./quick-start.html) · [运维与恢复](./operations.html)
