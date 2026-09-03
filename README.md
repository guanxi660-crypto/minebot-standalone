# MineBot Standalone (mineplayer-bot-node)

**MineCraft 挂机机器人轻量版** —— 基于 mineflayer + AI 视角的 Minecraft Bot 框架，免构建、内置登录鉴权、带 Web 控制面板。

> 本仓库是 [debbide/minebot](https://github.com/debbide/minebot) 的**轻量部署分支（方案 B）**：取根目录单文件版（mineplayer-bot-node）重构——修复部署问题、**新增面板登录鉴权**、抽出内嵌 HTML，让它在青龙面板 / Pterodactyl / 任意 Linux VPS 上**免 Docker、免前端构建**直接运行。

---

## ✨ 功能特性

| 功能 | 说明 |
|---|---|
| 🤖 多机器人挂机 | 一个面板管理多个机器人，崩溃 10 秒自动重连 |
| 🔐 面板登录 | 内置账号鉴权（默认 `admin / admin123`），API + WebSocket 双重保护 |
| 👣 拟人巡逻 | 物理引擎随机巡逻（可开关） |
| 💬 拟人喊话 | 随机发送"有人吗 / 2333"等拟人话语（可开关） |
| 👁️ AI 视角 | 机器人自动注视附近玩家 |
| ⏰ 定时重启 | 按分钟/小时向服务器发送 `/restart` |
| 🎮 翼龙面板联动 | 填写 Pterodactyl API 后可远程同步/管理面板服务器 |
| 🧠 内存守护 | 30 秒巡检，超阈值自动清理日志 / 优雅关闭（可配置） |
| 💾 配置持久化 | 机器人配置自动保存 `bots_config.json`，重启自动恢复 |

## 🆚 与原版完整版（server/ 目录）的区别

| | 本仓库（轻量版） | 原版完整版 |
|---|---|---|
| 前端 | 独立静态页 `public/index.html`，免构建 | React，需 `npm run build` |
| 依赖 | 8 个 | 20+ 个 |
| 启动 | `node index.js` | `cd server && npm install && npm start` |
| 适合 | 青龙面板 / 受限容器 / 快速部署 | Docker 全家桶 / 功能全开 |

**如果你需要** AI 对话 `!ask`、自动续期、Telegram 通知等完整功能，请使用原仓库的完整版。

---

## 🚀 快速开始

### 环境要求

- Node.js **>= 18**（mineflayer 要求）
- 可访问的 Minecraft 服务器（离线模式 `auth: offline`）

### 方式一：一键部署脚本（推荐）

```bash
# 克隆仓库
git clone https://github.com/guanxi660-crypto/minebot-standalone.git
cd minebot-standalone

# 执行一键部署 (检测 Node → 装依赖 → 配 .env → pm2 守护)
chmod +x install.sh
./install.sh
```

### 方式二：手动部署

```bash
cd minebot-standalone
npm install --omit=dev
cp .env.example .env        # 按需修改 PORT / 登录密码
node index.js               # 前台运行
```

用 pm2 守护（推荐长驻）：

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                # 按提示执行输出的命令开启自启
```

### 访问面板

```
http://<服务器IP>:4681
```

默认登录：**admin / admin123**（**务必修改，见下文「安全」**）

### 方式三：纯上传部署（青龙/翼龙等只能传文件的平台）

无法 git clone 的平台（Pterodactyl 面板、部分青龙容器），从仓库手动下载以下 **3 个文件**：

```
├── index.js               # 主程序
├── package.json           # 依赖清单 (可选带 package-lock.json)
└── public/index.html      # 前端页面 ← 必须放在 public 文件夹内!
```

**⚠️ 最常见的失败原因**：只传了 `index.js` 和 `package.json`，漏掉 `public/index.html`，或没建 `public` 文件夹 —— 页面会打不开（程序会打印明确提示）。三个文件必须按上面的目录结构摆放，`public/index.html` 与 `index.js` 同级。

上传后在平台控制台执行：

```bash
cd /home/container          # 按平台实际根目录调整
npm install --omit=dev
node index.js
```

> 缺 `public/index.html` 时程序仍会启动（API 正常），但首页显示 500 提示补传文件。

---

## 🛠️ 配置说明

### 环境变量（.env）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` / `SERVER_PORT` | `4681` | 监听端口（代码监听 `0.0.0.0`，`SERVER_PORT` > `PORT` 优先） |
| `ADMIN_USER` | `admin` | 面板登录用户名 |
| `ADMIN_PASSWORD` | `admin123` | 面板登录密码 ⚠️ 必改 |
| `MEMORY_MAX_PERCENT` | `90` | 内存占用超过此 % 触发优雅关闭，`0` = 禁用 |
| `SERVER_MEMORY` | 自动检测 | 覆盖内存上限（MB），容器内检测失败时手动指定 |
| `AUTO_FIX_DEPS` | `1` | 启动时自动补装缺失依赖，`0` = 关闭 |

### 面板内使用

1. 打开面板 → **登录**（默认 admin/admin123）
2. 顶部输入 **IP:PORT**（Minecraft 服务器地址）和 **角色名**
3. 点击 **部署角色** → 机器人上线（状态变"在线"）
4. 每个机器人卡片支持：
   - **定时重启**：设定分钟/小时，到点自动发 `/restart`
   - **翼龙配置**：面板地址 + 服务器 ID + API Key，支持文件同步
   - **模式开关**：AI 视角 / 巡逻 / 喊话
   - 实时日志（最近 30 条）

### 面板鉴权说明（本仓库新增）

- `POST /api/login`：提交 `{username, password}` 换取 token（24 小时有效）
- 所有 `/api/*` 接口需 `Authorization: Bearer <token>`
- WebSocket 连接需 `?token=<token>` 参数（原版只校验"非空"，本版改为校验**有效 token**）
- 前端登录失败/过期自动弹回登录框

---

## 🏢 平台部署指南

### 青龙面板（Qinglong）同机 / 普通 VPS

```bash
cd /root && git clone https://github.com/guanxi660-crypto/minebot-standalone.git
cd minebot-standalone && ./install.sh
```

> ⚠️ **不要**把本服务加进青龙"定时任务"里跑——长驻 Web 服务会被任务超时杀掉。正确姿势：SSH 用 pm2 守护，青龙面板照常跑你的脚本，互不干扰。

### Pterodactyl（翼龙）面板

1. 用 SFTP / 文件管理器把仓库文件传到服务器的 `/home/container/`
2. 面板控制台执行：
   ```bash
   cd /home/container && npm install --omit=dev && node index.js
   ```
3. 外部端口需在面板 **Network** 里分配并放行，`.env` 的 `PORT` 填分配到的端口（若 egg 注入了 `SERVER_PORT` 环境变量则自动生效）

### Docker（可选）

```bash
docker run -d --name minebot -p 4681:4681 -v $PWD:/app \
  -w /app node:20-alpine sh -c "npm install --omit=dev && node index.js"
```

---

## 📁 文件结构

```
├── index.js               # 主程序（后端：API + 机器人管理 + 登录鉴权）
├── public/index.html      # Web 控制面板前端（登录 + 管理界面）
├── package.json           # 依赖清单（8 个运行时依赖）
├── ecosystem.config.cjs   # pm2 配置文件
├── install.sh             # 一键部署脚本
├── .env.example           # 环境变量模板
└── bots_config.json       # （运行时自动生成）机器人配置持久化
```

> 部署时 `public/` 目录必须与 `index.js` 保持同层级，缺了页面打不开。

## 🛡️ 安全提醒

1. **改默认密码**：首次部署立即修改 `.env` 中 `ADMIN_PASSWORD`（或启动命令传 `ADMIN_PASSWORD=xxx`）
2. 对外暴露务必配防火墙/安全组，只放行需要的端口
3. WebSocket token 24 小时过期，进程重启后旧 token 全部失效（内存存储）
4. 本服务面向可信环境，翼龙 API Key 请勿泄露

## 🧰 常用运维

```bash
pm2 logs minebot          # 查看日志
pm2 restart minebot       # 重启
pm2 stop minebot          # 停止
pm2 delete minebot        # 移除进程
```

## 📜 License

MIT

## 🙏 致谢

基于 [debbide/minebot](https://github.com/debbide/minebot)（mineplayer-bot-node）修改：修复 `"type": "module"` 冲突、补全 `ws` 依赖、支持 `.env` 加载、内存阈值可配置、新增面板登录鉴权、抽出内嵌 HTML 为独立静态页。
