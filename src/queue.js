import { Queue } from 'bullmq';
import { QUEUE_NAME, config } from './config.js';
import { makeRedis } from './redis.js';

export const downloadQueue = new Queue(QUEUE_NAME, {
  connection: makeRedis(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    // Keep finished jobs around long enough that the client can still fetch the file.
    removeOnComplete: { age: config.retentionMinutes * 60, count: 500 },
    removeOnFail: { age: 24 * 3600 },
  },
});
