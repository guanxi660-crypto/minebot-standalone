import mineflayer from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pkg;

export class BotManager {
  constructor(configManager, aiService, broadcast) {
    this.configManager = configManager;
    this.aiService = aiService;
    this.broadcast = broadcast;
    this.bot = null;
    this.logs = [];
    this.maxLogs = 100;
    this.reconnecting = false;
    this.maxReconnectAttempts = 10;
    this.reconnectAttempts = 0;
    this.timer = null;
    this.autoChatInterval = null;
    this.activityMonitorInterval = null;
    this.connectionTimeout = null;
    this.lastActivity = Date.now();
    this.lastConnectionOptions = null;

    this.modes = {
      aiView: false,
      patrol: false,
      autoChat: false
    };

    this.status = {
      connected: false,
      serverAddress: '',
      version: '',
      health: 0,
      food: 0,
      position: null,
      players: []
    };

    this.commands = {
      '!help': this.cmdHelp.bind(this),
      '!come': this.cmdCome.bind(this),
      '!ask': this.cmdAsk.bind(this),
      '!stop': this.cmdStop.bind(this),
      '!pos': this.cmdPosition.bind(this),
      '!follow': this.cmdFollow.bind(this)
    };

    // Handle process signals
    this.setupProcessHandlers();
  }

  setupProcessHandlers() {
    process.on('SIGINT', () => {
      this.log('info', '收到中断信号，正在清理...', '🛑');
      this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      this.log('info', '收到终止信号，正在清理...', '🛑');
      this.cleanup();
      process.exit(0);
    });

    process.on('uncaughtException', (err) => {
      if (err.name === 'PartialReadError') return;
      console.error('未捕获异常:', err);
      this.log('error', `未捕获异常: ${err.message}`, '✗');
    });

    process.on('unhandledRejection', (reason) => {
      if (reason && reason.name === 'PartialReadError') return;
      console.error('未处理的 Promise 拒绝:', reason);
    });
  }

  updateActivity() {
    this.lastActivity = Date.now();
  }

  log(type, message, icon = '') {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const entry = {
      id: Date.now(),
      timestamp,
      type,
      icon,
      message
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.broadcast('log', entry);
    console.log(`[${timestamp}] ${icon} ${message}`);
  }

  getRecentLogs() {
    return this.logs.slice(-50);
  }

  getStatus() {
    return {
      ...this.status,
      modes: this.modes
    };
  }

  getModes() {
    return this.modes;
  }

  cleanup() {
    // Clear all intervals
    if (this.autoChatInterval) {
      clearInterval(this.autoChatInterval);
      this.autoChatInterval = null;
    }
    if (this.activityMonitorInterval) {
      clearInterval(this.activityMonitorInterval);
      this.activityMonitorInterval = null;
    }
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Clean up bot
    if (this.bot) {
      try {
        this.bot.removeAllListeners();
        if (this.bot._client) {
          this.bot._client.removeAllListeners();
        }
        if (typeof this.bot.quit === 'function') {
          this.bot.quit();
        } else if (typeof this.bot.end === 'function') {
          this.bot.end();
        }
      } catch (e) {
        // Ignore cleanup errors
      }
      this.bot = null;
    }

    this.status.connected = false;
  }

  startActivityMonitor() {
    if (this.activityMonitorInterval) {
      clearInterval(this.activityMonitorInterval);
    }

    this.activityMonitorInterval = setInterval(() => {
      // 5 minutes without activity
      if (Date.now() - this.lastActivity > 300000) {
        this.log('warning', 'Bot 可能卡死，尝试重连...', '⏱️');
        this.scheduleReconnect();
      }
    }, 30000); // Check every 30 seconds
  }

  scheduleReconnect() {
    if (this.reconnecting) {
      console.log('Already reconnecting, skip');
      return;
    }

    this.reconnecting = true;
    this.cleanup();

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('error', '已达到最大重连次数，停止重连', '✗');
      this.reconnecting = false;
      return;
    }

    this.reconnectAttempts++;
    // Exponential backoff: 15s, 30s, 60s max
    const delay = Math.min(15000 * Math.pow(2, this.reconnectAttempts - 1), 60000);

    this.log('info', `等待 ${delay/1000} 秒后重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`, '🔄');

    setTimeout(() => {
      if (this.lastConnectionOptions) {
        this.connect(this.lastConnectionOptions).catch(err => {
          this.log('error', `重连失败: ${err.message}`, '✗');
          this.reconnecting = false;
        });
      } else {
        this.reconnecting = false;
      }
    }, delay);
  }

