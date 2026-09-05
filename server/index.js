import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

import { BotManager } from './bot/BotPool.js';
import { AIService } from './services/AIService.js';
import { ConfigManager } from './services/ConfigManager.js';
import { AuthService } from './services/AuthService.js';
import { AuditService } from './services/AuditService.js';
import { SystemService } from './services/SystemService.js';
import { proxyService } from './services/ProxyService.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerProxyRoutes } from './routes/proxy.js';
import { registerTelegramRoutes } from './routes/telegram.js';
import { registerBotRoutes } from './routes/bots.js';
import { registerFileRoutes } from './routes/files.js';

dotenv.config();

// Log masking utility to prevent sensitive data leakage
function maskSensitiveData(text) {
  if (typeof text !== 'string') return text;

  return text
    // Mask API keys
    .replace(/apiKey[=:\s]+[^\s,}]+/gi, 'apiKey=***')
    .replace(/api_key[=:\s]+[^\s,}]+/gi, 'api_key=***')
    .replace(/apikey[=:\s]+[^\s,}]+/gi, 'apikey=***')
    // Mask passwords
    .replace(/password[=:\s]+[^\s,}]+/gi, 'password=***')
    .replace(/passwd[=:\s]+[^\s,}]+/gi, 'passwd=***')
    // Mask JWT tokens and Bearer tokens
    .replace(/Bearer\s+[^\s,}]+/gi, 'Bearer ***')
    .replace(/token[=:\s]+[^\s,}]+/gi, 'token=***')
    // Mask SSH keys
    .replace(/privateKey[=:\s]+[^\s,}]+/gi, 'privateKey=***')
    .replace(/private_key[=:\s]+[^\s,}]+/gi, 'private_key=***')
    // Mask URLs with credentials
    .replace(/https?:\/\/[^:]+:[^@]+@/gi, 'https://***:***@')
    // Mask Pterodactyl URLs
    .replace(/(ptero[a-z]*url|panel[a-z]*url)[=:\s]+[^\s,}]+/gi, '$1=***');
}

// Override console methods to mask sensitive data
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = function (...args) {
  const maskedArgs = args.map(arg => maskSensitiveData(String(arg)));
  originalLog.apply(console, maskedArgs);
};

console.error = function (...args) {
  const maskedArgs = args.map(arg => maskSensitiveData(String(arg)));
  originalError.apply(console, maskedArgs);
};

console.warn = function (...args) {
  const maskedArgs = args.map(arg => maskSensitiveData(String(arg)));
  originalWarn.apply(console, maskedArgs);
};

// Capture uncaught exceptions, prevent process crash
process.on('uncaughtException', (err) => {
  console.error('[进程] 未捕获的异常:', err.message);
  // 对于 PartialReadError 等非致命错误，不退出进程
  if (err.name === 'PartialReadError' || err.message.includes('PartialReadError')) {
    console.error('[进程] PartialReadError - 忽略并继续运行');
    return;
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[进程] 未处理的 Promise 拒绝:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Middleware
app.use(cors());
app.use(express.json());

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https: wss:; font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com;");
  next();
});

// Initialize services
const configManager = new ConfigManager();
const authService = new AuthService(configManager);
const aiService = new AIService(configManager);
const systemService = new SystemService();
const auditService = new AuditService();
const botManager = new BotManager(configManager, aiService, broadcast);

// Initialize Proxy Service
const initializeProxy = async () => {
  const config = configManager.getFullConfig();
  if (config.proxyNodes && config.proxyNodes.length > 0) {
    await proxyService.restart(config.proxyNodes);
  }
};
initializeProxy();

// Apply auth middleware to all /api routes except auth and screenshots
// MUST be defined BEFORE API routes
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login' || req.path === '/auth/check' || req.path.startsWith('/screenshots/') || req.path.startsWith('/webhooks/')) {
    return next();
  }
  return authService.authMiddleware()(req, res, next);
});

// Health check endpoint (before all middleware, for Docker health check)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

registerAuthRoutes(app, { authService, auditService });



