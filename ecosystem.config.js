module.exports = {
  apps: [{
    name: 'carryon-backend',
    script: 'server.js',
    cwd: '/home/ubuntu/carryon-backend',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production'
    },
    error_file: '/home/ubuntu/logs/carryon-error.log',
    out_file: '/home/ubuntu/logs/carryon-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true
  }]
};
