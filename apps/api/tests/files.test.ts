import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildApp } from '../src/app';
import { FastifyInstance } from 'fastify';

// Mock Prisma and Queue to isolate API unit test execution
vi.mock('../src/lib/prisma', () => ({
  prisma: {
    file: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { sizeBytes: 0 } }),
      create: vi.fn().mockResolvedValue({ id: 'mock-file-id' }),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../src/lib/queue', () => ({
  mediaQueue: {
    add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
  },
}));

describe('File Pipeline API Integration Tests', () => {
  let app: FastifyInstance;
  let userToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
    
    // Generate valid JWT token for authenticated test calls
    userToken = app.jwt.sign({ userId: 'user-123', email: 'test@example.com' });
  });

  describe('POST /api/v1/files/upload-url - Payload Validation', () => {
    it('should reject invalid MIME types via TypeBox with 400 Bad Request', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files/upload-url',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          originalName: 'malicious.exe',
          mimeType: 'application/x-msdownload', // Invalid MIME type
          sizeBytes: 1024,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['x-request-id']).toBeDefined(); // Verifies logger plugin injects trace header
    });
  });

  describe('POST /api/v1/files/complete - Ownership & Idempotency', () => {
    it('should return 404 if file does not belong to requesting user', async () => {
      const { prisma } = await import('../src/lib/prisma');
      vi.mocked(prisma.file.findUnique).mockResolvedValueOnce(null);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files/complete',
        headers: { authorization: `Bearer ${userToken}` },
        payload: { fileId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
      });
      console.log(response.payload); // Will display the exact JS runtime error causing the 500
      expect(response.statusCode).toBe(404);
    });

    it('should pass traceId to response header during completion', async () => {
      const customTraceId = 'custom-trace-id-1234';

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files/complete',
        headers: {
          authorization: `Bearer ${userToken}`,
          'x-request-id': customTraceId,
        },
        payload: { fileId: '00000000-0000-0000-0000-000000000000' },
      });

      // Validates incoming x-request-id is mapped directly to trace context
      expect(response.headers['x-request-id']).toBe(customTraceId);
    });
  });
});