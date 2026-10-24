// pm2 start ecosystem.config.cjs
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
        HOST: '127.0.0.1', // dashboard reachable only from this machine
        PORT: 7070,
        // TM_PASSWORD: 'change-me', // required if HOST is anything other than localhost
      },
    },
  ],
};
