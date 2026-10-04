import IORedis from 'ioredis';
import { REDIS_HOST, REDIS_PORT } from '../utils/constants';

export const redisConnection = new IORedis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null, // Required for BullMQ stability
});

redisConnection.on('connect', () => {
  console.log(`✅ Redis Connected Successfully to ${REDIS_HOST}:${REDIS_PORT}`);
});

redisConnection.on('error', (err) => {
  console.error('❌ Redis Connection Error:', err);
});
