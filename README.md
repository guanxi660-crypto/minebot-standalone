# MineBot Standalone (mineplayer-bot-node)

**MineCraft 挂机机器人轻量版** —— 基于 mineflayer + AI 视角的 Minecraft Bot 框架，免构建、内置登录鉴权、带 Web 控制面板。

> 本仓库从 [debbide/minebot](https://github.com/debbide/minebot) 重构而来：保留根目录单文件版（mineplayer-bot-node）并解决部署问题、**新增面板登录鉴权**、抽出内嵌 HTML 为独立前端，让它在青龙面板 / Pterodactyl / 任意 Linux VPS 上**免 Docker、免前端构建**直接运行。
>
> 现已集成 **原生核心服务（core）** 与 **哪吒监控上报（status.js）** 两个可选模块，均可独立开关。

---

## ✨ 功能特性

### 挂机面板

| 功能 | 说明 |
|---|---|
| 🤖 多机器人挂机 | 一个面板管理多个机器人，崩溃 10 秒自动重连 |
| 🔐 面板登录 | 内置账号鉴权（默认 `admin / admin123`），API + WebSocket 双重保护 |
| 🏷️ 服务器名称备注 | 自定义显示名称，重连/重启后不还原 |
| 📁 翼龙文件管理 | 远程列目录 / 上传 / 下载 / 删除文件 |
| ⏻ 翼龙电源控制 | 远程启动 / 停止 / 重启服务器 + 连接测试 |
| 👣 拟人巡逻 | 物理引擎随机巡逻（可开关） |
| 💬 拟人喊话 | 随机发送拟人话语（可开关） |
| ⛏️ 自动找矿 | 扫描周围矿脉自动挖掘（可开关） |
| 👁️ AI 视角 | 机器人自动注视附近玩家 |
| ⏰ 定时重启 | 按分钟/小时向服务器发送 `/restart` |
| 🧠 内存守护 | 三级自愈：清缓存 → 主动 GC → 超阈值重连 bot 释放堆 |
| 💾 配置持久化 | 机器人配置自动保存 `bots_config.json`，重启自动恢复 |

### 原生核心服务（core，开关 `CORE_ENABLED`）

| 功能 | 说明 |
|---|---|
| 🧩 单进程多协议 | VMess WS(+Argo) / VLESS Reality / Hysteria2 / TUIC / AnyTLS / SOCKS5，无子进程 |
| 🌐 Argo 隧道 | 固定 token / TunnelSecret JSON / 临时隧道三种模式 |
| 🔑 自动密钥 | Reality X25519 密钥对自动生成并持久化；TLS 自签证书自动生成 |
| 📡 订阅服务 | base64 订阅通过 HTTP 暴露，支持 Telegram 推送 / 节点上传 / 自动保活 |
| 🎛️ 面板控制 | 面板右下角可直接启停核心服务，无需重启进程 |
| 🕵️ 伪装命名 | 本地库文件伪装命名（`libcodec.so` / `libtransport.so`），日志不含协议/组件字眼 |

### 哪吒监控上报（status.js，开关 `STATUS_ENABLED`）

| 功能 | 说明 |
|---|---|
| 📈 指标上报 | CPU / 内存 / 磁盘 / 网络 / 负载 / 连接数 持续上报到哪吒 v1 |
| 🔌 gRPC 协议 | 哪吒 v1 Dashboard（protobuf over HTTP2），TLS 按端口自动判断 |
| 🔇 独立开关 | 与核心服务互不影响，排障时可单独静默上报 |

> ⚠️ 核心服务的 `.so` 库仅支持 **Linux**；纯面板模式全平台可用。

---

## 🚀 快速开始

### 环境要求

- Node.js **>= 18**（mineflayer 要求）
- Minecraft 服务器需 `server.properties` 中 `online-mode=false`（离线模式 `auth: offline`）

### 部署

```bash
git clone https://github.com/guanxi660-crypto/minebot-standalone.git
cd minebot-standalone

npm install --omit=dev
cp .env.example .env        # 按需修改端口 / 密码 / 各模块开关
node index.js               # 前台运行
```

> 若需 `global.gc()` 生效（内存自愈第 2 级），用 `node --expose-gc index.js` 启动。

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

### 纯上传部署（青龙/翼龙等只能传文件的平台）

```
├── index.js               # 主程序
├── core                   # 原生核心模块（无扩展名，代理功能）
├── status.js              # 哪吒上报模块
├── package.json           # 依赖清单（可选带 package-lock.json）
└── public/index.html      # 前端页面 ← 必须放在 public 文件夹内!
```

**⚠️ 最常见的失败原因**：漏掉 `public/index.html`，或没建 `public` 文件夹 —— 页面会打不开（程序会打印明确提示）。

---

## 🛠️ 配置说明

### 环境变量（.env）

#### 面板

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` / `SERVER_PORT` | `4681` | 监听端口（`SERVER_PORT` > `PORT` 优先） |
| `ADMIN_USER` | `admin` | 面板登录用户名 |
| `ADMIN_PASSWORD` | `admin123` | 面板登录密码 ⚠️ 必改 |
| `MEMORY_MAX_PERCENT` | `90` | 内存硬阈值，超过触发优雅关闭（面板自动重启），`0` = 禁用 |
| `SERVER_MEMORY` | 自动检测 | 覆盖内存上限（MB） |
| `AUTO_FIX_DEPS` | `1` | 启动时自动补装缺失依赖 |

#### 原生核心服务（core）

端口全部留空 = 不启用，只跑面板。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CORE_ENABLED` | `true` | 核心服务总开关；`false` 时不自动启动，可在面板手动开启 |
| `SUB_PATH` | `sub` | HTTP 订阅路径 |
| `UUID` | `0a6568ff-...` | 节点 UUID，建议修改 |
| `NAME` | 空 | 节点名称前缀（留空用 IP-ISP 自动命名） |
| `S5_PORT` | 空 | SOCKS5 端口，留空不启用 |
| `HY2_PORT` | 空 | Hysteria2 端口，留空不启用 |
| `TUIC_PORT` | 空 | TUIC 端口，留空不启用 |
| `ANYTLS_PORT` | 空 | AnyTLS 端口，留空不启用 |
| `REALITY_PORT` | 空 | VLESS Reality 端口，留空不启用 |
| `ARGO_DOMAIN` | 空 | Argo 固定隧道域名（留空用临时隧道） |
| `ARGO_AUTH` | 空 | Argo tunnel token 或 TunnelSecret JSON |
| `ARGO_PORT` | `8001` | Argo 回源端口 |
| `DISABLE_ARGO` | `false` | `true` 禁用隧道 |
| `CFIP` / `CFPORT` | `saas.sin.fan` / `443` | 优选域名/IP 与端口 |
| `FILE_PATH` | `.npm` | 运行目录（**会被自动清理，勿放长期文件**） |
| `CHAT_ID` / `BOT_TOKEN` | 空 | Telegram 推送（两个都填才推送） |
| `UPLOAD_URL` / `PROJECT_URL` | 空 | Merge-sub 订阅上传 |
| `AUTO_ACCESS` | `false` | `true` 开启自动保活 |
| `YT_WARPOUT` | `false` | `true` 强制视频站点走 WARP |
| `SHOW_LOG` | `true` | 核心服务日志开关 |

#### 哪吒监控（status.js）

不填 `NEZHA_SERVER` / `NEZHA_KEY` = 不启用，面板完全不受影响。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `STATUS_ENABLED` | `true` | 监控上报总开关；`false` 强制关闭（无需清空密钥） |
| `NEZHA_SERVER` | 空 | 哪吒 v1 面板地址，形如 `host:port`（**gRPC 端口，不是网页 HTTP 端口**） |
| `NEZHA_KEY` | 空 | 面板客户端设置里生成的 Client Secret |
| `UUID` | 同上 | 复用上面的 UUID 作为 Client UUID |

### 面板内使用

1. 打开面板 → **登录**
2. 顶部输入 **IP:PORT**（Minecraft 服务器地址）和 **角色名**
3. 点击 **部署角色** → 机器人上线
4. 每个机器人卡片支持：
   - **模式开关**：AI 视角 / 巡逻 / 喊话 / **自动找矿**
   - **服务器名称备注**：自定义显示名，重连后不还原
   - **定时重启**：设定分钟/小时，到点自动发 `/restart`
   - **翼龙管理**：连接测试 / 文件管理 / 电源控制
   - 实时日志（最近 30 条）
5. 右下角控制条：内存监控 + **核心服务启停**

### 面板鉴权说明

- `POST /api/login`：提交 `{username, password}` 换取 token（24 小时有效）
- 所有 `/api/*` 接口需 `Authorization: Bearer <token>`
- WebSocket 连接需 `?token=<token>` 参数，且必须是**未过期**的有效会话
- 前端登录失败/过期自动弹回登录框

---

## 📁 文件结构

```
├── index.js               # 主程序（面板 API + 机器人管理 + 登录鉴权 + 模块集成）
├── core                   # 原生核心服务模块（无扩展名）
├── status.js              # 哪吒监控上报模块
├── public/index.html      # Web 控制面板前端
├── package.json           # 依赖清单
├── ecosystem.config.cjs   # pm2 配置文件
├── install.sh             # 一键部署脚本
├── .env.example           # 环境变量模板
└── bots_config.json       # （运行时自动生成）机器人配置持久化
```

> 部署时 `public/` 目录必须与 `index.js` 保持同层级，缺了页面打不开。
> `core` 为无扩展名文件，Node 可正常 `require('./core')` 加载。

---

## 🛡️ 安全提醒

1. **改默认密码**：首次部署立即修改 `.env` 中 `ADMIN_PASSWORD`
2. 对外暴露务必配防火墙/安全组，只放行需要的端口
3. WebSocket token 24 小时过期，进程重启后旧 token 全部失效（内存存储）
4. 本服务面向可信环境，翼龙 API Key 请勿泄露
5. 原生 `.so` 库仅 Linux 可用；Windows 下核心服务启动失败但面板不受影响

---

## 🧰 常用运维

```bash
pm2 logs minebot          # 查看日志
pm2 restart minebot       # 重启
pm2 stop minebot          # 停止
pm2 delete minebot        # 移除进程
```

---

## 📜 License

MIT

## 🙏 致谢

基于 [debbide/minebot](https://github.com/debbide/minebot)（mineplayer-bot-node）修改。
