# mineplayer-bot-node · 完整版（full-version 分支）

**MineCraft 挂机机器人完整版** —— React 前端 + Node 后端，含 AI 对话（!ask）、自动喊话设置、自动续期、面板登录、文件管理、Telegram 通知。

> 本分支基于 [debbide/minebot](https://github.com/debbide/minebot) 完整版（server/ + React 前端）修复构建与部署问题。轻量版（单文件）见 **main 分支**。

## 🆚 两个分支的区别

| | `main`（轻量版） | `full-version`（本分支，完整版） |
|---|---|---|
| 前端 | 静态页 `public/index.html` | React（预构建产物在 `dist/`） |
| 功能 | 挂机/巡逻/喊话/定时重启/登录 | 全部 + AI 对话 + 自动续期 + 文件管理 + Telegram |
| 依赖 | 8 个 | 20+ 个 |
| 启动 | `node index.js` | `cd server && npm install && npm start` |

## 📁 文件结构

```
├── dist/                  # 前端构建产物（已预构建，无需 npm run build）
└── server/                # 后端
    ├── index.js           # 主程序（静态服务 dist/ + API + 登录鉴权）
    ├── bot/               # 机器人核心（BotManager / BotPool / AI行为）
    ├── routes/            # API 路由（auth/bots/files/proxy/system/telegram）
    ├── services/          # 服务层（AI/审计/认证/配置/代理）
    ├── tests/             # 冒烟测试
    ├── package.json
    └── ecosystem.config.cjs  # pm2 配置
```

## 🚀 快速开始

### 方式一：git clone（有终端权限）

```bash
git clone -b full-version https://github.com/guanxi660-crypto/minebot-standalone.git
cd minebot-standalone/server
npm install --omit=dev
node index.js          # 或 npm start
```

### 方式二：纯上传部署（青龙/翼龙等只能传文件的平台）

下载 `full-version` 分支的 zip，只传以下内容到根目录：

```
├── dist/                # 整个文件夹
└── server/              # 整个文件夹（不含 node_modules）
```

然后在平台控制台执行：

```bash
cd /home/container/server
npm install --omit=dev
node index.js
```

> ⚠️ `dist/` 必须与 `server/` 同级（`server/index.js` 通过 `../dist` 引用前端页面）。漏传 `dist/` 会导致页面打不开。

## 🛠️ 配置

服务默认读取 `server/.env`（不存在则用默认值）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` / `SERVER_PORT` | `3000` | 监听端口（`SERVER_PORT` 优先） |
| `JWT_SECRET` | 自动生成并持久化 `server/data/master.key` | 登录 token 签名密钥 |
| `ADMIN_USER` | `admin` | 面板登录用户名 |
| `ADMIN_PASSWORD` | `admin123` | 面板登录密码 ⚠️ 首次登录后必改 |

登录后可在面板 **设置** 页修改密码，配置会加密存储于 `server/data/config.json`。

## 🏢 平台部署（Pterodactyl）

1. 启动命令设为：`cd /home/container/server && node index.js`
2. 首次启动自动生成 `server/data/`（含密钥与配置）
3. 机器人需在面板内重新添加（完整版配置存储与轻量版不通用）

## 🧪 测试

```bash
cd server
npm test
```

## 🛡️ 安全提醒

- 默认密码 `admin/admin123` 必须修改
- `server/data/master.key` 是加密密钥，**不要**提交到仓库、**不要**泄露
- 端口需在防火墙/安全组放行
