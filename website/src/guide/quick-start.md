# 从零开始

## 1. 运行安装器

```bash
curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | bash
```

按提示填写：

| 项目 | 示例 |
| --- | --- |
| `VITE_API_URL` | `https://api.example.com` |
| `CORS_ORIGIN` | `https://cloud.example.com` |
| 保存目录 | `<项目目录>/data`，或已挂载磁盘下的新专用目录 |

地址换成自己的完整 origin，不带路径、查询或尾斜杠。确认页按 Enter 部署，`e` 重填，`q` 取消。

安装器生成数据库密码和应用密钥，准备镜像、等待 PostgreSQL、执行独立迁移，再启动前后端。详情见[完整部署](/deploy/installation)。

## 2. 配置 HTTPS

| 入口 | 默认上游 |
| --- | --- |
| Web | `http://127.0.0.1:47832` |
| API | `http://127.0.0.1:51947` |

使用宿主机反代。`deploy/nginx-site-init.conf` 只用于 ACME 验证；签发证书后按 `deploy/nginx-site.conf` 配置实际域名与证书路径，不同时加载两份示例。

代理需支持上传、媒体 Range 和相应超时，见[HTTPS 配置](/deploy/https)。Compose 不负责证书管理。

## 3. 创建管理员

1. 打开自己的 HTTPS Web 地址。
2. 创建至少 8 位强密码完成管理员初始化。
3. 登录后按需启用 TOTP 双重验证。

## 4. 上传测试文件

在 **设置 → 存储**确认本地目录可写、空间充足，再从 **上传中心**上传一个小文件。任务完成后，从文件管理下载并核对内容。

需要 Telegram 或云端保存时，继续看[第一次转存](/usage/first-transfer)。

## 5. 检查服务

进入项目目录（默认 `cd tg-vault`）后运行：

```bash
docker compose ps --all
curl -fsS http://127.0.0.1:51947/livez
curl -fsS http://127.0.0.1:51947/readyz
```

按[验收清单](/deploy/verification)检查公网登录和实际文件操作，然后建立备份。

## 6. 升级已有部署

先备份 `.env`、数据库和完整文件数据，步骤见[协调备份](/operations/maintenance#协调备份)。在原项目根目录运行同一条命令：

```bash
curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | bash
```

入口会复用当前项目，快进更新源码、拉取配套镜像并执行数据库迁移，然后替换前后端。地址按 Enter 保留，原有配置、密钥、数据库和文件挂载继续使用。

从其他目录运行时，在管道右侧的 `bash` 前设置 `TG_VAULT_INSTALL_DIR=/实际/项目目录`，指向原部署目录。本地源码有修改或无法快进时，安装器会停止并提示处理。

更新后按上一节检查服务，并验证 HTTPS 登录和文件读写。完整流程见[更新、备份与恢复](/operations/maintenance#更新)。
