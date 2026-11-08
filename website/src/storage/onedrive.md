# OneDrive

TG Vault 直连国际版当前用户的 OneDrive，需要自己的 Microsoft Web 应用和网页登录授权。

## 1. 复制本站回调

在 **设置 → 存储 → 添加存储 → OneDrive → 配置帮助与注意事项** 复制实际回调，形式如下：

```text
https://api.example.com/api/storage/onedrive/callback
```

## 2. 在 Microsoft Entra 注册应用

1. 打开 [Microsoft Entra 管理中心](https://entra.microsoft.com/)，进入 **应用注册 → 新注册**。
2. 选择支持目标账号的账户类型。个人账号需包含 **个人 Microsoft 账户**；仅组织单租户应用不能用于个人账号。
3. 重定向 URI 平台选择 **Web**，粘贴 TG Vault 回调，不选 SPA 或移动/桌面应用。
4. 从概述复制 **Application (client) ID / 应用程序（客户端）ID**，不是对象 ID。
5. 进入 **证书和密码 → 客户端密码 → 新客户端密码**，设置有效期并立即保存 **Value / 值**，不是 Secret ID。离开后无法再次查看值。
6. 确认 Microsoft Graph **委托权限** `Files.ReadWrite.All` 与 `offline_access`。组织限制用户同意时，需管理员批准。

## 3. 填写 TG Vault

| 字段 | 内容 |
| --- | --- |
| Client ID | 应用客户端 ID |
| 租户 ID | 通常为 `common`，应用账户类型须支持目标账号；单租户填对应租户 |
| 存储名称 | 显示备注 |
| Client Secret | 客户端密码的 **Value**，必填，不是微软账号密码 |

点击 **前往授权**，允许弹窗，在微软页面选择目标网盘账号并完成登录、MFA 和权限同意。

应用注册账号不必与网盘账号相同，但应用账户类型、租户和组织策略须允许登录。同一 Client ID 可分别授权多个账户。

## 4. 验收与维护

授权成功后新账户成为默认，已有文件与任务目标不变。上传文件后，在 OneDrive 核对位置并下载检查。留意 Client Secret 有效期，详情页不会回显原值。

| 报错 | 检查 |
| --- | --- |
| `AADSTS7000218` | 是否缺少 Client Secret |
| `AADSTS7000215` | 是否误填 Secret ID、密钥无效或 ID/Secret 不属于同一应用 |
| `AADSTS7000222` | Secret 已到期，更新凭据并重新授权 |
| `AADSTS50011` | 应用回调与 TG Vault 实际回调是否一致 |
| 账号不在租户/不支持个人账号 | 应用账户类型、租户与组织策略 |
| 回调成功但原页仍等待 | [HTTPS、Cookie 与回调主机](/deploy/https#oauth-必须回到同一个-api-主机) |

## 当前不提供的驱动模式

不支持世纪互联、SharePoint site ID 或应用权限模式，无需手工获取刷新令牌。
