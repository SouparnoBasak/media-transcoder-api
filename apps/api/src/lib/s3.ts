import { S3Client } from "@aws-sdk/client-s3";

export const s3Client = new S3Client({
  region: 'us-east-1',
  endpoint: 'http://localhost:9000', // Redirects AWS SDK requests from aws.amazon.com -> local MinIO
  credentials: {
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
  },
  forcePathStyle: true, // Forces http://localhost:9000/bucket-name instead of http://bucket-name.localhost:9000
});