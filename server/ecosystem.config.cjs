module.exports = {
  apps: [{
    name: 'minebot',
    script: 'index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    // Restart delay
    restart_delay: 5000,
    // Exponential backoff restart
    exp_backoff_restart_delay: 100,
    // Don't restart if exit code is 0
    stop_exit_codes: [0]
  }]
};
