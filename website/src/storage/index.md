# 选择与添加存储

在 **设置 → 存储 → 添加存储** 选择目标类型。

## 按你已有的资源选择

| 资源 | 类型 | 需要准备 |
| --- | --- | --- |
| 服务器磁盘 | [本地](/storage/local) | 挂载目录、空间与读写权限，无需账号 |
| 国际版 OneDrive | [OneDrive](/storage/onedrive) | Microsoft Web 应用、Client ID/Secret、网页登录授权 |
| 个人/共享 Google Drive | [Google Drive](/storage/google-drive) | Drive API、Web OAuth 客户端、回调地址 |
| S3 兼容对象存储 | [S3](/storage/s3) | HTTPS S3 API Endpoint、Region、Bucket、S3 密钥 |
| 阿里云对象存储 | [OSS](/storage/oss) | Bucket、Region、专用 RAM AccessKey |
| NAS 或 DAV 服务 | [WebDAV](/storage/webdav) | DAV endpoint、用户名与应用口令 |
| 已挂载存储的 OpenList | [OpenList](/storage/openlist) | 站点地址、虚拟目录、专用用户 |

阿里云 OSS 不是阿里云盘；Google Drive 不是 Google Cloud Storage。

## 当前界面的共同步骤

1. 选择类型，按对应指南填写连接参数。存储名称仅用于显示。
2. OneDrive/Google Drive 点击 **前往授权**，在提供方页面登录并同意权限；其余类型点击 **验证并添加**。
3. 检查账户状态，按需 **测试连接**、**设为默认**。
4. 上传文件，在实际存储中确认位置，再下载核对内容。

**OneDrive/Google Drive 授权成功会成为默认账户；OSS/S3/WebDAV/OpenList 不会自动切换。** 切换默认不迁移已有文件，也不改变已创建任务的目标。Bot `/target` 和订阅固定目标需单独设置。

## 账户维护与移除

- 列表支持搜索、测试连接、设为默认和查看详情。
- 在“详情 / 编辑”更新名称或支持的认证信息；密码和令牌不回显，留空保留原值。
- 默认账户需先切换才能移除；任务或上传占用时不能移除。
- 移除前会展示关联影响。确认后删除连接配置和 TG Vault 关联记录，**不删除远端文件**。

## 不会自动导入你的整盘

TG Vault 只显示已建立索引的文件，添加账户不会扫描或导入远端历史内容。新文件优先保留原名，重名时按策略跳过或添加 `（1）` 等编号。避免外部工具并发写入受管理目录，已有远端同名对象不能当作可覆盖的临时文件。

## 接入完成的标准

连接测试之外，还需确认实际写入、文件位置与下载内容。经网关接入云盘时，在云盘官方客户端检查最终文件。测试删除权限时使用新建测试文件。
