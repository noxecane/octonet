import { expect } from "chai";
import IORedis, { Redis } from "ioredis";

import { REDIS_URL } from "../config";
import { faker } from "../fake";
import { RedisStore } from "../../src";
import { sleep } from "../helpers";

let redis: Redis;
let store: RedisStore;

beforeAll(async () => {
  redis = new IORedis(REDIS_URL);
  store = new RedisStore(redis);
});

afterAll(async () => {
  await redis.quit();
});

afterEach(async () => {
  await redis.flushdb();
});

describe("RedisStore#commission", () => {
  it("should store the value in redis", async () => {
    const token = await store.commision(faker.internet.userName(), faker.internet.email(), "10s");
    const val = await redis.get(token);

    expect(val).to.be.a("string");
  });

  it("should create a token that expires after 100ms", async () => {
    const token = await store.commision(faker.internet.userName(), faker.internet.email(), "100ms");
    const t = await redis.pttl(token);

    expect(t).to.lessThanOrEqual(100);
  });

  it("should replace the key's token with a fresh one", async () => {
    const username = faker.internet.userName();
    const tokenOne = await store.commision(username, faker.internet.email(), "10s");
    const data = faker.internet.email();
    const tokenTwo = await store.commision(username, data, "10s");

    expect(tokenTwo).to.not.equal(tokenOne);
    expect(await store.peek(tokenOne)).to.be.null;
    expect(await store.peek(tokenTwo)).to.equal(data);
  });

  it("should give different keys different tokens", async () => {
    const tokenOne = await store.commision(faker.internet.userName(), faker.internet.email(), "10s");
    const tokenTwo = await store.commision(faker.internet.userName(), faker.internet.email(), "10s");

    expect(await store.peek(tokenOne)).to.not.be.null;
    expect(await store.peek(tokenTwo)).to.not.be.null;
  });
});

describe("RedisStore#peek", () => {
  it("should return a value without destroying the token", async () => {
    const data = faker.internet.email();
    const token = await store.commision(faker.internet.userName(), data, "3s");
    const value = await store.peek(token);
    const val = await redis.get(token);

    expect(value).to.equal(data);
    expect(val).to.be.a("string");
    expect(val).to.not.be.empty;
  });

  it("should return null after the token expires", async () => {
    const token = await store.commision(faker.internet.userName(), faker.internet.email(), "100ms");

    await sleep(110);
    const val = await store.peek(token);

    expect(val).to.be.null;
  });
});

describe("RedisStore#extend", () => {
  it("should change the lifetime of a token", async () => {
    const data = faker.internet.email();
    const token = await store.commision(faker.internet.userName(), data, "300ms");
    const oldTTL = await redis.pttl(token);

    const fromExtraction = await store.extend(token, "200ms");
    const newTTL = await redis.pttl(token);

    expect(fromExtraction).to.equal(data);
    expect(newTTL).to.not.eq(oldTTL);
    expect(newTTL).to.lessThanOrEqual(200);
  });

  it("should return null after the token expires", async () => {
    const token = await store.commision(faker.internet.userName(), faker.internet.email(), "100ms");

    await sleep(110);
    const val = await store.extend(token, "10ms");

    expect(val).to.be.null;
  });

  it("should keep an extended token revocable by key", async () => {
    const key = faker.internet.userName();
    const token = await store.commision(key, faker.internet.email(), "100ms");

    await store.extend(token, "3s");
    await sleep(150);
    await store.revoke(key);

    expect(await store.peek(token)).to.be.null;
  });
});

describe("RedisStore#reset", () => {
  it("should reset data a token represents", async () => {
    const data = faker.internet.email();
    const key = faker.internet.userName();
    const token = await store.commision(key, data, "100ms");
    const newData = faker.internet.email();

    await store.reset(key, newData);
    const newValue = await store.peek(token);

    expect(newValue).to.equal(newData);
    expect(newValue).not.eq(data);
  });

  it("should not change the sleep on the token", async () => {
    const key = faker.internet.userName();
    const token = await store.commision(key, faker.internet.email(), "100ms");

    await sleep(50);
    await store.reset(key, faker.internet.email());
    const newTTL = await redis.pttl(token);

    expect(newTTL).to.lessThanOrEqual(50);
  });

  it("should do nothing for a key without a token", async () => {
    await store.reset(faker.internet.userName(), faker.internet.email());

    expect(await redis.dbsize()).to.equal(0);
  });
});

describe("RedisStore#decommission", () => {
  it("should return a value and destroy the token", async () => {
    const data = faker.internet.email();
    const token = await store.commision(faker.internet.userName(), data, "3s");
    const value = await store.decommission(token);
    const val = await redis.get(token);

    expect(value).to.equal(data);
    expect(val).to.be.null;
  });

  it("should return null after the token expires", async () => {
    const token = await store.commision(faker.internet.userName(), faker.internet.email(), "100ms");

    await sleep(110);
    const val = await store.decommission(token);

    expect(val).to.be.null;
  });

  it("should leave nothing behind for the key", async () => {
    const token = await store.commision(faker.internet.userName(), faker.internet.email(), "3s");
    await store.decommission(token);

    expect(await redis.dbsize()).to.equal(0);
  });
});

describe("RedisStore#revoke", () => {
  it("should delete token for a key if it exists", async () => {
    const key = faker.internet.userName();
    const token = await store.commision(key, faker.internet.email(), "3s");
    await store.revoke(key);
    const val = await redis.get(token);

    expect(val).to.be.null;
    expect(await redis.dbsize()).to.equal(0);
  });

  it("should revoke the latest token after a new session", async () => {
    const key = faker.internet.userName();
    await store.commision(key, faker.internet.email(), "3s");
    const latest = await store.commision(key, faker.internet.email(), "3s");

    await store.revoke(key);

    expect(await store.peek(latest)).to.be.null;
  });

  it("should leave other keys' tokens alone", async () => {
    const other = await store.commision(faker.internet.userName(), faker.internet.email(), "3s");
    await store.commision("revoked", faker.internet.email(), "3s");

    await store.revoke("revoked");

    expect(await store.peek(other)).to.not.be.null;
  });
});
