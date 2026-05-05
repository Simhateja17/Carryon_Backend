module.exports = {
  apps: [{
    name: 'carryon-backend',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    node_args: '--require dotenv/config',
    env: {
      NODE_ENV: 'production',
      DOTENV_CONFIG_PATH: '/home/ubuntu/carryon-backend/.env',
    },
    error_file: '/home/ubuntu/logs/carryon-error.log',
    out_file: '/home/ubuntu/logs/carryon-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true
  }]
};
