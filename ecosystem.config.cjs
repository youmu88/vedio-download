/**
 * PM2 进程配置示例
 * 用法：pm2 start ecosystem.config.cjs && pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'video-downloader',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1, // 单实例（任务存储为单进程 JSON）
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      exp_backoff_restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
        PORT: 3456,
        // API_TOKEN: '请改成强随机值',
        // MAX_BANDWIDTH: '0',
        // ALLOWED_ORIGINS: 'http://localhost:3456,http://127.0.0.1:3456',
      },
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
