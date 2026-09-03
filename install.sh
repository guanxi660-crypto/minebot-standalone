#!/bin/bash
# ============================================
# MineCraft Bot Assistant - 一键部署脚本
# 适用于: 青龙面板同机 / VPS Node.js 环境
# 用法: chmod +x install.sh && ./install.sh
# ============================================
set -e

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}   MineCraft Bot Assistant - 一键部署${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

# 1. 检查 Node.js
echo -e "${YELLOW}[1/5] 检测 Node.js 环境...${NC}"
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ 未找到 Node.js，请先安装 Node.js >= 18${NC}"
    exit 1
fi
NODE_VER=$(node -v)
echo -e "${GREEN}✓ Node.js ${NODE_VER}${NC}"

if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ 未找到 npm${NC}"
    exit 1
fi
echo -e "${GREEN}✓ npm $(npm -v)${NC}"

# 2. 安装依赖
echo -e "${YELLOW}[2/5] 安装项目依赖 (npm install)...${NC}"
npm install --omit=dev
echo -e "${GREEN}✓ 依赖安装完成${NC}"

# 3. 配置 .env
echo -e "${YELLOW}[3/5] 检查 .env 配置文件...${NC}"
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo -e "${YELLOW}⚠ 已从 .env.example 创建 .env 文件，请根据实际情况修改${NC}"
    else
        echo -e "${YELLOW}⚠ 未找到 .env.example，跳过${NC}"
    fi
else
    echo -e "${GREEN}✓ .env 已存在${NC}"
fi

# 4. 安装 pm2 (如未安装)
echo -e "${YELLOW}[4/5] 检查进程管理器...${NC}"
if command -v pm2 &> /dev/null; then
    echo -e "${GREEN}✓ pm2 $(pm2 -v)${NC}"
else
    echo -e "${YELLOW}⚠ 未安装 pm2，正在安装...${NC}"
    npm install -g pm2
    echo -e "${GREEN}✓ pm2 $(pm2 -v) 安装完成${NC}"
fi

# 5. 启动服务
echo -e "${YELLOW}[5/5] 启动服务...${NC}"
if [ -f ecosystem.config.cjs ]; then
    pm2 start ecosystem.config.cjs
    pm2 save
    pm2 startup 2>/dev/null || true
else
    pm2 start index.js --name minebot
    pm2 save
fi

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}   MineCraft Bot Assistant 部署完成!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  ${CYAN}Web 面板:${NC} http://<服务器IP>:${PORT:-4681}"
echo -e "  ${CYAN}查看日志:${NC} pm2 logs minebot"
echo -e "  ${CYAN}重启服务:${NC} pm2 restart minebot"
echo -e "  ${CYAN}停止服务:${NC} pm2 stop minebot"
echo ""

# 提取端口并显示提示
PORT_VAL=${PORT:-4681}
echo -e "${YELLOW}⚠ 重要提示:${NC}"
echo -e "  1. 确保防火墙/安全组已放行 TCP ${PORT_VAL}"
echo -e "  2. 面板默认无登录密码，对外暴露请配置反向代理 + 鉴权"
echo -e "  3. 如使用青龙面板，请勿将此服务作为"定时任务"运行"
echo -e "     (pm2 会自动守护进程，青龙面板的任务超时会杀掉它)"
echo ""