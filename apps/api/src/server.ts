import Fastify from 'fastify';
import dotenv from 'dotenv';
import websocketPlugin from '@fastify/websocket';
import loggerPlugin from './plugin/logger';
import authPlugin from './plugin/auth';
import { authRoute } from './routes/v1/auth';
import { fileRoutes } from './routes/v1/files';
import { initCleanupJobs } from './lib/cleanup';
import { setupRealtimeEvents } from './lib/events';
dotenv.config()

const app=Fastify({logger:{
  level:process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
}});
initCleanupJobs();

const start = async () => {
  try {
    // 1. Plugins
    await app.register(loggerPlugin);
    await app.register(authPlugin);
    await app.register(websocketPlugin);

    // 2. Real-time Gateway Setup
    setupRealtimeEvents(app);

    // 3. Register  Route Modules with Prefixes
    await app.register(authRoute, { prefix: '/api/v1/auth' });
    await app.register(fileRoutes, { prefix: '/api/v1/files' });

    const port = Number(process.env.PORT) || 3000;
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();