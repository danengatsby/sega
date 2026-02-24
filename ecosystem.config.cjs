module.exports = {
  apps: [
    {
      name: 'sega-backend',
      cwd: '/var/www/sega/apps/backend',
      script: 'dist/server.js',
      interpreter: '/usr/bin/node',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      autorestart: true,
      max_memory_restart: '512M',
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
        CORS_ORIGIN: 'https://sega-contab.online',
      },
    },
  ],
};
