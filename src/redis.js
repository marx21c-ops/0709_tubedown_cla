import IORedis from 'ioredis';
import { config } from './config.js';

// BullMQ needs `maxRetriesPerRequest: null` and each blocking consumer
// (Worker, QueueEvents) needs its own connection — they cannot share one.
//
// `family: 0` enables dual-stack DNS. ioredis otherwise asks only for an A
// record, and Railway's private network publishes AAAA records only, so
// `redis.railway.internal` fails to resolve.
export function makeRedis() {
  return new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    family: 0,
  });
}
