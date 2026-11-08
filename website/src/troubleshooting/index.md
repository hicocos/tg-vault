# 问题排查与 FAQ

## 先收集状态

```bash
docker compose ps --all
curl -i http://127.0.0.1:51947/livez
curl -i http://127.0.0.1:51947/readyz
docker compose logs --tail=100 backend frontend postgres
df -h
df -i
```

保留版本、任务 ID、来源、阶段和第一处错误。分享日志前移除凭据、session、用户/聊天标识和私人路径。

## 部署与登录

| 现象 | 检查 |
| --- | --- |
| Web/API 502 | upstream、容器状态、宿主机监听和代理日志 |
| `/livez` 200，`/readyz` 503 | 依赖与组件详情，数据库/存储/密钥 |
| 登录后回登录页 | `/runtime-config.js`、HTTPS、同站 Cookie、CORS/Origin、代理头 |
| API 根路径 `Cannot GET /` | 使用 `/health`、`/livez` 或 `/readyz` |
| 上传 413 | 各层代理单请求上限与分片大小 |
| 数据库认证失败 | 原密码与连接串 URL 编码，不随机换密码 |
| `ENOTFOUND postgres` / `EAI_AGAIN` | 数据库容器与网络是否就绪 |
| 更新被本地修改阻止 | 确认并处理自己的修改，不强制清理生产目录 |
| 迁移失败后应用停止 | 查首个迁移错误和账本，不运行旧 workers 或删除卷 |

## Telegram

| 现象 | 检查 |
| --- | --- |
| Bot 无响应 | 三项凭据、启用状态、连接、数字允许用户与 PIN/TOTP 认证 |
| Bot 离线但 readiness 200 | `TELEGRAM_REQUIRED=false` 时可能如此，看 `components.telegramBot` |
| 无法手动重连 | 连接/自动重试状态、30 秒冷却或 cleanupBlocked |
| 直接发文件正常，转发失败 | 是否使用个人账号重读原帖；该账号能否访问来源 |
| 私有频道不可读 | 实际下载账号是否加入并可读历史 |
| 实体信息缺失 | 来源未知，不直接等于权限拒绝，按实际账号核对 |
| FloodWait | 等待服务端冷却，不循环重试或提高并发 |
| 新订阅无旧文件 | 新订阅从最新消息之后开始，历史用 `/tg_download` |
| 扫描无文件 | 类型、普通图片跳过、广告过滤和消息媒体 |
| 新订阅无通知用户 | 先让允许用户在 Bot 完成 `/start` |

## 存储与授权

| 现象 | 检查 |
| --- | --- |
| OneDrive 没有网盘密码框 | 正常，网盘账号在微软弹窗登录 |
| `AADSTS7000218` | Web 应用缺少 Client Secret |
| `AADSTS7000215` | Secret Value/ID 混淆、应用不匹配或密钥失效 |
| `AADSTS50011` / `redirect_uri_mismatch` | 提供方登记回调与设置页逐字一致 |
| Google `access_denied` | 测试用户、登录账号、组织策略与授权 |
| Google 数日后失效 | External + Testing 的令牌有效期 |
| 回调后原页等待 | 弹窗、Cookie、回调 API 主机、前端 origin 和配套版本 |
| S3 `SignatureDoesNotMatch` | 密钥、Endpoint、Region、path-style、服务器时钟 |
| OSS/S3 `AccessDenied` | 桶、列举及对象权限，不改成公共写入 |
| WebDAV 401/403/404 | 应用口令、目录权限、真实 DAV 地址 |
| 地址被安全策略拒绝 | 公网 HTTPS 与证书；内网开关仅针对 WebDAV |
| OpenList 能列目录却添加失败 | 原生添加会检查写入，确认专用用户和目录权限 |
| 切换默认后旧任务去原目标 | 任务固定目标的预期行为 |

## 任务与磁盘

| 现象 | 检查 |
| --- | --- |
| 有空间仍等待 | 实际挂载、保留线、分片预算、inode、其他任务占用 |
| 下载结束但未完成 | 上传、入库和媒体处理阶段 |
| 100% 仍有失败 | 批量百分比表示已发现条目处理完，核对失败/跳过 |
| 网关有文件但云盘没有 | 背后云盘异步状态、配额和官方客户端 |
| 本地路径“未确认” | 实际挂载与设备/inode 元数据，不伪造标识 |
| 重启后远端写入结果不明 | 人工核对，不按同名文件认领、覆盖或删除 |
| Web 上传中断 | 回上传队列按提示恢复，必要时重选本地文件 |

## qBittorrent

| 现象 | 检查 |
| --- | --- |
| 连接失败 | backend 可达的 API 地址、鉴权、Host/CSRF |
| 目录失败 | 同一宿主机文件与一致容器路径，不支持远程路径转换 |
| 转存后本地文件仍在 | 是否保留做种或清理失败；重试清理不重复上传 |
| 取消后源文件消失 | 取消会删除下载器任务及源文件，与保留做种无关 |
| 关闭扩展后下载器仍运行 | 关闭只停转存调度，不控制下载器已有任务 |
