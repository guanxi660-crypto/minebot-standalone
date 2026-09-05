import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// ============================================================================
// 安全配置
// ============================================================================

const JWT_SECRET = process.env.JWT_SECRET || 'c7b4e2a1f9c04d7fbd8a8c3a6f1b2d7e6a9c4b1f3d8e2c7a9b4f1d6e8c2a7b5f';

const TOKEN_EXPIRY = '24h';

// 常见密码列表 (用于密码强度检查)
const COMMON_PASSWORDS = new Set([
  'password', 'admin123', '123456', 'password123', 'admin', 'root',
  'letmein', 'welcome', 'monkey', 'dragon', 'master', 'sunshine',
  'princess', 'qwerty', '12345678', '123123', 'abc123'
]);

// ============================================================================
// 密码哈希与验证函数
// ============================================================================

/**
 * 使用 PBKDF2 + SHA256 哈希密码
 * @param {string} password - 密码
 * @param {Buffer} salt - 盐值 (如果为null则生成新盐)
 * @returns {{hash: string, salt: string}} - Base64编码的哈希和盐
 */
function hashPassword(password, salt = null) {
  if (!salt) {
    salt = crypto.randomBytes(16);
  }

  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  return {
    hash: hash.toString('base64'),
    salt: salt.toString('base64')
  };
}

/**
 * 验证密码 (安全比较,防止时序攻击)
 * @param {string} password - 输入的密码
 * @param {{hash: string, salt: string}} stored - 存储的哈希对象
 * @returns {boolean} - 是否匹配
 */
function verifyPassword(password, stored) {
  const salt = Buffer.from(stored.salt, 'base64');
  const { hash } = hashPassword(password, salt);

  // 使用 timingSafeEqual 防止时序攻击
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash, 'base64'),
      Buffer.from(stored.hash, 'base64')
    );
  } catch (error) {
    return false;
  }
}

/**
 * 验证密码强度
 * @param {string} password - 密码
 * @param {string} username - 用户名 (用于检查是否包含用户名)
 * @returns {{valid: boolean, score: number, reasons: string[]}}
 */
function validatePasswordStrength(password, username = '') {
  const reasons = [];
  let score = 0;

  if (!password) {
    reasons.push('Password cannot be empty');
    return { valid: false, score: 0, reasons };
  }

  // 长度检查
  if (password.length < 8) {
    reasons.push('Password must be at least 8 characters');
  } else {
    score += 1;
  }

  // 大小写混合
  if (!/[a-z]/.test(password)) {
    reasons.push('Password must contain lowercase letters');
  } else if (!/[A-Z]/.test(password)) {
    reasons.push('Password must contain uppercase letters');
  } else {
    score += 1;
  }

  // 数字检查
  if (!/\d/.test(password)) {
    reasons.push('Password must contain numbers');
  } else {
    score += 1;
  }

  // 特殊字符检查
  if (!/[!@#$%^&*_\-+=\[\]{};:'",.<>?/\\|`~]/.test(password)) {
    reasons.push('Password must contain special characters (!@#$%^&* etc)');
  } else {
    score += 1;
  }

  // 检查常见密码
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    reasons.push('Password is too common');
  } else {
    score += 1;
  }

  // 检查是否包含用户名
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    reasons.push('Password cannot contain username');
  }

  const valid = reasons.length === 0;
  return { valid, score: Math.max(0, Math.min(5, score)), reasons };
}

/**
 * 登录速率限制器
 */
class LoginRateLimiter {
  constructor() {
    this.attempts = new Map(); // key: username_ip, value: {count, timestamp, locked: boolean, lockedUntil}
    this.MAX_ATTEMPTS = 5;
    this.LOCKOUT_DURATION = 30000; // 30秒
    this.HARD_LOCKOUT_DURATION = 86400000; // 24小时
    this.HARD_LOCKOUT_THRESHOLD = 10;
  }

  checkAttempt(username, ip) {
    const key = `${username}_${ip}`;
    const now = Date.now();
    const attempt = this.attempts.get(key);

    if (!attempt) {
      return { allowed: true, remaining: this.MAX_ATTEMPTS };
    }

    // 检查硬锁定 (24小时)
    if (attempt.locked && attempt.hardLocked) {
      if (now < attempt.lockedUntil) {
        const remainingMs = attempt.lockedUntil - now;
        return {
          allowed: false,
          remaining: 0,
          message: `Account locked for ${Math.ceil(remainingMs / 1000)}s (hard lockout)`
        };
      } else {
        // 锁定期已过期
        this.attempts.delete(key);
        return { allowed: true, remaining: this.MAX_ATTEMPTS };
      }
    }

    // 检查软锁定 (30秒)
    if (attempt.locked) {
      if (now < attempt.lockedUntil) {
        const remainingMs = attempt.lockedUntil - now;
        return {
          allowed: false,
          remaining: 0,
          message: `Too many attempts. Try again in ${Math.ceil(remainingMs / 1000)}s`
        };
      } else {
        // 重置计数
        this.attempts.set(key, { count: 0, timestamp: now, locked: false });
        return { allowed: true, remaining: this.MAX_ATTEMPTS };
      }
    }

    // 检查是否超时需要重置
    if (now - attempt.timestamp > 300000) { // 5分钟后重置
      this.attempts.set(key, { count: 0, timestamp: now, locked: false });
      return { allowed: true, remaining: this.MAX_ATTEMPTS };
    }

    return { allowed: true, remaining: this.MAX_ATTEMPTS - attempt.count };
  }

