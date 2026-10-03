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

// --- [ 可选模块加载 ] ---
// core / status 都是可选模块: 缺失时降级为空实现, 保证面板本身仍能正常启动
// syncMethods: 同步方法( 返回值直接用, 不能返回 Promise )
// asyncMethods: 异步方法( 调用方会链式 .then/.catch, stub 需返回 Promise )
function loadOptionalModule(name, syncMethods = [], asyncMethods = []) {
    const makeStub = () => {
        const stub = {};
        for (const m of syncMethods) stub[m] = () => false;
        for (const m of asyncMethods) stub[m] = () => Promise.resolve(false);
        return stub;
    };

    const file = path.join(__dirname, name);
    if (!fsSync.existsSync(file)) {
        console.warn(`⚠️ 未找到可选模块 ${name}, 相关功能已禁用 (面板不受影响)`);
        return makeStub();
    }
    try {
        return require('./' + name);
    } catch (err) {
        console.warn(`⚠️ 模块 ${name} 加载失败, 相关功能已禁用: ${err.message}`);
        return makeStub();
    }
}

// 代理核心模块( 无扩展名文件 )
// 同步: coreStatus / isSbxRunning / isCoreEnabled / getSubBase64
// 异步: startSbx / stopSbx / resetCore
const coreModule = loadOptionalModule('core',
    ['coreStatus', 'isSbxRunning', 'isCoreEnabled', 'getSubBase64'],
    ['startSbx', 'stopSbx', 'resetCore']);

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
        note: bot.note,
        host: bot.targetHost,
        port: bot.targetPort,
        status: bot.status,
        logs: bot.logs,
        settings: bot.settings,
        playerCount: bot.playerCount,
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
// --- [ 自动找矿 ] ---
const ORE_BLOCKS = [           // 目标矿脉 (按价值从低到高, 优先挖低价值的以免浪费工具)
    'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore',
    'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore',
    'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore',
    'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore'
];
const ORE_SCAN_INTERVAL = 3 * 1000;   // 扫描间隔 (ms)
const ORE_SCAN_RADIUS = 4;            // 扫描半径 (方块), 太小够不到矿, 太大路径finding开销高
const ORE_MAX_TARGET_DISTANCE = 24;   // 单个矿脉的最远 pursue 距离
const ORE_STUCK_TIMEOUT = 15 * 1000;  // 单个矿脉挖掘超时, 超时放弃换下一个
const CHAT_RANDOM_THRESHOLD = 0.92; // 喊话触发随机阈值 (越高越不常触发)
const CHAT_COOLDOWN_MS = 90 * 1000; // 喊话冷却时间 (90秒内不重复发言)
const MEMORY_HIGH_PERCENT = 80;    // 内存高水位: 触发主动回收
const SHUTDOWN_MEMORY_PERCENT = parseFloat(process.env.MEMORY_MAX_PERCENT) || 90; // 优雅关闭阈值 (0=禁用)
const SHUTDOWN_ON_EXCEPTION_PERCENT = 85; // 未捕获异常且内存超此值时关闭
// --- [ 内存自愈新增配置 ] ---
const RECLAIM_TRIM_PERCENT = 88;   // 高于此水位: 裁剪日志 + 强制 GC 提示
const RECLAIM_RESTART_PERCENT = 93; // 高于此水位: 主动重连最占内存的 bot (真正释放堆)
const RECLAIM_COOLDOWN = 5 * 60 * 1000; // 自愈动作冷却 (ms), 防止反复重连抖动
const GC_HINT_INTERVAL = 60 * 1000; // 主动 GC 提示间隔 (ms)
let lastReclaimTick = 0;           // 上次自愈时间戳
let isShuttingDown = false;

