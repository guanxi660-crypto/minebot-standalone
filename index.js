/**
 * ============================================================
 * MineBot Standalone (mineplayer-bot-node 单文件版)
 * ============================================================
 * 基于 mineflayer 的 Minecraft 挂机机器人单文件版:
 *   - 内嵌 Web 控制面板 + 登录鉴权 (admin/admin123, 可用环境变量修改)
 *   - 多机器人管理: 自动重连 / 定时重启 / 拟人巡逻 / 拟人喊话 / AI 视角
 *   - 翼龙面板 (Pterodactyl) 联动: 远程重启 / 文件同步
 *   - 内存守护: 超阈值自动清理日志 / 优雅关闭 (阈值可配)
 *   - 依赖安装需手动执行: npm install --omit=dev (见 package.json)
 * License: MIT (基于 debbide/minebot 修改)
 * ============================================================
 */
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// --- [ 轻量 .env 加载器 (无第三方依赖) ] ---
// 读取同目录 .env 文件注入 process.env, 已存在的环境变量优先(不覆盖)
(function loadDotEnv() {
    const envFile = path.join(__dirname, '.env');
    if (!fsSync.existsSync(envFile)) return;
    try {
        const lines = fsSync.readFileSync(envFile, 'utf8').split(/\x0d?\x0a/);
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            const key = line.slice(0, eq).trim();
            let value = line.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (key && process.env[key] === undefined) {
                process.env[key] = value;
            }
        }
    } catch (e) {
        console.error('[系统警告] .env 加载失败:', e.message);
    }
})();

const mineflayer = require('mineflayer');
const express = require('express');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const WebSocket = require('ws');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const activeBots = new Map();
const CONFIG_FILE = path.join(__dirname, 'bots_config.json');
const wsClients = new Set();

// --- [ WebSocket 广播 ] ---
function broadcastToClients(type, data) {
    const message = JSON.stringify({ type, data, timestamp: Date.now() });
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function broadcastBotUpdate(botId, bot) {
    broadcastToClients('bot_update', {
        id: botId,
        username: bot.username,
        host: bot.targetHost,
        port: bot.targetPort,
        status: bot.status,
        logs: bot.logs,
        settings: bot.settings,
        nextRestart: bot.settings.restartInterval > 0 ? new Date(bot.lastRestartTick + bot.settings.restartInterval * 60000).toLocaleTimeString() : '未开启'
    });
}

function broadcastSystemStatus() {
    broadcastToClients('system_status', getMemoryStatus());
}
class LRUCache {
    constructor(maxSize = 10) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return undefined;
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    clear() {
        this.cache.clear();
    }
}

const mcDataCache = new LRUCache(10);
const LOG_LIMIT = 30;              // 每个机器人保留的日志条数
const LOG_TRIM_AT_MEMORY_HIGH = 15; // 内存紧张时裁剪到的条数
const MEMORY_WATCH_INTERVAL = 30 * 1000; // 内存巡检间隔 (ms)
const RECONNECT_DELAY = 10 * 1000; // 断线重连延迟 (ms)
const BOT_ACTION_INTERVAL = 8 * 1000; // 机器人行为 tick (巡逻/喊话/AI视角)
const CONNECT_TIMEOUT = 20 * 1000; // 服务器连接超时 (ms)
const PATROL_RANDOM_THRESHOLD = 0.7; // 巡逻触发随机阈值
const CHAT_RANDOM_THRESHOLD = 0.85; // 喊话触发随机阈值
const MEMORY_HIGH_PERCENT = 80;    // 内存高水位: 触发日志裁剪
const SHUTDOWN_MEMORY_PERCENT = parseFloat(process.env.MEMORY_MAX_PERCENT) || 90; // 优雅关闭阈值 (0=禁用)
const SHUTDOWN_ON_EXCEPTION_PERCENT = 85; // 未捕获异常且内存超此值时关闭
let isShuttingDown = false;

app.use(express.json());

// --- [ 登录鉴权 ] ---
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 小时
const sessions = new Map(); // token -> 过期时间

app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
        const token = crypto.randomBytes(24).toString('hex');
        sessions.set(token, Date.now() + SESSION_TTL);
        res.json({ success: true, token, expiresIn: SESSION_TTL });
    } else {
        res.status(401).json({ success: false, error: '账号或密码错误' });
    }
});

