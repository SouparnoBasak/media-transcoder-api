import Fastify from 'fastify';
import loggerPlugin from './plugin/logger';
import authPlugin from './plugin/auth';
import { authRoute } from './routes/v1/auth';
import { fileRoutes } from './routes/v1/files';

export async function buildApp() {
  const app = Fastify({
    logger: false, // Turn off output during tests to keep console clean
  });

  // Plugins
  await app.register(loggerPlugin);
  await app.register(authPlugin);

  // Routes
  await app.register(authRoute, { prefix: '/api/v1/auth' });
  await app.register(fileRoutes, { prefix: '/api/v1/files' });

  return app;
}