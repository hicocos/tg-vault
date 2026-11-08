# 域名、HTTPS 与登录

## 标准配置

使用 Docker Compose 运行服务，宿主机反代负责 HTTPS。

| 配置 | 示例/默认值 |
| --- | --- |
| Web / `CORS_ORIGIN` | `https://cloud.example.com` |
| API / `VITE_API_URL` | `https://api.example.com` |
| Web 上游 | `http://127.0.0.1:47832` |
| API 上游 | `http://127.0.0.1:51947` |

Web/API 应为同一主域名下的 HTTPS 子域名。地址填写完整 origin，不带路径或尾斜杠。仅设置 CORS 不能解决跨站 `SameSite=Lax` Cookie 问题。

## 反代与证书

- [`nginx-site-init.conf`](https://github.com/hicocos/tg-vault/blob/main/deploy/nginx-site-init.conf)：ACME HTTP 验证使用。
- [`nginx-site.conf`](https://github.com/hicocos/tg-vault/blob/main/deploy/nginx-site.conf)：证书就绪后的 HTTPS 应用代理。

替换域名、证书路径、ACME webroot 和已修改的端口，不同时加载两份示例。执行 `nginx -t` 通过后再加载。使用面板时配置同样的上游与转发规则。

代理需要：

- 转发完整路径、Host、真实 IP、`X-Forwarded-For`、`X-Forwarded-Proto`。
- 支持 `Range` / `If-Range`，保留上游鉴权和缓存头，不公共缓存鉴权响应。
- 请求体容纳单个分片及 multipart 开销。默认分片 32 MiB，可用 `client_max_body_size 64m`；这不是文件总大小上限。
- 设置适合上传和媒体响应的超时。

Compose 不提供证书服务。`TRUST_PROXY` 只信任实际代理，不无条件设为 `true`。

## 管理员与 Cookie

创建管理员前，Web/API 两个入口仅允许自己访问。没有默认管理员密码。HTTPS 生效后创建强密码，验证登录，再开放入口。

生产保持 `COOKIE_SECURE=true`；新安装器另写入 `COOKIE_SECURE_FORCE=true`。登录失败先核对 HTTPS、同站地址、实际 API 和 `CORS_ORIGIN`，不要关闭安全 Cookie。

## 修改地址

`VITE_API_URL` 在前端容器启动时写入 `/runtime-config.js`。修改后重建容器，并在浏览器查看该文件的实际值，无需重新编译镜像。

非空的 `OAUTH_CALLBACK_BASE_URL`、`OAUTH_FRONTEND_ORIGIN` 优先于基础域名，改域名需同步更新。

## OAuth 必须回到同一个 API 主机

登录 Cookie 只属于设置它的主机。发起授权与回调必须使用同一 API 主机，提供方登记的 redirect URI 与设置页逐字一致。

同源 `/api` 模式将 `VITE_API_URL` 显式留空，并将 `OAUTH_CALLBACK_BASE_URL` 设为 Web origin，代理实际回调。详细参数见[配置参考](/reference/configuration)。

## 常见问题

| 现象 | 检查 |
| --- | --- |
| 502 | 上游地址、容器就绪、宿主机监听和代理日志 |
| 登录后回登录页 | `/runtime-config.js`、HTTPS、同站 Cookie、CORS/Origin、代理头 |
| 上传 413 | 各层代理请求体限制与分片大小 |
| 回调后原页仍等待 | 弹窗、Cookie、回调主机、前端 origin、配套前后端版本 |
| API 根路径 `Cannot GET /` | 使用 `/health`、`/livez` 或 `/readyz` 检查服务 |
