# Telegram 连接与授权

## 两种连接

| 类型 | 用途 | 凭据 |
| --- | --- | --- |
| Bot | 接收私聊文件、命令和通知 | Bot Token、API ID、API Hash |
| 个人账号 | 频道历史下载、订阅，以及按来源读取转发原帖 | 手机号、验证码、可选两步验证密码 |

TG Vault 使用 GramJS/MTProto，Bot 也需要 API ID/Hash。只向 Bot 直接发文件不要求登录个人账号。

## 1. 获取凭据

1. 向 [@BotFather](https://t.me/BotFather) 发送 `/newbot`，取得 Token。
2. 在 [my.telegram.org](https://my.telegram.org) 的 **API development tools** 创建应用，取得 API ID/Hash。
3. 打开自己的 **Web → 设置 → Telegram → Telegram Bot 连接**，填写三项凭据，测试连接，设置 4 位数字 PIN，保存并启用。

## 2. 配置允许用户

在 **Telegram Bot 用户权限** 先填数字 user ID，多个用英文逗号分隔，不是用户名或频道 ID。然后私聊 Bot，发送 `/start` 完成认证；启用 TOTP 后按提示验证。

::: warning
PIN 不能替代允许列表。列表为空且无已认证用户时，第一个正确输入 PIN 的用户可自动加入。先配置列表，再分享 Bot/PIN。
:::

`TELEGRAM_ALLOWED_USER_IDS` 环境变量非空时覆盖 Web 列表并禁止 Web 修改。Bot 的 Web 凭据优先于环境变量，新部署建议统一在 Web 管理。

## 3. 登录个人账号

在同页 **Telegram 用户账号 → 添加账号** 选择二维码或手机号登录；手机号方式需要验证码，必要时输入两步验证密码，无需手工生成 session。新绑定账号自动启用，可继续添加其他账号。使用能访问目标来源的账号；私有频道通常需要加入，并能读取历史消息。

可添加多个账号参与调度，配置与状态说明见[多账号调度](/usage/multi-account)。

Session 可用于访问账号，应按密码保护。泄露后在 Telegram 撤销活动会话，必要时更换 Bot 凭据。

## 4. 转发文件的来源规则

- 启用个人账号下载且转发含完整来源与原帖 ID 时，由个人账号读取原帖。
- 来源不完整或未启用账号下载时，使用 Bot 接收的媒体。
- 账号读源失败会报错，不自动回退 Bot。
- 登录个人账号不会让它读取 Bot 私聊消息，也不会自动加入私有频道或绕过内容保护。

## 5. 离线与限流

系统自动恢复可恢复的连接。持续离线时先查看设置页连接状态与后端日志；`TELEGRAM_REQUIRED=false` 时，readiness 通过不代表 Bot 在线。

FloodWait 按服务端要求等待，不反复重试或加并发。MTProto 不直接套用 HTTP Bot API `getFile` 上限；实际文件仍受账号、权限、可用性和服务端限制。
