module.exports = {
  apps: [
    {
      name: 'cbt-api',
      script: 'dist/server/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      watch: false,
      max_memory_restart: '512M',
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      combine_logs: true
    }
  ]
};