  async connect(options = {}) {
    // Prevent multiple simultaneous connections
    if (this.bot && this.status.connected) {
      this.log('warning', '已有活动连接，请先断开', '⚠');
      return;
    }

    const config = this.configManager.getConfig();
    const host = options.host || config.server?.host || 'localhost';
    const port = options.port || config.server?.port || 25565;
    const username = options.username || config.server?.username || this.generateUsername();
    const version = options.version || config.server?.version || false;

    // Save connection options for reconnection
    this.lastConnectionOptions = { host, port, username, version };

    // Clean up existing connection first
    this.cleanup();

    // Wait a bit to ensure old connection is fully closed
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Reset reconnecting flag since we're starting a fresh connection
    this.reconnecting = false;

    this.log('info', `正在连接服务器 ${host}:${port}...`, '⚡');

    return new Promise((resolve, reject) => {
      try {
        const botOptions = {
          host,
          port,
          username,
          version: version || undefined,
          auth: 'offline',
          connectTimeout: 30000
        };

        this.bot = mineflayer.createBot(botOptions);

        // Connection timeout
        this.connectionTimeout = setTimeout(() => {
          if (this.bot && !this.status.connected) {
            this.log('error', '连接超时，主动断开', '❌');
            this.scheduleReconnect();
            reject(new Error('Connection timeout'));
          }
        }, 30000);

        this.bot.loadPlugin(pathfinder);

        // Login event
        this.bot.on('login', () => {
          this.log('success', 'Bot 已成功登录', '✅');
          clearTimeout(this.connectionTimeout);
          this.reconnecting = false;
          this.reconnectAttempts = 0;
          this.updateActivity();
          this.startActivityMonitor();
        });

        // Spawn event
        this.bot.once('spawn', () => {
          this.status.connected = true;
          this.status.serverAddress = `${host}:${port}`;
          this.status.version = this.bot.version;

          try {
            const movements = new Movements(this.bot, this.bot.registry);
            this.bot.pathfinder.setMovements(movements);
            this.log('success', `成功进入世界 (版本: ${this.bot.version})`, '✓');
          } catch (e) {
            this.log('warning', '路径规划初始化失败，部分功能可能不可用', '⚠');
          }

          this.broadcast('status', this.getStatus());
          resolve();
        });

        // Health update
        this.bot.on('health', () => {
          this.status.health = this.bot.health;
          this.status.food = this.bot.food;
          this.updateActivity();
          this.broadcast('status', this.getStatus());
        });

        // Position update
        this.bot.on('move', () => {
          if (this.bot && this.bot.entity) {
            this.status.position = this.bot.entity.position;
            this.updateActivity();
          }
        });

        // Player events
        this.bot.on('playerJoined', (player) => {
          if (this.bot) {
            this.status.players = Object.keys(this.bot.players);
            this.log('info', `玩家 ${player.username} 加入游戏`, '👋');
            this.broadcast('status', this.getStatus());
          }
        });

        this.bot.on('playerLeft', (player) => {
          if (this.bot) {
            this.status.players = Object.keys(this.bot.players);
            this.log('info', `玩家 ${player.username} 离开游戏`, '👋');
            this.broadcast('status', this.getStatus());
          }
        });

        // Chat handler
        this.bot.on('chat', async (username, message) => {
          if (!this.bot || username === this.bot.username) return;
          this.updateActivity();
          this.log('chat', `${username}: ${message}`, '💬');

          if (message.startsWith('!')) {
            await this.handleCommand(username, message);
          }
        });

        // Error handlers
        this.bot.on('error', (err) => {
          this.log('error', `错误: ${err.message}`, '✗');
          console.error('Bot error:', err);
        });

        this.bot.on('kicked', (reason) => {
          this.log('error', `被踢出: ${reason}`, '👢');
          this.status.connected = false;
          this.broadcast('status', this.getStatus());
          this.scheduleReconnect();
        });

        this.bot.on('end', () => {
          this.log('warning', '连接已断开', '🔌');
          this.status.connected = false;
          this.bot = null;
          this.broadcast('status', this.getStatus());
          this.scheduleReconnect();
        });

        // Low-level client events
        if (this.bot._client) {
          this.bot._client.on('error', (err) => {
            console.log('底层协议错误:', err.message);
          });

          this.bot._client.on('end', () => {
            console.log('底层连接断开');
          });
        }

      } catch (error) {
        this.log('error', `连接失败: ${error.message}`, '✗');
        reject(error);
      }
    });
  }

  disconnect() {
    this.reconnecting = true; // Prevent auto-reconnect
    this.cleanup();
    this.log('info', '已断开连接', '🔌');
    this.broadcast('status', this.getStatus());
    this.reconnecting = false;
  }

  async restart() {
    this.log('info', '正在重启...', '🔄');
    this.reconnectAttempts = 0;
    this.disconnect();
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (this.lastConnectionOptions) {
      await this.connect(this.lastConnectionOptions);
    }
  }

