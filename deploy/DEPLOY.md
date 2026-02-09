# FoomClous 服务器部署指南

## 前置条件

- Debian 系统服务器
- 域名 `co.zrn.qzz.io` 已解析到服务器 IP
- 开放端口：80, 443

## 部署步骤

### 方式一：自动部署（推荐）

1. **上传项目到服务器**

```bash
# 在本地打包项目（不包含 node_modules）
cd C:\Users\admin\Desktop\FoomClous
tar --exclude='node_modules' --exclude='.git' -czvf foomclous.tar.gz .

# 上传到服务器
scp foomclous.tar.gz user@your-server-ip:/tmp/
```

2. **在服务器上解压并运行部署脚本**

```bash
# SSH 连接到服务器
ssh user@your-server-ip

# 解压
sudo mkdir -p /opt/foomclous
cd /opt/foomclous
sudo tar -xzvf /tmp/foomclous.tar.gz

# 修改部署脚本中的邮箱
nano deploy/install.sh
# 将 EMAIL="admin@example.com" 改为您的邮箱

# 运行部署脚本
chmod +x deploy/install.sh
./deploy/install.sh
```

3. **访问网站**

部署完成后，访问 https://co.zrn.qzz.io

---

### 方式二：手动部署

#### 1. 安装 Docker

```bash
# 更新系统
sudo apt-get update && sudo apt-get upgrade -y

# 安装依赖
sudo apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release

# 添加 Docker GPG 密钥
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

# 添加 Docker 仓库
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 安装 Docker
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# 启动 Docker
sudo systemctl start docker
sudo systemctl enable docker

# 将当前用户添加到 docker 组
sudo usermod -aG docker $USER

# 重新登录以应用组权限
exit
# 重新 SSH 连接
```

#### 2. 上传项目文件

```bash
# 创建目录
sudo mkdir -p /opt/foomclous
sudo chown -R $USER:$USER /opt/foomclous

# 上传文件到 /opt/foomclous
# (使用 scp, rsync, 或 SFTP)
```

#### 3. 创建环境变量文件

```bash
cd /opt/foomclous

# 生成随机数据库密码
echo "DB_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)" > .env
```

#### 4. 首次启动（获取 SSL 证书）

```bash
# 使用临时配置（HTTP only）
cp nginx/conf.d/default.conf nginx/conf.d/default.conf.ssl
cp nginx/conf.d/default.conf.init nginx/conf.d/default.conf

# 启动服务
docker compose up -d --build

# 等待服务启动
sleep 10

# 获取 SSL 证书（替换邮箱）
docker compose run --rm certbot certonly --webroot \
    --webroot-path=/var/www/certbot \
    --email your-email@example.com \
    --agree-tos \
    --no-eff-email \
    -d co.zrn.qzz.io
```

#### 5. 启用 HTTPS

```bash
# 恢复 HTTPS 配置
cp nginx/conf.d/default.conf.ssl nginx/conf.d/default.conf

# 重启 Nginx
docker compose restart nginx
```

#### 6. 验证

访问 https://co.zrn.qzz.io

---

## 常用命令

```bash
# 进入项目目录
cd /opt/foomclous

# 查看服务状态
docker compose ps

# 查看日志
docker compose logs -f
docker compose logs -f backend    # 后端日志
docker compose logs -f frontend   # 前端日志
docker compose logs -f postgres   # 数据库日志

# 重启服务
docker compose restart
docker compose restart backend    # 重启后端

# 停止服务
docker compose down

# 更新代码后重新部署
docker compose up -d --build

# 清理无用镜像
docker system prune -f
```

## SSL 证书管理

证书由 Certbot 自动续期。手动续期命令：

```bash
docker compose run --rm certbot renew
docker compose restart nginx
```

## 数据备份

```bash
# 备份数据库
docker compose exec postgres pg_dump -U foomclous foomclous > backup_$(date +%Y%m%d).sql

# 备份上传文件
docker run --rm -v foomclous_file-storage:/data -v $(pwd):/backup alpine tar czvf /backup/files_$(date +%Y%m%d).tar.gz /data
```

## 故障排查

### 502 Bad Gateway
```bash
# 检查后端是否运行
docker compose ps
docker compose logs backend
```

### SSL 证书问题
```bash
# 检查证书
docker compose run --rm certbot certificates

# 强制续期
docker compose run --rm certbot renew --force-renewal
docker compose restart nginx
```

### 数据库连接失败
```bash
# 检查数据库状态
docker compose exec postgres pg_isready -U foomclous

# 查看数据库日志
docker compose logs postgres
```
