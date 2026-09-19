import { Type, Static } from '@sinclair/typebox';

export const UploadUrlSchema = {
  body: Type.Object({
    originalName: Type.String({ minLength: 1 }),
    mimeType: Type.Union([
      Type.Literal('image/jpeg'),
      Type.Literal('image/png'),
      Type.Literal('image/webp'),
    ]),
    sizeBytes: Type.Integer({ minimum: 1 }),
  }),
  response: {
    200: Type.Object({
      fileId: Type.String({ format: 'uuid' }),
      url: Type.String({ format: 'uri' }),
      storageKey: Type.String(),
    }),
    400: Type.Object({ error: Type.String() }),
  },
};

export const CompleteUploadSchema = {
  body: Type.Object({
    fileId: Type.String({ format: 'uuid' }),
  }),
};

export const DownloadFileSchema = {
  params: Type.Object({
    id: Type.String({ format: 'uuid' }),
  }),
};

export type UploadUrlInput = Static<typeof UploadUrlSchema.body>;
export type CompleteUploadInput = Static<typeof CompleteUploadSchema.body>;