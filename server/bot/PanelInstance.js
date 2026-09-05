import axios from 'axios';
import https from 'https';
import net from 'net';
import SftpClient from 'ssh2-sftp-client';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { proxyService } from '../services/ProxyService.js';

/**
 * Panel-only server instance (no Minecraft bot)
 * Used for managing servers via Pterodactyl API or SFTP
 */
export class PanelInstance {
  constructor(id, config, onLog, onStatusChange, configManager = null) {
    this.id = id;
    this.config = config;
    this.onLog = onLog;
    this.onStatusChange = onStatusChange;
    this.configManager = configManager;

    // 日志
    this.logs = [];
    this.maxLogs = 100;

    // 面板状态
    this.panelStatus = null;
    this.statusCheckInterval = null;

    this.status = {
      id: this.id,
      type: 'panel',
      connected: false, // 面板是否可访问
      serverName: config.name || `Panel ${id}`,
      pterodactyl: config.pterodactyl || null,
      sftp: config.sftp || null, // SFTP 配置
      fileAccessType: config.fileAccessType || 'pterodactyl', // 文件访问方式
      panelServerState: null, // 'running', 'starting', 'stopping', 'offline'
      panelServerStats: null, // CPU, memory usage etc.
      // 服务器地址信息（从面板获取）
      serverHost: null,
      serverPort: null,
      // TCP ping 结果
      tcpOnline: null, // true/false/null(未检测)
      tcpLatency: null // 延迟毫秒
    };

    // Auto Restart Logic
    this.autoRestart = {
      retryCount: 0,
      lastRestartTime: 0,
      manualStop: false
    };

    // 为 API 兼容性添加空的 modes 和 autoChatConfig
    this.modes = {};
    this.autoChatConfig = null;
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

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    console.log(`[${timestamp}] [${this.status.serverName}] ${icon} ${message}`);
    if (this.onLog) this.onLog(this.id, entry);
  }

  getLogs() {
    return this.logs;
  }

  clearLogs() {
    this.logs = [];
  }

  getStatus() {
    const name = this.config.name || this.status.serverName;
    // 只使用手动配置的地址
    const host = this.config.host || '';
    const port = this.config.port || 0;
    return {
      ...this.status,
      serverName: name, // 确保 serverName 与 name 一致
      serverHost: host, // 同步更新 serverHost
      serverPort: port, // 同步更新 serverPort
      host: host,
      port: port,
      name: name,
      modes: {},
      autoChat: null,
      behaviors: null,
      sftp: this.status.sftp,
      fileAccessType: this.status.fileAccessType,
      proxyNodeId: this.config.proxyNodeId || '',
      autoReconnect: !!this.config.autoReconnect
    };
  }

  /**
   * 检查面板配置是否有效
   */
  isPanelConfigured() {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.serverId) return false;

