import mineflayer from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pkg;
import { BehaviorManager } from './behaviors/index.js';
import axios from 'axios';
import https from 'https';
import SftpClient from 'ssh2-sftp-client';
import { SocksProxyAgent } from 'socks-proxy-agent';
import socks from 'socks';
import dns from 'dns/promises';
import net from 'net';
import { proxyService } from '../services/ProxyService.js';

const { SocksClient } = socks;

// 协议数据缓存，内存紧张时清空
const mcDataCache = new Map();
const WATER_RESCUE_INTERVAL_MS = 500;
const WATER_RESCUE_LOG_INTERVAL_MS = 10000;
const WATER_ESCAPE_GOAL_INTERVAL_MS = 2500;
const WATER_ESCAPE_SEARCH_RADIUS = 24;
const WATER_ESCAPE_STUCK_MS = 7000;
const WATER_ESCAPE_NEAR_GOAL_STUCK_MS = 2500;
const WATER_BLOCK_NAMES = new Set(['water', 'bubble_column']);
const DANGEROUS_WATER_RESCUE_BLOCKS = new Set([
  'lava',
  'fire',
  'soul_fire',
  'magma_block',
  'cactus',
  'campfire',
  'soul_campfire'
]);

/**
 * Single bot instance for one server connection
 */
export class BotInstance {
  constructor(id, config, aiService, onLog, onStatusChange, configManager = null) {
    this.id = id;
    // 深拷贝config，防止外部修改影响连接地址
    this.config = JSON.parse(JSON.stringify(config));
    this.aiService = aiService;
    this.onLog = onLog;
    this.onStatusChange = onStatusChange;
    this.configManager = configManager; // 用于保存配置

    this.bot = null;
    this.behaviors = null;
    this.isRepairing = false; // 防止重复重连
    this.connectionTimeout = null;
    this.reconnectTimeout = null;
    this.activityMonitorInterval = null;
    this.waterRescueInterval = null;
    this.autoChatInterval = null;
    this.restartCommandTimer = null; // 定时发送 /restart 命令
    this.lastActivity = Date.now();
    this.lastWaterRescueLogAt = 0;
    this.lastWaterEscapeGoalAt = 0;
    this.waterRescueActive = false;
    this.waterRescueStartedAt = 0;
    this.lastWaterSpawnRescueAt = 0;
    this.waterEscapeGoal = null;
    this.waterRescueLastPosition = null;
    this.waterRescueLastMovedAt = 0;
    this.waterRescueNearGoalSince = 0;
    this.waterRescueOriginalMovements = null;
    this.destroyed = false;
    this.spawnPosition = null; // 记录出生点用于巡逻
    this.hasAutoOpped = false; // 是否已自动给予OP权限
    this.reconnectAttempts = 0; // 重连次数
    this.pendingCommandFeedback = null;
    this.commandFeedbackTimer = null;
    this.playerLikeStartedGuard = false;
    this.lastDeathDiagnosticsAt = 0;
    this.lastDeathHandledAt = 0;
    this.lastRespawnHandledAt = 0;
    this.respawnRequestTimer = null;
    this.lastDeathMessageLogged = null;
    this.recentServerMessages = [];

    // 每个机器人独立的日志
    this.logs = [];
    this.maxLogs = 50; // 减少日志数量节省内存

    this.status = {
      id: this.id,
      connected: false,
      serverAddress: '',
      serverName: config.name || `Server ${id}`,
      version: '',
      health: 0,
      food: 0,
      position: null,
      players: [],
      username: '',
      restartTimer: config.restartTimer || {
        enabled: false,
        intervalMinutes: 0,
        nextRestart: null,
        command: '/restart'
      },
      pterodactyl: config.pterodactyl || null, // 翼龙面板配置
      rcon: config.rcon || { enabled: false, host: '', port: 25575, password: '' },
      sftp: config.sftp || null, // SFTP 配置
      fileAccessType: config.fileAccessType || 'pterodactyl', // 文件访问方式: 'pterodactyl' | 'sftp' | 'none'
      autoOp: config.autoOp !== false, // 默认启用自动OP
      autoReconnect: config.autoReconnect || false // 对有需要的节点开启持久重连
    };

    // 从配置加载模式设置 (确保所有模式都有默认值)
    const defaultModes = {
      aiView: false,
      patrol: false,
      autoChat: config.autoChat?.enabled || false,
      autoAttack: false,
      follow: false,
      invincible: false,  // 无敌模式
      antiAfk: false,
      autoEat: false,
      guard: false,
      rateLimit: false,
      humanize: false,
      safeIdle: false,
      playerLike: false,
      workflow: false
    };
    this.modes = { ...defaultModes, ...(config.modes || {}) };
    delete this.modes.mining;
    delete this.modes.fishing;

    this.behaviorSettings = {
      attack: {
        whitelist: [],
        minHealth: 12,
        ...(config.behaviorSettings?.attack || {})
      },
      patrol: {
        waypoints: Array.isArray(config.behaviorSettings?.patrol?.waypoints)
          ? config.behaviorSettings.patrol.waypoints
          : []
      },
      antiAfk: {
        intervalSeconds: 45,
        jitterSeconds: 15,
        ...(config.behaviorSettings?.antiAfk || {})
      },
      autoEat: {
        minHealth: 12,
        minFood: 18,
        ...(config.behaviorSettings?.autoEat || {})
      },
      guard: {
        radius: 24,
        attackRange: 4.5,
        minHealth: 12,
        pathCooldownMs: 800,
        patrolRadius: 48,
        patrolIntervalMs: 7000,
        patrolGoalTimeoutMs: 12000,
        ...(config.behaviorSettings?.guard || {})
      },
      rateLimit: {
        globalCooldownSeconds: 1,
        maxPerMinute: 20,
        ...(config.behaviorSettings?.rateLimit || {})
      },
      humanize: {
        intervalSeconds: 18,
        lookRange: 6,
        actionChance: 0.75,
        stepChance: 0.45,
        sneakChance: 0.25,
        swingChance: 0.25,
        stepDurationMinMs: 450,
        stepDurationMaxMs: 900,
        jumpUpEnabled: true,
        nearbyPlayerRange: 12,
        approachPlayerRange: 10,
        approachStopDistance: 3,
        playerReactionIntervalSeconds: 2,
        playerActionChance: 0.75,
        approachChance: 0.55,
        greetingEnabled: true,
        greetingChance: 0.65,
        greetingGlobalCooldownSeconds: 45,
        greetingPlayerCooldownSeconds: 180,
        greetingMessages: ['hi', 'hello', 'hey', 'yo', 'sup', 'morning', 'evening', 'anyone here?', 'nice place', 'cool base', 'looks busy here', 'just spawned in', 'I am checking around', 'need help?', 'all good?', 'what is up', '来了', '有人来了', '有人吗', '你也在这啊', '我看看', '路过一下', '在忙啥呢', '这边挺热闹', '我刚到', '一起看看', '这地方不错', '我站会儿', '需要帮忙吗', '你好呀', '早啊', '晚上好', '刚上线', '人不少啊', '我路过看看', '这边不错', '你们在忙啥', '看起来挺热闹', '我来转转', '别紧张'],
        approachGreetingMessages: ['你也来了啊', '你在这啊', '我看看你在干嘛', '这边有人啊', '哈喽', '刚过来看看', '我过来看看', '你在这干嘛', '这边有东西吗', '我跟一下', '别紧张我路过', '我看一眼', '这边安全吗', '我也来看看', 'just checking around', 'what are you doing here?', 'mind if I look?', 'I am just passing by', 'checking this spot', 'anything interesting?', 'I will follow a bit', 'looks interesting here'],
        leaveGreetingMessages: ['走了啊', '回头见', '我继续逛逛', '那我先走了', '一会儿见', '我去别处看看', '我继续巡逻', '待会儿回来', '先撤了', '这边看完了', '下次见', 'see ya', 'catch you later', 'I will be back', 'gonna check elsewhere', 'moving on', 'later', 'back in a bit'],
        hurtGreetingMessages: ['别打啊', '别别别', '打我干嘛', '我没惹你吧', '停一下停一下', '我路过的', '误会误会', '别急啊', '冷静点', '我只是看看', 'hey stop', 'why hit me?', 'chill', 'I am friendly', 'easy', 'not fighting you', 'calm down', 'my bad'],
        ...(config.behaviorSettings?.humanize || {})
      },
      safeIdle: {
        intervalSeconds: 20,
        lookRange: 6,
        actionChance: 0.5,
        timeoutSeconds: 45,
        resumeDelaySeconds: 10,
        ...(config.behaviorSettings?.safeIdle || {})
      },
      workflow: {
        ...(config.behaviorSettings?.workflow || {}),
        steps: (() => {
          const steps = Array.isArray(config.behaviorSettings?.workflow?.steps)
            ? config.behaviorSettings.workflow.steps.filter(step => step !== 'mining')
            : ['patrol', 'rest'];
          return steps.length > 0 ? steps : ['patrol', 'rest'];
        })(),
        patrolSeconds: config.behaviorSettings?.workflow?.patrolSeconds ?? 120,
        restSeconds: config.behaviorSettings?.workflow?.restSeconds ?? 40,
        miningMaxSeconds: undefined
      },
      pathSafety: {
        avoidWater: false,
        avoidLava: true,
        avoidEdges: true,
        maxDropDown: 2,
        allowSprinting: false,
        allowParkour: false,
        waterSpawnRescueEnabled: false,
        waterSpawnRescueCommand: '/spawn',
        waterSpawnRescueDelaySeconds: 8,
        waterSpawnRescueCooldownSeconds: 60,
        ...(config.behaviorSettings?.pathSafety || {})
      }
    };

    this.commandSettings = {
      allowAll: false,
      cooldownSeconds: 3,
      whitelist: [],
      silentReject: false,
      globalCooldownSeconds: 1,
      maxPerMinute: 20,
      ...(config.commandSettings || {})
    };
    this.commandCooldowns = new Map();
    this.commandUserCooldowns = new Map();
    this.commandUserWindows = new Map();

    // 自动喊话配置
    this.autoChatConfig = config.autoChat || {
      enabled: false,
      interval: 60000,
      messages: ['Hello!']
    };


    this.usernameSettings = {
      prefix: typeof config.usernameSettings?.prefix === 'string' ? config.usernameSettings.prefix : '',
      suffix: typeof config.usernameSettings?.suffix === 'string' ? config.usernameSettings.suffix : '',
      blacklist: Array.isArray(config.usernameSettings?.blacklist) ? config.usernameSettings.blacklist : [],
      maxAttempts: Number.isFinite(config.usernameSettings?.maxAttempts) ? Math.max(1, config.usernameSettings.maxAttempts) : 5,
      retryOnConflict: config.usernameSettings?.retryOnConflict !== false
    };
    this.usernameRetryCount = 0;
    this.nextUsername = null;

    this.commands = {
      '!help': this.cmdHelp.bind(this),
      '!come': this.cmdCome.bind(this),
      '!ask': this.cmdAsk.bind(this),
      '!stop': this.cmdStop.bind(this),
      '!pos': this.cmdPosition.bind(this),
      '!follow': this.cmdFollow.bind(this),
      '!attack': this.cmdAttack.bind(this),
      '!patrol': this.cmdPatrol.bind(this),
      '!god': this.cmdGod.bind(this),
      '!jump': this.cmdJump.bind(this),
      '!sneak': this.cmdSneak.bind(this)
    };
  }

  log(type, message, icon = '') {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const entry = {
      id: Date.now(),
      timestamp,
      type,
      icon,
      message,
      serverId: this.id
    };

    // 存储到本机器人的日志数组
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    console.log(`[${timestamp}] [${this.status.serverName}] ${icon} ${message}`);
    if (this.onLog) this.onLog(this.id, entry);
  }

  // 获取本机器人的日志
  getLogs() {
    return this.logs;
  }

  sendChatCommand(command) {
    if (!this.bot || !this.status.connected) {
      return { success: false, message: 'Bot 未连接' };
    }

    const text = String(command || '').trim();
    if (!text) {
      return { success: false, message: '命令不能为空' };
    }

    const beforePos = this.bot.entity?.position?.clone?.() || null;
    this.bot.chat(text);
    this.log('info', `已发送命令: ${text}，等待服务器响应`, '📤');

    if (this.commandFeedbackTimer) {
      clearTimeout(this.commandFeedbackTimer);
    }

    this.pendingCommandFeedback = {
      command: text,
      beforePos,
      startedAt: Date.now(),
      sawResponse: false
    };

    this.commandFeedbackTimer = setTimeout(() => {
      const pending = this.pendingCommandFeedback;
      if (!pending || pending.command !== text) return;

      const afterPos = this.bot?.entity?.position || null;
      const moved = pending.beforePos && afterPos && pending.beforePos.distanceTo(afterPos) >= 8;
      if (!pending.sawResponse && moved) {
        this.log('success', `命令可能已生效，位置变化: ${Math.floor(pending.beforePos.x)} ${Math.floor(pending.beforePos.y)} ${Math.floor(pending.beforePos.z)} -> ${Math.floor(afterPos.x)} ${Math.floor(afterPos.y)} ${Math.floor(afterPos.z)}`, '✅');
      } else if (!pending.sawResponse) {
        this.log('warning', `命令已发送但服务器无明确反馈: ${text}`, '⚠️');
      }

      this.pendingCommandFeedback = null;
      this.commandFeedbackTimer = null;
    }, 5000);

    if (typeof this.commandFeedbackTimer.unref === 'function') {
      this.commandFeedbackTimer.unref();
    }

    return { success: true, message: '命令已发送，等待服务器响应' };
  }

  handleCommandFeedback(message) {
    if (!this.pendingCommandFeedback) return;
    const text = String(message || '').trim();
    if (!text) return;

    const lower = text.toLowerCase();
    const noPermission = lower.includes('permission') || text.includes('没有权限') || text.includes('无权限') || text.includes('权限不足');
    const unknownCommand = lower.includes('unknown command') || lower.includes('unknown or incomplete command') || text.includes('未知命令') || text.includes('不存在的命令');
    const cooldown = lower.includes('cooldown') || text.includes('冷却') || text.includes('请等待');
    const teleporting = lower.includes('teleport') || lower.includes('warping') || text.includes('传送') || text.includes('正在传送');

    if (noPermission) {
      this.pendingCommandFeedback.sawResponse = true;
      this.log('warning', `服务器反馈: 没有权限 (${text})`, '🚫');
    } else if (unknownCommand) {
      this.pendingCommandFeedback.sawResponse = true;
      this.log('warning', `服务器反馈: 未知命令 (${text})`, '❓');
    } else if (cooldown) {
      this.pendingCommandFeedback.sawResponse = true;
      this.log('warning', `服务器反馈: 命令冷却中 (${text})`, '⏳');
    } else if (teleporting) {
      this.pendingCommandFeedback.sawResponse = true;
      this.log('success', `服务器反馈: ${text}`, '✅');
    }
  }

