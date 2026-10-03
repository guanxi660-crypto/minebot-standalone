# MineBot Standalone (mineplayer-bot-node)

**MineCraft 挂机机器人轻量版** —— 基于 mineflayer + AI 视角的 Minecraft Bot 框架，免构建、内置登录鉴权、带 Web 控制面板。

> 本仓库从 [debbide/minebot](https://github.com/debbide/minebot) 重构而来：保留根目录单文件版（mineplayer-bot-node）并解决部署问题、**新增面板登录鉴权**、抽出内嵌 HTML 为独立前端，让它在青龙面板 / Pterodactyl / 任意 Linux VPS 上**免 Docker、免前端构建**直接运行。
>
> 现已集成 **原生核心服务（core）** 与 **监控上报（status）** 两个可选模块，均可独立开关。

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

### 监控上报（status，开关 `STATUS_ENABLED`）

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
cp .env.sample .env          # 面板配置(端口/密码); 模块配置请直接改 core 与 status 文件
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

---

## 📦 上传哪些文件？（按场景对照）

`core` 和 `status` 是**可选模块**，默认不上传、不启动。三种场景对照如下：

### 场景 A：只用挂机面板（最简，推荐新手）

**上传 4 个文件：**

```
├── index.js               # 主程序（必需）
├── package.json           # 依赖清单（必需，缺了不会 npm install）
├── package-lock.json      # 锁定版本（推荐）
└── public/
    └── index.html         # 面板页面（必需，缺了页面打不开）
```

**外加复制一份配置：**
```bash
cp .env.sample .env       # 然后按需改端口 / 密码
```

✅ 结果：面板可用，两个模块都不存在（启动时打印一行提示后跳过，不影响面板）

---

### 场景 B：挂机面板 + 监控上报（哪吒）

在场景 A 基础上**多加 1 个文件**：

```
├── status                 # 监控上报模块（无扩展名）
└── .env 里加一行：
    STATUS_ENABLED=true
```

**配置步骤：**

1. 上传 `status` 到项目根目录（和 `index.js` 同级，**文件名没有 `.js`**）
2. 打开 `status`，编辑顶部「配置区」：
   ```js
   const NEZHA_SERVER = process.env.NEZHA_SERVER || '';   // 填 "主机:端口"
   const NEZHA_KEY    = process.env.NEZHA_KEY    || '';   // 填 Client Secret
   const UUID         = process.env.UUID         || '';   // 填 Client UUID
   ```
3. `.env` 里把 `STATUS_ENABLED` 改成 `true`
4. 重启生效

> ⚠️ **注意**：填了真实密钥的 `status` 文件**不要提交到 GitHub**。建议只把留空模板版放进仓库，线上单独维护一份填好值的。

---

### 场景 C：挂机面板 + 代理核心 + 监控上报（完整）

在场景 B 基础上**再多 1 个文件**：

```
├── core                   # 代理核心模块（无扩展名）
└── .env 里加一行：
    CORE_ENABLED=true
```

**配置步骤：**

1. 上传 `core` 到项目根目录（**文件名没有 `.js`**）
2. 打开 `core`，编辑顶部「配置区」，至少填好要启用的入站端口：
   ```js
   const HY2_PORT     = process.env.HY2_PORT     || '';   // 填 8443 启用 Hysteria2
   const REALITY_PORT = process.env.REALITY_PORT || '';   // 填 14443 启用 Reality
   // 端口全部留空 = 不启用任何代理协议
   ```
3. `.env` 里把 `CORE_ENABLED` 改成 `true`
4. 重启生效，订阅地址为 `http://<IP>:<面板端口>/<SUB_PATH>`

> ⚠️ **两个前提**：
> - `core` 的原生库仅支持 **Linux**（Windows 上会启动失败，但面板不受影响）
> - 核心服务会自动清理 `FILE_PATH` 目录（默认 `.npm/`），**别往里放需要长期保留的文件**

---

### 完整文件清单

| 文件 | 场景 A | 场景 B | 场景 C | 说明 |
|---|:---:|:---:|:---:|---|
| `index.js` | ✅ | ✅ | ✅ | 主程序，必需 |
| `package.json` | ✅ | ✅ | ✅ | 依赖清单，必需 |
| `package-lock.json` | ✅ | ✅ | ✅ | 版本锁定，推荐 |
| `public/index.html` | ✅ | ✅ | ✅ | 面板页面，必需 |
| `.env.sample` → `.env` | ✅ | ✅ | ✅ | 复制后按需改 |
| `status` | — | ✅ | ✅ | 监控上报模块（可选） |
| `core` | — | — | ✅ | 代理核心模块（可选） |
| `install.sh` | 可选 | 可选 | 可选 | 一键部署脚本 |

**永远不要上传**：`.env`（含密码）、`bots_config.json`（你的机器人配置）、`node_modules/`、`.npm/`

> 💡 **`bots_config.json` 在更新代码时务必保留** —— 那是你的机器人列表和设置，覆盖了就没了。

---

### 各平台上传方式

#### git clone（推荐）

```bash
git clone https://github.com/guanxi660-crypto/minebot-standalone.git
cd minebot-standalone
npm install --omit=dev
cp .env.sample .env
node index.js
```

#### Pterodactyl / 翼龙面板（只能传文件）

用面板的文件管理器或 SFTP，按上表传文件，然后执行：

```bash
cd /home/container
npm install --omit=dev
node index.js
```

> ⚠️ 翼龙面板的启动命令通常固定为 `node index.js`，且**根目录必须有 `package.json`** 才会触发自动 `npm install`。
> ⚠️ 更新代码时**只覆盖要更新的文件**，别动 `bots_config.json`。

#### 更新已有部署

只传变化的文件即可，通常是这几个：

```
index.js          # 改动了主程序
package.json      # 改了依赖
package-lock.json # 改了依赖
public/index.html # 改了面板页面
core / status     # 改了模块配置区
```

然后重启。`.env` 和 `bots_config.json` 不要动。


---

## 🛠️ 配置说明

本项目采用**「面板走 .env，模块走文件」**的配置方式：

| 配置对象 | 位置 | 说明 |
|---|---|---|
| 面板自身 | `.env`（从 `.env.sample` 复制） | 端口、登录密码、内存阈值 |
| **代理核心** | **`core` 文件的「配置区」** | 直接改等号右侧的值 |
| **监控上报** | **`status` 文件的「配置区」** | 直接改等号右侧的值 |

> 💡 **建议把 `core` 与 `status` 的变量直接写进对应文件里** —— 这两个文件都在你手里，改完重启即生效，不用维护 `.env`。`.env` 只留给面板。
>
> 两个模块文件也都支持同名环境变量覆盖，**环境变量优先**于文件内的值（方便临时改一次而不动文件）。

### 面板（.env）

复制模板后修改：

```bash
cp .env.sample .env
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` / `SERVER_PORT` | `4681` | 监听端口（`SERVER_PORT` > `PORT` 优先） |
| `ADMIN_USER` | `admin` | 面板登录用户名 |
| `ADMIN_PASSWORD` | `admin123` | 面板登录密码 ⚠️ 必改 |
| `MEMORY_MAX_PERCENT` | `90` | 内存硬阈值，超过触发优雅关闭（面板自动重启），`0` = 禁用 |
| `SERVER_MEMORY` | 自动检测 | 覆盖内存上限（MB） |
| `AUTO_FIX_DEPS` | `1` | 启动时自动补装缺失依赖 |

### 代理核心（core 文件）

打开 `core`，找到顶部**「配置区」**，改等号右侧的值：

```js
// 节点 UUID —— 建议改成自己的随机 UUID
const UUID = process.env.UUID || '0a6568ff-ea3c-4271-9020-450560e10d63';

// --- 入站端口 ( 留空 = 不启用该协议 ) ---
const HY2_PORT      = process.env.HY2_PORT      || '';      // ← 填 8443 启用 Hysteria2
const REALITY_PORT  = process.env.REALITY_PORT  || '';      // ← 填 14443 启用 Reality
// ...

// --- 反代隧道 ( ARGO_DOMAIN 与 ARGO_AUTH 都填 = 固定隧道, 否则用临时隧道 ) ---
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';         // ← 填你的域名
const ARGO_AUTH   = process.env.ARGO_AUTH   || '';         // ← 填 tunnel token
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `UUID` | `0a6568ff-...` | 节点 UUID，建议改 |
| `NAME` | 空 | 节点名称前缀（留空用 IP-ISP 自动命名） |
| `SUB_PATH` | `sub` | 订阅路径 |
| `S5_PORT` / `HY2_PORT` / `TUIC_PORT` / `ANYTLS_PORT` / `REALITY_PORT` | 空 | 各协议入站端口，**留空 = 不启用** |
| `ARGO_DOMAIN` / `ARGO_AUTH` | 空 | 都填 = 固定隧道；留空 = 临时隧道 |
| `ARGO_PORT` | `8001` | 固定隧道回源端口 |
| `DISABLE_ARGO` | `false` | `true` 禁用隧道 |
| `CFIP` / `CFPORT` | `saas.sin.fan` / `443` | 优选域名/IP 与端口 |
| `FILE_PATH` | `.npm` | 运行目录（**会被自动清理，勿放长期文件**） |
| `CHAT_ID` / `BOT_TOKEN` | 空 | Telegram 推送（两个都填才推送） |
| `UPLOAD_URL` / `PROJECT_URL` | 空 | Merge-sub 订阅上传 |
| `AUTO_ACCESS` | `false` | `true` 开启自动保活 |
| `YT_WARPOUT` | `false` | `true` 强制视频站点走 WARP |
| `SHOW_LOG` | `true` | 核心服务日志开关 |

> **端口全部留空 = 不启用代理**，只跑面板。想临时关闭整个核心服务，把 `CORE_ENABLED` 设为 `false`（或在面板右下角点停止）。
>
> **开关优先级**：`.env` 里的 `CORE_ENABLED` > `core` 文件内的值。
> 从 `.env.sample` 复制出来的默认是 `false`，所以**即使上传了 `core` 文件，不改成 `true` 也不会启动**。

### 监控上报（status 文件）

打开 `status`，找到**「配置区」**：

```js
// 监控上报总开关 ( false = 强制关闭 )
const STATUS_ENABLED = String(process.env.STATUS_ENABLED ?? 'true').toLowerCase() !== 'false';

// 哪吒 v1 面板地址, 形如 "host:port" —— 注意填 gRPC 端口, 不是网页 HTTP 端口
const NEZHA_SERVER = process.env.NEZHA_SERVER || '';      // ← 填 nz.serv00.net:8008
const NEZHA_KEY    = process.env.NEZHA_KEY    || '';      // ← 填 Client Secret
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `STATUS_ENABLED` | `true` | 监控总开关；`false` 强制关闭（无需清空密钥） |
| `NEZHA_SERVER` | 空 | 哪吒 v1 面板地址，形如 `host:port`（**gRPC 端口，不是网页 HTTP 端口**） |
| `NEZHA_KEY` | 空 | 面板客户端设置里生成的 Client Secret |
| `UUID` | 空 | Client UUID（与面板登记一致，通常和 `core` 里相同） |
| `STATUS_SHOW_LOG` | `false` | `true` 打开详细日志（排障用） |

> **开关优先级**：`.env` 里的 `STATUS_ENABLED` > `status` 文件内的值。
> 从 `.env.sample` 复制出来的默认是 `false`，所以**即使上传了 `status` 文件，不改成 `true` 也不会启动**。

#### 关于 UUID：两个模块各有一个，含义不同

| 位置 | 含义 | 出现在 |
|---|---|---|
| `core` 的 UUID | **代理节点认证凭据** | vless / vmess / hy2 / tuic / socks 节点链接里 |
| `status` 的 UUID | **哪吒客户端标识** | 哪吒面板的客户端列表 |

两者都优先读 `.env` 里的 `UUID`，所以有三种情况：

| `.env` 里的 `UUID` | 实际效果 |
|---|---|
| 填了值 | 两个模块**都**用这个值（相同） |
| 留空 | 各用文件里写的值 —— 填相同值就相同，填不同值就不同、互不干扰 |
| 留空，且 `core` 也没填 | `core` 用内置默认值，`status` 为空 → 不同 |

> 💡 **想用不同的 UUID**：保持 `.env` 里的 `UUID` 那一行**注释状态**，直接在各文件里写。
> 一旦在 `.env` 填了值，会**同时覆盖两边**，把你分别配的 UUID 冲掉。
>
> `.env.sample` 里那行 `# UUID=xxx...` 默认是注释掉的，就是为了避免这个误覆盖。

> **地址或密钥留空 = 不启用监控**，面板完全不受影响。


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
├── status                 # 监控上报模块 (无扩展名)
├── public/index.html      # Web 控制面板前端
├── package.json           # 依赖清单
├── ecosystem.config.cjs   # pm2 配置文件
├── install.sh             # 一键部署脚本
├── .env.sample            # 面板环境变量模板（复制为 .env 后修改）
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
5. ⚠️ **`core` / `status` 文件里可以直接写密钥**（UUID / Client Secret / Tunnel Token 等）。
   仓库里请只放**留空模板版**，填了真实凭据的版本**不要提交 GitHub** ——
   建议线下单独保存，线上传填好值的那份。
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