    if (panel.authType === 'cookie') {
      return !!panel.cookie;
    }
    return !!panel.apiKey;
  }

  /**
   * 获取认证请求头
   */
  getAuthHeaders() {
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
      // 浏览器通常还需要 User-Agent 和 Referer
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
      headers['Referer'] = `${panel.url}/server/${panel.serverId}`;
      headers['Origin'] = panel.url;
    } else {
      headers['Authorization'] = `Bearer ${panel.apiKey}`;
    }

    return headers;
  }

  /**
   * 获取完整的 HTTP 请求配置 (包含代理和 Headers)
   */
  getHttpOptions(extraConfig = {}) {
    const panel = this.status.pterodactyl;
    const options = {
      ...extraConfig,
      headers: { ...this.getAuthHeaders(), ...(extraConfig.headers || {}) },
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

  /**
   * 连接到面板（开始状态检查）
   */
  async connect() {
    // 检查是否有任何可用的配置（翼龙面板或手动IP/端口）
    const hasPanelConfig = this.isPanelConfigured();
    const pingHost = this.config.host;
    const pingPort = this.config.port;
    const hasAddress = pingHost && pingPort;

    if (!hasPanelConfig && !hasAddress) {
      this.log('warning', '未配置翼龙面板或服务器地址', '⚠');
      // 即使没有配置也启动状态检查，以便后续配置更新时能自动开始
      this.startStatusCheck();
      return;
    }

    if (hasPanelConfig) {
      this.log('info', '正在连接翼龙面板...', '🔌');

      try {
        // 先获取服务器分配的地址
        await this.fetchServerAllocation();
        // 再获取服务器状态
        await this.fetchServerStatus();
        this.status.connected = true;
        this.log('success', '面板连接成功', '✅');
      } catch (error) {
        const status = error.response?.status;
        let hint = '';
        if (status === 403) {
          hint = ' (API Key 无效或权限不足，请检查 API Key)';
        } else if (status === 401) {
          hint = ' (未授权，请检查 API Key 或 Cookie)';
        } else if (status === 419) {
          hint = ' (CSRF Token 失效，请更新 Cookie/Token)';
        } else if (status === 404) {
          hint = ' (服务器ID不存在，请检查配置)';
        }
        this.log('error', `面板连接失败: ${error.message}${hint}`, '❌');
        this.status.connected = false;
      }
    } else {
      // 只有手动配置，执行一次 TCP ping
      this.log('info', `检测服务器 ${pingHost}:${pingPort}...`, '🔌');
      await this.doTcpPingOnly();
      this.status.connected = true; // 标记为已连接（已开始监控）
    }

    // 开始定期检查状态
    this.startStatusCheck();

    if (this.onStatusChange) {
      this.onStatusChange(this.id, this.getStatus());
    }
  }

  /**
   * 断开连接（停止状态检查）
   */
  disconnect() {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
    this.status.connected = false;
    this.log('info', '已断开面板连接', '🔌');
    if (this.onStatusChange) {
      this.onStatusChange(this.id, this.getStatus());
    }
  }

  /**
   * 开始定期检查服务器状态
   */
  startStatusCheck() {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
    }

    // 每 30 秒检查一次状态
    this.statusCheckInterval = setInterval(async () => {
      try {
        if (this.isPanelConfigured()) {
          // 有翼龙面板配置，获取完整状态
          await this.fetchServerStatus();
        } else {
          // 没有翼龙面板，只做 TCP ping（doTcpPingOnly 会自己检查是否有地址）
          await this.doTcpPingOnly();
        }
      } catch (error) {
        const status = error.response?.status;
        let hint = '';
        if (status === 403) {
          hint = ' (API Key 无效或权限不足)';
        } else if (status === 401) {
          hint = ' (未授权)';
        } else if (status === 419) {
          hint = ' (CSRF Token 失效)';
        } else if (status === 404) {
          hint = ' (服务器ID不存在)';
        }
        this.log('warning', `状态检查失败: ${error.message}${hint}`, '⚠');
      }
    }, 30000);
  }

  /**
   * 刷新配置后重新检查状态（配置更新后调用）
   */
  async refreshStatusCheck() {
    const hasPanelConfig = this.isPanelConfigured();
    // 只使用手动配置的地址
    const pingHost = this.config.host;
    const pingPort = this.config.port;
    const hasAddress = pingHost && pingPort;

    if (!hasPanelConfig && !hasAddress) {
      // 没有配置，停止状态检查
      if (this.statusCheckInterval) {
        clearInterval(this.statusCheckInterval);
        this.statusCheckInterval = null;
      }
      this.status.tcpOnline = null;
      this.status.tcpLatency = null;
      return;
    }

    // 确保状态检查已启动
    if (!this.statusCheckInterval) {
      this.startStatusCheck();
    }

    // 立即执行一次检查
    try {
      if (hasPanelConfig) {
        await this.fetchServerStatus();
      } else {
        this.log('info', `检测服务器 ${pingHost}:${pingPort}...`, '🔌');
        await this.doTcpPingOnly();
      }
      this.status.connected = true;
    } catch (error) {
      this.log('warning', `状态检查失败: ${error.message}`, '⚠');
    }

    if (this.onStatusChange) {
      this.onStatusChange(this.id, this.getStatus());
    }
  }

  /**
   * 只执行 TCP ping（没有翼龙面板配置时使用）
   */
  async doTcpPingOnly() {
    // 只使用手动配置的地址，API获取的是管理地址不一定能ping
    const pingHost = this.config.host;
    const pingPort = this.config.port;

    if (pingHost && pingPort) {
      const pingResult = await this.tcpPing(pingHost, pingPort);
      this.status.tcpOnline = pingResult.online;
      this.status.tcpLatency = pingResult.latency;

      if (pingResult.online) {
        this.log('info', `TCP 在线: ${pingHost}:${pingPort} (${pingResult.latency}ms)`, '✅');
      } else {
        this.log('warning', `TCP 离线: ${pingHost}:${pingPort}`, '❌');
      }

      if (this.onStatusChange) {
        this.onStatusChange(this.id, this.getStatus());
      }
    } else {
      // 没有地址信息
      this.status.tcpOnline = null;
      this.status.tcpLatency = null;
    }
  }

  /**
   * 获取服务器分配的地址和端口
   */
  async fetchServerAllocation() {
    const panel = this.status.pterodactyl;
    if (!this.isPanelConfigured()) {
      throw new Error('面板未配置');
    }

    const url = `${panel.url}/api/client/servers/${panel.serverId}`;

    const response = await axios.get(url, this.getHttpOptions());

    const data = response.data.attributes;
    const relationships = data.relationships;

    // 获取主分配（primary allocation）
    if (relationships?.allocations?.data) {
      const allocations = relationships.allocations.data;
      // 找到默认分配或第一个分配
      const primaryAlloc = allocations.find(a => a.attributes.is_default) || allocations[0];
      if (primaryAlloc) {
        const alloc = primaryAlloc.attributes;
        this.status.serverHost = alloc.ip_alias || alloc.ip;
        this.status.serverPort = alloc.port;
        this.log('info', `服务器地址: ${this.status.serverHost}:${this.status.serverPort}`, '🌐');
      }
    }

    return {
      host: this.status.serverHost,
      port: this.status.serverPort
    };
  }

  /**
   * TCP ping 检测服务器端口是否在线
   */
  tcpPing(host, port, timeout = 5000) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const socket = new net.Socket();

      socket.setTimeout(timeout);

      socket.on('connect', () => {
        const latency = Date.now() - startTime;
        socket.destroy();
        resolve({ online: true, latency });
      });

      socket.on('timeout', () => {
        socket.destroy();
        console.log(`[TCP Ping] ${host}:${port} 超时 (${timeout}ms)`);
        resolve({ online: false, latency: null, error: 'timeout' });
      });

      socket.on('error', (err) => {
        socket.destroy();
        console.log(`[TCP Ping] ${host}:${port} 错误: ${err.message}`);
        resolve({ online: false, latency: null, error: err.message });
      });

      try {
        socket.connect(port, host);
      } catch (err) {
        console.log(`[TCP Ping] ${host}:${port} 连接异常: ${err.message}`);
        resolve({ online: false, latency: null, error: err.message });
      }
    });
  }

  /**
   * 获取服务器状态
   */
  async fetchServerStatus() {
    const panel = this.status.pterodactyl;
    if (!this.isPanelConfigured()) {
      throw new Error('面板未配置');
    }

    const url = `${panel.url}/api/client/servers/${panel.serverId}/resources`;

    const response = await axios.get(url, this.getHttpOptions());

    const data = response.data.attributes;
    this.status.panelServerState = data.current_state;
    this.status.panelServerStats = {
      cpuPercent: data.resources?.cpu_absolute || 0,
      memoryBytes: data.resources?.memory_bytes || 0,
      diskBytes: data.resources?.disk_bytes || 0,
      networkRx: data.resources?.network_rx_bytes || 0,
      networkTx: data.resources?.network_tx_bytes || 0,
      uptime: data.resources?.uptime || 0
    };

    // Auto Restart Check
    if (this.status.pterodactyl?.autoRestart?.enabled) {
      const currentState = this.status.panelServerState;
      const { maxRetries = 3 } = this.status.pterodactyl.autoRestart;

      if (currentState === 'offline' || currentState === 'stopping') {
        if (currentState === 'offline' && !this.autoRestart.manualStop) {
          const now = Date.now();
          // Cooldown: 60s
          if (now - this.autoRestart.lastRestartTime > 60000) {
            if (this.autoRestart.retryCount < maxRetries) {
              this.log('warning', `Detected server offline. Auto-restarting... (${this.autoRestart.retryCount + 1}/${maxRetries})`, '🔄');
              this.autoRestart.retryCount++;
              this.autoRestart.lastRestartTime = now;
              // Trigger restart asynchronously
              this.sendPowerSignal('start').catch(err => {
                this.log('error', `Auto-restart failed: ${err.message}`);
              });

              // Send Telegram Notification
              this.sendTelegramNotification(`🔄 [自动重启] 服务器 ${this.status.serverName} 意外离线，正在尝试第 ${this.autoRestart.retryCount}/${maxRetries} 次重启...`);

            } else if (this.autoRestart.retryCount === maxRetries) {
              const msg = `🚫 [自动重启] 服务器 ${this.status.serverName} 重启失败，已达到最大重试次数 (${maxRetries})，停止尝试。`;
              this.log('error', `Auto-restart gave up after ${maxRetries} attempts.`, '🚫');
              this.sendTelegramNotification(msg);
              this.autoRestart.retryCount++; // Increment to prevent log spam
            }
          }
        }
      } else if (currentState === 'running') {
        if (this.autoRestart.retryCount > 0) {
          this.log('success', 'Server is running stable. Resetting auto-restart counters.', '✅');
          this.autoRestart.retryCount = 0;
        }
      }
    }

    // TCP ping 只使用手动配置的地址
    const pingHost = this.config.host;
    const pingPort = this.config.port;

    // 只要有地址就执行 TCP ping，不依赖面板状态
    if (pingHost && pingPort) {
      const pingResult = await this.tcpPing(pingHost, pingPort);
      this.status.tcpOnline = pingResult.online;
      this.status.tcpLatency = pingResult.latency;

      if (pingResult.online) {
        this.log('info', `TCP 在线: ${pingHost}:${pingPort} (${pingResult.latency}ms)`, '✅');
      }
    } else {
      // 没有地址信息
      this.status.tcpOnline = null;
      this.status.tcpLatency = null;
    }

    if (this.onStatusChange) {
      this.onStatusChange(this.id, this.getStatus());
    }

    return this.status.panelServerStats;
  }

  /**
   * 发送电源信号
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

        await axios.post(url, { signal }, this.getHttpOptions());

        this.log('success', `电源信号已发送: ${signalNames[signal]}`, '⚡');

        if (signal === 'stop' || signal === 'kill') {
          this.autoRestart.manualStop = true;
        } else if (signal === 'start' || signal === 'restart') {
          this.autoRestart.manualStop = false;
          this.autoRestart.retryCount = 0;
        }

        setTimeout(() => this.fetchServerStatus().catch(() => { }), 2000);

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

    let hint = '';
    if (status === 403) {
      hint = panel.authType === 'cookie' ? ' (检查 Cookie 是否过期或权限不足)' : ' (检查 API Key 权限)';
    } else if (status === 401 || status === 419) {
      hint = panel.authType === 'cookie' ? ' (Cookie/CSRF 已失效，请重新从面板复制)' : ' (API Key 无效或已过期)';
    } else if (status === 404) {
      hint = ' (检查服务器 ID 或面板接口路径)';
    } else if (status === 409) {
      hint = ' (服务器状态冲突)';
    }

    this.log('error', `电源信号失败 [${status}]: ${errMsg}${hint}`, '✗');
    return { success: false, message: `${errMsg}${hint}` };
  }

  /**
   * 发送控制台命令
   */
  async sendPanelCommand(command) {
    const panel = this.status.pterodactyl;
    if (!panel || !panel.url || !panel.apiKey || !panel.serverId) {
      return { success: false, message: '翼龙面板未配置' };
    }

    try {
      // 1. Clean panel URL (remove trailing slashes and /api/client suffix if present)
      let baseUrl = panel.url.trim().replace(/\/+$/, '');
      if (baseUrl.endsWith('/api/client')) {
        baseUrl = baseUrl.slice(0, -11); // Remove last 11 chars
      }

      const url = `${baseUrl}/api/client/servers/${panel.serverId}/command`;

      this.log('info', `发送面板命令: ${command} -> ${url}`, '🖥️');

      await axios.post(url, { command }, this.getHttpOptions());

      this.log('success', `命令已发送: ${command}`, '🖥️');
      return { success: true, message: `已发送: ${command}` };
    } catch (error) {
      const status = error.response?.status;
      const errMsg = error.response?.data?.errors?.[0]?.detail || error.message;

      this.log('error', `命令发送失败 [${status}]: ${errMsg}`, '✗');
      return { success: false, message: errMsg };
    }
  }

  /**
   * 设置翼龙面板配置
   */
  setPterodactylConfig(config) {
    // 如果所有字段都为空，清除配置
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
        // Preserve existing autoRestart if not provided in config (safety fallback)
        this.status.pterodactyl.autoRestart = oldPterodactyl.autoRestart;
      }
      this.config.pterodactyl = this.status.pterodactyl;
      this.log('info', `翼龙面板配置已更新 [${authType === 'cookie' ? 'Cookie' : 'API Key'}]`, '🔑');
    }

    // 保存配置
    if (this.configManager) {
      this.configManager.updateServer(this.id, {
        pterodactyl: this.status.pterodactyl === null ? null : (this.status.pterodactyl || {})
      });
    }

    if (this.onStatusChange) {
      this.onStatusChange(this.id, this.getStatus());
    }

    // 刷新状态检查（切换到 TCP ping 或面板 API）
    this.refreshStatusCheck();

    return this.status.pterodactyl;
  }

  /**
   * 发送 Telegram 通知
   */
  async sendTelegramNotification(message) {
    if (!this.configManager) return;

    try {
      const config = this.configManager.getFullConfig();
      const tg = config.telegram;

      if (tg && tg.enabled && tg.botToken && tg.chatId) {
        await axios.post(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
          chat_id: tg.chatId,
          text: message
        }, { timeout: 10000 });
      }
    } catch (error) {
      this.log('error', `Telegram 通知发送失败: ${error.message}`);
    }
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
      const response = await axios.get(url, this.getHttpOptions({ params: { directory } }));

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
      const response = await axios.get(url, this.getHttpOptions({ params: { file }, timeout: 30000 }));

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
      await axios.post(url, content, this.getHttpOptions({
        params: { file },
        headers: { 'Content-Type': 'text/plain' },
        timeout: 30000
      }));

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
      const response = await axios.get(url, this.getHttpOptions({ params: { file } }));

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
      const response = await axios.get(url, this.getHttpOptions());

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
      await axios.post(url, { root, name }, this.getHttpOptions());

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
      await axios.post(url, { root, files }, this.getHttpOptions({ timeout: 30000 }));

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
      }, this.getHttpOptions());

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
      await axios.post(url, { location }, this.getHttpOptions({ timeout: 30000 }));

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
      const response = await axios.post(url, { root, files }, this.getHttpOptions({ timeout: 120000 }));

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
      await axios.post(url, { root, file }, this.getHttpOptions({ timeout: 120000 }));

      this.log('success', `已解压: ${file}`, '📂');
      return { success: true, message: '解压成功' };
    } catch (error) {
      const errMsg = error.response?.data?.errors?.[0]?.detail || error.message;
      this.log('error', `解压失败: ${errMsg}`, '❌');
      return { success: false, error: errMsg };
    }
  }

  // 以下方法返回空操作，保持接口一致性
  setMode() { return {}; }
  setBehavior() { return { success: false, message: '纯面板服务器不支持此操作' }; }
  doAction() { return { success: false, message: '纯面板服务器不支持此操作' }; }
  setRestartTimer() { return {}; }
  sendRestartCommand() { return { success: false, message: '纯面板服务器不支持此操作' }; }
  updateAutoChatConfig() { return {}; }

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
      basePath: config.basePath || '/'
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
   * 保存配置
   */
  saveConfig() {
    if (!this.configManager) return;

    try {
      this.configManager.updateServer(this.id, {
        name: this.config.name,
        host: this.config.host,
        port: this.config.port,
        pterodactyl: this.status.pterodactyl === null ? null : (this.status.pterodactyl || {}),
        sftp: this.status.sftp || {},
        fileAccessType: this.status.fileAccessType || 'pterodactyl'
      });
      this.log('info', '配置已保存', '💾');
    } catch (error) {
      this.log('warning', `保存配置失败: ${error.message}`, '⚠');
    }
  }

  /**
   * 获取 SFTP 客户端连接
   */
  async getSftpClient() {
    const sftp = this.status.sftp;
    if (!sftp || !sftp.host || !sftp.username) {
      throw new Error('SFTP 未配置');
    }

    // 解析 host，支持 host:port 格式
    let host = sftp.host;
    let port = sftp.port || 22;

    if (host.includes(':')) {
      const parts = host.split(':');
      host = parts[0];
      const parsedPort = parseInt(parts[1]);
      if (!isNaN(parsedPort)) {
        port = parsedPort;
      }
    }

    this.log('info', `SFTP 连接: ${host}:${port}`, '🔌');

    const client = new SftpClient();
    const connectOptions = {
      host: host,
      port: port,
      username: sftp.username,
      readyTimeout: 10000,
      retries: 2,
      retry_factor: 2,
      retry_minTimeout: 2000
    };

    if (sftp.privateKey) {
      connectOptions.privateKey = sftp.privateKey;
    } else if (sftp.password) {
      connectOptions.password = sftp.password;
    } else {
      throw new Error('SFTP 需要密码或私钥');
    }

    try {
      await client.connect(connectOptions);
      return client;
    } catch (error) {
      this.log('error', `SFTP 连接失败: ${sftp.host}:${sftp.port} - ${error.message}`, '❌');
      throw error;
    }
  }

  /**
   * 获取 SFTP 完整路径
   */
  getSftpFullPath(relativePath) {
    const basePath = (this.status.sftp?.basePath || '/').replace(/\/+$/, '') || '/';

    // 规范化相对路径
    let cleanPath = (relativePath || '/').replace(/\/+/g, '/');

    // 如果相对路径是根目录或空，直接返回 basePath
    if (cleanPath === '/' || cleanPath === '') {
      return basePath;
    }

    // 移除开头的斜杠，因为我们要拼接到 basePath
    cleanPath = cleanPath.replace(/^\/+/, '');

    // 拼接路径
    const fullPath = basePath === '/' ? `/${cleanPath}` : `${basePath}/${cleanPath}`;
    return fullPath.replace(/\/+/g, '/');
  }

  /**
   * 通过 SFTP 列出目录文件
   */
  async listFilesSftp(directory = '/') {
    let client;
    try {
      client = await this.getSftpClient();

      // 获取当前工作目录
      let cwd = '/';
      try {
        cwd = await client.cwd();
        this.log('info', `SFTP 当前目录: ${cwd}`, '📂');
      } catch (e) {
        // 某些服务器不支持 cwd
      }

      // 确定要列出的路径
      let fullPath;
      const basePath = this.status.sftp?.basePath;

      if (directory === '/' || directory === '' || directory === '.') {
        // 根目录：优先使用 basePath
        if (basePath && basePath !== '/') {
          fullPath = basePath;
        } else {
          // 翼龙 SFTP 返回 cwd='/' 但实际需要用 '.' 列出当前目录
          fullPath = '.';
        }
      } else {
        fullPath = this.getSftpFullPath(directory);
      }

      this.log('info', `SFTP 列出目录: ${fullPath}`, '📂');

      const list = await client.list(fullPath);
      this.log('info', `SFTP 找到 ${list.length} 个文件`, '📂');

      const files = list.map(item => ({
        name: item.name,
        mode: item.rights?.user || '',
        size: item.size,
        isFile: item.type === '-',
        isSymlink: item.type === 'l',
        isEditable: item.type === '-' && item.size < 10 * 1024 * 1024,
        mimetype: this.getMimeType(item.name),
        createdAt: item.accessTime ? new Date(item.accessTime * 1000).toISOString() : null,
        modifiedAt: item.modifyTime ? new Date(item.modifyTime * 1000).toISOString() : null
      }));

      return { success: true, files, directory };
    } catch (error) {
      this.log('error', `SFTP 列出文件失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) {
        try {
          await client.end();
        } catch (e) {
          // 忽略关闭连接时的错误
        }
      }
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
      this.log('info', `SFTP 读取文件: ${fullPath}`, '📄');

      const content = await client.get(fullPath);

      return { success: true, content: content.toString('utf-8'), file };
    } catch (error) {
      this.log('error', `SFTP 读取文件失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) {
        try {
          await client.end();
        } catch (e) {
          // 忽略关闭连接时的错误
        }
      }
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
      this.log('info', `SFTP 写入文件: ${fullPath}`, '📝');

      await client.put(Buffer.from(content, 'utf-8'), fullPath);

      this.log('success', `SFTP 文件已保存: ${file}`, '💾');
      return { success: true, message: '文件已保存' };
    } catch (error) {
      this.log('error', `SFTP 保存文件失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) {
        try {
          await client.end();
        } catch (e) {
          // 忽略关闭连接时的错误
        }
      }
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
      this.log('info', `SFTP 创建文件夹: ${fullPath}`, '📁');

      await client.mkdir(fullPath, true);

      this.log('success', `SFTP 文件夹已创建: ${root}${name}`, '📁');
      return { success: true, message: '文件夹已创建' };
    } catch (error) {
      this.log('error', `SFTP 创建文件夹失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) {
        try {
          await client.end();
        } catch (e) {
          // 忽略关闭连接时的错误
        }
      }
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
          this.log('info', `SFTP 删除: ${fullPath}`, '🗑️');
          const stat = await client.stat(fullPath);
          if (stat.isDirectory) {
            await client.rmdir(fullPath, true);
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
      if (client) {
        try {
          await client.end();
        } catch (e) {
          // 忽略关闭连接时的错误
        }
      }
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
      this.log('info', `SFTP 重命名: ${fromPath} -> ${toPath}`, '✏️');

      await client.rename(fromPath, toPath);

      this.log('success', `SFTP 已重命名: ${from} -> ${to}`, '✏️');
      return { success: true, message: '重命名成功' };
    } catch (error) {
      this.log('error', `SFTP 重命名失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) {
        try {
          await client.end();
        } catch (e) {
          // 忽略关闭连接时的错误
        }
      }
    }
  }

  /**
   * 通过 SFTP 复制文件
   */
  async copyFileSftp(location) {
    let client;
    try {
      client = await this.getSftpClient();
      const fullPath = this.getSftpFullPath(location);

      const lastSlash = location.lastIndexOf('/');
      const dir = location.substring(0, lastSlash + 1);
      const fileName = location.substring(lastSlash + 1);
      const ext = fileName.lastIndexOf('.');
      const baseName = ext > 0 ? fileName.substring(0, ext) : fileName;
      const extension = ext > 0 ? fileName.substring(ext) : '';
      const copyName = `${baseName} copy${extension}`;
      const copyPath = this.getSftpFullPath(`${dir}${copyName}`);

      this.log('info', `SFTP 复制: ${fullPath} -> ${copyPath}`, '📋');

      const content = await client.get(fullPath);
      await client.put(content, copyPath);

      this.log('success', `SFTP 已复制: ${location} -> ${copyName}`, '📋');
      return { success: true, message: '复制成功' };
    } catch (error) {
      this.log('error', `SFTP 复制失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) {
        try {
          await client.end();
        } catch (e) {
          // 忽略关闭连接时的错误
        }
      }
    }
  }

  /**
   * 获取 SFTP 文件下载
   */
  async getFileDownloadSftp(file) {
    let client;
    try {
      client = await this.getSftpClient();
      const fullPath = this.getSftpFullPath(file);
      this.log('info', `SFTP 下载: ${fullPath}`, '📥');

      const content = await client.get(fullPath);

      return { success: true, content, file };
    } catch (error) {
      this.log('error', `SFTP 下载文件失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) {
        try {
          await client.end();
        } catch (e) {
          // 忽略关闭连接时的错误
        }
      }
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
      this.log('info', `SFTP 上传: ${fullPath}`, '📤');

      await client.put(content, fullPath);

      this.log('success', `SFTP 文件已上传: ${fileName}`, '📤');
      return { success: true, message: '文件已上传' };
    } catch (error) {
      this.log('error', `SFTP 上传文件失败: ${error.message}`, '❌');
      return { success: false, error: error.message };
    } finally {
      if (client) {
        try {
          await client.end();
        } catch (e) {
          // 忽略关闭连接时的错误
        }
      }
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

  /**
   * 清理资源
   */
  cleanup() {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
    this.status.connected = false;
  }
}