// --- [ 拟人喊话生成器 ] ---
// 按场景选词库 + RP括号动作 + 随机emoji/大小写变体, 让 bot 发言更像真人
const CHAT_ACTIONS = ['(yawns)', '(stretches)', '(looks around)', '(nods)', '(waves)', '(sighs)', '(shrugs)', '(checks the time)', '(leans back)', '(taps fingers)'];
const CHAT_SOCIAL = [
    'anyone here?', 'yo', 'sup everyone', 'hey guys', 'hello?', 'gl all',
    'nice server', 'gg', 'lol', 'wow this place is cool', 'been playing long?',
    'anyone up for a build trade?', 'pretty chill here', 'good vibes today'
];
const CHAT_SOLO = [
    'quiet today...', 'zzz...', 'just vibing', 'nice spot', 'this base is cool',
    'should i build something here...', 'alright, time to grind', 'peaceful',
    'sun looks nice in here', 'gonna afk for a bit', 'such a chill place to hang'
];
const CHAT_EMOJI = [' :)', ' :D', ' ;)', ' ^^', ' o/', ' <3', ' :p', ' :3', ' \\(^-^)/', ''];
const CHAT_PUNCT = ['', '', '!', '...', '~'];

function generateChatMessage(playerCount) {
    // 服务器还有其他玩家(排除自己) -> 社交型, 否则自言自语
    const pool = playerCount > 1 ? CHAT_SOCIAL : CHAT_SOLO;
    let msg = pool[Math.floor(Math.random() * pool.length)];

    // 40% 概率加 RP 括号动作 (前置)
    if (Math.random() < 0.4) {
        msg = CHAT_ACTIONS[Math.floor(Math.random() * CHAT_ACTIONS.length)] + ' ' + msg;
    }
    // 30% 概率加 emoji (后置)
    if (Math.random() < 0.3) {
        msg += CHAT_EMOJI[Math.floor(Math.random() * CHAT_EMOJI.length)];
    }
    // 20% 概率改标点
    if (Math.random() < 0.2 && !msg.endsWith(')')) {
        msg = msg.replace(/[.!?~]+$/, '') + CHAT_PUNCT[Math.floor(Math.random() * CHAT_PUNCT.length)];
    }
    // 15% 概率整句小写 (更随意)
    if (Math.random() < 0.15) {
        msg = msg.toLowerCase();
    }
    return msg;
}

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
    const usage = process.memoryUsage();
    const used = usage.rss;
    const total = cachedMemoryLimit || os.totalmem();
    const percent = ((used / total) * 100).toFixed(1);
    // heapUsed 才是"真正被 JS 对象占用的内存"; rss 高但 heapUsed 平稳 => V8 缓存未归还 OS, 非泄漏
    const heapUsed = (usage.heapUsed / 1024 / 1024).toFixed(1);
    const heapTotal = (usage.heapTotal / 1024 / 1024).toFixed(1);
    const heapPercent = ((usage.heapUsed / usage.heapTotal) * 100).toFixed(1);
    return {
        used: (used / 1024 / 1024).toFixed(1),
        total: (total / 1024 / 1024).toFixed(0),
        percent,
        heapUsed,
        heapTotal,
        heapPercent,
        external: (usage.external / 1024 / 1024).toFixed(1)
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
            destroyBotInstance(bot);
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

    // 5. 停止原生代理服务
    try { await coreModule.stopSbx(); } catch (e) {}

    console.log('✓ 优雅关闭完成，进程退出');
    process.exit(0);
}

