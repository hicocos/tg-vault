#!/bin/bash

# Docker 垃圾清理脚本
# 用于清理 FoomClous 项目的 Docker 垃圾文件

echo "========================================="
echo "Docker 垃圾清理脚本"
echo "========================================="
echo ""

# 显示当前 Docker 磁盘使用情况
echo "📊 当前 Docker 磁盘使用情况："
docker system df
echo ""

# 询问用户确认
read -p "是否继续清理？(y/n): " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ 已取消清理"
    exit 1
fi

echo ""
echo "🧹 开始清理..."
echo ""

# 1. 停止并删除所有容器（包括未运行的）
echo "1️⃣ 停止并删除所有容器..."
docker-compose down
docker container prune -f
echo "✅ 容器清理完成"
echo ""

# 2. 删除未使用的镜像
echo "2️⃣ 删除未使用的镜像..."
docker image prune -a -f
echo "✅ 镜像清理完成"
echo ""

# 3. 删除未使用的卷（注意：这会删除数据！）
echo "⚠️  警告：以下操作会删除未使用的 Docker 卷（可能包含数据）"
read -p "是否删除未使用的卷？(y/n): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    docker volume prune -f
    echo "✅ 卷清理完成"
else
    echo "⏭️  跳过卷清理"
fi
echo ""

# 4. 删除未使用的网络
echo "3️⃣ 删除未使用的网络..."
docker network prune -f
echo "✅ 网络清理完成"
echo ""

# 5. 删除构建缓存
echo "4️⃣ 删除构建缓存..."
docker builder prune -a -f
echo "✅ 构建缓存清理完成"
echo ""

# 6. 显示清理后的磁盘使用情况
echo "========================================="
echo "📊 清理后的 Docker 磁盘使用情况："
docker system df
echo ""

echo "========================================="
echo "✨ 清理完成！"
echo "========================================="
echo ""
echo "💡 提示：如果需要重新启动项目，请运行："
echo "   docker-compose up -d"
