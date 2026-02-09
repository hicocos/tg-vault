#!/bin/bash

# FoomClous 服务器部署脚本
# 适用于 Debian 系统

set -e

DOMAIN="i.foomclous.dpdns.org"
EMAIL="admin@example.com"  # 请修改为您的邮箱

echo "=========================================="
echo "  FoomClous 服务器部署脚本"
echo "  域名: $DOMAIN"
echo "=========================================="

# 1. 更新系统
echo ""
echo "[1/6] 更新系统包..."
sudo apt-get update
sudo apt-get upgrade -y

# 2. 安装 Docker
echo ""
echo "[2/6] 安装 Docker..."
if ! command -v docker &> /dev/null; then
    # 安装依赖
    sudo apt-get install -y \
        apt-transport-https \
        ca-certificates \
        curl \
        gnupg \
        lsb-release

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

    echo "Docker 安装完成！"
else
    echo "Docker 已安装，跳过..."
fi

# 3. 创建项目目录
echo ""
echo "[3/6] 创建项目目录..."
DEPLOY_DIR="/opt/foomclous"
sudo mkdir -p $DEPLOY_DIR
sudo chown -R $USER:$USER $DEPLOY_DIR

# 4. 复制文件到服务器（假设已经上传到当前目录）
echo ""
echo "[4/6] 准备配置文件..."
cd $DEPLOY_DIR

# 创建 .env 文件
if [ ! -f .env ]; then
    echo "DB_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)" > .env
    echo ".env 文件已创建"
fi

# 5. 首次启动（获取 SSL 证书）
echo ""
echo "[5/6] 首次启动（HTTP 模式，用于获取 SSL 证书）..."

# 使用临时配置
if [ -f nginx/conf.d/default.conf.init ]; then
    cp nginx/conf.d/default.conf nginx/conf.d/default.conf.ssl
    cp nginx/conf.d/default.conf.init nginx/conf.d/default.conf
fi

# 启动服务
docker compose up -d --build

# 等待服务启动
echo "等待服务启动..."
sleep 10

# 获取 SSL 证书
echo ""
echo "[6/6] 获取 SSL 证书..."
docker compose run --rm certbot certonly --webroot \
    --webroot-path=/var/www/certbot \
    --email $EMAIL \
    --agree-tos \
    --no-eff-email \
    -d $DOMAIN

# 恢复 HTTPS 配置
if [ -f nginx/conf.d/default.conf.ssl ]; then
    cp nginx/conf.d/default.conf.ssl nginx/conf.d/default.conf
    rm nginx/conf.d/default.conf.ssl
fi

# 重启 Nginx 以应用 HTTPS
docker compose restart nginx

echo ""
echo "=========================================="
echo "  部署完成！"
echo "=========================================="
echo ""
echo "  访问地址: https://$DOMAIN"
echo ""
echo "  常用命令:"
echo "  - 查看状态: docker compose ps"
echo "  - 查看日志: docker compose logs -f"
echo "  - 重启服务: docker compose restart"
echo "  - 停止服务: docker compose down"
echo ""
echo "  SSL 证书将自动续期。"
echo ""
