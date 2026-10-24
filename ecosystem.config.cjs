// pm2 start ecosystem.config.cjs
//
// HOST stays 127.0.0.1 on a Mac or PC you sit at. On a NAS or headless server, set HOST=0.0.0.0
// so the dashboard opens from your LAN; the first password then needs the setup code from the log.
module.exports = {
  apps: [
    {
      name: 'homeport',
      script: 'dist/server/index.js',
      cwd: __dirname,
      max_memory_restart: '400M',
      time: true,
      env: {
        NODE_ENV: 'production',
        HOST: process.env.HOST || '127.0.0.1',
        PORT: process.env.PORT || 7070,
      },
    },
  ],
};