  generateUsername() {
    const adjectives = ['Clever', 'Swift', 'Brave', 'Happy', 'Mighty', 'Wise'];
    const animals = ['Fox', 'Wolf', 'Bear', 'Tiger', 'Eagle', 'Panda'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    const num = Math.floor(Math.random() * 99);
    return `${adj}${animal}${num}`;
  }

  setMode(mode, enabled) {
    if (mode in this.modes) {
      this.modes[mode] = enabled;
      this.log('info', `${mode} 模式: ${enabled ? '开启' : '关闭'}`, '✦');

      if (mode === 'autoChat') {
        this.handleAutoChatMode(enabled);
      } else if (mode === 'patrol') {
        this.handlePatrolMode(enabled);
      }

      this.broadcast('status', this.getStatus());
    }
  }

  handleAutoChatMode(enabled) {
    if (this.autoChatInterval) {
      clearInterval(this.autoChatInterval);
      this.autoChatInterval = null;
    }

    if (enabled && this.bot) {
      const messages = this.configManager.getConfig().autoChat?.messages || [
        '欢迎来到服务器！',
        '有问题可以问我 !ask [问题]',
        '需要帮助请输入 !help'
      ];
      const interval = this.configManager.getConfig().autoChat?.interval || 60000;

      this.autoChatInterval = setInterval(() => {
        if (this.bot && this.modes.autoChat) {
          const msg = messages[Math.floor(Math.random() * messages.length)];
          this.bot.chat(msg);
          this.log('chat', `[自动喊话] ${msg}`, '📢');
        }
      }, interval);
    }
  }

  handlePatrolMode(enabled) {
    if (enabled && this.bot) {
      this.log('info', '巡逻模式已启动', '🚶');
    } else if (this.bot?.pathfinder) {
      this.bot.pathfinder.stop();
    }
  }

  setTimer(minutes, hours, action = 'restart') {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    const totalMs = ((hours || 0) * 60 + (minutes || 0)) * 60 * 1000;

    if (totalMs > 0) {
      this.log('info', `定时器已设置: ${hours || 0}时${minutes || 0}分后${action}`, '⏰');

      this.timer = setTimeout(async () => {
        this.log('info', `定时器触发: ${action}`, '⏰');
        if (action === 'restart') {
          await this.restart();
        } else if (action === 'disconnect') {
          this.disconnect();
        }
      }, totalMs);
    }
  }

  async handleCommand(username, message) {
    const parts = message.trim().split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (this.commands[cmd]) {
      try {
        await this.commands[cmd](username, args);
        this.log('success', `指令执行成功: ${cmd}`, '✓');
      } catch (error) {
        this.log('error', `指令执行失败: ${error.message}`, '✗');
      }
    } else if (this.bot) {
      this.bot.chat(`未知指令: ${cmd}，输入 !help 查看帮助`);
    }
  }

  async executeCommand(command) {
    if (this.bot) {
      this.bot.chat(command);
      this.log('info', `发送指令: ${command}`, '📤');
      return true;
    }
    throw new Error('机器人未连接');
  }

  // Command implementations
  cmdHelp(username) {
    if (!this.bot) return;
    const helpText = [
      '可用指令:',
      '!help - 显示帮助',
      '!come - 走向你',
      '!follow - 跟随你',
      '!stop - 停止移动',
      '!pos - 显示位置',
      '!ask [问题] - 问AI问题'
    ];
    helpText.forEach(line => this.bot.chat(line));
  }

  async cmdCome(username) {
    if (!this.bot) return;
    const player = this.bot.players[username];
    if (!player?.entity) {
      this.bot.chat('找不到你的位置');
      return;
    }

    const goal = new goals.GoalNear(
      player.entity.position.x,
      player.entity.position.y,
      player.entity.position.z,
      2
    );
    this.bot.pathfinder.setGoal(goal);
    this.bot.chat(`正在走向 ${username}`);
  }

  cmdFollow(username) {
    if (!this.bot) return;
    const player = this.bot.players[username];
    if (!player?.entity) {
      this.bot.chat('找不到你的位置');
      return;
    }

    const goal = new goals.GoalFollow(player.entity, 2);
    this.bot.pathfinder.setGoal(goal, true);
    this.bot.chat(`开始跟随 ${username}`);
  }

  cmdStop() {
    if (!this.bot) return;
    this.bot.pathfinder.stop();
    this.bot.chat('已停止');
  }

  cmdPosition() {
    if (!this.bot) return;
    const pos = this.bot.entity.position;
    this.bot.chat(`位置: X=${Math.floor(pos.x)} Y=${Math.floor(pos.y)} Z=${Math.floor(pos.z)}`);
  }

  async cmdAsk(username, args) {
    if (!this.bot) return;
    if (args.length === 0) {
      this.bot.chat('请输入问题，例如: !ask 今天天气怎么样');
      return;
    }

    const question = args.join(' ');
    this.log('info', `${username} 问: ${question}`, '🤖');

    try {
      const response = await this.aiService.chat(question, username);
      const maxLen = 100;
      for (let i = 0; i < response.length; i += maxLen) {
        this.bot.chat(response.substring(i, i + maxLen));
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (error) {
      this.bot.chat('AI 暂时无法回答，请稍后再试');
      this.log('error', `AI 错误: ${error.message}`, '✗');
    }
  }
}
