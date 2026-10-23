// pm2 start ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'homeport',
    script: 'dist/server/index.js',
    cwd: __dirname,
    max_memory_restart: '400M',
    time: true,
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1', // dashboard hanya bisa dibuka dari Mac ini
      PORT: 7070,
      // TM_PASSWORD: 'ganti-ini', // wajib kalau HOST dibuka ke LAN (0.0.0.0)
    },
  }],
};