// 内存监控和自愈
// 三级策略:
//   1. >= MEMORY_HIGH_PERCENT(80%) : 清 LRU + 裁剪日志
//   2. >= RECLAIM_TRIM_PERCENT(88%) : 追加 global.gc() 提示, 让 V8 归还堆给 OS
//   3. >= RECLAIM_RESTART_PERCENT(93%): 主动重连最占内存的 bot (pathfinder/区块缓存只有重连才真正释放)
setInterval(async () => {
    const status = getMemoryStatus();
    const percent = parseFloat(status.percent);

    // 广播系统状态 (含 heapUsed 等诊断字段)
    broadcastSystemStatus();

    if (percent < MEMORY_HIGH_PERCENT) return;

    // --- 第 1 级: 轻量回收 ---
    mcDataCache.clear();
    activeBots.forEach(bot => {
        const oldLogs = bot.logs;
        bot.logs = bot.logs.slice(0, LOG_TRIM_AT_MEMORY_HIGH);
        oldLogs.length = 0;
        bot.pushLog(`⚠️ 内存占用过高 (${status.percent}%)，已清理缓存`, 'text-red-500 font-black');
    });
    console.error(`\n⚠️ [${new Date().toLocaleTimeString()}] 内存占用 ${status.percent}% (堆 ${status.heapUsed}/${status.heapTotal} MB)，已清理缓存`);

    // --- 第 2 级: 主动 GC (仅在暴露 --expose-gc 时可用) ---
    if (percent >= RECLAIM_TRIM_PERCENT && typeof global.gc === 'function') {
        try {
            global.gc();
            console.error(`🧹 [${new Date().toLocaleTimeString()}] 已主动触发 GC, 堆回落后可释放部分 RSS`);
        } catch (e) { /* ignore */ }
    }

    // --- 第 3 级: 主动重连释放堆 (真正的泄漏修复) ---
    if (percent >= RECLAIM_RESTART_PERCENT && Date.now() - lastReclaimTick > RECLAIM_COOLDOWN) {
        lastReclaimTick = Date.now();
        console.error(`🔄 [${new Date().toLocaleTimeString()}] 内存超 ${RECLAIM_RESTART_PERCENT}%，主动重连全部 bot 释放堆`);
        const ids = Array.from(activeBots.keys());
        for (const id of ids) {
            const b = activeBots.get(id);
            if (!b) continue;
            try {
                b.pushLog(`🔄 内存自愈: 主动重连以释放内存`, 'text-orange-400 font-bold');
                attemptRepair(id, b, '内存自愈');
            } catch (e) { /* ignore */ }
        }
    }

    // --- 兜底: 超硬阈值仍关闭 (由翼龙面板自动重启拉起) ---
    if (SHUTDOWN_MEMORY_PERCENT > 0 && percent > SHUTDOWN_MEMORY_PERCENT) {
        console.error(`\n🛑 [${new Date().toLocaleTimeString()}] 内存占用 ${status.percent}%，超过硬阈值 ${SHUTDOWN_MEMORY_PERCENT}%，触发优雅关闭(面板将自动重启)`);
        await gracefulShutdown('内存占用超过硬阈值');
    }
}, MEMORY_WATCH_INTERVAL);

