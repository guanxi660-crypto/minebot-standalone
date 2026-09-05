import { BotInstance } from './BotInstance.js';
import { PanelInstance } from './PanelInstance.js';
import os from 'os';
import fs from 'fs';

/**
 * 获取内存状态 - 支持容器环境
 */
function getMemoryStatus() {
  const used = process.memoryUsage().rss;
  let total = os.totalmem();

  // 尝试识别容器内存限制
  if (process.env.SERVER_MEMORY) {
    total = parseInt(process.env.SERVER_MEMORY) * 1024 * 1024;
  } else {
    try {
      // Linux cgroup v1
      if (fs.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) {
        const limit = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim());
        if (limit < 9223372036854771712) total = limit;
      }
      // Linux cgroup v2
      else if (fs.existsSync('/sys/fs/cgroup/memory.max')) {
        const limit = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
        if (limit !== 'max') total = parseInt(limit);
      }
    } catch (e) { }
  }

  const percent = ((used / total) * 100).toFixed(1);
  return {
    used: (used / 1024 / 1024).toFixed(1),
    total: (total / 1024 / 1024).toFixed(0),
    percent
  };
}

/**
 * Manages multiple bot instances across different servers
 */
export class BotPool {
  constructor(configManager, aiService, broadcast) {
    this.configManager = configManager;
    this.aiService = aiService;
    this.broadcast = broadcast;
    this.bots = new Map(); // id -> BotInstance
    this.logs = [];
    this.maxLogs = 100; // 减少日志数量

    this.setupProcessHandlers();
    this.startMemoryMonitor();

    // 启动时加载已保存的服务器配置
    this.loadSavedServers();
  }

  /**
   * 内存监控 - 80%告警，90%清理缓存
   */
  startMemoryMonitor() {
    setInterval(() => {
      const status = getMemoryStatus();
      const percent = parseFloat(status.percent);
      // 广播给前端
      this.broadcast('system_status', status);

      if (percent >= 80) {
        console.warn(`[内存警告] 使用率 ${status.percent}% (${status.used}/${status.total} MB)`);

        // 清理协议缓存
        BotInstance.clearCache();

        // 紧急修剪日志
        this.logs = this.logs.slice(-20);
        this.bots.forEach(bot => {
          if (bot.logs && bot.logs.length > 20) {
            bot.logs = bot.logs.slice(-20);
          }
        });

        // 90%以上考虑重启
        if (percent >= 90) {
          console.error(`[内存危险] 使用率 ${status.percent}%，建议重启服务`);
        }
      }
    }, 30000); // 每30秒检查
  }

  /**
   * 获取内存状态 - 供API使用
   */
  getMemoryStatus() {
    return getMemoryStatus();
  }

  /**
   * 加载已保存的服务器配置
   */
  loadSavedServers() {
    const servers = this.configManager.getServers();
    if (servers && servers.length > 0) {
      console.log(`正在加载 ${servers.length} 个已保存的服务器配置...`);

      // 先创建所有实例
      for (const serverConfig of servers) {
        const instance = this.createInstance(serverConfig);
        this.bots.set(serverConfig.id, instance);
        console.log(`已加载服务器: ${serverConfig.name || serverConfig.id} (${serverConfig.type || 'minecraft'})`);
      }

      // 然后并行连接所有服务器（不阻塞）
      for (const serverConfig of servers) {
        const instance = this.bots.get(serverConfig.id);
        const type = serverConfig.type || 'minecraft';
        // 使用 setTimeout 确保不阻塞主线程，游戏服务器延迟一点避免同时连接
        const delay = type === 'panel' ? 0 : 500;
        setTimeout(() => {
          instance.connect().catch(err => {
            console.log(`${type === 'panel' ? '面板' : '游戏'}服务器 ${serverConfig.name || serverConfig.id} 连接失败: ${err.message}`);
          });
        }, delay);
      }
    }
  }

