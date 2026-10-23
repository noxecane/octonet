# Authentication

This section describes how Authentication is performed in Octonet.

## Introduction

The Authentication module in Octonet exists for 2 main reasons:

- User session management
- System session management

These involve managing sessions for requests initiated by the user or the system. Usually, a session token is provided in the request header through which a session object is obtained.

One way through which a user session can be differentiated from a system session is the `scheme` value. This is depicted as shown below.

```js
// express request headers.

// general format
req.headers.authorization = `${scheme} ${token}`;

// request header for a user session with a `Bearer` scheme
req.headers.authorization = `Bearer ${token}`;

// request header for a system session with a custom-defined scheme
req.headers.authorization = `Custom ${token}`;
```

> Note that a user can only have a **single** token in Redis store at any point in time. This is because the cryptographic function for generating a token is **idempotent**. Hence, it returns the same value regardless of the number of times the function is being called.

## User session management

The **RedisStore** module **manages user sessions** and has 4 main utility functions through which token-related actions for authentication are performed in Octonet. They are discussed below:

### **commission**_<T = any>_**(key**: _string_, **val**: _T_, **time**: _string_**)**: _Promise\<string>_

The _commission_ function creates a random token for a key and saves the data for it in Redis. The saved data can be accessed via the token. A key has at most one live token: a new one replaces the previous token, which stops working. `reset` and `revoke` find the token from the key, so you can change or end a session without knowing its token. Needs Redis 6.2 or newer.

#### Parameters