// --- [ 核心逻辑 ] ---
async function saveBotsConfig() {
    try {
        const config = Array.from(activeBots.values()).map(b => ({
            host: b.targetHost, port: b.targetPort, username: b.username,
            settings: { ...b.settings, note: b.note }, logs: b.logs.slice(0, LOG_LIMIT) 
        }));
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (err) {}
}

// --- [ 自动找矿 ] ---
// 在 bot 周围扫描已加载区块内的矿脉, 用 GoalBreakBlock 逐个挖掉
// 说明: mineflayer 只能拿到已加载区块的数据, 未加载区域扫不到 —— 所以机器人得先站在那里等区块加载

/** 扫描 bot 周围已加载区块, 找出最近的矿脉坐标; 没有则返回 null */
function findNearestOre(bot) {
    if (!bot.entity) return null;
    const origin = bot.entity.position.floored();
    let best = null;
    let bestDist = Infinity;

    for (let dx = -ORE_SCAN_RADIUS; dx <= ORE_SCAN_RADIUS; dx++) {
        for (let dy = -ORE_SCAN_RADIUS; dy <= ORE_SCAN_RADIUS; dy++) {
            for (let dz = -ORE_SCAN_RADIUS; dz <= ORE_SCAN_RADIUS; dz++) {
                const pos = origin.offset(dx, dy, dz);
                // blockAt 对未加载区块返回 null, 自动跳过
                const block = bot.blockAt(pos);
                if (!block || !ORE_BLOCKS.includes(block.name)) continue;
                const dist = pos.distanceTo(origin);
                if (dist < bestDist) { bestDist = dist; best = pos; }
            }
        }
    }
    return best ? { pos: best, name: bot.blockAt(best).name, dist: bestDist } : null;
}

/**
 * 执行一次找矿动作: 找一个矿脉并下 GoalBreakBlock
 * 返回 'mining' | 'idle' | 'unreachable' | 'stuck'
 */
function tryMineOnce(bot, botMeta) {
    const found = findNearestOre(bot);
    if (!found) return 'idle';

    // 距离太远就换下一个 (pathfinder 挖不过去)
    if (found.dist > ORE_MAX_TARGET_DISTANCE) return 'unreachable';

    // 已在挖就保持当前目标, 不重复下 goal
    if (botMeta.oreTarget) {
        if (Date.now() - botMeta.oreTargetAt > ORE_STUCK_TIMEOUT) {
            // 超时: 放弃这个目标 (可能够不到/被卡住), 清掉换下一个
            botMeta.oreTarget = null;
            botMeta.pushLog(`⏱️ 挖掘超时, 放弃目标`, 'text-yellow-600');
            return 'stuck';
        }
        return 'mining';
    }

    try {
        bot.pathfinder.setGoal(new goals.GoalBreakBlock(found.pos));
        botMeta.oreTarget = found.pos;
        botMeta.oreTargetAt = Date.now();
        botMeta.isMoving = true;
        botMeta.pushLog(`⛏️ 发现 ${found.name} (距离 ${found.dist.toFixed(1)}), 开始挖掘`, 'text-amber-400 font-bold');
    } catch (e) {
        botMeta.oreTarget = null;
        return 'stuck';
    }
    return 'mining';
}

/** 停止当前挖掘目标 (关闭开关/被删除/关服时调用) */
function stopMining(botMeta) {
    if (botMeta.oreTimer) { clearInterval(botMeta.oreTimer); botMeta.oreTimer = null; }
    botMeta.oreTarget = null;
    const inst = botMeta.instance;
    if (inst && inst.pathfinder) {
        try { inst.pathfinder.setGoal(null); } catch (e) {}
    }
    botMeta.isMoving = false;
}

async function createSmartBot(id, host, port, username, existingLogs = [], settings = null) {
    let finalHost = host.trim();
    let finalPort = parseInt(port) || 25565;
    if (finalHost.includes(':')) {
        const parts = finalHost.split(':');
        finalHost = parts[0]; finalPort = parseInt(parts[1]) || 25565;
    }

    const defaultSettings = { walk: false, ai: true, chat: false, mine: false, restartInterval: 0, pterodactyl: { url: '', key: '', id: '', defaultDir: '/' } };
    const note = (settings && settings.note) || username;
    const botMeta = { id, username, targetHost: finalHost, targetPort: finalPort, note, status: "连接中", logs: Array.isArray(existingLogs) ? existingLogs.slice(0, LOG_LIMIT) : [], settings: settings || defaultSettings, instance: null, afkTimer: null, oreTimer: null, oreTarget: null, oreTargetAt: 0, isRepairing: false, isReconnecting: false, lastRestartTick: Date.now(), isMoving: false, playerCount: 0, lastChatTick: 0 };
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
            botMeta.playerCount = Object.keys(bot.players).length || 0;
            pushLog(`✅ 成功进入服务器`, 'text-emerald-400 font-bold');
            broadcastBotUpdate(id, botMeta);
            
            let mcData;
            try {
                mcData = mcDataCache.get(bot.version) || require('minecraft-data')(bot.version);
                if (mcData) mcDataCache.set(bot.version, mcData);
            } catch (e) { pushLog(`❌ 协议不支持`, 'text-red-500'); return bot.end(); }
            
            const movements = new Movements(bot, mcData);
            // canDig 必须为 true, 否则 pathfinder 无法挖开挡路方块 (挖矿功能依赖它)
            movements.canDig = true;
            bot.pathfinder.setMovements(movements);

            if (botMeta.afkTimer) clearInterval(botMeta.afkTimer);
            botMeta.afkTimer = setInterval(() => {
                if (!bot.entity) return;
                // 刷新同服务器玩家数量 (含 bot 自身)
                const pc = Object.keys(bot.players).length || 0;
                if (pc !== botMeta.playerCount) {
                    botMeta.playerCount = pc;
                    broadcastBotUpdate(id, botMeta);
                }
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
                // 喊话 (冷却90秒 + 随机触发 + 拟人化内容)
                if (botMeta.settings.chat && (Date.now() - botMeta.lastChatTick) >= CHAT_COOLDOWN_MS && Math.random() > CHAT_RANDOM_THRESHOLD) {
                    const m = generateChatMessage(Object.keys(bot.players).length || 0);
                    botMeta.lastChatTick = Date.now();
                    bot.chat(m); pushLog(`💬 拟人发话: ${m}`, 'text-orange-400');
                }
            }, BOT_ACTION_INTERVAL);

            // --- [ 自动找矿定时器 ] ---
            // 独立于巡逻: 挖矿有自己的目标/超时状态, 关闭巡逻也能挖
            if (botMeta.settings.mine) {
                if (botMeta.oreTimer) clearInterval(botMeta.oreTimer);
                botMeta.oreTimer = setInterval(() => {
                    if (!bot.entity || !botMeta.instance) return;
                    const r = tryMineOnce(bot, botMeta);
                    // idle/unreachable 时清掉目标, 下轮重新扫描
                    if (r === 'idle' || r === 'unreachable' || r === 'stuck') botMeta.oreTarget = null;
                }, ORE_SCAN_INTERVAL);
                pushLog(`⛏️ 自动找矿已开启 (半径 ${ORE_SCAN_RADIUS} 格)`, 'text-amber-500 font-bold');
            }
        });

        bot.on('goal_reached', () => {
            botMeta.isMoving = false;
            if (botMeta.settings.mine && botMeta.oreTarget) {
                // 挖到了: 清目标, 下一轮继续找下一个
                botMeta.oreTarget = null;
                pushLog(`✅ 矿脉已挖除`, 'text-emerald-400');
            }
            if (botMeta.settings.walk) pushLog(`📍 巡逻到达目标点`, 'text-slate-400');
        });
        bot.once('end', () => attemptRepair(id, botMeta, "断开"));
        bot.on('error', (e) => attemptRepair(id, botMeta, e.code || "ERR"));
    } catch (err) { attemptRepair(id, botMeta, "失败"); }
}