  recordFailure(username, ip) {
    const key = `${username}_${ip}`;
    const now = Date.now();
    const attempt = this.attempts.get(key) || { count: 0, timestamp: now, locked: false };

    attempt.count++;

    if (attempt.count >= this.HARD_LOCKOUT_THRESHOLD) {
      attempt.locked = true;
      attempt.hardLocked = true;
      attempt.lockedUntil = now + this.HARD_LOCKOUT_DURATION;
      this.attempts.set(key, attempt);
      return { locked: true, hardLocked: true, message: 'Account locked for 24 hours' };
    } else if (attempt.count >= this.MAX_ATTEMPTS) {
      attempt.locked = true;
      attempt.hardLocked = false;
      attempt.lockedUntil = now + this.LOCKOUT_DURATION;
      this.attempts.set(key, attempt);
      return { locked: true, hardLocked: false, message: 'Account locked for 30s' };
    }

    this.attempts.set(key, attempt);
    return { locked: false };
  }

  recordSuccess(username, ip) {
    const key = `${username}_${ip}`;
    this.attempts.delete(key);
  }
}

const rateLimiter = new LoginRateLimiter();

// ============================================================================
// AuthService 类
// ============================================================================

export class AuthService {
  constructor(configManager) {
    this.configManager = configManager;
    this.rateLimiter = rateLimiter;
  }

  /**
   * 获取初始管理员凭证 (从环境变量或默认值)
   * @returns {{username: string, password: {hash: string, salt: string}}}
   */
  getDefaultCredentials() {
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(8).toString('hex');

    const { hash, salt } = hashPassword(adminPassword);

    console.log('📋 First-time setup credentials:');
    console.log(`   Username: ${adminUsername}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.log(`   Generated password: ${adminPassword}`);
      console.log('   ⚠️  Make sure to save this password or set ADMIN_PASSWORD in environment');
    }

    return {
      username: adminUsername,
      password: { hash, salt }
    };
  }

  /**
   * 获取当前凭证
   */
  getCredentials() {
    const config = this.configManager.getFullConfig();

    if (!config.auth || !config.auth.password) {
      return this.getDefaultCredentials();
    }

    // 兼容旧版明文密码格式 - 自动迁移到哈希格式
    if (typeof config.auth.password === 'string') {
      console.log('🔄 Migrating plaintext password to hashed format...');
      const { hash, salt } = hashPassword(config.auth.password);
      config.auth.password = { hash, salt };
      // 保存迁移后的配置
      this.configManager.updateConfig({ auth: config.auth });
      console.log('✅ Password migration complete');
    }

    return config.auth;
  }

  /**
   * 验证用户凭证
   * @param {string} username - 用户名
   * @param {string} password - 密码 (明文)
   * @param {string} ip - 客户端IP (用于速率限制)
   * @returns {{valid: boolean, message?: string}}
   */
  validateCredentials(username, password, ip = '0.0.0.0') {
    // 检查速率限制
    const rateLimitCheck = this.rateLimiter.checkAttempt(username, ip);
    if (!rateLimitCheck.allowed) {
      return { valid: false, message: rateLimitCheck.message, rateLimited: true };
    }

    const creds = this.getCredentials();

    // 验证用户名
    if (username !== creds.username) {
      this.rateLimiter.recordFailure(username, ip);
      return { valid: false, message: 'Invalid username or password' };
    }

    // 验证密码哈希
    if (!verifyPassword(password, creds.password)) {
      this.rateLimiter.recordFailure(username, ip);
      return { valid: false, message: 'Invalid username or password' };
    }

    // 成功
    this.rateLimiter.recordSuccess(username, ip);
    return { valid: true };
  }

  /**
   * 生成JWT令牌
   */
  generateToken(username) {
    return jwt.sign(
      { username, iat: Date.now() },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );
  }

  /**
   * 验证JWT令牌
   */
  verifyToken(token) {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch (error) {
      return null;
    }
  }

  /**
   * 更新凭证 (需要验证密码强度)
   * @param {string} username - 新用户名
   * @param {string} password - 新密码 (明文)
   * @returns {{success: boolean, message?: string}}
   */
  updateCredentials(username, password) {
    // 验证密码强度
    const strength = validatePasswordStrength(password, username);
    if (!strength.valid) {
      return {
        success: false,
        message: `Password too weak: ${strength.reasons.join(', ')}`
      };
    }

    // 哈希新密码
    const { hash, salt } = hashPassword(password);

    const config = this.configManager.getFullConfig();
    config.auth = {
      username,
      password: { hash, salt }
    };

    this.configManager.updateConfig(config);
    return { success: true, message: 'Credentials updated successfully' };
  }

  /**
   * 验证用户是否已初始化
   */
  isInitialized() {
    const config = this.configManager.getFullConfig();
    return config.auth && config.auth.password && config.auth.password.hash;
  }

  // Middleware for protecting routes
  authMiddleware() {
    return (req, res, next) => {
      // Skip auth for login endpoint
      if (req.path === '/api/auth/login' || req.path === '/api/auth/check') {
        return next();
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const token = authHeader.substring(7);
      const decoded = this.verifyToken(token);

      if (!decoded) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      req.user = decoded;
      next();
    };
  }
}
