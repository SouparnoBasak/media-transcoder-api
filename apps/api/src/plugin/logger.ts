import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';

const loggerPlugin: FastifyPluginAsync = async (app) => {
  // Enforce incoming x-request-id or assign a fresh UUID traceId
  app.addHook('onRequest', async (request, reply) => {
    const traceId = (request.headers['x-request-id'] as string) || randomUUID();
    
    // Attach traceId to request object for easy downstream access
    request.id = traceId;
    
    // Send x-request-id back to client in response headers
    reply.header('x-request-id', traceId);

    // Bind traceId directly into request-scoped logger
    request.log = request.log.child({ traceId });
  });
};

export default fp(loggerPlugin);