// 彻底销毁一个 bot 实例, 断开所有引用让 GC 能回收
// mineflayer 的 pathfinder / chunk 数据在 end() 后仍有异步任务, 必须等一拍再真正丢弃
function destroyBotInstance(botMeta) {
    const inst = botMeta.instance;
    botMeta.instance = null;
    if (botMeta.afkTimer) { clearInterval(botMeta.afkTimer); botMeta.afkTimer = null; }
    if (botMeta.oreTimer) { clearInterval(botMeta.oreTimer); botMeta.oreTimer = null; }
    botMeta.oreTarget = null;
    if (!inst) return;
    try {
        // pathfinder 内部有 interval/异步寻路任务, 必须先 stop 再摘引用
        if (inst.pathfinder) {
            try { inst.pathfinder.setMovements && inst.pathfinder.setGoal(null); } catch (e) { /* ignore */ }
            try { inst.pathfinder.stop && inst.pathfinder.stop(); } catch (e) { /* ignore */ }
        }
        inst.removeAllListeners();
        // ⚠️ 不要在此把 inst._client 置 null —— end() 内部还要用它 write()/end(),
        //    提前置空会抛 "Cannot read properties of null (reading 'write')"。
        //    内存回收交给 V8: 断开 listeners + end() 后 socket 引用自然释放。
        inst.end();
    } catch (e) { /* ignore */ }
}