  recordServerMessage(message) {
    const text = String(message || '').trim();
    if (!text) return;
    const now = Date.now();
    this.recentServerMessages.push({ text, at: now });
    this.recentServerMessages = this.recentServerMessages
      .filter(item => now - item.at <= 30000)
      .slice(-40);
  }

  findRecentDeathMessage() {
    const username = String(this.bot?.username || this.status.username || '').toLowerCase();
    if (!username) return null;
    const deathHints = [
      'died',
      'was slain',
      'was shot',
      'drowned',
      'burned',
      'fell',
      'blew up',
      'hit the ground',
      'killed',
      '死亡',
      '淹死',
      '被',
      '杀死',
      '射杀',
      '摔死',
      '烧死',
      '炸死'
    ];
    for (const item of [...this.recentServerMessages].reverse()) {
      const lower = item.text.toLowerCase();
      if (!lower.includes(username)) continue;
      if (deathHints.some(hint => lower.includes(hint.toLowerCase()))) return item.text;
    }
    return null;
  }

  getNearbyEntitiesForDeath(type, range = 12, limit = 6) {
    if (!this.bot?.entity) return [];
    const origin = this.bot.entity.position;
    return Object.values(this.bot.entities || {})
      .filter(entity => entity && entity !== this.bot.entity && entity.type === type && entity.position)
      .map(entity => ({
        name: entity.username || entity.name || entity.type || 'unknown',
        distance: origin.distanceTo(entity.position)
      }))
      .filter(entity => entity.distance <= range)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  getDeathEnvironmentInfo() {
    if (!this.bot?.entity?.position || typeof this.bot.blockAt !== 'function') return null;
    const pos = this.bot.entity.position;
    const feet = this.bot.blockAt(pos);
    const head = this.bot.blockAt(pos.offset(0, 1, 0));
    const below = this.bot.blockAt(pos.offset(0, -1, 0));
    return {
      position: pos,
      feet: feet?.name || 'unknown',
      head: head?.name || 'unknown',
      below: below?.name || 'unknown',
      inWater: this.isBotInWater(),
      inLava: feet?.name === 'lava' || head?.name === 'lava'
    };
  }

  inferCauseFromDeathMessage(deathMessage) {
    if (!deathMessage) return null;
    const lower = deathMessage.toLowerCase();
    const hostileNames = ['witch', 'enderman', 'creeper', 'skeleton', 'stray', 'bogged', 'zombie', 'drowned', 'spider', 'pillager', 'blaze', 'ghast', 'slime', 'phantom'];
    const hostile = hostileNames.find(name => lower.includes(name));
    if (hostile) return `服务器死亡消息显示被敌对生物击杀: ${hostile}`;
    if (lower.includes('drowned')) return '服务器死亡消息显示死于溺水';
    if (lower.includes('fell') || lower.includes('hit the ground')) return '服务器死亡消息显示死于摔落';
    if (lower.includes('lava') || lower.includes('burned') || lower.includes('fire')) return '服务器死亡消息显示死于岩浆/燃烧';
    if (lower.includes('magic')) return '服务器死亡消息显示死于魔法伤害';
    if (lower.includes('shot')) return '服务器死亡消息显示死于远程射击';
    if (lower.includes('killed') || lower.includes('slain')) return `服务器死亡消息: ${deathMessage}`;
    return null;
  }

  inferDeathCause(environment, hostiles, deathMessage = null) {
    const messageCause = this.inferCauseFromDeathMessage(deathMessage);
    if (messageCause) return messageCause;
    if (environment?.inLava) return '可能死于岩浆/燃烧伤害';
    const nearest = hostiles[0];
    if (nearest) return `可能被附近敌对生物击杀: ${nearest.name} (${nearest.distance.toFixed(1)} 格)`;
    if (environment?.inWater) return '可能死于溺水或水中无法脱离';
    return '未识别到明确死因，查看服务器死亡消息或坐标环境';
  }

  logDeathDiagnostics() {
    const now = Date.now();
    if (now - this.lastDeathDiagnosticsAt < 5000) return;
    this.lastDeathDiagnosticsAt = now;

    const environment = this.getDeathEnvironmentInfo();
    const hostiles = this.getNearbyEntitiesForDeath('hostile');
    const players = this.getNearbyEntitiesForDeath('player');
    const deathMessage = this.findRecentDeathMessage();

    if (deathMessage && deathMessage !== this.lastDeathMessageLogged) {
      this.lastDeathMessageLogged = deathMessage;
      this.log('warning', `死亡消息: ${deathMessage}`, '💀');
    }
    if (environment?.position) {
      const pos = environment.position;
      this.log('warning', `死亡坐标: X=${pos.x.toFixed(1)} Y=${pos.y.toFixed(1)} Z=${pos.z.toFixed(1)}`, '📍');
      this.log('warning', `死亡环境: 脚下=${environment.feet} 头部=${environment.head} 下方=${environment.below} 水中=${environment.inWater ? '是' : '否'} 岩浆=${environment.inLava ? '是' : '否'}`, '🧭');
    }
    if (hostiles.length > 0) {
      this.log('warning', `死亡附近敌对生物: ${hostiles.map(entity => `${entity.name}(${entity.distance.toFixed(1)}格)`).join(', ')}`, '🛡️');
    }
    if (players.length > 0) {
      this.log('warning', `死亡附近玩家: ${players.map(entity => `${entity.name}(${entity.distance.toFixed(1)}格)`).join(', ')}`, '🧍');
    }
    this.log('warning', `死亡诊断: ${this.inferDeathCause(environment, hostiles, deathMessage)}`, '🔎');
  }

  // 清空本机器人的日志
  clearLogs() {
    this.logs = [];
  }

  updateActivity() {
    this.lastActivity = Date.now();
  }

  applyMovementSafety(movements) {
    if (!movements) return;
    const safety = this.behaviorSettings?.pathSafety || {};
    if (typeof safety.allowSprinting === 'boolean') {
      movements.allowSprinting = safety.allowSprinting;
    }
    if (typeof safety.allowParkour === 'boolean') {
      movements.allowParkour = safety.allowParkour;
    }
    if (Number.isFinite(safety.maxDropDown)) {
      movements.maxDropDown = Math.max(0, safety.maxDropDown);
    }
    if (safety.avoidEdges) {
      movements.allowParkour = false;
      if (Number.isFinite(safety.maxDropDown)) {
        movements.maxDropDown = Math.max(0, safety.maxDropDown);
      }
    }
    if (safety.avoidWater) {
      movements.liquidCost = 1000;
      movements.waterCost = 1000;
    }
    if (safety.avoidLava) {
      movements.lavaCost = 1000;
    }
  }

  generateUsername() {
    const adjectives = ['Clever', 'Swift', 'Brave', 'Happy', 'Mighty', 'Wise', 'Quick', 'Sneaky'];
    const animals = ['Fox', 'Wolf', 'Bear', 'Tiger', 'Eagle', 'Panda', 'Otter', 'Raccoon'];
    const prefix = this.usernameSettings.prefix || '';
    const suffix = this.usernameSettings.suffix || '';

    for (let i = 0; i < this.usernameSettings.maxAttempts; i++) {
      const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
      const animal = animals[Math.floor(Math.random() * animals.length)];
      const secondAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
      const rawName = `${prefix}${adj}${animal}${secondAdj}${suffix}`;
      const candidate = this.normalizeUsername(rawName);
      if (!this.isUsernameBlacklisted(candidate)) {
        return candidate;
      }
    }

    const fallback = `${prefix}Bot${adjectives[Math.floor(Math.random() * adjectives.length)]}${suffix}`;
    return this.normalizeUsername(fallback);
  }

  normalizeUsername(rawName) {
    const cleaned = String(rawName).replace(/[^a-zA-Z0-9_]/g, '');
    let name = cleaned.slice(0, 16);
    if (name.length < 3) {
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const pad = letters[Math.floor(Math.random() * letters.length)] +
        letters[Math.floor(Math.random() * letters.length)] +
        letters[Math.floor(Math.random() * letters.length)];
      name = (name + pad).slice(0, 3);
    }
    return name;
  }


  isUsernameBlacklisted(name) {
    const lower = String(name).toLowerCase();
    return this.usernameSettings.blacklist
      .map(item => String(item).toLowerCase().trim())
      .filter(item => item)
      .some(item => lower.includes(item));
  }

  shouldRetryWithNewUsername(reason) {
    if (this.config.username) return false;
    if (!this.usernameSettings.retryOnConflict) return false;
    if (!reason) return false;
    const text = String(reason).toLowerCase();
    return (
      text.includes('already') ||
      text.includes('in use') ||
      text.includes('logged in') ||
      text.includes('name') ||
      text.includes('用户名') ||
      text.includes('已登录') ||
      text.includes('已在线') ||
      text.includes('重复') ||
      text.includes('重名')
    );
  }

  prepareNextUsername(reason) {
    if (!this.shouldRetryWithNewUsername(reason)) return false;
    if (this.usernameRetryCount >= this.usernameSettings.maxAttempts) {
      return false;
    }
    this.usernameRetryCount += 1;
    this.nextUsername = this.generateUsername();
    return true;
  }

  getStatus() {
    return {
      ...this.status,
      // 添加配置中的服务器连接信息
      host: this.config.host,
      port: this.config.port,
      name: this.config.name || this.status.serverName,
      username: this.status.username || this.config.username,
      modes: this.modes,
      autoChat: this.autoChatConfig,
      behaviors: this.behaviors?.getStatus() || null,
      proxyNodeId: this.config.proxyNodeId || '',
      autoReconnect: !!this.config.autoReconnect
    };
  }

  isPanelConfigured() {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.serverId) return false;

    if (panel.authType === 'cookie') {
      return !!panel.cookie;
    }
    return !!panel.apiKey;
  }

  getPanelAuthHeaders() {
    const panel = this.status.pterodactyl;
    if (!panel) return {};

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };

    if (panel.authType === 'cookie') {
      headers['Cookie'] = panel.cookie;
      if (panel.csrfToken) {
        headers['X-CSRF-Token'] = panel.csrfToken;
        headers['X-Xsrf-Token'] = panel.csrfToken;
      }
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
      headers['Referer'] = `${panel.url}/server/${panel.serverId}`;
      headers['Origin'] = panel.url;
    } else {
      headers['Authorization'] = `Bearer ${panel.apiKey}`;
    }

