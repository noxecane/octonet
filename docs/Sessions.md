# Sessions

A session token is a random string your app hands a user at sign-in. Unlike a [system token](JWT.md), it
holds nothing itself: it points at data kept in a store, so it can be changed or ended at any time.

`TokenStore` is the contract and `RedisStore` is the implementation on Redis.

```ts
import { Redis } from "ioredis";
import { RedisStore } from "@noxecane/octonet";

const sessions = new RedisStore(new Redis(process.env.REDIS_URL));
```

**What `RedisStore` guarantees**

- Every session gets a fresh token: 32 random bytes, as 64 hex characters.
- Each key (e.g. a user id) has at most one live session. Starting a new one ends the old one.
- You can change or end a key's session knowing only the key.
- Values are stored as JSON, so dates come back as strings.
- Lifetimes are [`ms`](https://github.com/vercel/ms) strings, e.g. `"30m"`, `"7d"`, `"500ms"`.

**What it needs:** Redis 6.2 or newer. Besides each token, it keeps an index entry per key under
`octonet:session:<key>`.

## Sign a user in

`commission(key, value, lifetime)` starts a session and returns its token. Any earlier session for the same
key stops working.

```ts
const token = await sessions.commission(user.id, { id: user.id, role: user.role }, "7d");
res.json({ token });
```

## Recognise the user on each request

`peek(token)` returns the session's value, or `null` if the token is unknown or expired. It doesn't change
the session's lifetime.

The natural place to call it is `receive`'s `user` resolver (see [HTTP](HTTP.md)), which gets every
`Authorization` header that isn't a system token:

```ts
app.use(
  receive({
    scheme: "Octonet",
    keys,
    user: async req => {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      return (await sessions.peek<Octonet.User>(token)) ?? undefined;
    }
  })
);
```

## Keep an active session alive

`extend(token, lifetime)` gives the session a new lifetime, counted from now (the time it had left doesn't
matter). It returns the value, or `null` if the session is gone.

```ts
await sessions.extend(token, "7d");
```

## Change what a session holds

`reset(key, value)` replaces the value of the key's live session, e.g. after the user's role changes. The
session keeps its token and the time it has left. It does nothing if the key has no live session.

```ts
await sessions.reset(user.id, { id: user.id, role: "admin" });
```

## Sign out

`decommission(token)` ends the session and returns its value, or `null` if there was none.

```ts
await sessions.decommission(token);
```

## Sign a user out everywhere

`revoke(key)` ends the key's live session without knowing its token, e.g. after a password change. Other
keys' sessions are untouched.

```ts
await sessions.revoke(user.id);
```

## Keep sessions somewhere else

Implement `TokenStore` (six methods: `commission`, `peek`, `extend`, `reset`, `decommission`, `revoke`). The
methods that may find nothing return `AsyncNullable<T>`, a `Promise<T | null>`. Code written against
`TokenStore` then works with either store.

```ts
import { AsyncNullable, TokenStore } from "@noxecane/octonet";

class MemoryStore implements TokenStore {
  peek<T>(token: string): AsyncNullable<T> {
    // ...
  }
  // ...
}
```
