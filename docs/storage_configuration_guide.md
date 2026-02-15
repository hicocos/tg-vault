# FoomClous 存储源配置指南 ☁️

FoomClous 支持多种存储后端。您可以根据对速度、容量和成本的需求，选择本地存储或云存储。

---

## 1. 本地存储 (Local Storage)

文件直接保存在运行 FoomClous 的服务器硬盘上，速度最快，但受限于服务器磁盘大小。

- **配置**: 无需特殊操作。
- **持久化**: 如果使用 Docker，请确保挂载了挂载卷（默认已集成在 `docker-compose.yml` 中）。

---

## 2. Microsoft OneDrive

适合拥有 Office 365 订阅的用户，提供 1TB - 5TB 的廉价高速存储。

### 获取凭据
1. 访问 [Azure Portal](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)。
2. 创建“新注册”，**重定向 URI** 选择 `Web` 并填写：`https://您的域名/api/storage/onedrive/callback`。
3. 获取 **Client ID** 和 **Tenant ID**（通常为 `common`）。
4. 在“证书和密码”中生成 **Client Secret**。

### 开启功能
- **设置 -> 存储源 -> OneDrive**，输入凭据并点击“保存并授权”。

---

## 3. S3 兼容存储 (AWS S3, MinIO, R2)

支持所有兼容 S3 协议的对象存储，如 Cloudflare R2, Backblaze B2, MinIO 等。

### 配置信息
- **Endpoint**: 节点地址 (如 `https://s3.us-east-1.amazonaws.com`)。
- **Region**: 区域 (如 `us-east-1`)。
- **AccessKey / SecretKey**: 访问密钥。
- **Bucket**: 存储桶名称。
- **Force Path Style**: 如果使用 MinIO 或某些私有云，可能需要勾选。

---

## 4. WebDAV (坚果云, InfiniCLOUD)

最通用的网络存储协议。

### 配置信息
- **URL**: WebDAV 服务器地址 (如 `https://dav.jianguoyun.com/dav/`)。
- **Username**: 登录账号。
- **Password**: 应用专用口令（非登录密码）。

---

## 5. Google Drive

适合需要大量存储空间且拥有 Google 账号的用户。

### 获取凭据
1. 访问 [Google Cloud Console](https://console.cloud.google.com/apis/credentials)。
2. 创建“OAuth 2.0 客户端 ID”。
3. **应用类型**选择 `Web 应用程序`。
4. 在“已授权的重定向 URI”中填写：`https://您的域名/api/storage/google-drive/callback`。
5. 获取 **Client ID** 和 **Client Secret**。

### 开启功能
- **设置 -> 存储源 -> Google Drive**，输入凭据并点击“保存并授权”。

---

## 6. 阿里云 OSS

国内用户推荐，响应速度快，成本低。

### 详细配置步骤

#### 1. 创建存储桶 (Bucket)
1. 登录 [阿里云 OSS 控制台](https://oss.console.aliyun.com/)。
2. 点击 **“创建 Bucket”**。
3. **名称**: 自定义（如 `foomclous-data`）。
4. **地域**: 选择距离您最近的地域（例如：华东 1 上海）。
   - **重要**: 记住地域 ID，如 `oss-cn-shanghai`。
5. **读写权限**: 建议选择 **“私有”**（FoomClous 会通过后端签名访问，确保安全）。

#### 2. 获取 AccessKey (推荐使用 RAM 用户)
1. 进入 [RAM 访问控制台](https://ram.console.aliyun.com/)。
2. 创建一个 **“用户”**，勾选 **“OpenAPI 调用访问”**。
3. 创建成功后，保存好 **AccessKey ID** 和 **AccessKey Secret**。
4. **添加权限**: 给该用户授予 `AliyunOSSFullAccess` 权限。

#### 3. 填写配置项
- **Region**: 您的地域 ID (例如 `oss-cn-shanghai`)。
- **AccessKey ID**: 您保存的 ID。
- **AccessKey Secret**: 您保存的 Secret。
- **Bucket**: 您创建的存储桶名称。

---

## 🔄 如何切换活动账户？

1. 进入 **设置 -> 存储源设置**。
2. 在列表中找到您想使用的账户。
3. 点击 **“切换到此账户”**。
4. **提示**：新上传的文件会存入新账户，已上传的文件仍会通过原路径访问。

---
[返回文档中心](./README.md)
