import { Redis } from '@upstash/redis';

let client: Redis | null = null;

function getRedis(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null; // Redis not configured — degrade gracefully
  }
  if (!client) {
    client = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return client;
}

export async function getCached<T>(key: string): Promise<T | null> {
  try {
    const redis = getRedis();
    if (!redis) return null;
    return await redis.get<T>(key);
  } catch {
    return null;
  }
}

export async function setCached<T>(key: string, value: T, ttlSeconds = 300): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(key, value, { ex: ttlSeconds });
  } catch {
    // degrade gracefully
  }
}

export async function deleteCached(key: string): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.del(key);
  } catch {
    // degrade gracefully
  }
}

export async function deleteCachedPattern(pattern: string): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    // degrade gracefully
  }
}