// Serve static files
app.use((req, res, next) => {
  const isHtml = req.path === '/' || req.path.endsWith('.html');
  const isAsset = req.path.startsWith('/assets/') && (req.path.endsWith('.js') || req.path.endsWith('.css'));
  if (isHtml || isAsset) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(join(__dirname, '../dist')));
// Serve screenshots
app.use('/api/screenshots', express.static(join(process.cwd(), 'data', 'screenshots')));

// WebSocket connections
const clients = new Set();

server.on('upgrade', (req, socket, head) => {
  return wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  // Verify token for WebSocket connections
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token || !authService.verifyToken(token)) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  clients.add(ws);

  // Send current status on connection
  ws.send(JSON.stringify({
    type: 'status',
    data: botManager.getStatus()
  }));

  // Send recent logs
  ws.send(JSON.stringify({
    type: 'logs',
    data: botManager.getRecentLogs()
  }));

  ws.on('close', () => {
    clients.delete(ws);
  });
});

function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// Initialize renewal service (after broadcast is defined)


// API Routes

registerSystemRoutes(app, { systemService });
registerProxyRoutes(app, { configManager, proxyService });

// Get bot status
app.get('/api/status', (req, res) => {
  res.json(botManager.getStatus());
});

// Get all configuration
app.get('/api/config', (req, res) => {
  res.json(configManager.getConfig());
});

// Get full configuration (for settings page)
app.get('/api/config/full', (req, res) => {
  const config = configManager.getFullConfig();
  // Hide sensitive data
  const safeConfig = {
    ...config,
    auth: config.auth ? { username: config.auth.username, password: '******' } : null,
    ai: config.ai ? { ...config.ai, apiKey: config.ai.apiKey ? '******' : '' } : null
  };
  res.json(safeConfig);
});