function attemptRepair(id, botMeta, reason) {
    if (!activeBots.has(id) || botMeta.isRepairing) return;
    // 手动重连进行中时不插队: end() 会触发本函数, 不挡住就会排一个 10 秒延迟重连,
    // 与手动重连的 1 秒重建撞车 —— 手点一次实际重连两次
    if (botMeta.isReconnecting) return;
    botMeta.isRepairing = true; botMeta.status = "重连中";
    destroyBotInstance(botMeta);
    setTimeout(() => {
        if (!activeBots.has(id)) return;
        botMeta.isRepairing = false;
        createSmartBot(id, botMeta.targetHost, botMeta.targetPort, botMeta.username, botMeta.logs, botMeta.settings);
    }, RECONNECT_DELAY);
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
        note: b.note,
            host: b.targetHost,
            port: b.targetPort,
            status: b.status,
            logs: b.logs,
            settings: b.settings,
            playerCount: b.playerCount,
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

    if (!['ai', 'walk', 'chat', 'mine'].includes(type)) {
        throw { status: 400, message: '无效的切换类型' };
    }

    bot.settings[type] = !bot.settings[type];

    const labelMap = { ai: "AI视角", walk: "拟人巡逻", chat: "拟人喊话", mine: "自动找矿" };
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

    // 挖矿开关: 开启时启动扫描定时器, 关闭时立即清掉并清理当前目标
    // 注意: bot 是 botMeta(元数据), 真实实例是 bot.instance —— entity 等字段都在实例上
    if (type === 'mine') {
        const inst = bot.instance;
        if (bot.settings.mine) {
            if (!inst || !inst.entity) {
                bot.pushLog(`⚠️ 未连接到服务器, 无法开启挖矿`, 'text-red-400');
            } else {
                if (bot.oreTimer) clearInterval(bot.oreTimer);
                bot.oreTimer = setInterval(() => {
                    // 实例可能已因断线被换掉, 每轮重新取
                    const cur = bot.instance;
                    if (!cur || !cur.entity) return;
                    const r = tryMineOnce(cur, bot);
                    if (r === 'idle' || r === 'unreachable' || r === 'stuck') bot.oreTarget = null;
                }, ORE_SCAN_INTERVAL);
                bot.pushLog(`⛏️ 自动找矿已开启 (半径 ${ORE_SCAN_RADIUS} 格)`, 'text-amber-500 font-bold');
            }
        } else {
            stopMining(bot);
            bot.pushLog(`⏹️ 自动找矿已停止`, 'text-slate-500 font-bold');
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

    // 置手动重连标志, 阻止 attemptRepair 的 10 秒延迟重连插队 (防双重重连)
    bot.isReconnecting = true;
    // 强制断开当前连接, 立即重连 (不走自动重连的延迟)
    bot.isRepairing = false; // 允许立即重连
    destroyBotInstance(bot);

    bot.status = "重连中";
    bot.pushLog(`🔁 手动重连: 正在重新连接...`, 'text-blue-400 font-bold');
    broadcastBotUpdate(req.params.id, bot);

    // 立即重建连接
    setTimeout(() => {
        if (!activeBots.has(req.params.id)) return;
        bot.isReconnecting = false;
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

// --- [ 自定义备注 ] ---
// 保存 bot 显示名称/备注 (默认取游戏ID, 可自定义)
app.post("/api/bots/:id/note", apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);
    const note = (req.body.note || "").trim().slice(0, 30);
    bot.note = note || bot.username;
    // 关键: 同步写入 settings.note, 重连/重启后 createSmartBot
    // 才能从 settings.note 恢复自定义名称 (否则退回 username)
    bot.settings.note = note || bot.username;
    bot.pushLog(`🏷️ 备注更新: ${bot.note}`, 'text-purple-300');
    await saveBotsConfig();
    broadcastBotUpdate(req.params.id, bot);
    res.json({ success: true, note: bot.note });
}));

// --- [ 翼龙面板 API 工具函数 ] ---
// 校验并返回翼龙面板请求配置
function getPtero(bot) {
    const p = bot.settings.pterodactyl || { url: '', key: '', id: '' };
    if (!p.url || !p.key || !p.id) {
        const err = new Error('翼龙面板未配置 (地址/Key/服务器ID)');
        err.status = 400;
        throw err;
    }
    return {
        url: p.url,
        headers: {
            'Authorization': 'Bearer ' + p.key,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        serverId: p.id
    };
}

// --- [ 翼龙连接测试 ] ---
// 测试 URL/Key/服务器ID 是否有效
app.post("/api/bots/:id/test-panel", apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);
    const p = getPtero(bot);
    const ep = `${p.url}/api/client/servers/${p.serverId}`;
    try {
        const r = await axios.get(ep, { headers: p.headers, timeout: 8000 });
        const srv = r.data.attributes;
        bot.pushLog(`🔌 面板连接成功: ${srv.name} (${srv.status})`, 'text-emerald-400 font-bold');
        res.json({ success: true, name: srv.name, status: srv.status, identifier: srv.identifier });
    } catch (e) {
        const msg = e.response ? `HTTP ${e.response.status}: ${e.response.data?.errors?.[0]?.detail || e.response.data?.errors?.[0]?.code || '请求失败'}` : e.message;
        bot.pushLog(`🔌 面板连接失败: ${msg}`, 'text-red-400');
        res.status(502).json({ success: false, error: msg });
    }
}));

// --- [ 翼龙电源控制 ] ---
// signal: start | stop | restart | kill
app.post("/api/bots/:id/power", apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);
    const signal = req.body.signal;
    if (!['start', 'stop', 'restart', 'kill'].includes(signal)) {
        throw { status: 400, message: '无效的电源操作 (start/stop/restart/kill)' };
    }
    const p = getPtero(bot);
    const ep = `${p.url}/api/client/servers/${p.serverId}/power`;
    try {
        await axios.post(ep, { signal }, { headers: p.headers, timeout: 8000 });
        const map = { start: '启动', stop: '停止', restart: '重启', kill: '强杀' };
        bot.pushLog(`⏻ 电源: 已发送 ${map[signal]}`, 'text-yellow-400 font-bold');
        res.json({ success: true, message: `已发送 ${signal}` });
    } catch (e) {
        const msg = e.response ? `HTTP ${e.response.status}` : e.message;
        bot.pushLog(`⏻ 电源失败: ${msg}`, 'text-red-400');
        res.status(502).json({ success: false, error: msg });
    }
}));

