# System tokens (JWT)

A system token is how one service proves to another who it is. Every service must make and read them the
same way, so octonet keeps the format in one place: `jwt.encode` and `jwt.decode`.

You rarely call them yourself. `createAgent` makes a token for every call and `receive` reads it (see
[HTTP](HTTP.md)). Use `jwt` directly when you need a token outside HTTP, or want to check one by hand.

```ts
import { jwt } from "@noxecane/octonet";
```

**What the format guarantees**

- The token is encrypted and authenticated (JWE, `dir` with `A256GCM`). Nobody without the key can read or
  change its claims.
- It always expires: `encode` requires a lifetime. `decode` rejects an expired token.
- If the token has a key id (`kid`), the `kid` is authenticated along with the claims.

**What it doesn't do**

- It doesn't check _who_ may hold a key. With one key per service (below), the receiving service holds
  every caller's key, so it could make a token that passes as any of them. That's fine when the receiver is
  trusted anyway.
- It can't be revoked before it expires. Keep lifetimes short (the agent uses 10 seconds). For revocable
  user sessions, see [Sessions](Sessions.md).

## Make a key

A key is 32 random bytes as a `Uint8Array` (a `Buffer` works). Any other length fails when encoding.

```sh
openssl rand -base64 32
```

```ts
const key = Buffer.from(process.env.BILLING_KEY, "base64");
```

## Send claims to another service with a shared key

`encode(key, lifetime, data)` returns the token. `decode(key, token)` returns `{ claims, kid }`, where
`claims` is the `data` you encoded. It rejects a token that's malformed, expired or made with another key.

```ts
const token = await jwt.encode(key, "5m", { service: "billing", report_id: "r-1" });

const { claims } = await jwt.decode<{ service: string; report_id: string }>(key, token);
```

The lifetime is an `ms` string such as `"500ms"`, `"30s"`, `"5m"` or `"1h"`, rounded up to whole seconds.

## Give each calling service its own key

When several services call one service, give each caller its own key and use its name as the key id. The
caller puts its `kid` in the token; the receiver holds every caller's key by `kid` and picks the right one.
One caller then can't make a token that passes as another.

```ts
// in the "billing" service: it holds only its own key
const token = await jwt.encode(billingKey, "10s", { service: "billing" }, { kid: "billing" });

// in the receiving service: every caller's key, by kid
const { claims, kid } = await jwt.decode({ billing: billingKey, emails: emailsKey }, token);
// kid === "billing"
```

With a map, a token without a `kid`, or with a `kid` the map doesn't have, fails like a bad token. Only the
map's own keys count, so a `kid` such as `"constructor"` finds nothing.

`receive` uses exactly this: its `keys` are passed to `decode`, and it also requires the `kid` to equal the
`service` claim.

## Look keys up instead of holding a map

Pass a function from `kid` to key. Return `undefined` for an unknown `kid`, and the token fails.

```ts
const { claims } = await jwt.decode(kid => keyring.get(kid), token);
```

## Read a token with a single key, whatever its kid

With a single key, `decode` ignores the token's `kid` for choosing the key, but still returns it:

```ts
const { claims, kid } = await jwt.decode(key, token); // kid is undefined if the token has none
```

## Types

- `jwt.DecodeKeys`: what `decode` and `receive` accept: a key, a map from `kid` to key, or a lookup function.
- `jwt.EncodeOptions`: `{ kid? }`.
- `jwt.Decoded<T>`: `{ claims: T; kid?: string }`.
