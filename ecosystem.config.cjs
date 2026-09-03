/**
 * pm2 生态系统配置文件
 * 使用方式: pm2 start ecosystem.config.cjs
 *
 * 首次部署:
 *   npm install -g pm2
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup   # 设置开机自启
 */
module.exports = {
  apps: [
    {
      // 应用名称 (用于 pm2 stop/restart/logs)
      name: 'minebot',

      // 入口文件
      script: 'index.js',

      // 运行模式: fork (单进程, 推荐)
      exec_mode: 'fork',

      // 环境变量
      env: {
        NODE_ENV: 'production',
        PORT: 4681,
        // MEMORY_MAX_PERCENT: 90,     // 内存自动关闭阈值
        // AUTO_FIX_DEPS: 1,           // 自动补装依赖
      },

      // 内存超出此限制时 pm2 自动重启 (单位: K/M/G)
      // 设为 0 禁用; 青龙面板小内存建议 512M~1G
      max_memory_restart: '0',

      // 日志文件
      error_file: 'logs/error.log',
      out_file: 'logs/output.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // 优雅关闭等待时间 (ms) — 给 index.js 的 gracefulShutdown 留时间
      kill_timeout: 30000,

      // 自动重启
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};