import 'dotenv/config';
import { createApp } from './app.js';

const { app } = createApp();
const port = Number(process.env.PORT) || 3001;
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Frame server listening on port ${port}`));
server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`端口 ${port} 已被占用。请先在旧服务终端按 Ctrl+C 停止旧进程，再重新启动；不要重复打开多个服务。`);
  else console.error('网页服务启动失败，请检查监听地址和端口配置。');
  process.exit(1);
});
