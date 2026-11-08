# 更新、备份与恢复

命令在部署目录执行，保留当前使用的 Compose 覆盖文件。

## 状态与日志

```bash
docker compose ps --all
curl -fsS http://127.0.0.1:51947/livez
curl -fsS http://127.0.0.1:51947/readyz
docker compose logs --tail=100 backend frontend postgres
```

`livez=200`、`readyz=503` 表示进程存活但依赖未就绪，查看组件错误。Bot 非必需时需单独检查连接状态。不要覆盖镜像的监督器启动方式为裸 `node dist/index.js`。

## 协调备份

```bash
BACKUP_DIR=/path/to/secure-backups ./deploy/backup.sh
./deploy/restore-verify.sh /path/to/secure-backups/<timestamp>
```

替换为实际路径。备份需要运行中的 PostgreSQL、已有 backend 容器和拉取辅助镜像的能力；不要先 `down` 删除用于确认挂载的容器。

| 文件 | 内容 |
| --- | --- |
| `postgres.dump` | PostgreSQL custom-format dump |
| `file-storage.tar.gz` | 完整 `/data`，包含文件、预览、暂存、session 和密钥 |
| `manifest.txt` | 时间、源码修订、一致性标记和 SHA-256 |

`.env`、反代配置、远端对象、OpenList 数据、下载器配置和外部 BT 目录**不包含在内，另行备份**。

预检空间至少为未压缩 `/data` + 数据库大小 + 512 MiB。归档期间停止 backend，结束或失败后恢复原状态；期间不要运行其他写入工具。备份含秘密，应加密、离机保存。

## 更新

备份后，在原项目根目录运行同一条一键命令：

```bash
curl -fsSL https://raw.githubusercontent.com/hicocos/tg-vault/main/install.sh | bash
```

安装器快进更新源码，准备配套 `latest` 镜像，停止旧应用后执行独立迁移，再替换前后端。保留原配置和挂载，不自动迁移文件。

- 本地修改、detached HEAD 或无法快进时停止，不强行覆盖。
- 固定源码或已手动更新时可用 `--skip-source-update`。
- 迁移失败保持应用停止；不要启动旧 workers、删卷或改账本。
- 更新后检查镜像修订、HTTPS 登录、文件读写及按需启用的 Telegram/云存储。

## 手动迁移与回退

CLI：`node dist/scripts/database.js status|plan|migrate|check`。只有 `migrate` 写入；应用启动不自动迁移。

手动升级按[完整顺序](/deploy/installation#数据库命令与手动升级)执行：备份 → 准备镜像 → 停旧应用 → plan/migrate → 启动新应用。任一步失败即停止。

旧镜像未必兼容新 schema。优先前向修复；需回退时，隔离验证，必要时恢复升级前同一批数据库、完整 `/data` 和原密钥，再用匹配镜像。

## 恢复演练

`restore-verify.sh` 只校验归档，不恢复数据。演练用独立主机或独立 Docker daemon；Compose 固定容器名和端口，**仅换目录或 `-p` 不足以隔离**。

使用空测试数据库/目录、manifest 对应源码与镜像，不复用生产挂载。持有有效 session 的副本启动前限制外网。步骤见[隔离恢复演练](/deploy/installation#隔离恢复演练与正式恢复)。

验证登录、TOTP、密钥解密、旧文件和远端连接后再切换。不要向运行中 `/data` 解压覆盖，不用 `down -v` 或 `git clean -fdx` 排障。