  /**
   * 根据配置类型创建实例
   */
  createInstance(serverConfig) {
    const type = serverConfig.type || 'minecraft';

    if (type === 'panel') {
      // 纯面板服务器
      return new PanelInstance(
        serverConfig.id,
        serverConfig,
        this.onLog.bind(this),
        this.onStatusChange.bind(this),
        this.configManager
      );
    } else {
      // 游戏服务器（默认）
      return new BotInstance(
        serverConfig.id,
        serverConfig,
        this.aiService,
        this.onLog.bind(this),
        this.onStatusChange.bind(this),
        this.configManager
      );
    }
  }

  setupProcessHandlers() {
    process.on('SIGINT', () => {
      console.log('收到中断信号，正在清理...');
      this.disconnectAll();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('收到终止信号，正在清理...');
      this.disconnectAll();
      process.exit(0);
    });

    process.on('uncaughtException', (err) => {
      if (err.name === 'PartialReadError') return;
      console.error('未捕获异常:', err);
    });

    process.on('unhandledRejection', (reason) => {
      if (reason && reason.name === 'PartialReadError') return;
      console.error('未处理的 Promise 拒绝:', reason);
    });
  }

  onLog(botId, entry) {
    const logEntry = { ...entry, serverId: botId };
    this.logs.push(logEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.broadcast('log', logEntry);
  }

  onStatusChange(botId, status) {
    const payload = status?.id ? status : { ...status, id: botId };
    this.broadcast('bot_update', payload);
    // Backward compatibility
    this.broadcast('botStatus', { botId, status: payload });
    this.broadcast('status', this.getOverallStatus());
  }

  getRecentLogs() {
    return this.logs.slice(-100);
  }

  /**
   * Get status of all bots
   */
  getAllStatus() {
    const statuses = {};
    for (const [id, bot] of this.bots) {
      statuses[id] = bot.getStatus();
    }
    return statuses;
  }

  /**
   * Get overall summary status (for backward compatibility)
   */
  getOverallStatus() {
    const connectedBots = Array.from(this.bots.values()).filter(b => b.status.connected);
    const firstConnected = connectedBots[0];

    return {
      connected: connectedBots.length > 0,
      serverAddress: firstConnected?.status.serverAddress || '',
      version: firstConnected?.status.version || '',
      health: firstConnected?.status.health || 0,
      food: firstConnected?.status.food || 0,
      position: firstConnected?.status.position || null,
      players: firstConnected?.status.players || [],
      modes: firstConnected?.modes || { aiView: false, patrol: false, autoChat: false },
      // Multi-server info
      totalBots: this.bots.size,
      connectedBots: connectedBots.length,
      botList: Array.from(this.bots.values()).map(b => ({
        id: b.id,
        name: b.status.serverName,
        type: b.status.type || 'minecraft',
        connected: b.status.connected,
        serverAddress: b.status.serverAddress || (b.status.serverHost ? `${b.status.serverHost}:${b.status.serverPort}` : ''),
        username: b.status.username,
        players: b.status.players || [],
        // 面板服务器状态
        panelServerState: b.status.panelServerState || null,
        panelServerStats: b.status.panelServerStats || null,
        // TCP ping 状态（仅面板服务器）
        tcpOnline: b.status.tcpOnline ?? null,
        tcpLatency: b.status.tcpLatency ?? null,
        serverHost: b.status.serverHost || null,
        serverPort: b.status.serverPort || null
      }))
    };
  }

  getModes() {
    const firstBot = this.bots.values().next().value;
    return firstBot?.modes || { aiView: false, patrol: false, autoChat: false };
  }

  /**
   * Add a new server and connect
   */
  async addServer(serverConfig) {
    const id = serverConfig.id || `server_${Date.now()}`;

    // 如果已存在，只连接不重新创建
    if (this.bots.has(id)) {
      const existingBot = this.bots.get(id);
      if (!existingBot.status.connected) {
        try {
          await existingBot.connect();
        } catch (error) {
          // Bot will auto-reconnect
        }
      }
      return { id, status: existingBot.getStatus() };
    }

    // 使用 createInstance 根据类型创建实例
    const instance = this.createInstance({ ...serverConfig, id });
    this.bots.set(id, instance);

    try {
      await instance.connect();
      return { id, status: instance.getStatus() };
    } catch (error) {
      // Will auto-reconnect
      return { id, status: instance.getStatus(), error: error.message };
    }
  }

  /**
   * Remove a server
   */
  removeServer(id) {
    const bot = this.bots.get(id);
    if (bot) {
      bot.disconnect();
      this.bots.delete(id);
      this.broadcast('bot_deleted', { id });
      return true;
    }
    return false;
  }

  /**
   * Connect single server (backward compatible)
   */
  async connect(options = {}) {
    const config = this.configManager.getConfig();
    const serverConfig = {
      id: 'default',
      name: options.name || 'Default Server',
      host: options.host || config.server?.host || 'localhost',
      port: options.port || config.server?.port || 25565,
      username: options.username || config.server?.username || undefined,
      version: options.version || config.server?.version || false,
      autoChat: config.autoChat
    };

    // Remove existing default if exists
    if (this.bots.has('default')) {
      this.removeServer('default');
    }

    return this.addServer(serverConfig);
  }

  /**
   * Connect to multiple servers from config
   */
  async connectAll() {
    const config = this.configManager.getConfig();
    const servers = config.servers || [];

    if (servers.length === 0 && config.server?.host) {
      // Fallback to single server config
      servers.push({
        id: 'default',
        name: 'Default Server',
        ...config.server
      });
    }

    const results = [];
    for (const serverConfig of servers) {
      try {
        const result = await this.addServer(serverConfig);
        results.push(result);
      } catch (error) {
        results.push({ id: serverConfig.id, error: error.message });
      }
    }

    return results;
  }

  /**
   * Disconnect specific server
   */
  disconnect(id = 'default') {
    const bot = this.bots.get(id);
    if (!bot) return false;
    bot.disconnect();
    this.broadcastStatus(id, bot.getStatus());
    return true;
  }

  /**
   * Disconnect all servers
   */
  disconnectAll() {
    for (const [id, bot] of this.bots) {
      bot.disconnect();
      this.broadcastStatus(id, bot.getStatus());
    }
    this.broadcast('status', this.getOverallStatus());
  }

  /**
   * Restart specific server - 使用自动刷新重连逻辑
   */
  async restart(id = 'default') {
    const bot = this.bots.get(id);
    if (bot) {
      // 如果有 autoRefreshReconnect 方法，直接使用
      if (typeof bot.autoRefreshReconnect === 'function') {
        bot.autoRefreshReconnect();
        return { message: '正在自动刷新重连...', status: bot.getStatus() };
      } else {
        // 兼容旧方法
        bot.disconnect();
        await new Promise(r => setTimeout(r, 1000));
        await bot.connect();
        return { message: '重连完成', status: bot.getStatus() };
      }
    }
    throw new Error(`Bot ${id} not found`);
  }

  /**
   * Set mode for specific bot or all bots
   */
  setMode(mode, enabled, botId = null) {
    if (botId) {
      const bot = this.bots.get(botId);
      if (bot) {
        bot.setMode(mode, enabled);
      }
    } else {
      // Apply to all bots
      for (const bot of this.bots.values()) {
        bot.setMode(mode, enabled);
      }
    }
    return this.getModes();
  }

  /**
   * Execute command on specific bot
   */
  async executeCommand(command, botId = 'default') {
    const bot = this.bots.get(botId);
    if (bot?.bot) {
      bot.bot.chat(command);
      bot.log('info', `发送: ${command}`, '📤');
      return true;
    }
    throw new Error('Bot not connected');
  }

  /**
   * Get status (backward compatible)
   */
  getStatus() {
    return this.getOverallStatus();
  }

  // Timer support
  setTimer(minutes, hours, action = 'restart', botId = 'default') {
    const totalMs = ((hours || 0) * 60 + (minutes || 0)) * 60 * 1000;
    if (totalMs > 0) {
      setTimeout(async () => {
        if (action === 'restart') {
          await this.restart(botId);
        } else if (action === 'disconnect') {
          this.disconnect(botId);
        }
      }, totalMs);
    }
  }
}

// Export as BotManager for backward compatibility
export { BotPool as BotManager };
