# Google Drive

使用自己的 Web OAuth 应用授权 Google 账号，不使用 Google Cloud Storage 密钥、API Key 或服务账号 JSON。

## 1. 准备应用

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 创建或选择项目。
2. 进入 **API 和服务 → 库**，启用 **Google Drive API**。
3. 在 **Google Auth Platform** 配置品牌、受众与联系邮箱。External 测试应用需将登录账号加入测试用户。
4. 创建 **Web application / Web 应用** OAuth 客户端。
5. 从 **设置 → 存储 → 添加存储 → Google Drive** 的帮助区复制回调，填入 **Authorized redirect URIs / 已获授权的重定向 URI**，不是 JavaScript 来源。
6. 保存同一客户端的 Client ID 和 Client Secret。

回调形式如下，以 TG Vault 显示的实际地址为准：

```text
https://api.example.com/api/storage/google-drive/callback
```

## 2. 填写并授权

| 字段 | 内容 |
| --- | --- |
| 存储名称 | 可选显示备注 |
| Client ID / Secret | 同一 Web OAuth 客户端的凭据，均必填 |
| 共享云端硬盘 ID | 仅 Shared drive 填写；个人“我的云端硬盘”留空，不填普通文件夹链接 |

点击 **前往授权**，允许弹窗，在 Google 页面登录并同意权限。遇到未验证应用提示，先确认是自己创建的应用。

TG Vault 请求 `drive.file`，不能读取所有既有文件。共享盘需目标账号具有写入权限，且文件在应用可访问范围内。

## 3. 验证目标

授权成功后新账户成为默认，不迁移已有文件或改变已创建任务的目标。TG Vault 在目标位置使用 `TG Vault` 文件夹，添加账户不会导入整盘。上传后可在 Google Drive 核对位置并下载检查。

## 长期运行注意事项

External 应用处于 Testing 且请求 Drive 权限时，刷新令牌通常在 **7 天**后到期。长期使用需按 Google 要求发布应用，并满足相应验证和组织策略。

| 现象 | 检查 |
| --- | --- |
| `403 access_denied` | 测试用户、组织策略、权限同意 |
| `redirect_uri_mismatch` | 回调的协议、主机、路径及尾斜杠是否一致 |
| 几天后失效 | External + Testing 状态、用户是否撤销权限 |
| 弹窗被拦截或回调后等待 | 站点弹窗权限、API 主机、登录 Cookie、前后端版本 |
| 共享盘写入失败 | 共享盘 ID、成员权限、应用可访问范围 |
