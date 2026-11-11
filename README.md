# MineBot Standalone — dev (Linux VPS 纯挂机版)

**MineCraft 挂机机器人 · 纯面板精简版** —— 基于 mineflayer 的 Minecraft Bot 挂机面板，专为 Linux VPS / Docker 部署打造。**不含代理核心与监控上报模块**，依赖更少、镜像更小、审计面更窄。

> 本分支（`dev`）从 `main` 拆出：移除 core（代理核心）与 status（监控上报）两个可选模块的全部代码、配置与依赖。
> 需要完整版（含代理/上报）请回 **[`main` 分支](https://github.com/guanxi660-crypto/minebot-standalone)**。

---

## ✨ 功能特性

| 功能 | 说明 |
|---|---|
| 🤖 多机器人挂机 | 一个面板管理多个机器人，崩溃 10 秒自动重连 |
| ⏸️ 暂停/恢复 | 保持在线挂起全部行为，恢复按配置重新拉起 |
| 🔐 面板登录 | 内置账号鉴权（默认 `admin / admin123`），API + WebSocket 双重保护 |
| 🏷️ 服务器名称备注 | 自定义显示名称，重连/重启后不还原 |
| 📁 翼龙文件管理 | 远程列目录 / 上传 / 下载 / 删除文件 |
| ⏻ 翼龙电源控制 | 远程启动 / 停止 / 重启服务器 + 连接测试 |
| 👣 拟人巡逻 | 物理引擎随机巡逻（可开关） |
| 💬 拟人喊话 | 随机发送拟人话语（可开关） |
| 👁️ AI 视角 | 机器人自动注视附近玩家 |
| ⏰ 定时重启 | 按分钟/小时向服务器发送 `/restart` |
| 📊 系统状态 | 进程 CPU 占用 + 内存使用实时显示 |
| 🧠 内存守护 | 三级自愈：清缓存 → 主动 GC → 超阈值重连 bot 释放堆 |
| 💾 配置持久化 | 机器人配置自动保存 `bots_config.json`，重启自动恢复（行为开关不跨进程恢复，防开机自动挖矿） |

---

## 🚀 快速开始

### 方式一：Docker（推荐）

镜像由 GitHub Actions 自动构建并发布到 GHCR（`linux/amd64` + `linux/arm64`）：

```bash
docker run -d \
  --name minebot \
  --restart unless-stopped \
  -p 4681:4681 \
  -e ADMIN_USER=admin \
  -e ADMIN_PASSWORD=请修改我 \
  ghcr.io/guanxi660-crypto/minebot-standalone:dev
```

> 容器内固定监听 4681，用 `-p` 映射任意外部端口。
> `bots_config.json` 在工作目录，持久化请挂卷（`-v minebot-data:/app`）。

### 方式二：一键安装脚本（裸机 VPS + pm2）

```bash
git clone -b dev https://github.com/guanxi660-crypto/minebot-standalone.git minebot
cd minebot
chmod +x install.sh
./install.sh
```

脚本自动完成：检测 Node ≥ 18 → `npm install --omit=dev` → 创建 `.env` → 安装 pm2 → 启动 + 开机自启。

### 方式三：手动部署

```bash
git clone -b dev https://github.com/guanxi660-crypto/minebot-standalone.git minebot
cd minebot
npm install --omit=dev
cp .env.sample .env        # 修改端口/密码
node index.js              # 前台运行（调试）
```

> 若需 `global.gc()` 生效（内存自愈第 2 级），用 `node --expose-gc index.js` 启动。

pm2 守护（推荐长驻）：

```bash
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

### 访问面板

```
http://<服务器IP>:4681
```

默认登录：**admin / admin123**（**务必修改**：编辑 `.env` 的 `ADMIN_PASSWORD` 后重启）

---

## ⚙️ 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `4681` | 监听端口（优先级 `SERVER_PORT` > `PORT` > 4681） |
| `ADMIN_USER` | `admin` | 面板登录账号 |
| `ADMIN_PASSWORD` | `admin123` | 面板登录密码，**首次部署必改** |
| `MEMORY_MAX_PERCENT` | `90` | 内存硬阈值（百分比），超过触发优雅关闭由容器/pm2 拉起；`0` 禁用 |
| `SERVER_MEMORY` | 自动检测 | 手动指定内存上限（MB），容器内检测不准时使用 |
| `AUTO_FIX_DEPS` | `1` | 启动时自动补装缺失依赖，`0` 关闭 |

Minecraft 服务器需 `server.properties` 中 `online-mode=false`（离线模式）。

---

## 🐳 从源码构建镜像

```bash
docker build -t minebot-dev .
docker run -d --name minebot -p 4681:4681 minebot-dev
```

推送到 `dev` 分支会自动触发 GHCR 构建（见 `.github/workflows/build-docker.yml`）。

---

## 🔒 安全提示

- 首次部署立即修改 `ADMIN_PASSWORD`
- 建议不要把面板端口直接暴露公网：套反代 + 额外鉴权，或用防火墙白名单
- `bots_config.json` 含机器人配置，注意备份与权限

---

## 📄 License

MIT — 见 [LICENSE](LICENSE)