// --- [ 翼龙文件列表 ] ---
// 列出服务器指定目录文件
app.get("/api/bots/:id/files", apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);
    const p = getPtero(bot);
    const dir = req.query.dir || bot.settings.pterodactyl.defaultDir || '/';
    const ep = `${p.url}/api/client/servers/${p.serverId}/files/list?directory=${encodeURIComponent(dir)}`;
    try {
        const r = await axios.get(ep, { headers: p.headers, timeout: 8000 });
        res.json({ success: true, files: r.data.data || [] });
    } catch (e) {
        const msg = e.response ? `HTTP ${e.response.status}` : e.message;
        res.status(502).json({ success: false, error: msg });
    }
}));

// --- [ 翼龙文件上传 ] ---
// 上传文件到服务器 (multipart, 字段名 file, 参数 directory)
app.post("/api/bots/:id/upload", upload.single('file'), apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);
    if (!req.file) throw { status: 400, message: '未收到文件' };
    const p = getPtero(bot);
    const dir = req.body.directory || bot.settings.pterodactyl.defaultDir || '/';
    // 翼龙需要先创建 upload url
    try {
        const up = await axios.post(`${p.url}/api/client/servers/${p.serverId}/files/upload`, {}, { headers: p.headers, timeout: 8000 });
        const uploadUrl = up.data.attributes.url;
        // 预签名 URL: 直接 PUT 文件字节
        await axios.put(uploadUrl, req.file.buffer, { timeout: 20000 });
        // 上传完成后刷新文件列表
        await axios.get(`${p.url}/api/client/servers/${p.serverId}/files/list?directory=${encodeURIComponent(dir)}`, { headers: p.headers, timeout: 8000 });
        bot.pushLog(`📤 文件上传: ${req.file.originalname}`, 'text-emerald-400');
        res.json({ success: true, message: '已上传 ' + req.file.originalname });
    } catch (e) {
        const msg = e.response ? `HTTP ${e.response.status}` : e.message;
        bot.pushLog(`📤 上传失败: ${msg}`, 'text-red-400');
        res.status(502).json({ success: false, error: msg });
    }
}));

// --- [ 翼龙文件删除 ] ---
// 删除服务器文件
app.post("/api/bots/:id/files/delete", apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);
    const p = getPtero(bot);
    const file = req.body.file;
    if (!file) throw { status: 400, message: '缺少文件路径' };
    try {
        await axios.post(`${p.url}/api/client/servers/${p.serverId}/files/delete`, { files: [file] }, { headers: p.headers, timeout: 8000 });
        bot.pushLog(`🗑️ 删除文件: ${file}`, 'text-red-300');
        res.json({ success: true });
    } catch (e) {
        const msg = e.response ? `HTTP ${e.response.status}` : e.message;
        res.status(502).json({ success: false, error: msg });
    }
}));

// --- [ 翼龙文件下载 ] ---
// 生成文件下载链接 (翼龙返回临时 url)
app.post("/api/bots/:id/download", apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);
    const p = getPtero(bot);
    const file = req.body.file;
    if (!file) throw { status: 400, message: '缺少文件路径' };
    try {
        const r = await axios.post(`${p.url}/api/client/servers/${p.serverId}/files/download`, { file }, { headers: p.headers, timeout: 8000 });
        res.json({ success: true, url: r.data.attributes.url });
    } catch (e) {
        const msg = e.response ? `HTTP ${e.response.status}` : e.message;
        res.status(502).json({ success: false, error: msg });
    }
}));



