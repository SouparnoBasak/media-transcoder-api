import { Queue } from 'bullmq';
import Redis from 'ioredis';

const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export const mediaQueue = new Queue('media-processing', { connection,
  defaultJobOptions:{
    attempts:3,
    backoff:{
      type:'exponential',
      delay:5000,
    },
    removeOnComplete:{
      age:86400,
      count:1000,
    },
    removeOnFail:{
      age:604800,
    },
  },
});