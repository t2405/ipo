import { createClient } from "redis";

class RedisCacheService {
  private client: ReturnType<typeof createClient> | null = null;
  private fallbackCache = new Map<string, { value: any; expiry: number }>();

  private async ensureClient() {
    if (this.client) return this.client;

    const connectionString = process.env.REDIS_URL;
    if (!connectionString) {
      return null;
    }

    try {
      const redisClient = createClient({ url: connectionString });
      redisClient.on("error", (err) => {
        console.warn("Redis cache warning:", err.message || err);
      });
      await redisClient.connect();
      this.client = redisClient;
      return this.client;
    } catch (err) {
      console.warn("Redis unavailable, falling back to local in-process cache for this request scope:", err);
      return null;
    }
  }

  public async get(key: string): Promise<any | null> {
    const client = await this.ensureClient();
    if (client) {
      const value = await client.get(key);
      return value ? JSON.parse(value) : null;
    }

    const item = this.fallbackCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      this.fallbackCache.delete(key);
      return null;
    }
    return item.value;
  }

  public async set(key: string, value: any, ttlSeconds: number): Promise<void> {
    const client = await this.ensureClient();
    if (client) {
      await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
      return;
    }

    const expiry = Date.now() + ttlSeconds * 1000;
    this.fallbackCache.set(key, { value, expiry });
  }

  public async delete(key: string): Promise<void> {
    const client = await this.ensureClient();
    if (client) {
      await client.del(key);
      return;
    }
    this.fallbackCache.delete(key);
  }
}

export const redisCache = new RedisCacheService();
