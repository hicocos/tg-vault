# 部署验收清单

## 服务与入口

在部署目录执行：

```bash
docker compose ps --all
curl -fsS http://127.0.0.1:51947/livez
curl -fsS http://127.0.0.1:51947/readyz
docker compose logs --tail=100 backend frontend postgres
```

- PostgreSQL、backend、frontend 正常；`db-migrate` 成功退出。
- 浏览器可访问实际 HTTPS Web/API，证书与 `/runtime-config.js` 正确。
- `/readyz` 检查当前要求的依赖。Bot 非必需时需单独看连接状态。

## 管理员

- 创建强密码后，退出并重新登录成功。
- 启用 TOTP 后实际验证，生产 secure Cookie 保持开启。

## 文件读写

用自己创建的无敏感内容小文件测试：

1. 核对存储账户、目录、可写状态与空间。
2. 上传，等待任务完成，在文件管理中核对名称、大小和目录。
3. 在实际宿主机挂载或存储提供方页面确认文件存在。
4. 下载后比对内容或哈希。
5. 按需测试删除，只操作该测试文件。

```bash
sha256sum tg-vault-check.txt
```

上传前和下载后分别计算、比较。存储连接探测不等于完整读写检查；经网关转存时，还需在背后云盘官方客户端确认。

## Telegram 与订阅

- 允许用户通过 `/start` 认证，直接发送的小文件可保存和下载。
- 频道下载账号能读原帖，小范围任务成功，失败/跳过数量符合预期。
- 新建测试订阅后发布新媒体，确认扫描、过滤和最终文件。新订阅不自动回填全部历史。

## 升级与恢复后

检查前后端镜像修订、旧文件读取、凭据解密、Telegram 状态和远端连接。备份格式/校验和通过不能替代隔离恢复演练，流程见[更新与备份](/operations/maintenance)。