    return headers;
  }

  getPanelHttpOptions(extraConfig = {}) {
    const panel = this.status.pterodactyl;
    const options = {
      ...extraConfig,
      headers: { ...this.getPanelAuthHeaders(), ...(extraConfig.headers || {}) },
      timeout: extraConfig.timeout || 15000
    };

    if (panel?.ignoreTlsError) {
      options.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }

    if (this.config.proxyNodeId) {
      const localPort = proxyService.getLocalPort(this.config.proxyNodeId);
      if (localPort) {
        const agent = new SocksProxyAgent(`socks5://127.0.0.1:${localPort}`);
        options.httpsAgent = agent;
        options.httpAgent = agent;
      }
    }

    return options;
  }

  cleanup() {
    if (this.activityMonitorInterval) {
      clearInterval(this.activityMonitorInterval);
      this.activityMonitorInterval = null;
    }
    if (this.waterRescueInterval) {
      clearInterval(this.waterRescueInterval);
      this.waterRescueInterval = null;
    }
    this.stopWaterRescueControls();
    if (this.autoChatInterval) {
      clearInterval(this.autoChatInterval);
      this.autoChatInterval = null;
    }
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.restartCommandTimer) {
      clearInterval(this.restartCommandTimer);
      this.restartCommandTimer = null;
    }
    if (this.respawnRequestTimer) {
      clearTimeout(this.respawnRequestTimer);
      this.respawnRequestTimer = null;
    }
    if (this.commandFeedbackTimer) {
      clearTimeout(this.commandFeedbackTimer);
      this.commandFeedbackTimer = null;
    }
    this.pendingCommandFeedback = null;

    // 停止所有行为
    if (this.behaviors) {
      this.behaviors.stopAll();
      this.behaviors = null;
    }

    this.status.connected = false;
    this.status.position = null;
    this.status.health = 0;
    this.status.food = 0;
    this.status.players = [];

    if (this.bot) {
      try {
        this.bot.removeAllListeners();
        if (this.bot._client) {
          this.bot._client.removeAllListeners();
        }
        // Force end the connection
        if (typeof this.bot.end === 'function') {
          this.bot.end();
        } else if (typeof this.bot.quit === 'function') {
          this.bot.quit();
        }
      } catch (e) {
        // Ignore errors during cleanup
      }
      this.bot = null;
    }
  }

  startActivityMonitor() {
    if (this.activityMonitorInterval) {
      clearInterval(this.activityMonitorInterval);
    }

    this.activityMonitorInterval = setInterval(() => {
      // 2分钟无活动才触发重连，避免频繁重连
      if (Date.now() - this.lastActivity > 120000) {
        this.log('warning', 'Bot 无响应超过2分钟，尝试重连...', '⏱️');
        this.attemptRepair('无响应');
      }
    }, 30000); // 每30秒检查一次
  }

  /**
   * 防溺水自救：掉进水里时暂停原移动，尝试找岸边并持续上浮。
   */
  startWaterRescueMonitor() {
    if (this.waterRescueInterval) {
      clearInterval(this.waterRescueInterval);
    }

    this.waterRescueInterval = setInterval(() => this.tickWaterRescue(), WATER_RESCUE_INTERVAL_MS);
    if (typeof this.waterRescueInterval.unref === 'function') {
      this.waterRescueInterval.unref();
    }
  }

  isWaterBlock(block) {
    return !!block && WATER_BLOCK_NAMES.has(block.name);
  }

  isUnsafeWaterEscapeBlock(block) {
    if (!block) return true;
    return DANGEROUS_WATER_RESCUE_BLOCKS.has(block.name);
  }

  isBotInWater() {
    if (!this.bot?.entity?.position || typeof this.bot.blockAt !== 'function') return false;
    if (this.bot.entity.isInWater) return true;
    const pos = this.bot.entity.position;
    const feet = this.bot.blockAt(pos);
    const head = this.bot.blockAt(pos.offset(0, 1, 0));
    return this.isWaterBlock(feet) || this.isWaterBlock(head);
  }

  stopWaterRescueControls() {
    const wasActive = this.waterRescueActive;
    this.waterRescueActive = false;
    this.waterEscapeGoal = null;
    this.waterRescueLastPosition = null;
    this.waterRescueLastMovedAt = 0;
    this.waterRescueNearGoalSince = 0;
    this.restoreWaterRescueMovements();
    if (wasActive && this.bot?.pathfinder) {
      this.bot.pathfinder.stop();
    }
    if (!this.bot?.setControlState) return;
    this.bot.setControlState('forward', false);
    this.bot.setControlState('back', false);
    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
    this.bot.setControlState('jump', false);
    this.bot.setControlState('sneak', false);
    this.bot.setControlState('sprint', false);
  }

  applyWaterRescueMovements() {
    if (!this.bot?.pathfinder || !this.bot?.registry) return;
    if (!this.waterRescueOriginalMovements) {
      this.waterRescueOriginalMovements = this.movements || null;
    }
    const rescueMovements = new Movements(this.bot, this.bot.registry);
    rescueMovements.canDig = false;
    this.applyMovementSafety(rescueMovements);
    rescueMovements.liquidCost = 1;
    rescueMovements.waterCost = 1;
    rescueMovements.allowSprinting = true;
    rescueMovements.allowParkour = false;
    rescueMovements.maxDropDown = Math.min(rescueMovements.maxDropDown ?? 2, 2);
    this.bot.pathfinder.setMovements(rescueMovements);
  }

  restoreWaterRescueMovements() {
    if (!this.bot?.pathfinder || !this.waterRescueOriginalMovements) return;
    this.bot.pathfinder.setMovements(this.waterRescueOriginalMovements);
    this.waterRescueOriginalMovements = null;
  }

  isWaterEscapeStandable(feetPos) {
    const feet = this.bot.blockAt(feetPos);
    const head = this.bot.blockAt(feetPos.offset(0, 1, 0));
    const below = this.bot.blockAt(feetPos.offset(0, -1, 0));
    if (!feet || !head || !below) return false;
    if (this.isWaterBlock(feet) || this.isWaterBlock(head) || this.isWaterBlock(below)) return false;
    if (this.isUnsafeWaterEscapeBlock(feet) || this.isUnsafeWaterEscapeBlock(head) || this.isUnsafeWaterEscapeBlock(below)) return false;
    if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') return false;
    return below.boundingBox !== 'empty';
  }

  findWaterEscapeGoal(minDistance = 0) {
    if (!this.bot?.entity?.position || typeof this.bot.blockAt !== 'function') return null;
    const origin = this.bot.entity.position.floored();
    const current = this.bot.entity.position;
    let best = null;
    let bestScore = Infinity;

    for (let radius = 1; radius <= WATER_ESCAPE_SEARCH_RADIUS; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          for (let dy = 3; dy >= -3; dy--) {
            const feetPos = origin.offset(dx, dy, dz);
            if (!this.isWaterEscapeStandable(feetPos)) continue;
            const distance = current.distanceTo(feetPos.offset(0.5, 0, 0.5));
            if (distance < minDistance) continue;
            const horizontal = Math.sqrt(dx * dx + dz * dz);
            const verticalPenalty = Math.abs(dy) * 1.5;
            const score = horizontal + verticalPenalty;
            if (score >= bestScore) continue;
            bestScore = score;
            best = feetPos;
          }
        }
      }
      if (best && radius >= 8) break;
    }

    if (!best) return null;
    return {
      goal: new goals.GoalNear(best.x, best.y, best.z, 1),
      position: best,
      distance: this.bot.entity.position.distanceTo(best)
    };
  }

  updateWaterRescueStuckState(now) {
    if (!this.bot?.entity?.position) return;
    const current = this.bot.entity.position;
    if (!this.waterRescueLastPosition) {
      this.waterRescueLastPosition = current.clone();
      this.waterRescueLastMovedAt = now;
      return;
    }
    if (current.distanceTo(this.waterRescueLastPosition) >= 1.2) {
      this.waterRescueLastPosition = current.clone();
      this.waterRescueLastMovedAt = now;
    }
  }

  applyWaterRescueControls() {
    if (!this.bot?.setControlState) return;
    this.bot.setControlState('back', false);
    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
    this.bot.setControlState('sneak', false);
    this.bot.setControlState('sprint', true);
    this.bot.setControlState('jump', true);

    const target = this.waterEscapeGoal?.position;
    if (!target || !this.bot.entity?.position) {
      this.bot.setControlState('forward', false);
      return;
    }

    this.bot.lookAt(target.offset(0.5, 1, 0.5));
    this.bot.setControlState('forward', true);
  }

  tickWaterRescue() {
    if (!this.bot || !this.status.connected || !this.bot.entity) return;
    if (this.behaviorSettings?.pathSafety?.avoidWater === false) {
      if (this.waterRescueActive) this.stopWaterRescueControls();
      return;
    }

    if (!this.isBotInWater()) {
      if (this.waterRescueActive) this.stopWaterRescueControls();
      this.waterRescueStartedAt = 0;
      return;
    }

    const now = Date.now();
    this.updateActivity();

    if (!this.waterRescueActive) {
      this.waterRescueActive = true;
      this.waterRescueStartedAt = now;
      this.lastWaterEscapeGoalAt = 0;
      this.waterEscapeGoal = null;
      this.waterRescueLastPosition = this.bot.entity.position.clone();
      this.waterRescueLastMovedAt = now;
      this.waterRescueNearGoalSince = 0;
      this.applyWaterRescueMovements();
    }

    this.updateWaterRescueStuckState(now);

    if (now - this.lastWaterRescueLogAt > WATER_RESCUE_LOG_INTERVAL_MS) {
      this.lastWaterRescueLogAt = now;
      this.log('warning', '检测到机器人在水中，正在大范围寻找岸边自救', '🌊');
    }

    const safety = this.behaviorSettings?.pathSafety || {};
    if (safety.waterSpawnRescueEnabled) {
      const delayMs = Math.max(1, Number(safety.waterSpawnRescueDelaySeconds) || 8) * 1000;
      const cooldownMs = Math.max(5, Number(safety.waterSpawnRescueCooldownSeconds) || 60) * 1000;
      const command = String(safety.waterSpawnRescueCommand || '/spawn').trim() || '/spawn';
      if (this.waterRescueStartedAt && now - this.waterRescueStartedAt >= delayMs && now - this.lastWaterSpawnRescueAt >= cooldownMs) {
        this.lastWaterSpawnRescueAt = now;
        this.log('warning', `水中停留过久，尝试发送救援命令 ${command}`, '🛟');
        this.sendChatCommand(command);
      }
    }

    if (this.waterEscapeGoal?.position) {
      const goalDistance = this.bot.entity.position.distanceTo(this.waterEscapeGoal.position.offset(0.5, 0, 0.5));
      if (goalDistance <= 2 && this.isBotInWater()) {
        if (!this.waterRescueNearGoalSince) this.waterRescueNearGoalSince = now;
        if (now - this.waterRescueNearGoalSince > WATER_ESCAPE_NEAR_GOAL_STUCK_MS) {
          this.waterEscapeGoal = null;
          this.lastWaterEscapeGoalAt = 0;
          this.waterRescueNearGoalSince = 0;
          if (this.bot.pathfinder) this.bot.pathfinder.stop();
          this.log('warning', '水中自救已到岸边但仍在水中，重新寻找更远落脚点', '🛟');
        }
      } else {
        this.waterRescueNearGoalSince = 0;
      }
    }

    if (this.bot.pathfinder && (!this.waterEscapeGoal || now - this.lastWaterEscapeGoalAt > WATER_ESCAPE_GOAL_INTERVAL_MS)) {
      const minDistance = this.isBotInWater() ? 2.5 : 0;
      const escape = this.findWaterEscapeGoal(minDistance);
      if (escape) {
        this.waterEscapeGoal = escape;
        this.lastWaterEscapeGoalAt = now;
        this.bot.pathfinder.setGoal(escape.goal, true);
        if (now - this.lastWaterRescueLogAt < 1000) {
          this.log('info', `水中自救目标: X=${escape.position.x} Y=${escape.position.y} Z=${escape.position.z}，距离 ${escape.distance.toFixed(1)} 格`, '🛟');
        }
      } else {
        this.waterEscapeGoal = null;
        this.bot.pathfinder.stop();
      }
    }

    if (this.waterRescueLastMovedAt && now - this.waterRescueLastMovedAt > WATER_ESCAPE_STUCK_MS) {
      this.lastWaterEscapeGoalAt = 0;
      this.waterEscapeGoal = null;
      this.waterRescueNearGoalSince = 0;
      this.waterRescueLastPosition = this.bot.entity.position.clone();
      this.waterRescueLastMovedAt = now;
      if (this.bot.pathfinder) this.bot.pathfinder.stop();
      this.log('warning', '水中自救疑似卡住，重新扫描更远岸边', '🛟');
    }

    this.applyWaterRescueControls();
  }

  /**
   * 尝试修复连接 - 防止重复重连，固定间隔
   */
  attemptRepair(reason) {
    // 防止重复重连
    if (this.destroyed || this.isRepairing) {
      return;
    }

    this.isRepairing = true;
    this.status.connected = false;
    this.reconnectAttempts++;

    if (!this.nextUsername) {
      const prepared = this.prepareNextUsername(reason);
      if (prepared) {
        this.log('warning', `用户名冲突，尝试更换为 ${this.nextUsername} 重连`, '🔁');
      }
    }

    // 计算下一次等待时间 (指数退避)
    // 5s for first attempt, then 10s, 20s... max 60s
    let delaySeconds = 5;
    if (this.reconnectAttempts > 1) {
      delaySeconds = Math.min(5 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)), 60);
    }
    const backoff = delaySeconds * 1000;

    this.log('warning', `连接异常 (${reason})，${delaySeconds}秒后重连 (第${this.reconnectAttempts}次)...`, '🔄');

    // 彻底清理旧连接
    this.cleanup();

    if (this.onStatusChange) {
      this.onStatusChange(this.id, this.getStatus());
    }

    this.reconnectTimeout = setTimeout(async () => {
      if (this.destroyed) {
        this.isRepairing = false;
        return;
      }

      try {
        await this.connect();
        this.log('success', '重连成功', '✅');
        this.reconnectAttempts = 0;
        this.isRepairing = false;
      } catch (err) {
        this.log('error', `重连失败: ${err.message}`, '✗');
        this.isRepairing = false;

        // 如果开启了自动持久重连，则再次触发重连逻辑
        if (this.status.autoReconnect && !this.destroyed) {
          this.attemptRepair(`重试失败: ${err.message}`);
        }
      }
    }, backoff);
  }

  /**
   * 软断开 - 用于手动刷新，不设置 destroyed 标志
   */
  softDisconnect() {
    this.status.connected = false;
    this.cleanup();
    this.log('info', '正在刷新连接...', '🔄');
    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
  }

  async resolveMinecraftDestination(host, port) {
    const destinationPort = port || 25565;
    if (destinationPort === 25565 && net.isIP(host) === 0 && host !== 'localhost') {
      try {
        const addresses = await dns.resolveSrv(`_minecraft._tcp.${host}`);
        if (addresses?.length) {
          return { host: addresses[0].name, port: addresses[0].port };
        }
      } catch {
        // 保持 minecraft-protocol 原有行为：SRV 解析失败时直连原 host:port。
      }
    }
    return { host, port: destinationPort };
  }

  /**
   * 清理内存缓存 - 内存紧张时调用
   */
  static clearCache() {
    mcDataCache.clear();
    console.log('[内存优化] 已清理协议数据缓存');
  }

  async connect() {
    // 如果已连接且正常，不重复连接
    if (this.bot && this.status.connected) {
      this.log('warning', '已有活动连接', '⚠');
      return;
    }

    // 完全清理旧连接（使用 cleanup 确保彻底）
    if (this.bot) {
      this.cleanup();
    }

    // 重置手动停止标志，允许后续自动重连
    this.destroyed = false;

    // 缩短等待时间
    await new Promise(r => setTimeout(r, 200));

    // 只使用手动配置的地址，不使用面板API获取的地址
    const host = this.config.host;
    // 如果端口为0或未定义，传undefined给mineflayer，让其处理默认值(25565)和SRV解析
    const port = (this.config.port && this.config.port > 0) ? this.config.port : undefined;

    if (!host) {
      this.log('error', '未配置服务器地址，请在设置中配置 host', '❌');
      throw new Error('未配置服务器地址');
    }

    const username = this.config.username || this.nextUsername || this.generateUsername();
    this.nextUsername = null;
    const version = this.config.version || false;

    let botOptions = null;
    let connectViaProxy = null;
    if (this.config.proxyNodeId) {
      const localPort = proxyService.getLocalPort(this.config.proxyNodeId);
      if (localPort) {
        this.log('info', `使用代理节点: ${this.config.proxyNodeId} (桥接端口: ${localPort})`, '🌐');
        connectViaProxy = async (client) => {
          try {
            const destination = await this.resolveMinecraftDestination(host, port);
            if (botOptions) {
              botOptions.host = destination.host;
              botOptions.port = destination.port;
            }
            const { socket } = await SocksClient.createConnection({
              command: 'connect',
              proxy: {
                host: '127.0.0.1',
                port: localPort,
                type: 5
              },
              destination,
              timeout: 15000,
              set_tcp_nodelay: true
            });
            client.setSocket(socket);
            client.emit('connect');
          } catch (error) {
            client.emit('error', error);
          }
        };
      } else {
        this.log('warning', `代理节点未启动或不存在，已回退直连: ${this.config.proxyNodeId}`, '⚠');
      }
    }

    this.status.username = username;
    this.log('info', `正在连接 ${host}:${port} (用户: ${username})...`, '⚡');

    return new Promise((resolve, reject) => {
      try {
        botOptions = {
          host,
          port,
          username,
          version: version || undefined,
          auth: 'offline',
          connectTimeout: 15000,
          checkTimeoutInterval: 30000,
          connect: connectViaProxy || undefined,
          brand: 'vanilla',
          hideErrors: true,
          clientInformation: {
            chatVisibility: 'FULL',
            chatColors: true,
            skinParts: {
              showCape: true,
              showJacket: true,
              showLeftArm: true,
              showRightArm: true,
              showLeftPants: true,
              showRightPants: true,
              showHat: true
            },
            mainHand: 'right'
          }
        };

        this.bot = mineflayer.createBot(botOptions);
        const activeBot = this.bot;

        this.connectionTimeout = setTimeout(() => {
          if (this.bot && !this.status.connected) {
            this.log('error', '连接超时', '❌');
            reject(new Error('Connection timeout'));
            this.attemptRepair('连接超时');
          }
        }, 15000); // 15秒超时

        this.bot.loadPlugin(pathfinder);

        this.bot.on('login', () => {
          this.log('success', `登录成功 (${username})`, '✅');
          clearTimeout(this.connectionTimeout);
          this.isRepairing = false;
          this.reconnectAttempts = 0;
          this.usernameRetryCount = 0;
          this.updateActivity();
          this.startActivityMonitor();

          if (this.modes.autoChat) {
            this.startAutoChat();
          }
        });

        this.bot.once('spawn', () => {
          this.status.connected = true;
          this.status.serverAddress = `${host}${port ? `:${port}` : ''}`;
          this.status.version = this.bot.version;

          // 记录出生点用于巡逻
          if (this.bot.entity) {
            this.spawnPosition = this.bot.entity.position.clone();
            const pos = this.bot.entity.position;
            this.log('info', `进服坐标: X=${pos.x.toFixed(1)} Y=${pos.y.toFixed(1)} Z=${pos.z.toFixed(1)}`, '📍');
          }

          try {
            const movements = new Movements(this.bot, this.bot.registry);
            movements.canDig = false; // 禁止挖掘方块
            this.applyMovementSafety(movements);
            this.movements = movements;
            this.bot.pathfinder.setMovements(movements);
          } catch (e) {
            this.log('warning', '路径规划初始化失败', '⚠');
          }

          // 初始化行为管理器，传递日志函数以便巡逻等行为输出坐标
          const controller = {
            startPatrol: () => {
              this.stopConflictingModes('patrol');
              const waypoints = this.behaviorSettings.patrol?.waypoints || null;
              return this.behaviors?.patrol?.start(waypoints);
            },
            stopPatrol: () => this.behaviors?.patrol?.stop(),
            stopAllMovement: () => this.bot?.pathfinder?.stop?.()
          };
          this.behaviors = new BehaviorManager(
            this.bot,
            goals,
            this.log.bind(this),
            this.handleBehaviorAutoStop.bind(this),
            controller
          );

          this.log('success', `进入世界 (版本: ${this.bot.version})`, '✓');

          // 恢复之前开启的模式
          this.restoreModes();

          // 自动给机器人 OP 权限（通过翼龙面板）
          if (this.status.autoOp && this.status.pterodactyl && !this.hasAutoOpped) {
            this.autoOpSelf();
          }

          if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
          resolve();
        });

        this.bot.on('health', () => {
          this.status.health = this.bot.health;
          this.status.food = this.bot.food;
          this.updateActivity();
          if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
        });

        // 死亡自动重生
        this.bot.on('death', () => {
          if (this.bot !== activeBot) return;
          const now = Date.now();
          if (now - this.lastDeathHandledAt < 5000) return;
          this.lastDeathHandledAt = now;

          // 停止所有行为
          if (this.behaviors) {
            try {
              this.behaviors.stopAll();
            } catch (e) {
              this.log('error', `停止行为失败: ${e.message}`, '❌');
            }
          }
          if (this.respawnRequestTimer) {
            clearTimeout(this.respawnRequestTimer);
            this.respawnRequestTimer = null;
          }
          // 延迟一点再重生，避免太快
          const tryRespawn = (attempt = 1) => {
            if (this.bot !== activeBot) return;
            try {
              activeBot.respawn();
            } catch (e) {
              this.log('error', `重生失败 (尝试 ${attempt}): ${e.message}`, '❌');
              if (attempt < 3) {
                this.respawnRequestTimer = setTimeout(() => tryRespawn(attempt + 1), 1000);
              }
            }
          };
          this.respawnRequestTimer = setTimeout(() => tryRespawn(), 500);
        });

        this.bot.on('respawn', () => {
          if (this.bot !== activeBot) return;
          const now = Date.now();
          if (now - this.lastRespawnHandledAt < 3000) return;
          this.lastRespawnHandledAt = now;
          if (this.respawnRequestTimer) {
            clearTimeout(this.respawnRequestTimer);
            this.respawnRequestTimer = null;
          }

          // 更新出生点
          if (activeBot.entity) {
            this.spawnPosition = activeBot.entity.position.clone();
          }
          if (this.modes.invincible) {
            setTimeout(() => {
              if (this.bot === activeBot) this.applyInvincibleMode();
            }, 500);
          }
          if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
        });

        this.bot.on('move', () => {
          if (this.bot?.entity && this.status.connected) {
            this.status.position = this.bot.entity.position;
            this.updateActivity();
          }
        });

        this.bot.on('playerJoined', (player) => {
          if (this.bot) {
            this.status.players = Object.keys(this.bot.players);
            this.log('info', `${player.username} 加入`, '👋');
            if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
          }
        });

        this.bot.on('playerLeft', (player) => {
          if (this.bot) {
            this.status.players = Object.keys(this.bot.players);
            if (this.modes.follow && this.behaviors?.follow?.getStatus?.().target === player.username) {
              this.behaviors.follow.stop();
              this.modes.follow = false;
              this.bot.chat('跟随目标离开，停止跟随');
            }
            if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
          }
        });

        this.bot.on('chat', async (chatUsername, message) => {
          if (!this.bot || chatUsername === this.bot.username) return;
          this.updateActivity();
          this.log('chat', `${chatUsername}: ${message}`, '💬');

          if (message.startsWith('!')) {
            await this.handleCommand(chatUsername, message);
          }
        });

        this.bot.on('message', (jsonMsg) => {
          const text = jsonMsg.toString();
          this.recordServerMessage(text);
          this.handleCommandFeedback(text);
        });

        this.bot.on('error', (err) => {
          this.log('error', `错误: ${err.message}`, '✗');
          // 使用防重复重连
          this.attemptRepair(err.message);
        });

        this.bot.on('kicked', (reason) => {
          const reasonText = typeof reason === 'string' ? reason : JSON.stringify(reason);
          this.log('error', `被踢出: ${reasonText}`, '👢');
          this.status.connected = false;
          if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
          // 被踢出后重连
          this.attemptRepair(reasonText);
        });

        this.bot.on('end', () => {
          this.log('warning', '连接断开', '🔌');
          this.status.connected = false;
          this.bot = null;
          if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
          // 连接断开自动重连，除非是主动断开
          if (!this.destroyed) {
            this.attemptRepair('连接断开');
          }
        });

      } catch (error) {
        this.log('error', `连接失败: ${error.message}`, '✗');
        // 连接失败使用防重复重连
        this.attemptRepair(error.message);
        reject(error);
      }
    });
  }

  disconnect() {
    this.destroyed = true;
    this.isRepairing = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.cleanup();
    this.log('info', '已断开', '🔌');
    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
  }

  startAutoChat() {
    if (this.autoChatInterval) {
      clearInterval(this.autoChatInterval);
    }

    const messages = this.autoChatConfig.messages || ['Hello!'];
    const interval = this.autoChatConfig.interval || 60000;

    this.autoChatInterval = setInterval(() => {
      if (this.bot && this.modes.autoChat) {
        const msg = messages[Math.floor(Math.random() * messages.length)];
        this.bot.chat(msg);
        this.log('chat', `[自动] ${msg}`, '📢');
      }
    }, interval);
  }

  /**
   * 更新自动喊话配置
   */
  updateAutoChatConfig(config) {
    this.autoChatConfig = {
      ...this.autoChatConfig,
      ...config
    };
    this.config.autoChat = this.autoChatConfig;
    // 如果正在运行，重启以应用新配置
    if (this.modes.autoChat) {
      this.startAutoChat();
    }
    this.saveConfig();
    return this.autoChatConfig;
  }

  /**
   * 保存配置到 ConfigManager
   */
  saveConfig() {
    if (!this.configManager) return;

    try {
      const nextConfig = {
        ...this.config,
        modes: this.modes,
        commandSettings: this.commandSettings,
        autoChat: this.autoChatConfig,
        restartTimer: {
          enabled: this.status.restartTimer?.enabled || false,
          intervalMinutes: this.status.restartTimer?.intervalMinutes || 0,
          command: this.status.restartTimer?.command || '/restart'
        },
        pterodactyl: this.status.pterodactyl === null ? null : (this.status.pterodactyl || {}),
        rcon: this.status.rcon || {},
        sftp: this.status.sftp || {},
        fileAccessType: this.status.fileAccessType || 'pterodactyl',
        autoOp: this.status.autoOp,
        autoReconnect: this.status.autoReconnect,
        behaviorSettings: this.behaviorSettings
      };
      this.config = { ...this.config, ...nextConfig };
      this.configManager.updateServer(this.id, nextConfig);
      this.log('info', '配置已保存', '💾');
    } catch (error) {
      this.log('warning', `保存配置失败: ${error.message}`, '⚠');
    }
  }

  /**
   * 恢复之前开启的模式（重连后调用）
   */
  restoreModes() {
    if (!this.bot || !this.behaviors) return;

    // 稍微延迟一下，确保机器人完全初始化
    setTimeout(() => {
      try {
        if (this.modes.aiView) {
          this.behaviors.aiView.start();
          this.log('info', 'AI 视角已恢复', '👁️');
        }
      } catch (e) {
        this.log('warning', `AI 视角恢复失败: ${e.message}`, '⚠️');
      }

      try {
        if (this.modes.patrol) {
          if (this.spawnPosition) {
            this.behaviors.patrol.centerPos = this.spawnPosition.clone();
          }
          const result = this.behaviors.patrol.start();
          if (result.success) {
            this.log('info', '巡逻模式已恢复', '🚶');
          } else {
            this.log('warning', `巡逻模式恢复失败: ${result.message}`, '⚠️');
            this.modes.patrol = false;
          }
        }
      } catch (e) {
        this.log('warning', `巡逻模式恢复失败: ${e.message}`, '⚠️');
        this.modes.patrol = false;
      }

      try {
        if (this.modes.autoAttack) {
          this.behaviors.attack.start();
          this.log('info', '自动攻击已恢复', '⚔️');
        }
      } catch (e) {
        this.log('warning', `自动攻击恢复失败: ${e.message}`, '⚠️');
      }

      try {
        if (this.modes.antiAfk) {
          const options = this.behaviorSettings.antiAfk || {};
          this.behaviors.antiAfk.start(options);
          this.log('info', '防踢已恢复', '🟢');
        }
      } catch (e) {
        this.log('warning', `防踢恢复失败: ${e.message}`, '⚠️');
      }

      try {
        if (this.modes.autoEat) {
          const options = this.behaviorSettings.autoEat || {};
          this.behaviors.autoEat.start(options);
          this.log('info', '自动吃已恢复', '🍖');
        }
      } catch (e) {
        this.log('warning', `自动吃恢复失败: ${e.message}`, '⚠️');
      }

      try {
        if (this.modes.guard) {
          const options = this.behaviorSettings.guard || {};
          this.behaviors.guard.start(options);
          this.log('info', '守护已恢复', '🛡️');
        }
      } catch (e) {
        this.log('warning', `守护恢复失败: ${e.message}`, '⚠️');
      }

      try {
        if (this.modes.rateLimit) {
          const options = this.behaviorSettings.rateLimit || {};
          this.behaviors.rateLimit.start(options);
          this.log('info', '限速已恢复', '⏱️');
        }
      } catch (e) {
        this.log('warning', `限速恢复失败: ${e.message}`, '⚠️');
      }

      try {
        if (this.modes.playerLike) {
          const result = this.startPlayerLikeBehaviors();
          if (result.success) {
            this.log('info', '生存智能已恢复', '🧍');
          } else {
            this.log('warning', `生存智能恢复失败: ${result.message}`, '⚠️');
          }
        }
      } catch (e) {
        this.log('warning', `生存智能恢复失败: ${e.message}`, '⚠️');
      }

      try {
        if (!this.modes.playerLike && this.modes.humanize) {
          const options = this.behaviorSettings.humanize || {};
          this.behaviors.humanize.start(options);
          this.log('info', '拟人已恢复', '🧍');
        }
      } catch (e) {
        this.log('warning', `拟人恢复失败: ${e.message}`, '⚠️');
      }

      try {
        if (!this.modes.playerLike && this.modes.safeIdle) {
          const options = this.behaviorSettings.safeIdle || {};
          this.behaviors.safeIdle.start(options);
          this.log('info', '安全挂机已恢复', '⛺');
        }
      } catch (e) {
        this.log('warning', `安全挂机恢复失败: ${e.message}`, '⚠️');
      }

      try {
        if (this.modes.workflow) {
          const options = this.behaviorSettings.workflow || {};
          this.behaviors.workflow.start(options);
          this.log('info', '任务脚本已恢复', '🧭');
        }
      } catch (e) {
        this.log('warning', `任务脚本恢复失败: ${e.message}`, '⚠️');
      }

      try {
        if (this.modes.invincible) {
          // 使用面板控制台发送创造模式命令（确保有权限）
          this.applyInvincibleMode();
        }
      } catch (e) {
        this.log('warning', `无敌模式恢复失败: ${e.message}`, '⚠️');
      }

      try {
        if (this.modes.autoChat) {
          this.startAutoChat();
          this.log('info', '自动喊话已恢复', '💬');
        }
      } catch (e) {
        this.log('warning', `自动喊话恢复失败: ${e.message}`, '⚠️');
      }
    }, 2000);
  }

  setMode(mode, enabled) {
    if (mode in this.modes) {
      this.modes[mode] = enabled;
      this.config.modes = { ...this.modes };
      if (mode === 'autoChat') {
        if (enabled) {
          this.startAutoChat();
        } else if (this.autoChatInterval) {
          clearInterval(this.autoChatInterval);
          this.autoChatInterval = null;
        }
      }
      // AI 视角模式
      if (mode === 'aiView' && this.behaviors) {
        if (enabled) {
          this.behaviors.aiView.start();
          this.log('info', 'AI 视角已开启', '👁️');
        } else {
          this.behaviors.aiView.stop();
          this.log('info', 'AI 视角已关闭', '👁️');
        }
      }
      // 巡逻模式
      if (mode === 'patrol' && this.behaviors) {
        if (enabled) {
          this.stopConflictingModes('patrol');
          // 使用出生点作为巡逻中心
          if (this.spawnPosition) {
            this.behaviors.patrol.centerPos = this.spawnPosition.clone();
          }
          this.behaviors.patrol.start();
          this.log('info', '巡逻模式已开启', '🚶');
        } else {
          this.behaviors.patrol.stop();
          this.log('info', '巡逻模式已关闭', '🚶');
        }
      }
      // 无敌模式 - 使用创造模式实现真正无敌
      if (mode === 'invincible' && this.bot) {
        if (enabled) {
          this.applyInvincibleMode();
        } else {
          this.disableInvincibleMode();
        }
      }
      // 保存模式设置到配置
      this.saveConfig();
      if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
    }
  }

  /**
   * 设置定时发送 /restart 命令
   * @param {number} minutes - 间隔分钟数，0 表示禁用
   */
  setRestartTimer(minutes) {
    // 清除现有定时器
    if (this.restartCommandTimer) {
      clearInterval(this.restartCommandTimer);
      this.restartCommandTimer = null;
    }

    if (minutes > 0 && this.bot) {
      const intervalMs = minutes * 60 * 1000;
      const nextRestart = new Date(Date.now() + intervalMs);

      this.status.restartTimer = {
        enabled: true,
        intervalMinutes: minutes,
        nextRestart: nextRestart.toISOString()
      };

      this.restartCommandTimer = setInterval(() => {
        if (this.bot && this.status.connected) {
          this.bot.chat('/restart');
          this.log('info', '执行定时重启命令 /restart', '⏰');
          // 更新下次重启时间
          this.status.restartTimer.nextRestart = new Date(Date.now() + intervalMs).toISOString();
          if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
        }
      }, intervalMs);

      this.log('info', `定时重启已设置: 每 ${minutes} 分钟执行 /restart`, '⏰');
    } else {
      this.status.restartTimer = {
        enabled: false,
        intervalMinutes: 0,
        nextRestart: null
      };
      this.log('info', '定时重启已禁用', '⏰');
    }

    this.config.restartTimer = {
      enabled: this.status.restartTimer?.enabled || false,
      intervalMinutes: this.status.restartTimer?.intervalMinutes || 0,
      command: this.status.restartTimer?.command || '/restart'
    };
    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
    // 保存配置
    this.saveConfig();
    return this.status.restartTimer;
  }

  /**
   * 立即发送 /restart 命令
   */
  sendRestartCommand() {
    if (this.bot && this.status.connected) {
      this.bot.chat('/restart');
      this.log('info', '立即发送 /restart 命令', '⚡');
      return { success: true, message: '已发送 /restart' };
    }
    return { success: false, message: 'Bot 未连接' };
  }

  /**
   * 通过翼龙面板发送控制台命令
   */
  async sendPanelCommand(command) {
    const panel = this.status.pterodactyl;
    const hasPanel = panel && panel.url && panel.apiKey && panel.serverId;
    if (!hasPanel) {
      return this.sendRconCommand(command);
    }

    try {
      const url = `${panel.url}/api/client/servers/${panel.serverId}/command`;
      this.log('info', `正在发送面板命令: ${command} -> ${url}`, '🖥️');

      const response = await axios.post(url, { command }, {
        headers: {
          'Authorization': `Bearer ${panel.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 10000 // 10秒超时
      });

      this.log('success', `面板命令已发送: ${command}`, '🖥️');
      return { success: true, message: `已发送: ${command}` };
    } catch (error) {
      const status = error.response?.status;
      const errDetail = error.response?.data?.errors?.[0]?.detail;
      const errMsg = errDetail || error.response?.data?.message || error.message;

      // 打印完整响应用于调试
      console.log('[Panel API Error]', {
        status,
        data: error.response?.data,
        headers: error.response?.headers
      });

      let hint = '';
      if (status === 403) {
        hint = ' (检查: API Key是否有效、IP是否被限制、账号是否有该服务器权限)';
      } else if (status === 404) {
        hint = ' (检查: 服务器ID是否正确)';
      }

      this.log('error', `面板命令失败 [${status}]: ${errMsg}${hint}`, '✗');
      if (this.status.rcon?.enabled) {
        this.log('warning', '面板命令失败，尝试使用 RCON...', '⚠');
        return this.sendRconCommand(command);
      }
      return { success: false, message: `${errMsg}${hint}` };
    }
  }

  async sendRconCommand(command) {
    const rcon = this.status.rcon;
    if (!rcon || !rcon.enabled || !rcon.host || !rcon.port || !rcon.password) {
      return { success: false, message: 'RCON 未配置' };
    }

    try {
      const { Rcon } = await import('rcon-client');
      const client = await Rcon.connect({
        host: rcon.host,
        port: rcon.port,
        password: rcon.password,
        timeout: 8000
      });
      const response = await client.send(command);
      await client.end();
      this.log('success', `RCON 命令已发送: ${command}`, '🛰️');
      return { success: true, message: response || `已发送: ${command}` };
    } catch (error) {
      const errMsg = error?.message || 'RCON 命令失败';
      this.log('error', `RCON 命令失败: ${errMsg}`, '✗');
      return { success: false, message: errMsg };
    }
  }

  async testRconConnection() {
    const rcon = this.status.rcon;
    if (!rcon || !rcon.enabled || !rcon.host || !rcon.port || !rcon.password) {
      return { success: false, message: 'RCON 未配置' };
    }

    try {
      const { Rcon } = await import('rcon-client');
      const client = await Rcon.connect({
        host: rcon.host,
        port: rcon.port,
        password: rcon.password,
        timeout: 8000
      });
      const response = await client.send('list');
      await client.end();
      return { success: true, message: response || 'RCON 连接成功' };
    } catch (error) {
      const errMsg = error?.message || 'RCON 连接失败';
      return { success: false, message: errMsg };
    }
  }

  /**
   * 自动给机器人 OP 权限
   */
  async autoOpSelf() {
    if (!this.status.username) {
      this.log('warning', '无法自动OP：用户名未知', '⚠');
      return;
    }

    const result = await this.sendPanelCommand(`op ${this.status.username}`);
    if (result.success) {
      this.hasAutoOpped = true;
      this.log('success', `已自动授予 OP 权限: ${this.status.username}`, '👑');
    }
  }

  /**
   * 应用无敌模式 - 优先使用面板控制台，否则使用机器人聊天
   */
  async applyInvincibleMode() {
    if (!this.bot || !this.status.username) return;

    const username = this.status.username;

    // 优先尝试通过面板控制台发送命令（有完整权限）
    if (this.status.pterodactyl?.url && this.status.pterodactyl?.apiKey) {
      const result = await this.sendPanelCommand(`gamemode creative ${username}`);
      if (result.success) {
        this.log('success', '无敌模式已开启 (创造模式 - 通过面板)', '🛡️');
        return;
      }
      this.log('warning', '面板命令失败，尝试使用机器人命令...', '⚠');
    }

    // 回退：通过机器人聊天发送命令
    this.bot.chat(`/gamemode creative ${username}`);
    this.log('info', '无敌模式命令已发送 (创造模式)', '🛡️');
  }

  /**
   * 关闭无敌模式
   */
  async disableInvincibleMode() {
    if (!this.bot || !this.status.username) return;

    const username = this.status.username;
    const fallbackMode = 'survival';

    // 优先尝试通过面板控制台发送命令
    if (this.status.pterodactyl?.url && this.status.pterodactyl?.apiKey) {
      const result = await this.sendPanelCommand(`gamemode ${fallbackMode} ${username}`);
      if (result.success) {
        this.log('success', `无敌模式已关闭 (${fallbackMode} - 通过面板)`, '🛡️');
        return;
      }
    }

    // 回退：通过机器人聊天发送命令
    this.bot.chat(`/gamemode ${fallbackMode} ${username}`);
    this.log('info', `无敌模式已关闭 (${fallbackMode})`, '🛡️');
  }

  /**
   * 设置翼龙面板配置
   */
  setPterodactylConfig(config) {
    const url = (config.url || '').replace(/\/$/, '');
    const apiKey = config.apiKey || '';
    const cookie = config.cookie || '';
    const csrfToken = config.csrfToken || '';
    const authType = config.authType || 'api';
    const ignoreTlsError = config.ignoreTlsError === true || config.ignoreTlsError === 'true';
    const serverId = config.serverId || '';

    const oldPterodactyl = this.status.pterodactyl;

    if (!url && !apiKey && !cookie && !serverId) {
      this.status.pterodactyl = null;
      this.config.pterodactyl = null;
      this.log('info', '翼龙面板配置已清除', '🔑');
    } else {
      this.status.pterodactyl = { url, apiKey, cookie, csrfToken, authType, ignoreTlsError, serverId };
      if (config.autoRestart) {
        // Ensure types are correct
        this.status.pterodactyl.autoRestart = {
          enabled: config.autoRestart.enabled === true || config.autoRestart.enabled === 'true',
          maxRetries: parseInt(config.autoRestart.maxRetries) || 3
        };
      } else if (oldPterodactyl?.autoRestart) {
        this.status.pterodactyl.autoRestart = oldPterodactyl.autoRestart;
      }
      this.config.pterodactyl = this.status.pterodactyl;
      this.log('info', `翼龙面板配置已更新 [${authType === 'cookie' ? 'Cookie' : 'API Key'}]`, '🔑');
    }

    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
    // 保存配置
    this.saveConfig();
    return this.status.pterodactyl;
  }

  /**
   * 设置 RCON 配置
   */
  setRconConfig(config) {
    const host = (config.host || '').trim();
    const port = Number(config.port) || 25575;
    const password = config.password || '';
    const enabled = config.enabled === true || config.enabled === 'true';

    if (!enabled && !host && !password) {
      this.status.rcon = { enabled: false, host: '', port: 25575, password: '' };
      this.config.rcon = this.status.rcon;
      this.log('info', 'RCON 配置已清除', '🛰️');
    } else {
      this.status.rcon = { enabled, host, port, password };
      this.config.rcon = this.status.rcon;
      this.log('info', `RCON 配置已更新 [${enabled ? '启用' : '停用'}]`, '🛰️');
    }

    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
    this.saveConfig();
    return this.status.rcon;
  }

  /**
   * 发送翼龙面板电源信号
   * @param {string} signal - 电源信号: 'start' | 'stop' | 'restart' | 'kill'
   */
  async sendPowerSignal(signal) {
    const validSignals = ['start', 'stop', 'restart', 'kill'];
    if (!validSignals.includes(signal)) {
      return { success: false, message: `无效的电源信号，可选: ${validSignals.join(', ')}` };
    }

    const panel = this.status.pterodactyl;
    if (!this.isPanelConfigured()) {
      return { success: false, message: '翼龙面板未配置' };
    }

    const signalNames = {
      'start': '开机',
      'stop': '关机',
      'restart': '重启',
      'kill': '强制终止'
    };

    const urls = [
      `${panel.url}/api/client/servers/${panel.serverId}/power`,
      `${panel.url}/api/servers/${panel.serverId}/power`
    ];

    let lastError = null;
    for (const url of urls) {
      try {
        this.log('info', `正在发送电源信号: ${signalNames[signal]} -> ${url}`, '⚡');

        await axios.post(url, { signal }, this.getPanelHttpOptions());

        this.log('success', `电源信号已发送: ${signalNames[signal]}`, '⚡');
        return { success: true, message: `已发送: ${signalNames[signal]}` };
      } catch (error) {
        lastError = error;
        if (error.response?.status !== 404 || url === urls[urls.length - 1]) {
          break;
        }
        this.log('warning', '标准翼龙电源接口不可用，尝试 Minerack 兼容接口', '⚡');
      }
    }

    const status = lastError?.response?.status;
    const errDetail = lastError?.response?.data?.errors?.[0]?.detail;
    const errMsg = errDetail || lastError?.response?.data?.message || lastError?.message;

    console.log('[Power API Debug]', {
      status,
      authType: panel.authType || 'api',
      response: lastError?.response?.data
    });

    let hint = '';
    if (status === 403) {
      hint = panel.authType === 'cookie'
        ? ' (Cookie 登录已失效或账号权限不足)'
        : ' (403常见原因: 1.需要Client API Key而非Application API Key 2.API Key需在面板Account→API Credentials创建 3.检查Key是否有该服务器权限)';
    } else if (status === 404) {
      hint = ' (检查: 服务器ID应为短ID如c5281c3e，或面板接口路径不兼容)';
    } else if (status === 409) {
      hint = ' (服务器状态冲突，可能已在运行或已停止)';
    } else if (status === 401 || status === 419) {
      hint = panel.authType === 'cookie' ? ' (Cookie/CSRF 已失效，请重新从面板复制)' : ' (API Key无效或已过期)';
    }

    this.log('error', `电源信号失败 [${status}]: ${errMsg}${hint}`, '✗');
    return { success: false, message: `${errMsg}${hint}` };
  }

  // ==================== 文件管理 API ====================

  /**
   * 列出目录文件
   * @param {string} directory - 目录路径，默认为根目录
   */
  async listFiles(directory = '/') {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.apiKey || !panel.serverId) {
      return { success: false, error: '翼龙面板未配置' };
    }

    try {
      const url = `${panel.url}/api/client/servers/${panel.serverId}/files/list`;
      const response = await axios.get(url, {
        params: { directory },
        headers: {
          'Authorization': `Bearer ${panel.apiKey}`,
          'Accept': 'application/json'
        },
        timeout: 15000
      });

      const files = response.data.data.map(item => ({
        name: item.attributes.name,
        mode: item.attributes.mode,
        size: item.attributes.size,
        isFile: item.attributes.is_file,
        isSymlink: item.attributes.is_symlink,
        isEditable: item.attributes.is_editable,
        mimetype: item.attributes.mimetype,
        createdAt: item.attributes.created_at,
        modifiedAt: item.attributes.modified_at
      }));

      return { success: true, files, directory };
    } catch (error) {
      const errMsg = error.response?.data?.errors?.[0]?.detail || error.message;
      this.log('error', `列出文件失败: ${errMsg}`, '❌');
      return { success: false, error: errMsg };
    }
  }

  /**
   * 获取文件内容
   * @param {string} file - 文件路径
   */
  async getFileContents(file) {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.apiKey || !panel.serverId) {
      return { success: false, error: '翼龙面板未配置' };
    }

    try {
      const url = `${panel.url}/api/client/servers/${panel.serverId}/files/contents`;
      const response = await axios.get(url, {
        params: { file },
        headers: {
          'Authorization': `Bearer ${panel.apiKey}`,
          'Accept': 'application/json'
        },
        timeout: 30000
      });

      return { success: true, content: response.data, file };
    } catch (error) {
      const errMsg = error.response?.data?.errors?.[0]?.detail || error.message;
      this.log('error', `读取文件失败: ${errMsg}`, '❌');
      return { success: false, error: errMsg };
    }
  }

  /**
   * 写入文件内容
   * @param {string} file - 文件路径
   * @param {string} content - 文件内容
   */
  async writeFile(file, content) {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.apiKey || !panel.serverId) {
      return { success: false, error: '翼龙面板未配置' };
    }

    try {
      const url = `${panel.url}/api/client/servers/${panel.serverId}/files/write`;
      await axios.post(url, content, {
        params: { file },
        headers: {
          'Authorization': `Bearer ${panel.apiKey}`,
          'Content-Type': 'text/plain',
          'Accept': 'application/json'
        },
        timeout: 30000
      });

      this.log('success', `文件已保存: ${file}`, '💾');
      return { success: true, message: '文件已保存' };
    } catch (error) {
      const errMsg = error.response?.data?.errors?.[0]?.detail || error.message;
      this.log('error', `保存文件失败: ${errMsg}`, '❌');
      return { success: false, error: errMsg };
    }
  }

  /**
   * 获取文件下载链接
   * @param {string} file - 文件路径
   */
  async getDownloadUrl(file) {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.apiKey || !panel.serverId) {
      return { success: false, error: '翼龙面板未配置' };
    }

    try {
      const url = `${panel.url}/api/client/servers/${panel.serverId}/files/download`;
      const response = await axios.get(url, {
        params: { file },
        headers: {
          'Authorization': `Bearer ${panel.apiKey}`,
          'Accept': 'application/json'
        },
        timeout: 15000
      });

      return { success: true, url: response.data.attributes.url };
    } catch (error) {
      const errMsg = error.response?.data?.errors?.[0]?.detail || error.message;
      this.log('error', `获取下载链接失败: ${errMsg}`, '❌');
      return { success: false, error: errMsg };
    }
  }

  /**
   * 获取上传链接
   */
  async getUploadUrl() {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.apiKey || !panel.serverId) {
      return { success: false, error: '翼龙面板未配置' };
    }

    try {
      const url = `${panel.url}/api/client/servers/${panel.serverId}/files/upload`;
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${panel.apiKey}`,
          'Accept': 'application/json'
        },
        timeout: 15000
      });

      return { success: true, url: response.data.attributes.url };
    } catch (error) {
      const errMsg = error.response?.data?.errors?.[0]?.detail || error.message;
      this.log('error', `获取上传链接失败: ${errMsg}`, '❌');
      return { success: false, error: errMsg };
    }
  }

  /**
   * 创建文件夹
   * @param {string} root - 父目录
   * @param {string} name - 文件夹名称
   */
  async createFolder(root, name) {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.apiKey || !panel.serverId) {
      return { success: false, error: '翼龙面板未配置' };
    }

    try {
      const url = `${panel.url}/api/client/servers/${panel.serverId}/files/create-folder`;
      await axios.post(url, { root, name }, {
        headers: {
          'Authorization': `Bearer ${panel.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 15000
      });

      this.log('success', `文件夹已创建: ${root}${name}`, '📁');
      return { success: true, message: '文件夹已创建' };
    } catch (error) {
      const errMsg = error.response?.data?.errors?.[0]?.detail || error.message;
      this.log('error', `创建文件夹失败: ${errMsg}`, '❌');
      return { success: false, error: errMsg };
    }
  }

  /**
   * 删除文件/文件夹
   * @param {string} root - 目录
   * @param {string[]} files - 要删除的文件名列表
   */
  async deleteFiles(root, files) {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.apiKey || !panel.serverId) {
      return { success: false, error: '翼龙面板未配置' };
    }

    try {
      const url = `${panel.url}/api/client/servers/${panel.serverId}/files/delete`;
      await axios.post(url, { root, files }, {
        headers: {
          'Authorization': `Bearer ${panel.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000
      });

      this.log('success', `已删除 ${files.length} 个文件`, '🗑️');
      return { success: true, message: `已删除 ${files.length} 个文件` };
    } catch (error) {
      const errMsg = error.response?.data?.errors?.[0]?.detail || error.message;
      this.log('error', `删除文件失败: ${errMsg}`, '❌');
      return { success: false, error: errMsg };
    }
  }

  /**
   * 重命名文件/文件夹
   * @param {string} root - 目录
   * @param {string} from - 原名称
   * @param {string} to - 新名称
   */
  async renameFile(root, from, to) {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.apiKey || !panel.serverId) {
      return { success: false, error: '翼龙面板未配置' };
    }

    try {
      const url = `${panel.url}/api/client/servers/${panel.serverId}/files/rename`;
      await axios.put(url, {
        root,
        files: [{ from, to }]
      }, {
        headers: {
          'Authorization': `Bearer ${panel.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 15000
      });

      this.log('success', `已重命名: ${from} -> ${to}`, '✏️');
      return { success: true, message: '重命名成功' };
    } catch (error) {
      const errMsg = error.response?.data?.errors?.[0]?.detail || error.message;
      this.log('error', `重命名失败: ${errMsg}`, '❌');
      return { success: false, error: errMsg };
    }
  }

  /**
   * 复制文件
   * @param {string} location - 文件路径
   */
  async copyFile(location) {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.apiKey || !panel.serverId) {
      return { success: false, error: '翼龙面板未配置' };
    }

    try {
      const url = `${panel.url}/api/client/servers/${panel.serverId}/files/copy`;
      await axios.post(url, { location }, {
        headers: {
          'Authorization': `Bearer ${panel.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000
      });

      this.log('success', `已复制: ${location}`, '📋');
      return { success: true, message: '复制成功' };
    } catch (error) {
      const errMsg = error.response?.data?.errors?.[0]?.detail || error.message;
      this.log('error', `复制失败: ${errMsg}`, '❌');
      return { success: false, error: errMsg };
    }
  }

  /**
   * 压缩文件
   * @param {string} root - 目录
   * @param {string[]} files - 要压缩的文件列表
   */
  async compressFiles(root, files) {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.apiKey || !panel.serverId) {
      return { success: false, error: '翼龙面板未配置' };
    }

    try {
      const url = `${panel.url}/api/client/servers/${panel.serverId}/files/compress`;
      const response = await axios.post(url, { root, files }, {
        headers: {
          'Authorization': `Bearer ${panel.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 120000
      });

      const archiveName = response.data.attributes.name;
      this.log('success', `已压缩为: ${archiveName}`, '📦');
      return { success: true, archive: archiveName };
    } catch (error) {
      const errMsg = error.response?.data?.errors?.[0]?.detail || error.message;
      this.log('error', `压缩失败: ${errMsg}`, '❌');
      return { success: false, error: errMsg };
    }
  }

  /**
   * 解压文件
   * @param {string} root - 目录
   * @param {string} file - 压缩包名称
   */
  async decompressFile(root, file) {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.apiKey || !panel.serverId) {
      return { success: false, error: '翼龙面板未配置' };
    }

    try {
      const url = `${panel.url}/api/client/servers/${panel.serverId}/files/decompress`;
      await axios.post(url, { root, file }, {
        headers: {
          'Authorization': `Bearer ${panel.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 120000
      });

      this.log('success', `已解压: ${file}`, '📂');
      return { success: true, message: '解压成功' };
    } catch (error) {
      const errMsg = error.response?.data?.errors?.[0]?.detail || error.message;
      this.log('error', `解压失败: ${errMsg}`, '❌');
      return { success: false, error: errMsg };
    }
  }

  async handleCommand(username, message) {
    const parts = message.trim().split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (this.commands[cmd]) {
      try {
        if (!this.isCommandAllowed(username)) {
          if (this.bot && !this.commandSettings.silentReject) {
            this.bot.chat('你没有权限使用指令');
          }
          return;
        }
        if (this.isUserCommandThrottled(username)) {
          if (this.bot && !this.commandSettings.silentReject) {
            this.bot.chat('指令过于频繁，请稍后再试');
          }
          return;
        }
        if (this.isCommandOnCooldown(username, cmd)) {
          if (this.bot && !this.commandSettings.silentReject) {
            this.bot.chat('指令冷却中，请稍后再试');
          }
          return;
        }
        await this.commands[cmd](username, args);
      } catch (error) {
        this.log('error', `指令失败: ${error.message}`, '✗');
      }
    }
  }

  isCommandAllowed(username) {
    if (this.commandSettings.allowAll) return true;
    const whitelist = Array.isArray(this.commandSettings.whitelist) ? this.commandSettings.whitelist : [];
    const lowered = whitelist.map(name => String(name).toLowerCase());
    return lowered.includes(String(username).toLowerCase());
  }

  isCommandOnCooldown(username, cmd) {
    const cooldown = Number(this.commandSettings.cooldownSeconds) || 0;
    if (cooldown <= 0) return false;
    const key = `${username}:${cmd}`;
    const now = Date.now();
    const last = this.commandCooldowns.get(key) || 0;
    if (now - last < cooldown * 1000) {
      return true;
    }
    this.commandCooldowns.set(key, now);
    return false;
  }

  isUserCommandThrottled(username) {
    const now = Date.now();
    const globalCooldown = Number(this.commandSettings.globalCooldownSeconds) || 0;
    if (globalCooldown > 0) {
      const last = this.commandUserCooldowns.get(username) || 0;
      if (now - last < globalCooldown * 1000) {
        return true;
      }
      this.commandUserCooldowns.set(username, now);
    }

    const maxPerMinute = Number(this.commandSettings.maxPerMinute) || 0;
    if (maxPerMinute > 0) {
      const window = this.commandUserWindows.get(username) || { start: now, count: 0 };
      if (now - window.start > 60000) {
        window.start = now;
        window.count = 0;
      }
      if (window.count >= maxPerMinute) {
        this.commandUserWindows.set(username, window);
        return true;
      }
      window.count += 1;
      this.commandUserWindows.set(username, window);
    }

    return false;
  }

  startPlayerLikeBehaviors() {
    if (!this.behaviors) return { success: false, message: 'Bot 未连接' };
    const humanizeOptions = this.behaviorSettings.humanize || {};
    const safeIdleOptions = this.behaviorSettings.safeIdle || {};
    const guardOptions = this.behaviorSettings.guard || {};
    const humanizeResult = this.behaviors.humanize.active
      ? { success: true, message: '拟人已在运行' }
      : this.behaviors.humanize.start(humanizeOptions);
    const safeIdleResult = this.behaviors.safeIdle.active
      ? { success: true, message: '安全挂机已在运行' }
      : this.behaviors.safeIdle.start(safeIdleOptions);
    const guardWasActive = this.behaviors.guard.active;
    const guardResult = guardWasActive
      ? { success: true, message: '守护已在运行' }
      : this.behaviors.guard.start({ ...guardOptions, keepFightingAtLowHealth: true });
    this.playerLikeStartedGuard = !guardWasActive && guardResult.success;

    if (!humanizeResult.success && !safeIdleResult.success && !guardResult.success) {
      return { success: false, message: `${humanizeResult.message}; ${safeIdleResult.message}; ${guardResult.message}` };
    }

    return { success: true, message: '生存智能已开启，已启用防怪守护' };
  }

  stopPlayerLikeBehaviors() {
    if (!this.behaviors) return { success: false, message: 'Bot 未连接' };
    if (this.behaviors.humanize.active) this.behaviors.humanize.stop();
    if (this.behaviors.safeIdle.active) this.behaviors.safeIdle.stop();
    if (this.playerLikeStartedGuard && this.behaviors.guard.active) {
      this.behaviors.guard.stop();
      this.playerLikeStartedGuard = false;
    }
    return { success: true, message: '生存智能已关闭' };
  }

  stopMode(mode) {
    if (!this.behaviors) return;
    switch (mode) {
      case 'follow':
        this.behaviors.follow.stop();
        this.modes.follow = false;
        break;
      case 'attack':
        this.behaviors.attack.stop();
        this.modes.autoAttack = false;
        break;
      case 'patrol':
        this.behaviors.patrol.stop();
        this.modes.patrol = false;
        break;
      case 'guard':
        this.behaviors.guard.stop();
        this.modes.guard = false;
        break;
      case 'humanize':
        this.behaviors.humanize.stop();
        this.modes.humanize = false;
        break;
      case 'safeIdle':
        this.behaviors.safeIdle.stop();
        this.modes.safeIdle = false;
        break;
      case 'playerLike':
        this.stopPlayerLikeBehaviors();
        this.modes.playerLike = false;
        break;
      case 'workflow':
        this.behaviors.workflow.stop();
        this.modes.workflow = false;
        break;
      default:
        return;
    }
  }

  stopConflictingModes(target) {
    const conflicts = {
      follow: ['patrol'],
      patrol: ['follow', 'attack'],
      attack: ['patrol'],
      guard: ['follow', 'patrol', 'attack']
    };

    const toStop = conflicts[target] || [];
    toStop.forEach(mode => {
      if (mode === 'follow' && this.modes.follow) this.stopMode('follow');
      if (mode === 'patrol' && this.modes.patrol) this.stopMode('patrol');
      if (mode === 'attack' && this.modes.autoAttack) this.stopMode('attack');
      if (mode === 'guard' && this.modes.guard) this.stopMode('guard');
    });
  }

  handleBehaviorAutoStop(behavior, reason) {
    const messages = {
      follow: { target_lost: '跟随目标已离开，自动停止跟随' },
      attack: { low_health: '生命值过低，自动停止攻击' },
      guard: { low_health: '生命值过低，自动停止守护' }
    };

    if (behavior === 'follow') this.modes.follow = false;
    if (behavior === 'attack') this.modes.autoAttack = false;
    if (behavior === 'guard') this.modes.guard = false;
    if (behavior === 'antiAfk') this.modes.antiAfk = false;
    if (behavior === 'autoEat') this.modes.autoEat = false;
    if (behavior === 'rateLimit') this.modes.rateLimit = false;
    if (behavior === 'humanize') this.modes.humanize = false;
    if (behavior === 'safeIdle') this.modes.safeIdle = false;
    if (behavior === 'playerLike') this.modes.playerLike = false;
    if (behavior === 'workflow') this.modes.workflow = false;

    const msg = messages[behavior]?.[reason];
    if (msg && this.bot) {
      this.bot.chat(msg);
    }
    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
  }

  updateBehaviorSettings(settings = {}) {
    const next = {
      attack: { ...(this.behaviorSettings.attack || {}) },
      patrol: { ...(this.behaviorSettings.patrol || {}) },
      antiAfk: { ...(this.behaviorSettings.antiAfk || {}) },
      autoEat: { ...(this.behaviorSettings.autoEat || {}) },
      guard: { ...(this.behaviorSettings.guard || {}) },
      rateLimit: { ...(this.behaviorSettings.rateLimit || {}) },
      humanize: { ...(this.behaviorSettings.humanize || {}) },
      safeIdle: { ...(this.behaviorSettings.safeIdle || {}) },
      workflow: { ...(this.behaviorSettings.workflow || {}) },
      pathSafety: { ...(this.behaviorSettings.pathSafety || {}) }
    };

    if (settings.attack) {
      if (Array.isArray(settings.attack.whitelist)) {
        next.attack.whitelist = settings.attack.whitelist
          .map(name => String(name).trim())
          .filter(name => name);
      }
      if (settings.attack.minHealth !== undefined) {
        const minHealth = Number(settings.attack.minHealth);
        if (!Number.isNaN(minHealth) && minHealth >= 0) {
          next.attack.minHealth = minHealth;
        }
      }
    }

    if (settings.patrol) {
      if (Array.isArray(settings.patrol.waypoints)) {
        next.patrol.waypoints = settings.patrol.waypoints
          .map(point => ({
            x: Number(point.x),
            y: Number(point.y),
            z: Number(point.z)
          }))
          .filter(point => !Number.isNaN(point.x) && !Number.isNaN(point.y) && !Number.isNaN(point.z));
      }
    }

    if (settings.antiAfk) {
      const intervalSeconds = Number(settings.antiAfk.intervalSeconds);
      const jitterSeconds = Number(settings.antiAfk.jitterSeconds);
      if (!Number.isNaN(intervalSeconds)) {
        next.antiAfk.intervalSeconds = Math.max(5, intervalSeconds);
      }
      if (!Number.isNaN(jitterSeconds)) {
        next.antiAfk.jitterSeconds = Math.max(0, jitterSeconds);
      }
    }

    if (settings.autoEat) {
      const minHealth = Number(settings.autoEat.minHealth);
      const minFood = Number(settings.autoEat.minFood);
      if (!Number.isNaN(minHealth)) {
        next.autoEat.minHealth = Math.max(0, minHealth);
      }
      if (!Number.isNaN(minFood)) {
        next.autoEat.minFood = Math.max(0, minFood);
      }
    }

    if (settings.guard) {
      const radius = Number(settings.guard.radius);
      const attackRange = Number(settings.guard.attackRange);
      const minHealth = Number(settings.guard.minHealth);
      const pathCooldownMs = Number(settings.guard.pathCooldownMs);
      if (!Number.isNaN(radius)) next.guard.radius = Math.max(2, radius);
      if (!Number.isNaN(attackRange)) next.guard.attackRange = Math.max(2, attackRange);
      if (!Number.isNaN(minHealth)) next.guard.minHealth = Math.max(0, minHealth);
      if (!Number.isNaN(pathCooldownMs)) next.guard.pathCooldownMs = Math.max(300, pathCooldownMs);
    }

    if (settings.rateLimit) {
      const globalCooldownSeconds = Number(settings.rateLimit.globalCooldownSeconds);
      const maxPerMinute = Number(settings.rateLimit.maxPerMinute);
      if (!Number.isNaN(globalCooldownSeconds)) next.rateLimit.globalCooldownSeconds = Math.max(0, globalCooldownSeconds);
      if (!Number.isNaN(maxPerMinute)) next.rateLimit.maxPerMinute = Math.max(0, maxPerMinute);
    }

    if (settings.humanize) {
      const intervalSeconds = Number(settings.humanize.intervalSeconds);
      const lookRange = Number(settings.humanize.lookRange);
      const actionChance = Number(settings.humanize.actionChance);
      const stepChance = Number(settings.humanize.stepChance);
      const sneakChance = Number(settings.humanize.sneakChance);
      const swingChance = Number(settings.humanize.swingChance);
      const stepDurationMinMs = Number(settings.humanize.stepDurationMinMs);
      const stepDurationMaxMs = Number(settings.humanize.stepDurationMaxMs);
      const nearbyPlayerRange = Number(settings.humanize.nearbyPlayerRange);
      const approachPlayerRange = Number(settings.humanize.approachPlayerRange);
      const approachStopDistance = Number(settings.humanize.approachStopDistance);
      const playerReactionIntervalSeconds = Number(settings.humanize.playerReactionIntervalSeconds);
      const playerActionChance = Number(settings.humanize.playerActionChance);
      const approachChance = Number(settings.humanize.approachChance);
      const greetingChance = Number(settings.humanize.greetingChance);
      const greetingGlobalCooldownSeconds = Number(settings.humanize.greetingGlobalCooldownSeconds);
      const greetingPlayerCooldownSeconds = Number(settings.humanize.greetingPlayerCooldownSeconds);
      if (!Number.isNaN(intervalSeconds)) next.humanize.intervalSeconds = Math.max(5, intervalSeconds);
      if (!Number.isNaN(lookRange)) next.humanize.lookRange = Math.max(2, lookRange);
      if (!Number.isNaN(actionChance)) next.humanize.actionChance = Math.min(1, Math.max(0, actionChance));
      if (!Number.isNaN(stepChance)) next.humanize.stepChance = Math.min(1, Math.max(0, stepChance));
      if (!Number.isNaN(sneakChance)) next.humanize.sneakChance = Math.min(1, Math.max(0, sneakChance));
      if (!Number.isNaN(swingChance)) next.humanize.swingChance = Math.min(1, Math.max(0, swingChance));
      if (!Number.isNaN(stepDurationMinMs)) next.humanize.stepDurationMinMs = Math.max(150, stepDurationMinMs);
      if (!Number.isNaN(stepDurationMaxMs)) next.humanize.stepDurationMaxMs = Math.max(next.humanize.stepDurationMinMs || 150, stepDurationMaxMs);
      if (typeof settings.humanize.jumpUpEnabled === 'boolean') next.humanize.jumpUpEnabled = settings.humanize.jumpUpEnabled;
      if (!Number.isNaN(nearbyPlayerRange)) next.humanize.nearbyPlayerRange = Math.max(3, nearbyPlayerRange);
      if (!Number.isNaN(approachPlayerRange)) next.humanize.approachPlayerRange = Math.max(4, approachPlayerRange);
      if (!Number.isNaN(approachStopDistance)) next.humanize.approachStopDistance = Math.max(2, approachStopDistance);
      if (!Number.isNaN(playerReactionIntervalSeconds)) next.humanize.playerReactionIntervalSeconds = Math.max(1, playerReactionIntervalSeconds);
      if (!Number.isNaN(playerActionChance)) next.humanize.playerActionChance = Math.min(1, Math.max(0, playerActionChance));
      if (!Number.isNaN(approachChance)) next.humanize.approachChance = Math.min(1, Math.max(0, approachChance));
      if (typeof settings.humanize.greetingEnabled === 'boolean') next.humanize.greetingEnabled = settings.humanize.greetingEnabled;
      if (!Number.isNaN(greetingChance)) next.humanize.greetingChance = Math.min(1, Math.max(0, greetingChance));
      if (!Number.isNaN(greetingGlobalCooldownSeconds)) next.humanize.greetingGlobalCooldownSeconds = Math.max(10, greetingGlobalCooldownSeconds);
      if (!Number.isNaN(greetingPlayerCooldownSeconds)) next.humanize.greetingPlayerCooldownSeconds = Math.max(30, greetingPlayerCooldownSeconds);
      const chatMessageFields = [
        'greetingMessages',
        'approachGreetingMessages',
        'leaveGreetingMessages',
        'hurtGreetingMessages'
      ];
      for (const field of chatMessageFields) {
        if (!Array.isArray(settings.humanize[field])) continue;
        const messages = settings.humanize[field]
          .map(message => String(message || '').trim())
          .filter(message => message && !message.startsWith('/'))
          .map(message => message.slice(0, 40));
        if (messages.length > 0) next.humanize[field] = messages;
      }
    }

    if (settings.safeIdle) {
      const intervalSeconds = Number(settings.safeIdle.intervalSeconds);
      const lookRange = Number(settings.safeIdle.lookRange);
      const actionChance = Number(settings.safeIdle.actionChance);
      const timeoutSeconds = Number(settings.safeIdle.timeoutSeconds);
      const resumeDelaySeconds = Number(settings.safeIdle.resumeDelaySeconds);
      if (!Number.isNaN(intervalSeconds)) next.safeIdle.intervalSeconds = Math.max(5, intervalSeconds);
      if (!Number.isNaN(lookRange)) next.safeIdle.lookRange = Math.max(2, lookRange);
      if (!Number.isNaN(actionChance)) next.safeIdle.actionChance = Math.min(1, Math.max(0, actionChance));
      if (!Number.isNaN(timeoutSeconds)) next.safeIdle.timeoutSeconds = Math.max(10, timeoutSeconds);
      if (!Number.isNaN(resumeDelaySeconds)) next.safeIdle.resumeDelaySeconds = Math.max(0, resumeDelaySeconds);
    }

    if (settings.workflow) {
      const steps = Array.isArray(settings.workflow.steps)
        ? settings.workflow.steps.map(step => String(step)).filter(step => step !== 'mining')
        : null;
      const patrolSeconds = Number(settings.workflow.patrolSeconds);
      const restSeconds = Number(settings.workflow.restSeconds);
      if (steps && steps.length > 0) next.workflow.steps = steps;
      if (!Number.isNaN(patrolSeconds)) next.workflow.patrolSeconds = Math.max(10, patrolSeconds);
      if (!Number.isNaN(restSeconds)) next.workflow.restSeconds = Math.max(5, restSeconds);
    }

    if (settings.pathSafety) {
      if (typeof settings.pathSafety.avoidWater === 'boolean') next.pathSafety.avoidWater = settings.pathSafety.avoidWater;
      if (typeof settings.pathSafety.avoidLava === 'boolean') next.pathSafety.avoidLava = settings.pathSafety.avoidLava;
      if (typeof settings.pathSafety.avoidEdges === 'boolean') next.pathSafety.avoidEdges = settings.pathSafety.avoidEdges;
      const maxDropDown = Number(settings.pathSafety.maxDropDown);
      if (!Number.isNaN(maxDropDown)) next.pathSafety.maxDropDown = Math.max(0, maxDropDown);
      if (typeof settings.pathSafety.allowSprinting === 'boolean') next.pathSafety.allowSprinting = settings.pathSafety.allowSprinting;
      if (typeof settings.pathSafety.allowParkour === 'boolean') next.pathSafety.allowParkour = settings.pathSafety.allowParkour;
      if (typeof settings.pathSafety.waterSpawnRescueEnabled === 'boolean') next.pathSafety.waterSpawnRescueEnabled = settings.pathSafety.waterSpawnRescueEnabled;
      if (settings.pathSafety.waterSpawnRescueCommand !== undefined) {
        const command = String(settings.pathSafety.waterSpawnRescueCommand).trim();
        next.pathSafety.waterSpawnRescueCommand = command || '/spawn';
      }
      const waterSpawnRescueDelaySeconds = Number(settings.pathSafety.waterSpawnRescueDelaySeconds);
      const waterSpawnRescueCooldownSeconds = Number(settings.pathSafety.waterSpawnRescueCooldownSeconds);
      if (!Number.isNaN(waterSpawnRescueDelaySeconds)) next.pathSafety.waterSpawnRescueDelaySeconds = Math.max(1, waterSpawnRescueDelaySeconds);
      if (!Number.isNaN(waterSpawnRescueCooldownSeconds)) next.pathSafety.waterSpawnRescueCooldownSeconds = Math.max(5, waterSpawnRescueCooldownSeconds);
    }

    this.behaviorSettings = next;
    this.config.behaviorSettings = next;
    this.saveConfig();
    if (settings.pathSafety) {
      this.applyMovementSafety(this.movements);
    }
    return this.behaviorSettings;
  }

  updateCommandSettings(settings = {}) {
    const next = {
      allowAll: !!settings.allowAll,
      cooldownSeconds: Number.isFinite(settings.cooldownSeconds)
        ? Math.max(0, settings.cooldownSeconds)
        : this.commandSettings.cooldownSeconds,
      whitelist: Array.isArray(settings.whitelist)
        ? settings.whitelist.map(name => String(name).trim()).filter(Boolean)
        : this.commandSettings.whitelist,
      silentReject: typeof settings.silentReject === 'boolean'
        ? settings.silentReject
        : this.commandSettings.silentReject,
      globalCooldownSeconds: Number.isFinite(settings.globalCooldownSeconds)
        ? Math.max(0, settings.globalCooldownSeconds)
        : this.commandSettings.globalCooldownSeconds,
      maxPerMinute: Number.isFinite(settings.maxPerMinute)
        ? Math.max(0, settings.maxPerMinute)
        : this.commandSettings.maxPerMinute
    };

    this.commandSettings = next;
    this.config.commandSettings = next;
    this.saveConfig();
    return this.commandSettings;
  }

  cmdHelp() {
    if (!this.bot) return;
    const helpLines = [
      '!help - 帮助',
      '!come - 过来',
      '!follow [玩家] - 跟随',
      '!stop - 停止所有行为',
      '!pos - 位置',
      '!attack [hostile/all] - 自动攻击',
      '!patrol - 随机巡逻',
      '!god - 无敌模式',
      '!jump - 跳跃',
      '!sneak - 蹲下/站起',
      '!ask [问题] - 问AI'
    ];
    helpLines.forEach(line => this.bot.chat(line));
  }

  async cmdCome(username) {
    if (!this.bot) return;
    const player = this.bot.players[username];
    if (!player?.entity) {
      this.bot.chat('找不到你');
      return;
    }
    const goal = new goals.GoalNear(player.entity.position.x, player.entity.position.y, player.entity.position.z, 2);
    this.bot.pathfinder.setGoal(goal);
    this.bot.chat(`正在走向 ${username}`);
  }

  cmdFollow(username, args) {
    if (!this.bot || !this.behaviors) return;

    const targetName = args[0] || username;

    if (this.modes.follow) {
      this.behaviors.follow.stop();
      this.modes.follow = false;
      this.bot.chat('停止跟随');
    } else {
      this.stopConflictingModes('follow');
      const result = this.behaviors.follow.start(targetName);
      if (result.success) {
        this.modes.follow = true;
        this.bot.chat(result.message);
      } else {
        this.bot.chat(result.message);
      }
    }
    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
  }

  cmdStop() {
    if (!this.bot) return;
    if (this.behaviors) {
      this.behaviors.stopAll();
    }
    this.bot.pathfinder.stop();
    this.modes.follow = false;
    this.modes.autoAttack = false;
    this.modes.patrol = false;
    this.modes.antiAfk = false;
    this.modes.autoEat = false;
    this.modes.guard = false;
    this.modes.rateLimit = false;
    this.modes.humanize = false;
    this.modes.safeIdle = false;
    this.modes.workflow = false;
    this.bot.chat('已停止所有行为');
    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
  }

  cmdPosition() {
    if (!this.bot) return;
    const pos = this.bot.entity.position;
    this.bot.chat(`X=${Math.floor(pos.x)} Y=${Math.floor(pos.y)} Z=${Math.floor(pos.z)}`);
  }

  cmdAttack(username, args) {
    if (!this.bot || !this.behaviors) return;

    if (this.modes.autoAttack) {
      this.behaviors.attack.stop();
      this.modes.autoAttack = false;
      this.bot.chat('停止攻击');
    } else {
      this.stopConflictingModes('attack');
      const mode = args[0] || 'hostile';
      const result = this.behaviors.attack.start(mode, this.behaviorSettings.attack || {});
      this.modes.autoAttack = true;
      this.bot.chat(result.message);
    }
    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
  }

  cmdPatrol() {
    if (!this.bot || !this.behaviors) return;

    if (this.modes.patrol) {
      this.behaviors.patrol.stop();
      this.modes.patrol = false;
      this.bot.chat('停止巡逻');
    } else {
      this.stopConflictingModes('patrol');
      const waypoints = this.behaviorSettings.patrol?.waypoints || null;
      const result = this.behaviors.patrol.start(waypoints);
      if (result.success) {
        this.modes.patrol = true;
        this.bot.chat(result.message);
      } else {
        this.modes.patrol = false;
        this.bot.chat(`巡逻启动失败: ${result.message || '未知错误'}`);
      }
    }
    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
  }

  cmdGod() {
    if (!this.bot) return;

    if (this.modes.invincible) {
      this.disableInvincibleMode();
      this.modes.invincible = false;
      this.bot.chat('无敌模式已关闭');
    } else {
      this.applyInvincibleMode();
      this.modes.invincible = true;
      this.bot.chat('无敌模式已开启');
    }
    this.saveConfig();
    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
  }

  cmdJump() {
    if (!this.bot || !this.behaviors) return;
    this.behaviors.action.jump();
    this.bot.chat('跳!');
  }

  cmdSneak() {
    if (!this.bot || !this.behaviors) return;
    const sneaking = this.bot.getControlState('sneak');
    this.behaviors.action.sneak(!sneaking);
    this.bot.chat(sneaking ? '站起' : '蹲下');
  }

  async cmdAsk(username, args) {
    if (!this.bot || args.length === 0) return;

    try {
      const response = await this.aiService.chat(args.join(' '), username);
      for (let i = 0; i < response.length; i += 100) {
        this.bot.chat(response.substring(i, i + 100));
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (error) {
      this.bot.chat('AI 暂时不可用');
    }
  }

  // 行为控制 API
  setBehavior(behavior, enabled, options = {}) {
    if (!this.behaviors) return { success: false, message: 'Bot 未连接' };

    let result;
    switch (behavior) {
      case 'follow':
        if (enabled) {
          this.stopConflictingModes('follow');
          result = this.behaviors.follow.start(options.target, options);
          this.modes.follow = result.success;
        } else {
          result = this.behaviors.follow.stop();
          this.modes.follow = false;
        }
        break;
      case 'attack':
        if (enabled) {
          this.stopConflictingModes('attack');
          const attackOptions = { ...(this.behaviorSettings.attack || {}), ...(options || {}) };
          result = this.behaviors.attack.start(options.mode || 'hostile', attackOptions);
          this.modes.autoAttack = true;
        } else {
          result = this.behaviors.attack.stop();
          this.modes.autoAttack = false;
        }
        break;
      case 'patrol':
        if (enabled) {
          this.stopConflictingModes('patrol');
          const patrolOptions = { ...(this.behaviorSettings.patrol || {}), ...(options || {}) };
          result = this.behaviors.patrol.start(patrolOptions.waypoints);
          this.modes.patrol = true;
        } else {
          result = this.behaviors.patrol.stop();
          this.modes.patrol = false;
        }
        break;
      case 'antiAfk':
        if (enabled) {
          const antiAfkOptions = { ...(this.behaviorSettings.antiAfk || {}), ...(options || {}) };
          result = this.behaviors.antiAfk.start(antiAfkOptions);
          this.modes.antiAfk = result.success;
        } else {
          result = this.behaviors.antiAfk.stop();
          this.modes.antiAfk = false;
        }
        break;
      case 'autoEat':
        if (enabled) {
          const autoEatOptions = { ...(this.behaviorSettings.autoEat || {}), ...(options || {}) };
          result = this.behaviors.autoEat.start(autoEatOptions);
          this.modes.autoEat = result.success;
        } else {
          result = this.behaviors.autoEat.stop();
          this.modes.autoEat = false;
        }
        break;
      case 'guard':
        if (enabled) {
          this.stopConflictingModes('guard');
          const guardOptions = { ...(this.behaviorSettings.guard || {}), ...(options || {}) };
          result = this.behaviors.guard.start(guardOptions);
          this.modes.guard = result.success;
        } else {
          result = this.behaviors.guard.stop();
          this.modes.guard = false;
        }
        break;
      case 'rateLimit':
        if (enabled) {
          const rateOptions = { ...(this.behaviorSettings.rateLimit || {}), ...(options || {}) };
          result = this.behaviors.rateLimit.start(rateOptions);
          this.modes.rateLimit = result.success;
        } else {
          result = this.behaviors.rateLimit.stop();
          this.modes.rateLimit = false;
        }
        break;
      case 'humanize':
        if (enabled) {
          const humanizeOptions = { ...(this.behaviorSettings.humanize || {}), ...(options || {}) };
          result = this.behaviors.humanize.start(humanizeOptions);
          this.modes.humanize = result.success;
          if (result.success) this.modes.playerLike = false;
        } else {
          result = this.behaviors.humanize.stop();
          this.modes.humanize = false;
        }
        break;
      case 'safeIdle':
        if (enabled) {
          const safeIdleOptions = { ...(this.behaviorSettings.safeIdle || {}), ...(options || {}) };
          result = this.behaviors.safeIdle.start(safeIdleOptions);
          this.modes.safeIdle = result.success;
          if (result.success) this.modes.playerLike = false;
        } else {
          result = this.behaviors.safeIdle.stop();
          this.modes.safeIdle = false;
        }
        break;
      case 'playerLike':
        if (enabled) {
          result = this.startPlayerLikeBehaviors();
          this.modes.playerLike = result.success;
          if (result.success) {
            this.modes.humanize = false;
            this.modes.safeIdle = false;
          }
        } else {
          result = this.stopPlayerLikeBehaviors();
          this.modes.playerLike = false;
        }
        break;
      case 'workflow':
        if (enabled) {
          const workflowOptions = { ...(this.behaviorSettings.workflow || {}), ...(options || {}) };
          result = this.behaviors.workflow.start(workflowOptions);
          this.modes.workflow = result.success;
        } else {
          result = this.behaviors.workflow.stop();
          this.modes.workflow = false;
        }
        break;
      default:
        result = { success: false, message: '未知行为' };
    }

    this.config.modes = { ...this.modes };
    this.saveConfig();

    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
    return result;
  }

  // 执行动作
  doAction(action, params = {}) {
    if (!this.behaviors) return { success: false, message: 'Bot 未连接' };

    switch (action) {
      case 'jump':
        return this.behaviors.action.jump();
      case 'sneak':
        return this.behaviors.action.sneak(params.enabled);
      case 'sprint':
        return this.behaviors.action.sprint(params.enabled);
      case 'useItem':
        return this.behaviors.action.useItem();
      case 'swing':
        return this.behaviors.action.swing();
      case 'lookAt':
        return this.behaviors.action.lookAt(params.x, params.y, params.z);
      default:
        return { success: false, message: '未知动作' };
    }
  }

  // ==================== SFTP 配置与文件管理 ====================

  /**
   * 设置 SFTP 配置
   */
  setSftpConfig(config) {
    this.status.sftp = {
      host: config.host || '',
      port: parseInt(config.port) || 22,
      username: config.username || '',
      password: config.password || '',
      privateKey: config.privateKey || '',
      basePath: config.basePath || '/' // 基础路径，用于限制访问范围
    };
    this.config.sftp = this.status.sftp;
    this.log('info', 'SFTP 配置已更新', '🔑');
    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
    this.saveConfig();
    return this.status.sftp;
  }

  /**
   * 设置文件访问方式
   * @param {string} type - 'pterodactyl' | 'sftp' | 'none'
   */
  setFileAccessType(type) {
    const validTypes = ['pterodactyl', 'sftp', 'none'];
    if (!validTypes.includes(type)) {
      return { success: false, message: `无效的文件访问方式，可选: ${validTypes.join(', ')}` };
    }
    this.status.fileAccessType = type;
    this.config.fileAccessType = type;
    this.log('info', `文件访问方式已设置为: ${type}`, '📁');
    if (this.onStatusChange) this.onStatusChange(this.id, this.getStatus());
    this.saveConfig();
    return { success: true, type };
  }

  /**
   * 获取 SFTP 客户端连接
   */
  async getSftpClient() {
    const sftp = this.status.sftp;
    if (!sftp || !sftp.host || !sftp.username) {
      throw new Error('SFTP 未配置');
    }

    const client = new SftpClient();
    const connectOptions = {
      host: sftp.host,
      port: sftp.port || 22,
      username: sftp.username
    };

    // 优先使用私钥，否则使用密码
    if (sftp.privateKey) {
      connectOptions.privateKey = sftp.privateKey;
    } else if (sftp.password) {
      connectOptions.password = sftp.password;
    } else {
      throw new Error('SFTP 需要密码或私钥');
    }

    await client.connect(connectOptions);
    return client;
  }

  /**
   * 获取 SFTP 完整路径
   */
  getSftpFullPath(relativePath) {
    const basePath = this.status.sftp?.basePath || '/';
    // 规范化路径
    let fullPath = relativePath.startsWith('/') ? relativePath : `${basePath}/${relativePath}`;
    // 移除多余的斜杠
    fullPath = fullPath.replace(/\/+/g, '/');
    return fullPath;
  }

  // ==================== SFTP 文件操作方法 ====================

  /**
   * 通过 SFTP 列出目录文件
   */
  async listFilesSftp(directory = '/') {
    let client;
    try {
      client = await this.getSftpClient();
      const fullPath = this.getSftpFullPath(directory);
      const list = await client.list(fullPath);

      const files = list.map(item => ({
        name: item.name,
        mode: item.rights?.user || '',
        size: item.size,
        isFile: item.type === '-',
        isSymlink: item.type === 'l',
        isEditable: item.type === '-' && item.size < 10 * 1024 * 1024, // 小于 10MB 可编辑
        mimetype: this.getMimeType(item.name),
        createdAt: item.accessTime ? new Date(item.accessTime).toISOString() : null,
        modifiedAt: item.modifyTime ? new Date(item.modifyTime).toISOString() : null
      }));

      return { success: true, files, directory };
    } catch (error) {
      this.log('error', `SFTP 列出文件失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) await client.end();
    }
  }

  /**
   * 通过 SFTP 获取文件内容
   */
  async getFileContentsSftp(file) {
    let client;
    try {
      client = await this.getSftpClient();
      const fullPath = this.getSftpFullPath(file);
      const content = await client.get(fullPath);

      return { success: true, content: content.toString('utf-8'), file };
    } catch (error) {
      this.log('error', `SFTP 读取文件失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) await client.end();
    }
  }

  /**
   * 通过 SFTP 写入文件内容
   */
  async writeFileSftp(file, content) {
    let client;
    try {
      client = await this.getSftpClient();
      const fullPath = this.getSftpFullPath(file);
      await client.put(Buffer.from(content, 'utf-8'), fullPath);

      this.log('success', `SFTP 文件已保存: ${file}`, '💾');
      return { success: true, message: '文件已保存' };
    } catch (error) {
      this.log('error', `SFTP 保存文件失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) await client.end();
    }
  }

  /**
   * 通过 SFTP 创建文件夹
   */
  async createFolderSftp(root, name) {
    let client;
    try {
      client = await this.getSftpClient();
      const fullPath = this.getSftpFullPath(`${root}/${name}`);
      await client.mkdir(fullPath, true);

      this.log('success', `SFTP 文件夹已创建: ${root}${name}`, '📁');
      return { success: true, message: '文件夹已创建' };
    } catch (error) {
      this.log('error', `SFTP 创建文件夹失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) await client.end();
    }
  }

  /**
   * 通过 SFTP 删除文件/文件夹
   */
  async deleteFilesSftp(root, files) {
    let client;
    try {
      client = await this.getSftpClient();
      let deletedCount = 0;

      for (const fileName of files) {
        const fullPath = this.getSftpFullPath(`${root}/${fileName}`);
        try {
          // 检查是文件还是目录
          const stat = await client.stat(fullPath);
          if (stat.isDirectory) {
            await client.rmdir(fullPath, true); // 递归删除目录
          } else {
            await client.delete(fullPath);
          }
          deletedCount++;
        } catch (e) {
          this.log('warning', `删除 ${fileName} 失败: ${e.message}`, '⚠');
        }
      }

      this.log('success', `SFTP 已删除 ${deletedCount} 个文件`, '🗑️');
      return { success: true, message: `已删除 ${deletedCount} 个文件` };
    } catch (error) {
      this.log('error', `SFTP 删除文件失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) await client.end();
    }
  }

  /**
   * 通过 SFTP 重命名文件/文件夹
   */
  async renameFileSftp(root, from, to) {
    let client;
    try {
      client = await this.getSftpClient();
      const fromPath = this.getSftpFullPath(`${root}/${from}`);
      const toPath = this.getSftpFullPath(`${root}/${to}`);
      await client.rename(fromPath, toPath);

      this.log('success', `SFTP 已重命名: ${from} -> ${to}`, '✏️');
      return { success: true, message: '重命名成功' };
    } catch (error) {
      this.log('error', `SFTP 重命名失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) await client.end();
    }
  }

  /**
   * 通过 SFTP 复制文件（下载后上传到新位置）
   */
  async copyFileSftp(location) {
    let client;
    try {
      client = await this.getSftpClient();
      const fullPath = this.getSftpFullPath(location);

      // 生成副本名称
      const lastSlash = location.lastIndexOf('/');
      const dir = location.substring(0, lastSlash + 1);
      const fileName = location.substring(lastSlash + 1);
      const ext = fileName.lastIndexOf('.');
      const baseName = ext > 0 ? fileName.substring(0, ext) : fileName;
      const extension = ext > 0 ? fileName.substring(ext) : '';
      const copyName = `${baseName} copy${extension}`;
      const copyPath = this.getSftpFullPath(`${dir}${copyName}`);

      // 读取原文件内容
      const content = await client.get(fullPath);
      // 写入副本
      await client.put(content, copyPath);

      this.log('success', `SFTP 已复制: ${location} -> ${copyName}`, '📋');
      return { success: true, message: '复制成功' };
    } catch (error) {
      this.log('error', `SFTP 复制失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) await client.end();
    }
  }

  /**
   * 获取 SFTP 文件下载（返回文件内容的 Buffer）
   */
  async getFileDownloadSftp(file) {
    let client;
    try {
      client = await this.getSftpClient();
      const fullPath = this.getSftpFullPath(file);
      const content = await client.get(fullPath);

      return { success: true, content, file };
    } catch (error) {
      this.log('error', `SFTP 下载文件失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) await client.end();
    }
  }

  /**
   * 通过 SFTP 上传文件
   */
  async uploadFileSftp(directory, fileName, content) {
    let client;
    try {
      client = await this.getSftpClient();
      const fullPath = this.getSftpFullPath(`${directory}/${fileName}`);
      await client.put(content, fullPath);

      this.log('success', `SFTP 文件已上传: ${fileName}`, '📤');
      return { success: true, message: '文件已上传' };
    } catch (error) {
      this.log('error', `SFTP 上传文件失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) await client.end();
    }
  }

  /**
   * 根据文件名获取 MIME 类型
   */
  getMimeType(fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const mimeTypes = {
      txt: 'text/plain',
      json: 'application/json',
      yml: 'text/yaml',
      yaml: 'text/yaml',
      properties: 'text/x-java-properties',
      cfg: 'text/plain',
      conf: 'text/plain',
      ini: 'text/plain',
      log: 'text/plain',
      xml: 'application/xml',
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
      jar: 'application/java-archive',
      zip: 'application/zip',
      gz: 'application/gzip',
      tar: 'application/x-tar',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      ico: 'image/x-icon'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }
}