app.delete("/api/bots/:id", apiErrorHandler(async (req, res) => {
    const bot = validateBot(req.params.id);

    destroyBotInstance(bot);
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

// --- [ 订阅服务 ] ---
// 由原生核心模块 (core) 生成, 挂在 SUB_PATH 路径下
const SUB_PATH = '/' + (process.env.SUB_PATH || 'sub').replace(/^\/+/, '');
app.get(SUB_PATH, (req, res) => {
    const content = coreModule.getSubBase64();
    if (!content) {
        return res.status(404).send('Not Found');
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(content);
});

// --- [ 原生核心服务控制 ] ---
// 与 tgbot-js-sbx 同一套设计: 状态机 + 幂等启动 + 失败复位
// action: start | stop | status

// 状态英文枚举 → 面板展示文案
function coreStatusText(status) {
    if (status === 'running') return '▶️ 核心服务运行中';
    if (status === 'starting') return '⏳ 核心服务正在启动';
    return '⏹ 核心服务已停止';
}

app.post("/api/core", apiErrorHandler(async (req, res) => {
    const action = req.body.action;
    if (!['start', 'stop', 'status'].includes(action)) {
        throw { status: 400, message: '无效的操作 (start/stop/status)' };
    }

    if (action === 'status') {
        return res.json({
            success: true,
            status: coreModule.coreStatus(),
            detail: coreStatusText(coreModule.coreStatus()),
            autoEnabled: coreModule.isCoreEnabled()
        });
    }

    if (action === 'start') {
        if (coreModule.coreStatus() !== 'stopped') {
            return res.json({ success: true, detail: '已经在运行或正在启动，无需重复开始' });
        }
        try {
            await coreModule.startSbx();
            return res.json({ success: true, status: coreModule.coreStatus(), detail: coreStatusText(coreModule.coreStatus()) });
        } catch (err) {
            // 启动中途失败(如下载中断)会留下 started 占位标记, 必须复位才能再次开始
            try { coreModule.resetCore(); } catch (e) {}
            throw { status: 500, message: '启动失败: ' + err.message };
        }
    }

    // stop
    await coreModule.stopSbx();
    res.json({ success: true, status: coreModule.coreStatus(), detail: coreStatusText('stopped') });
}));

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

    // 原生核心服务 (core): 受 CORE_ENABLED 开关控制, 默认随进程启动
    // 设为 false 时不自动启动, 之后可在面板里手动开启
    if (coreModule.isCoreEnabled()) {
        coreModule.startSbx().then(({ subTxt }) => {
            const n = subTxt ? subTxt.split('\n').filter(Boolean).length : 0;
            console.log(`✓ 原生代理服务已启动 (${n} 个节点, 订阅路径 /${(process.env.SUB_PATH || 'sub').replace(/^\/+/, '')})`);
        }).catch(err => {
            console.error('⚠️ 原生代理服务启动失败 (面板功能不受影响):', err.message);
        });
    } else {
        console.log('ℹ️ 原生核心服务已由 CORE_ENABLED=false 关闭, 可在面板内手动开启');
    }

    // --- [ 监控上报 ] ---
    // 独立模块( status，无扩展名 )，仅做监控指标上报，不含代理功能。
    // 受 STATUS_ENABLED 开关控制；未配置 NEZHA_SERVER / NEZHA_KEY 时静默跳过。
    loadOptionalModule('status', [], ['startNezhaAgent']).startNezhaAgent().catch((err) => {
        console.error('[Status] 启动失败（面板功能不受影响）:', err.message);
    });
});

// WebSocket 服务器初始化
const wss = new WebSocket.Server({ noServer: true });

// WebSocket 认证
server.on('upgrade', (request, socket, head) => {
    try {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const token = url.searchParams.get('token');

        // token 校验: 必须是未过期的有效会话
        const expiry = token && sessions.get(token);
        if (!token || !expiry || expiry < Date.now()) {
            if (expiry) sessions.delete(token);
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
        note: bot.note,
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
    const st = getMemoryStatus();
    if (parseFloat(st.percent) > SHUTDOWN_ON_EXCEPTION_PERCENT) {
        console.error(`⚠️ 异常 + 内存 ${st.percent}%, 触发优雅关闭(面板自动重启)`);
        gracefulShutdown('异常触发 + 内存告急');
    } else {
        // 内存正常时不必自杀: 清缓存 + 打印堆信息, 由内存巡检兜底
        mcDataCache.clear();
        console.error(`ℹ️ 内存正常 (堆 ${st.heapUsed}/${st.heapTotal} MB), 已清缓存继续运行`);
    }
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ [未处理的 Promise 拒绝]', reason);
});