// API 鉴权中间件: 除 /api/login 外全部要求 Bearer token
app.use('/api', (req, res, next) => {
    if (req.path === '/login') return next();
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const expiry = sessions.get(token);
    if (!expiry || expiry < Date.now()) {
        if (expiry) sessions.delete(token);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// --- [ 内存监控 - 支持 cgroup v1/v2 ] ---
let cachedMemoryLimit = null;

async function getMemoryLimit() {
    if (cachedMemoryLimit !== null) return cachedMemoryLimit;

    // 1. 环境变量
    if (process.env.SERVER_MEMORY) {
        cachedMemoryLimit = parseInt(process.env.SERVER_MEMORY) * 1024 * 1024;
        return cachedMemoryLimit;
    }

    // 2. cgroup v1
    try {
        if (fsSync.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) {
            const limit = parseInt(fsSync.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim());
            if (limit < 9223372036854771712) {
                cachedMemoryLimit = limit;
                return cachedMemoryLimit;
            }
        }
    } catch (e) {}

    // 3. cgroup v2
    try {
        if (fsSync.existsSync('/sys/fs/cgroup/memory.max')) {
            const limit = fsSync.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
            if (limit !== 'max') {
                cachedMemoryLimit = parseInt(limit);
                return cachedMemoryLimit;
            }
        }
    } catch (e) {}

    // 4. 默认系统内存
    cachedMemoryLimit = os.totalmem();
    return cachedMemoryLimit;
}

function getMemoryStatus() {
    const used = process.memoryUsage().rss;
    const total = cachedMemoryLimit || os.totalmem();
    const percent = ((used / total) * 100).toFixed(1);
    return {
        used: (used / 1024 / 1024).toFixed(1),
        total: (total / 1024 / 1024).toFixed(0),
        percent
    };
}

// 初始化内存限制
getMemoryLimit().catch(() => {});

// --- [ 优雅关闭处理 ] ---
async function gracefulShutdown(reason = '内存告急') {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n🛑 [${new Date().toLocaleTimeString()}] 开始优雅关闭: ${reason}`);

    // 1. 停止接受新连接
    if (global.server) {
        global.server.close(() => console.log('✓ 已关闭 HTTP 服务器'));
    }

    // 2. 断开所有机器人
    console.log(`📊 正在断开 ${activeBots.size} 个机器人...`);
    for (const [id, bot] of activeBots) {
        try {
            if (bot.afkTimer) clearInterval(bot.afkTimer);
            if (bot.instance) {
                bot.instance.removeAllListeners();
                bot.instance.end();
            }
            bot.pushLog('🛑 服务器关闭，机器人已断开', 'text-red-500');
        } catch (e) {}
    }

    // 3. 保存配置
    try {
        await saveBotsConfig();
        console.log('✓ 配置已保存');
    } catch (e) {
        console.error('✗ 配置保存失败:', e.message);
    }

    // 4. 清理资源
    mcDataCache.clear();
    activeBots.clear();

    console.log('✓ 优雅关闭完成，进程退出');
    process.exit(0);
}

// 内存监控和自愈
setInterval(async () => {
    const status = getMemoryStatus();
    const percent = parseFloat(status.percent);

    // 广播系统状态
    broadcastSystemStatus();

    if (percent >= MEMORY_HIGH_PERCENT) {
        mcDataCache.clear();
        activeBots.forEach(bot => {
            // 真正清理日志：创建新数组并清空引用
            const oldLogs = bot.logs;
            bot.logs = bot.logs.slice(0, LOG_TRIM_AT_MEMORY_HIGH);
            oldLogs.length = 0;

            bot.pushLog(`⚠️ 内存占用过高 (${status.percent}%)，已清理缓存`, 'text-red-500 font-black');
        });

        if (SHUTDOWN_MEMORY_PERCENT > 0 && percent > SHUTDOWN_MEMORY_PERCENT) {
                            console.error(`\n⚠️ [${new Date().toLocaleTimeString()}] 内存占用 ${status.percent}%，触发优雅关闭`);
                            await gracefulShutdown('内存占用超过阈值');
                        }
    }
}, MEMORY_WATCH_INTERVAL);

// --- [ 核心逻辑 ] ---
async function saveBotsConfig() {
    try {
        const config = Array.from(activeBots.values()).map(b => ({
            host: b.targetHost, port: b.targetPort, username: b.username, 
            settings: b.settings, logs: b.logs.slice(0, LOG_LIMIT) 
        }));
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (err) {}
}

async function createSmartBot(id, host, port, username, existingLogs = [], settings = null) {
    let finalHost = host.trim();
    let finalPort = parseInt(port) || 25565;
    if (finalHost.includes(':')) {
        const parts = finalHost.split(':');
        finalHost = parts[0]; finalPort = parseInt(parts[1]) || 25565;
    }

    const defaultSettings = { walk: false, ai: true, chat: false, restartInterval: 0, pterodactyl: { url: '', key: '', id: '', defaultDir: '/' } };
    const botMeta = { id, username, targetHost: finalHost, targetPort: finalPort, status: "连接中", logs: Array.isArray(existingLogs) ? existingLogs.slice(0, LOG_LIMIT) : [], settings: settings || defaultSettings, instance: null, afkTimer: null, isRepairing: false, lastRestartTick: Date.now(), isMoving: false };
    activeBots.set(id, botMeta);

    const pushLog = (msg, colorClass = '') => {
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        botMeta.logs.unshift({ time, msg, color: colorClass });
        if (botMeta.logs.length > LOG_LIMIT) botMeta.logs = botMeta.logs.slice(0, LOG_LIMIT);
        // 实时推送日志更新
        broadcastBotUpdate(id, botMeta);
    };
    botMeta.pushLog = pushLog;

    try {
        const bot = mineflayer.createBot({ host: finalHost, port: finalPort, username: username, auth: 'offline', hideErrors: true, physicsEnabled: settings ? settings.walk : false, connectTimeout: CONNECT_TIMEOUT });
        bot.loadPlugin(pathfinder);
        botMeta.instance = bot;

        bot.once('spawn', () => {
            botMeta.status = "在线";
            botMeta.centerPos = bot.entity.position.clone();
            pushLog(`✅ 成功进入服务器`, 'text-emerald-400 font-bold');
            broadcastBotUpdate(id, botMeta);
            
            let mcData;
            try {
                mcData = mcDataCache.get(bot.version) || require('minecraft-data')(bot.version);
                if (mcData) mcDataCache.set(bot.version, mcData);
            } catch (e) { pushLog(`❌ 协议不支持`, 'text-red-500'); return bot.end(); }
            
            const movements = new Movements(bot, mcData);
            movements.canDig = false;
            bot.pathfinder.setMovements(movements);

            if (botMeta.afkTimer) clearInterval(botMeta.afkTimer);
            botMeta.afkTimer = setInterval(() => {
                if (!bot.entity) return;
                // 重启逻辑
                if (botMeta.settings.restartInterval > 0 && (Date.now() - botMeta.lastRestartTick) / 60000 >= botMeta.settings.restartInterval) {
                    bot.chat('/restart'); botMeta.lastRestartTick = Date.now(); pushLog(`⏰ 周期任务: 执行 /restart`, 'text-red-500 font-bold');
                }
                // AI视角
                if (botMeta.settings.ai && !botMeta.isMoving) {
                    const target = bot.nearestEntity(p => p.type === 'player');
                    if (target) bot.lookAt(target.position.offset(0, 1.6, 0));
                }
                // 巡逻
                if (botMeta.settings.walk && !botMeta.isMoving && Math.random() > PATROL_RANDOM_THRESHOLD) {
                    botMeta.isMoving = true;
                    const targetPos = botMeta.centerPos.offset((Math.random()-0.5)*12, 0, (Math.random()-0.5)*12);
                    pushLog(`👣 巡逻: 前往点 [${Math.round(targetPos.x)}, ${Math.round(targetPos.z)}]`, 'text-emerald-500');
                    bot.pathfinder.setGoal(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 1));
                }
                // 喊话
                if (botMeta.settings.chat && Math.random() > CHAT_RANDOM_THRESHOLD) {
                    const words = ["有人吗", "2333", "啧", "掛机中"];
                    const m = words[Math.floor(Math.random() * words.length)];
                    bot.chat(m); pushLog(`💬 拟人发话: ${m}`, 'text-orange-400');
                }
            }, BOT_ACTION_INTERVAL);
        });

        bot.on('goal_reached', () => { botMeta.isMoving = false; if(botMeta.settings.walk) pushLog(`📍 巡逻到达目标点`, 'text-slate-400'); });
        bot.once('end', () => attemptRepair(id, botMeta, "断开"));
        bot.on('error', (e) => attemptRepair(id, botMeta, e.code || "ERR"));
    } catch (err) { attemptRepair(id, botMeta, "失败"); }
}

function attemptRepair(id, botMeta, reason) {
    if (!activeBots.has(id) || botMeta.isRepairing) return;
    botMeta.isRepairing = true; botMeta.status = "重连中";
    if (botMeta.instance) { botMeta.instance.removeAllListeners(); try { botMeta.instance.end(); } catch(e) {} botMeta.instance = null; }
    if (botMeta.afkTimer) clearInterval(botMeta.afkTimer);
    setTimeout(() => { if (!activeBots.has(id)) return; botMeta.isRepairing = false; createSmartBot(id, botMeta.targetHost, botMeta.targetPort, botMeta.username, botMeta.logs, botMeta.settings); }, RECONNECT_DELAY);
}

// --- [ API 验证和错误处理 ] ---
const validateBot = (id) => {
    const bot = activeBots.get(id);
    if (!bot) throw { status: 404, message: '机器人不存在' };
    return bot;
};

const validateString = (value, fieldName, minLen = 1, maxLen = 255) => {
    if (typeof value !== 'string' || value.trim().length < minLen || value.length > maxLen) {
        throw { status: 400, message: `${fieldName} 无效 (长度: ${minLen}-${maxLen})` };
    }
    return value.trim();
};

const validateNumber = (value, fieldName, min = 0, max = 65535) => {
    const num = parseFloat(value);
    if (isNaN(num) || num < min || num > max) {
        throw { status: 400, message: `${fieldName} 无效 (范围: ${min}-${max})` };
    }
    return num;
};

const validateHost = (host) => {
    const trimmed = validateString(host, '服务器地址', 1, 255);
    const ipRegex = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
    if (!ipRegex.test(trimmed.split(':')[0])) {
        throw { status: 400, message: '服务器地址格式无效' };
    }
    return trimmed;
};

const apiErrorHandler = (handler) => async (req, res) => {
    try {
        await handler(req, res);
    } catch (err) {
        const status = err.status || 500;
        const message = err.message || '服务器错误';
        console.error(`[API 错误] ${status}: ${message}`);
        res.status(status).json({ success: false, error: message });
    }
};

// --- [ API 端点 ] ---
app.get("/api/system/status", (req, res) => {
    try {
        res.json(getMemoryStatus());
    } catch (err) {
        res.status(500).json({ success: false, error: '获取系统状态失败' });
    }
});

app.get("/api/bots", (req, res) => {
    try {
        const bots = Array.from(activeBots.values()).map(b => ({
            id: b.id,
            username: b.username,
            host: b.targetHost,
            port: b.targetPort,
            status: b.status,
            logs: b.logs,
            settings: b.settings,
            nextRestart: b.settings.restartInterval > 0 ? new Date(b.lastRestartTick + b.settings.restartInterval * 60000).toLocaleTimeString() : '未开启'
        }));
        res.json({ success: true, bots });
    } catch (err) {
        res.status(500).json({ success: false, error: '获取机器人列表失败' });
    }
});

app.post("/api/bots", apiErrorHandler(async (req, res) => {
    const host = validateHost(req.body.host);
    const username = validateString(req.body.username, '用户名', 1, 16);

    createSmartBot('bot_' + Math.random().toString(36).substr(2, 7), host, 25565, username);
    res.json({ success: true, message: '机器人已创建' });
}));

app.post("/api/bots/:id/toggle", apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);
    const type = req.body.type;

    if (!['ai', 'walk', 'chat'].includes(type)) {
        throw { status: 400, message: '无效的切换类型' };
    }

    bot.settings[type] = !bot.settings[type];

    const labelMap = { ai: "AI视角", walk: "拟人巡逻", chat: "拟人喊话" };
    const label = labelMap[type];
    const statusText = bot.settings[type] ? "[开启]" : "[关闭]";

    bot.pushLog(`🔘 切换: ${label} -> ${statusText}`, 'text-yellow-400 font-bold');

    if (type === 'walk' && bot.instance) {
        bot.instance.physicsEnabled = bot.settings.walk;
        if (bot.settings.walk) {
            bot.pushLog(`⚙️ 物理引擎: 已激活 (巡逻模式)`, 'text-yellow-600 font-bold');
        } else {
            bot.instance.pathfinder.setGoal(null);
            bot.isMoving = false;
            bot.pushLog(`⚙️ 物理引擎: 已休眠 (强制静止)`, 'text-slate-500 font-bold');
        }
    }

    await saveBotsConfig();
    broadcastBotUpdate(req.params.id, bot);
    res.json({ success: true, message: '已切换' });
}));

app.post("/api/bots/:id/restart-now", apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);

    if (!bot.instance) {
        throw { status: 400, message: '机器人未连接' };
    }

    bot.instance.chat('/restart');
    bot.lastRestartTick = Date.now();
    bot.pushLog(`⚡ 立即重启: 已发送 /restart`, 'text-red-400 font-bold');
    broadcastBotUpdate(req.params.id, bot);
    res.json({ success: true, message: '重启命令已发送' });
}));

app.post("/api/bots/:id/reconnect", apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);

    // 强制断开当前连接, 立即重连 (不走自动重连的延迟)
    bot.isRepairing = false; // 允许立即重连
    if (bot.instance) {
        bot.instance.removeAllListeners();
        try { bot.instance.end(); } catch (e) {}
        bot.instance = null;
    }
    if (bot.afkTimer) clearInterval(bot.afkTimer);

    bot.status = "重连中";
    bot.pushLog(`🔁 手动重连: 正在重新连接...`, 'text-blue-400 font-bold');
    broadcastBotUpdate(req.params.id, bot);

    // 立即重建连接
    setTimeout(() => {
        if (!activeBots.has(req.params.id)) return;
        bot.isRepairing = false;
        createSmartBot(req.params.id, bot.targetHost, bot.targetPort, bot.username, bot.logs, bot.settings);
    }, 1000);

    res.json({ success: true, message: '正在重连' });
}));

app.post("/api/bots/:id/set-timer", apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);
    const value = validateNumber(req.body.value, '时间值', 0, 10080);
    const unit = req.body.unit;

    if (!['min', 'hour'].includes(unit)) {
        throw { status: 400, message: '无效的时间单位' };
    }

    bot.settings.restartInterval = unit === 'hour' ? Math.round(value * 60) : Math.round(value);
    bot.lastRestartTick = Date.now();
    bot.pushLog(`⏰ 设定: 每 ${value}${unit === 'hour' ? '小时' : '分钟'} 重启一次`, 'text-cyan-400 font-bold');

    await saveBotsConfig();
    broadcastBotUpdate(req.params.id, bot);
    res.json({ success: true, message: '定时器已设置' });
}));

app.post("/api/bots/:id/pto-config", apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);

    const url = (req.body.url || "").trim().replace(/\/$/, "");
    const key = (req.body.key || "").trim();
    const id = (req.body.id || "").trim();
    const defaultDir = (req.body.defaultDir || "/").trim();

    if (url && !url.startsWith('http')) {
        throw { status: 400, message: '翼龙面板 URL 必须以 http 开头' };
    }

    bot.settings.pterodactyl = { url, key, id, defaultDir };
    bot.pushLog(`🔑 翼龙配置: 凭据已保存`, 'text-blue-300');

    await saveBotsConfig();
    broadcastBotUpdate(req.params.id, bot);
    res.json({ success: true, message: '配置已保存' });
}));

app.delete("/api/bots/:id", apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);

    if (bot.afkTimer) clearInterval(bot.afkTimer);
    if (bot.instance) bot.instance.end();
    activeBots.delete(req.params.id);

    await saveBotsConfig();
    broadcastToClients('bot_deleted', { id: req.params.id });
    res.json({ success: true, message: '机器人已移除' });
}));

// --- [ 前端 UI ] ---
// 页面从 public/index.html 读取 (部署时必须保持 public/ 目录结构与 index.js 同级)
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
if (!fsSync.existsSync(INDEX_HTML)) {
    console.error('============================================================');
    console.error('❌ 缺少前端页面文件: public/index.html');
    console.error('   请把 public/index.html 与 index.js 保持同级目录上传:');
    console.error('     index.js');
    console.error('     package.json');
    console.error('     public/index.html   ← 必须在 public 文件夹内');
    console.error('   程序继续启动, 但首页将无法打开 (API 正常可用)');
    console.error('============================================================');
}
app.get('/', (req, res) => {
    if (!fsSync.existsSync(INDEX_HTML)) {
        return res.status(500).send(
            '<h2>缺少 public/index.html</h2>' +
            '<p>请把 <code>public/index.html</code> 与 <code>index.js</code> 同级上传后重启进程。</p>' +
            '<p>详见 README「纯上传部署」章节。</p>'
        );
    }
    res.sendFile(INDEX_HTML);
});

// --- [ 启动 ] ---
// 端口优先级: SERVER_PORT > PORT > 默认 4681
const PORT = process.env.SERVER_PORT || process.env.PORT || 4681;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`=========================================`);
    console.log(`mineplayer-bot-node 已启动 (优雅关闭版)`);
    console.log(`端口: ${PORT} | 内存管理已激活`);
    console.log(`=========================================`);
    if (fsSync.existsSync(CONFIG_FILE)) {
        try {
            const saved = JSON.parse(fsSync.readFileSync(CONFIG_FILE));
            saved.forEach(b => createSmartBot('bot_'+Math.random().toString(36).substr(2,5), b.host, b.port, b.username, b.logs || [], b.settings));
        } catch (e) {}
    }
});

// WebSocket 服务器初始化
const wss = new WebSocket.Server({ noServer: true });

// WebSocket 认证
server.on('upgrade', (request, socket, head) => {
    try {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const token = url.searchParams.get('token');

        // 简单的 token 验证（这里可以根据实际需求改进）
        // 目前允许任何非空 token，实际应该验证 JWT 或其他认证机制
        if (!token || !sessions.has(token)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } catch (error) {
        console.error('[WebSocket 认证错误]', error.message);
        socket.destroy();
    }
});

wss.on('connection', (ws) => {
    wsClients.add(ws);
    console.log(`[WebSocket] 新连接，当前连接数: ${wsClients.size}`);

    // 发送初始数据
    try {
        // 发送所有机器人状态
        activeBots.forEach((bot, id) => {
            ws.send(JSON.stringify({
                type: 'bot_update',
                data: {
                    id,
                    username: bot.username,
                    host: bot.targetHost,
                    port: bot.targetPort,
                    status: bot.status,
                    logs: bot.logs,
                    settings: bot.settings,
                    nextRestart: bot.settings.restartInterval > 0 ? new Date(bot.lastRestartTick + bot.settings.restartInterval * 60000).toLocaleTimeString() : '未开启'
                },
                timestamp: Date.now()
            }));
        });

        // 发送系统状态
        ws.send(JSON.stringify({
            type: 'system_status',
            data: getMemoryStatus(),
            timestamp: Date.now()
        }));
    } catch (error) {
        console.error('[WebSocket] 发送初始数据失败:', error.message);
    }

    ws.on('close', () => {
        wsClients.delete(ws);
        console.log(`[WebSocket] 连接关闭，当前连接数: ${wsClients.size}`);
    });

    ws.on('error', (err) => {
        console.error('[WebSocket 错误]', err.message);
        wsClients.delete(ws);
    });
});

// 保存全局 server 引用用于优雅关闭
global.server = server;

// 处理进程信号
process.on('SIGTERM', () => gracefulShutdown('收到 SIGTERM 信号'));
process.on('SIGINT', () => gracefulShutdown('收到 SIGINT 信号'));

// 改进的异常处理
process.on('uncaughtException', (err) => {
    console.error('❌ [未捕获异常]', err.message);
    if (parseFloat(getMemoryStatus().percent) > SHUTDOWN_ON_EXCEPTION_PERCENT) {
        gracefulShutdown('异常触发 + 内存告急');
    }
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ [未处理的 Promise 拒绝]', reason);
});