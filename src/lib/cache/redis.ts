import { createClient, RedisClientType } from 'redis';

let client: RedisClientType | null = null;
let connectPromise: Promise<void> | null = null;

async function getRedis(): Promise<RedisClientType> {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
    client.on('error', (err) => console.error('Redis error', err));
    connectPromise = client.connect();
  }
  if (connectPromise) {
    await connectPromise;
    connectPromise = null;
  }
  return client;
}

export async function getCached<T>(key: string): Promise<T | null> {
  try {
    const redis = await getRedis();
    const val = await redis.get(key);
    return val ? (JSON.parse(val) as T) : null;
  } catch {
    return null; // degrade gracefully if Redis is down
  }
}

export async function setCached<T>(
  key: string,
  value: T,
  ttlSeconds = 300
): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch {
    // degrade gracefully
  }
}

export async function deleteCached(key: string): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.del(key);
  } catch {
    // degrade gracefully
  }
}

export async function deleteCachedPattern(pattern: string): Promise<void> {
  try {
    const redis = await getRedis();
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(keys);
    }
  } catch {
    // degrade gracefully
  }
}
