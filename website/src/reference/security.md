# 安全与隐私

## 管理员与入口

- 系统没有默认密码，首次访问 Web 时设置管理员密码。
- 使用 HTTPS 和至少 8 位强密码，生产保留 secure Cookie 与准确的 `CORS_ORIGIN`。
- 默认应用端口仅绑定宿主机回环，不公开 PostgreSQL 或 Docker socket。
- `TRUST_PROXY` 只信任实际代理范围。

管理员密码使用加盐 scrypt 哈希；Web 会话使用 HttpOnly Cookie，修改类请求校验 Origin。CORS 不能代替认证或解决跨站 Cookie 限制。

## Bot 与 TOTP

先填数字用户允许列表，再分享 Bot/PIN。空列表且无认证用户时，首个正确 PIN 用户可自动加入。

在 Web 或 `/setup_2fa` 启用 TOTP 后，Web/Bot 均需二次验证。保护二维码与密钥；普通部署无需填写会覆盖数据库值的 `TOTP_SECRET`。

## 凭据和 session

存储凭据加密依赖原应用密钥。保留 `.env` 中的 `SESSION_SECRET`、`STORAGE_CREDENTIALS_SECRET`，或历史部署的 `/data/secrets`；随意替换可能使 TOTP/存储凭据不可读。

Telegram session 具有账号访问能力。不要共享或在测试环境复用生产 session；泄露后在 Telegram 撤销活动会话。验证码和两步验证密码只在自己的 HTTPS 管理页输入。

文档站无登录、上传或凭据表单，搜索在浏览器本地执行，不向第三方搜索服务发送查询。

## 存储权限

使用目标桶/目录的专用最小权限凭据，不共享主账号或 OpenList 管理员密码。桶保持私有，不为后端上传开放公共写入或宽泛 CORS。

WebDAV 内网开关会扩大 SSRF 范围并允许明文传输，仅对可信需求启用；不放宽 S3/OpenList，不忽略 TLS 证书错误。

## 备份与问题报告

备份含 session、密钥和配置，应限制访问、加密、离机保存；`.env` 单独安全备份。恢复演练使用独立主机/daemon，限制持有有效 session 的副本外网。

日志/截图/Issue 提交前移除：Token、API Hash、session、Cookie、请求头、验证码、手机号、用户/聊天标识、真实文件名、IP/私有路径、数据库和原始归档。

秘密曾进入 Git 历史时，先撤销或轮换。删除当前文件、添加 `.gitignore` 不能消除历史泄露。

## 内容权限

只保存有权访问和归档的内容，遵守 Telegram 和存储服务条款。FloodWait 按要求等待，不用多账号或高频重试规避限制。