- **key:** A unique key for the session, e.g. a user id
- **value:** The value to be referenced with the token. Typically, this is the session object
- **time:** The lifespan (expiry time) of the token, formatted in accordance with specifications contained in the [ms](https://github.com/vercel/ms#readme) library (see reference section at the end of this document).

#### Return value

- It returns a promise that resolves to the created token.<br/><br/>

### **peek**_<T = any>_**(token**: _string_**)**: _AsyncNullable\<T>_

The _peek_ function retrieves the session object from Redis which the token points to. However, it doesn't change the validity of the token.

#### Parameters

- **token:** the cryptographic token

#### Return value

- Returns the session object for the given token from Redis (if found) or `null` if there is no object referenced by that token.<br/><br/>

### **extend**_<T = any>_**(token**: _string_, **time**: _string_**)**: _AsyncNullable\<T>_

The _extend_ function resets the expiry time of a specified token.

#### Parameters

- **token:** The reference token
- **time:** The new expiry time, formatted in accordance with specifications contained in the [ms](https://github.com/vercel/ms#readme) library.

#### Return value

- Returns the session object for the given token from Redis (if found) or `null` if there is no object referenced by that token.<br/><br/>

### **reset**_<T = any>_**(key**: _string_, **newVal**: _T_): _Promise\<void>_

The _reset_ function replaces the content a token points to with a new content. The token is gotten from the unique _key_ with which it was initially created.

#### Parameters

- **key:** The unique key with which the token was initially created
- **newVal:** The new content that the token should reference.

#### Return value

- No return value<br/><br/>

### **decommission**_<T = any>_**(token**: _string_**)**: _AsyncNullable\<T>_

The _decomission_ function deletes a token from the Redis store and returns the content the token was pointing to (if it exists) prior to being decomissioned.

#### Parameters

- **token:** The token to be decomissioned

#### Return value

- Returns the content referenced by the token (if it exists) or `null` otherwise.<br/><br/>

### **revoke(key**: _string_): _Promise\<void>_

The _revoke_ function deletes a token and its referenced content from Redis without returning the referenced content.

#### Parameters

- **key:** The unique key with which the token was initially created

#### Return value

- No return value<br/><br/>

## Practical examples

Let's look at practial applications of these utility functions.

### Step 1: create a Redis Client

First, we create a Redis client.

```js
// redis.config.ts

import IORedis from "ioredis";
import Logger from "./logger";

const redis_url = "redis://localhost:6379"; // read this from your .env file
const Redis = new IORedis(redis_url);

Redis.on("error", err => {
  Logger.error(err, "An error occured with the Redis client.");
});

export default Redis;
```

### Step 2: create and use `RedisStore` instance

Next, we create and Octonet's `RedisStore` instance as shown below

```js
// redis.store.ts

import { RedisStore } from "@noxecane/octonet";
import Redis from "./redis.config";

const key = "user@example.com"; // unique key

// sample session object
const session = {
  id: 1,
  email: "user@example.com",
  role: "user"
};

const redisStore: RedisStore = new RedisStore(Redis);

// sample immediately invoking start function for the purpose of this example
(async function () {
  // create a token with an expiry time of 1 hour
  const token: string = await redisStore.commission(key, session, "1h"); // returns a cryptographic token

  // view the object referenced by the token (in this case, it's the session object created above)
  const storedSession = await redisStore.peek(token);

  // reset the expiry time for the token to 30 mins
  await redisStore.extend(token, "30m");

  // reset the object referenced by the token
  const newSession = {
    id: 1,
    email: "anotherUser@example.com",
    role: "user"
  };

  /* reset the token.
   * after this function has been called, redisStore.peek(token) === newSession
   */
  await redisStore.reset(key, newSession);

  /* decommission a token
   *  after this function has been called, redisStore.peek(token) === null
   */
  await redisStore.decommission(token);

  /* revoke a token
   *  after this function has been called, redisStore.peek(token) === null
   */
  await redisStore.revoke(key);
})();
```

### System session management (headless requests)

The JWT module encrypts and decrypts the tokens services use to call each other. Import it as `jwt` from
`@noxecane/octonet`.

```ts
import { jwt } from "@noxecane/octonet";

const secret = new TextEncoder().encode("12345678123456781234567812345678"); // 32 bytes

const token = await jwt.encode(secret, "5m", { email: "email@example.com" });
const { claims } = await jwt.decode(secret, token); // claims equal the data passed in
```

#### Several systems, one key each

When several systems call one service, give each system its own key and a key id (`kid`). A system signs
with its own key and puts its `kid` in the token; the receiving service holds every system's key and picks
the right one by `kid`. A system then can't produce a token that passes as another system's.

```ts
// in the "slack" system: it only holds its own key
const token = await jwt.encode(slackKey, "5m", claims, { kid: "slack" });

// in the receiving service: every system's key, by kid
const { claims, kid } = await jwt.decode({ slack: slackKey, web: webKey }, token);
// kid is "slack"; it is authenticated along with the claims
```

The receiving service can still create tokens for any system, since it holds every key. That's fine when it's
the authority anyway. If you have several independent verifiers, or a verifier you trust less than the
systems, asymmetric keys (signed JWS) are worth their extra complexity.

### Functions

### **encode(secret**: _Uint8Array_, **timeout**: _string_, **data**: _any_, **opts?**: _{ kid?: string }_): _Promise\<string>_

Creates an encrypted JWT.

#### Parameters

- **secret**: a 32-byte key.
- **timeout**: how long until the token expires, as `${number}${unit}`, e.g. `30s`, `5m`, `1h`, `1d`.
- **data**: the claims to put in the token.
- **opts.kid**: key id of `secret`, put in the token's protected header.

#### Returns

- The token (string).

### **decode(keys**: _DecodeKeys_, **token**: _string_): _Promise\<{ claims, kid? }>_

Decrypts and checks a token made by `encode`.

#### Parameters

- **keys**: one of
  - the secret used to encode (any `kid` is ignored);
  - a map from `kid` to secret;
  - a function that returns the secret for a `kid`, or `undefined`.

  With a map or a function, a token without a `kid`, or with an unknown one, fails like a bad token.
- **token**: the token.

#### Returns

- `claims`: the data passed to `encode`.
- `kid`: the token's key id, if it had one.
