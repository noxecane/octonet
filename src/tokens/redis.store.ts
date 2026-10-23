import crypto from "crypto";

import { Redis } from "ioredis";
import ms from "ms";

import { AsyncNullable, TokenStore } from "./store";

interface Session<T> {
  key: string;
  value: T;
}

// run `command` on KEYS[1] only while it still points at ARGV[1], so a newer
// session for the same key is never touched
const ifIndexIs = (command: string) => `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("${command}", KEYS[1], unpack(ARGV, 2))
  end
  return 0
`;

/**
 * Sessions on redis: one random token per key, so a new session for a key
 * replaces the old one. An index from key to token lets `reset` and `revoke`
 * work with only the key. Needs Redis 6.2 or newer.
 */
export class RedisStore implements TokenStore {
  constructor(private redis: Redis) {}

  async commission<T = any>(key: string, val: T, time: string): Promise<string> {
    const token = crypto.randomBytes(32).toString("hex");
    const ttl = ms(time);

    // one transaction, so a session is never live without its index entry
    const [, [, previous]] = await this.redis
      .multi()
      .set(token, JSON.stringify({ key, value: val }), "PX", ttl)
      .set(indexKey(key), token, "PX", ttl, "GET")
      .exec();

    if (previous) {
      await this.redis.del(previous as string);
    }

    return token;
  }

  async peek<T = any>(token: string): AsyncNullable<T> {
    const session = await this.load<T>(token);
    return session ? session.value : null;
  }

  async extend<T = any>(token: string, time: string): AsyncNullable<T> {
    const session = await this.load<T>(token);
    if (!session) {
      return null;
    }

    const ttl = ms(time);
    await this.redis.pexpire(token, ttl);
    await this.redis.eval(ifIndexIs("pexpire"), 1, indexKey(session.key), token, ttl);

    return session.value;
  }

  async reset<T = any>(key: string, newVal: T): Promise<void> {
    const token = await this.redis.get(indexKey(key));
    if (!token) return;

    await this.redis.set(token, JSON.stringify({ key, value: newVal }), "KEEPTTL", "XX");
  }

  async decommission<T = any>(token: string): AsyncNullable<T> {
    const session = await this.load<T>(token);
    if (!session) {
      return null;
    }

    await this.redis.del(token);
    await this.redis.eval(ifIndexIs("del"), 1, indexKey(session.key), token);

    return session.value;
  }

  async revoke(key: string): Promise<void> {
    const token = await this.redis.get(indexKey(key));
    if (!token) return;

    await this.redis.del(token);
    await this.redis.eval(ifIndexIs("del"), 1, indexKey(key), token);
  }

  private async load<T>(token: string): Promise<Session<T> | null> {
    const result = await this.redis.get(token);
    return result ? JSON.parse(result) : null;
  }
}

function indexKey(key: string) {
  return `octonet:session:${key}`;
}
