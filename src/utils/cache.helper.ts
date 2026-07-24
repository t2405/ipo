import { createClient } from "redis";

class RedisCacheService {
  private client: any = null;
  private fallbackCache = new Map<
    string,
    { value: unknown; expiry: number }
  >();

  private async ensureClient(): Promise<any> {
    if (this.client) return this.client;

    const connectionString = process.env.REDIS_URL;
    if (!connectionString) {
      return null;
    }

    try {
      const client = createClient({
        url: connectionString,
      });

      client.on("error", (err) => {
        console.warn("Redis cache warning:", err);
      });

      await client.connect();

      this.client = client;
      return client;
    } catch (err) {
      console.warn(
        "Redis unavailable, using in-memory cache:",
        err
      );
      return null;
    }
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    const client = await this.ensureClient();

    if (client) {
      const value = await client.get(key);

      if (value == null) {
        return null;
      }

      const text =
        typeof value === "string"
          ? value
          : value?.toString?.() ?? null;

      if (text == null) {
        return null;
      }

      return JSON.parse(text) as T;
    }

    const item = this.fallbackCache.get(key);

    if (!item) {
      return null;
    }

    if (Date.now() > item.expiry) {
      this.fallbackCache.delete(key);
      return null;
    }

    return item.value as T;
  }

  public async set(
    key: string,
    value: unknown,
    ttlSeconds: number
  ): Promise<void> {
    const client = await this.ensureClient();

    if (client) {
      await client.set(
        key,
        JSON.stringify(value),
        {
          EX: ttlSeconds,
        }
      );
      return;
    }

    this.fallbackCache.set(key, {
      value,
      expiry: Date.now() + ttlSeconds * 1000,
    });
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