// Update configuration
app.post('/api/config', (req, res) => {
  try {
    configManager.updateConfig(req.body);
    res.json({ success: true, config: configManager.getConfig() });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Update all settings
app.post('/api/settings', (req, res) => {
  try {
    const { server, ai, auth, autoChat, autoRenew } = req.body;

    const updates = {};
    if (server) updates.server = server;
    if (ai) {
      updates.ai = {
        ...configManager.getFullConfig().ai,
        ...ai,
        // Only update apiKey if provided and not masked
        apiKey: ai.apiKey && ai.apiKey !== '******'
          ? ai.apiKey
          : configManager.getFullConfig().ai?.apiKey
      };
    }
    if (auth && auth.password !== '******') {
      updates.auth = auth;
    } else if (auth) {
      updates.auth = {
        username: auth.username,
        password: configManager.getFullConfig().auth?.password || 'admin123'
      };
    }
    if (autoChat) updates.autoChat = autoChat;
    if (autoRenew) updates.autoRenew = autoRenew;

    configManager.updateConfig(updates);

    // Reinitialize AI service if config changed
    if (ai) {
      aiService.updateConfig();
    }

    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Save credentials
app.post('/api/credentials', (req, res) => {
  try {
    configManager.updateCredentials(req.body);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Connect bot
app.post('/api/bot/connect', async (req, res) => {
  try {
    await botManager.connect(req.body);
    res.json({ success: true, status: botManager.getStatus() });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Disconnect bot
app.post('/api/bot/disconnect', (req, res) => {
  try {
    botManager.disconnect();
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Restart bot
app.post('/api/bot/restart', async (req, res) => {
  try {
    await botManager.restart();
    res.json({ success: true, status: botManager.getStatus() });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Toggle mode
app.post('/api/bot/mode', (req, res) => {
  try {
    const { mode, enabled } = req.body;
    botManager.setMode(mode, enabled);
    res.json({ success: true, modes: botManager.getModes() });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Get modes
app.get('/api/bot/modes', (req, res) => {
  res.json(botManager.getModes());
});

// Set timer
app.post('/api/bot/timer', (req, res) => {
  try {
    const { minutes, hours, action } = req.body;
    botManager.setTimer(minutes, hours, action);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Execute command
app.post('/api/bot/command', async (req, res) => {
  try {
    const { command } = req.body;
    const result = await botManager.executeCommand(command);
    res.json({ success: true, result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// AI chat
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const response = await aiService.chat(message);
    res.json({ success: true, response });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Get logs
app.get('/api/logs', (req, res) => {
  res.json(botManager.getRecentLogs());
});

registerBotRoutes(app, {
  botManager,
  configManager
});
registerFileRoutes(app, {
  botManager
});

// Serve frontend for all other routes


registerTelegramRoutes(app, { configManager });

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../dist/index.html'));
});

// Webhook endpoint for auto power-on
app.post('/api/webhooks/trigger', async (req, res) => {
  try {
    const body = req.body;
    // 将整个 body 转为小写字符串以便匹配
    const content = JSON.stringify(body).toLowerCase();

    console.log('[Webhook] Received trigger:', content.substring(0, 200) + '...');

    // 广播到前端日志，方便用户调试
    broadcast('log', {
      type: 'info',
      icon: '🔔',
      message: `收到 Webhook: ${content.substring(0, 50)}...`,
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    });

    const matchedBots = [];

    // 遍历所有机器人实例
    for (const [id, bot] of botManager.bots) {
      // 获取服务器名称（优先用配置名，没有则用默认名）
      const serverName = (bot.config.name || bot.status.serverName || '').toLowerCase();

      // 如果服务器名字有效且出现在 webhook 内容中
      if (serverName && content.includes(serverName)) {
        // 检查是否有面板配置
        const panel = bot.status.pterodactyl;
        const hasPanelConfig = typeof bot.isPanelConfigured === 'function'
          ? bot.isPanelConfigured()
          : !!(panel?.url && panel?.serverId && (panel?.apiKey || panel?.cookie));

        if (hasPanelConfig) {
          const authType = panel?.authType === 'cookie' ? 'Cookie' : 'API Key';
          const msg = `Webhook 匹配到服务器: ${bot.config.name}，正在通过 ${authType} 执行开机...`;
          console.log(`[Webhook] ${msg}`);
          broadcast('log', { type: 'success', icon: '⚡', message: msg, timestamp: new Date().toLocaleTimeString() });

          // 为了不阻塞响应，异步执行开机
          bot.sendPowerSignal('start')
            .then(async () => {
              // 成功开机后，发送 Telegram 通知
              const tgConfig = configManager.getFullConfig().telegram || {};
              const { enabled, botToken, chatId } = tgConfig;

              const finalToken = enabled && botToken ? botToken : process.env.TG_BOT_TOKEN;
              const finalChatId = enabled && chatId ? chatId : process.env.TG_CHAT_ID;

              if (finalToken && finalChatId) {
                try {
                  const message = `⚡电源信号已发送: [${bot.config.name}] 开机成功`;
                  await axios.post(`https://api.telegram.org/bot${finalToken}/sendMessage`, {
                    chat_id: finalChatId,
                    text: message
                  });
                  console.log(`[Telegram]这里是TG消息通知推送日志 Notification sent for ${serverName}`);
                } catch (tgError) {
                  console.error('[Telegram] Failed to send notification:', tgError.message);
                }
              }
            })
            .catch(e => {
              console.error(`[Webhook] Failed to start ${serverName}:`, e.message);
              broadcast('log', { type: 'error', icon: '❌', message: `开机失败: ${e.message}`, timestamp: new Date().toLocaleTimeString() });
            });

          matchedBots.push(serverName);
        } else {
          const msg = `Webhook 匹配到 ${bot.config.name} 但未配置翼龙面板信息`;
          console.log(`[Webhook] ${msg}`);
          broadcast('log', { type: 'warning', icon: '⚠️', message: msg, timestamp: new Date().toLocaleTimeString() });
        }
      }
    }

    if (matchedBots.length > 0) {
      res.json({ success: true, message: `Triggered start for: ${matchedBots.join(', ')}`, matched: matchedBots });
    } else {
      res.json({ success: false, message: 'No matching server found with panel config' });
    }
  } catch (error) {
    console.error('[Webhook] Error:', error);
    // 广播错误以便用户知道请求失败了
    broadcast('log', {
      type: 'error',
      icon: '💥',
      message: `Webhook 处理出错: ${error.message}`,
      timestamp: new Date().toLocaleTimeString()
    });
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Default login: admin / admin123`);
  broadcast('log', {
    type: 'info',
    icon: '🚀',
    message: `服务器已启动，端口 ${PORT}`
  });

  // 服务器连接由 BotPool.loadSavedServers() 自动处理
  // 这里只做日志提示
  const servers = configManager.getServers();
  if (servers && servers.length > 0) {
    console.log(`发现 ${servers.length} 个保存的服务器，正在后台自动连接...`);
    broadcast('log', {
      type: 'info',
      icon: '🔄',
      message: `正在后台自动连接 ${servers.length} 个服务器...`
    });
  }
});
