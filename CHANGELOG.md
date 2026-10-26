# Changelog

## 0.4.0

A deliberately breaking release with no compatibility shims: octonet now keeps only the contracts services
share and the abstractions that are hard to get right. It's the last release before 1.0, which will be the
first to promise backwards compatibility. See [Migrating from 0.3](#migrating-from-03).

### Added

- **Tracing for NATS messages.** `publish` sends a `traceparent` that continues the current request's or
  message's trace. `consume` runs each message inside its trace, and every log line written while handling it
  gets `trace_id`, `consumer` and `subject`. See [docs/NATS.md](docs/NATS.md#follow-a-message-through-services).
- **Work queues on NATS.** `ensureStream(nats, name, { type: "queue" })` creates a stream that keeps each
  job until a worker acknowledges it. `consume` delivers a queue's pending jobs, including those enqueued
  while no worker ran, and instances of one app share the work. See
  [docs/NATS.md](docs/NATS.md#run-background-jobs-on-a-queue).
- **Per-system keys in `jwt`.** `encode(secret, timeout, data, { kid })` puts a key id in the token's protected
  header. `decode` also accepts a map from `kid` to secret, or a lookup function, and picks the key by the
  token's `kid`; a missing or unknown `kid` fails like a bad token. See
  [docs/JWT.md](docs/JWT.md#give-each-calling-service-its-own-key).

### Changed

- **Breaking: Node 24 and TypeScript 5.** octonet needs Node 24 or newer (`engines.node` was `>=20.0.0`) and
  is built with TypeScript 5 (was 4.9), targeting ES2024.
- **Breaking: interservice HTTP is `receive` plus `createAgent`.** See [docs/HTTP.md](docs/HTTP.md).
  - `receive({ scheme, keys, user })` is new express middleware for a service's edge. It sets
    `req.caller = { system?, user? }` from a system token (decoded with `jwt.decode`) or your `user`
    resolver, and passes a bad system token to the error handler as `UnauthorizedError`. It keeps the
    request's trace and caller for everything that handles it.
  - `createAgent({ service, auth, logger, timeout })` replaces `new HttpAgent(config)` and returns an
    `AxiosInstance`. Call it like axios (`http.get(url, opts)`) instead of building a `RequestWrapper` with
    `makeRequest`/`get`/`post`/... and `.do()`/`.raw()`. `HttpMethod` and the wrapper's plugins are gone.
  - Every agent call sends a W3C `traceparent` (continuing the current request's trace) and a system token
    with `{ service, user? }`, where `user` is the current caller's user. These replace `.track(req)` and
    `.auth(req | session)`, the `X-Request-ID`/`X-Origin-Service` headers, `NoRequestIDError` and
    `NoAuthorizationTokenError`. `agent.for({ user })` gives an agent that acts for a given user.
  - `auth: { scheme, key, kid?, timeout? }` is required and replaces `scheme`/`secret`: the key is a
    `Uint8Array` and can carry a `kid`. For external APIs use a plain axios instance.
  - The timeout is an `ms` string on the agent (`timeout: "5s"`), or axios's own `timeout` in ms per call,
    instead of seconds passed to `.do()`.
  - `.type("form" | "urlencoded")` and `.set()`/`.query()` are gone: pass `FormData` or `URLSearchParams`
    bodies, and axios's `headers`/`params`.
  - `useLogger(axios, logger)` and `useErrors(axios)` add logging and octonet's errors to any axios instance,
    e.g. a client for an external API.
  - `Logger` records written while handling a request get `trace_id` and `caller_system`.
- **Breaking: NATS moves to nats 3 and plain functions.** See [docs/NATS.md](docs/NATS.md).
  - `ensureStream(nats, name, { type: "log", retention } | { type: "broadcast", buffer })` replaces
    `StreamFactory`, and takes an optional `duplicate_window`.
  - `publish(nats, subject, data, { msgID })` replaces `Stream` and `NatsPublisher`. It sends the caller's
    `msgID` (none if not given) instead of a random one that defeated duplicate detection.
  - `consume(nats, [instances], { app, logger, ... })` replaces `Consumers`. Handlers are still
    `@stream`/`@subscribe` classes, but the app passes built instances: there's no Inversify container.
  - Any error a handler throws now redelivers the message, up to `max_deliver` attempts (default 5), then it's
    dropped and logged. Before, only `RetryError` redelivered (and stalled the consumer) while other errors
    dropped the message. `RetryError` is gone; to give up on a message, catch and return.
  - Handler middleware is gone, with the exports that built it: `groupDecorator`, `handlerDecorator`,
    `parseHandlers`, `ParsedHandler`, `collapse`, `loggerMiddleware` and `Middleware`.
  - Durable consumers are named `<stream>_<app>_<subject>`; 0.3 repeated the stream in the subject part
    (`<stream>_<namespace>_<stream>_<subject>`), so 0.4 creates new consumers.
  - Stream names are used as given; `StreamFactory` lowercased them.
  - A deleted stream or consumer no longer crashes the process.
  - Apps connect with `@nats-io/transport-node` (nats 3) and need `"moduleResolution": "node16"` or newer.
    Decorators still need `experimentalDecorators`, but no longer `emitDecoratorMetadata`.
- **Breaking: JSON dates are no longer converted.** `HttpAgent` responses, `RedisStore` sessions and NATS
  messages used to turn any ISO-looking string into a `Date`, including invalid dates and date-only strings in
  plain text fields. They now stay strings, as in standard JSON; convert them where you need a `Date`.
- **Breaking:** `jwt.decode` returns `{ claims, kid }` instead of the claims alone.
- **Breaking:** the JWT helpers moved from `dist/http/jwt` to `dist/jwt`. Import them as `jwt` from
  `@noxecane/octonet`; deep imports into `dist` aren't part of the API.
- jose `^4` → `^5`. octonet stays CommonJS; jose 6 is ESM-only.

### Fixed

- Token lifetimes (`jwt.encode`'s `timeout`, `createAgent`'s `auth.timeout`) take `ms` format like every
  other duration in octonet. They went to jose's own parser, which rejected values like `"500ms"`. Expiry is
  rounded up to whole seconds.
- **NATS messages are redacted in logs.** `consume` logged each message's contents under `data`, which no
  serializer redacts; it now logs them under `event`, so the paths given to `defaultSerializers` apply.
- **Error data is redacted in logs**, like response bodies: an `APIError`'s `data` (or any field of a logged
  error) goes through the same paths.
- `LoggerConfig.buffer` only accepts what works: a stream that takes records as objects, like Bunyan's
  `RingBuffer`. A plain writable stream used to type-check and then throw on the first log line.
- HTTP errors with a non-JSON body (e.g. an HTML 502 from a proxy) are an `APIError` with their status and the
  body as text. The response was always parsed as JSON, so they failed with a parse error and lost the status.
- `TimeoutError`'s message gives the timeout in ms (`timed out after 500ms`); it used to print a bare number
  of seconds that rounded short timeouts to 0.
- Logging an axios request no longer changes its config, and a non-JSON string body (e.g. a `URLSearchParams`
  form) is left out of the log instead of breaking the serializer.
- **Security, breaking: `RedisStore` issues a fresh random token for every session.** Tokens were
  `HMAC(secret, key)`, so a key always got the same token: a stolen token came back on every later sign-in,
  and anyone with the secret could compute any key's token. Now each `commission` returns a new token and
  retires the key's previous one (one live session per key). `reset` and `revoke` still work with only the
  key, through an index. The constructor drops the secret: `new RedisStore(redis)`. Existing sessions are
  not carried over. Needs Redis 6.2 or newer.
- `reset` keeps the token's TTL even when it has none, instead of sending an invalid `PX -1`.
- **Breaking:** `TokenStore.commision` is spelled `commission`. Rename your calls; there's no alias.

### Removed

- The unused `LogError` type.
- **Breaking:** the `qs` and `form-data` dependencies, with the request wrapper that used them.
- **Breaking:** AMQP support (`QueueFactory`, `Queue`, `Workers`, `@worker`, `@command`) and the `amqplib`
  dependency. Use amqplib directly if you need RabbitMQ.
- **Breaking:** jobs (`@cron`, `@job`, `@query`, `hourly`/`daily`/`weekly`/`monthly`, `JobRunner`,
  `RedisQueue`) and the `node-cron` dependency, along with `wrapHandler` from the retry helpers. Use a
  dedicated job library instead.
- **Breaking:** the retry helpers `retryOnError`, `retryOnRequest` and `ExitError`, and `RetryError` (see the
  NATS change above).
- **Breaking:** the `inversify`, `reflect-metadata` and `nats` (2) dependencies.

### Migrating from 0.3

Upgrade services that call each other together: 0.3 and 0.4 trace with different headers, and a 0.4
service that holds keys by `kid` rejects 0.3's tokens, which have none.

**Runtime**

| 0.3                                         | 0.4                                                             |
| ------------------------------------------- | --------------------------------------------------------------- |
| Node 20, TypeScript 4                       | Node 24, TypeScript 5                                           |
| `"moduleResolution": "node"`                | `"module"` and `"moduleResolution"`: `"node16"` or `"nodenext"` |
| `emitDecoratorMetadata`, `reflect-metadata` | not needed; keep `experimentalDecorators`                       |
| ISO strings revived as `Date`               | dates stay strings; convert where you need a `Date`             |

**Calling other services** ([docs/HTTP.md](docs/HTTP.md))

| 0.3                                                   | 0.4                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `new HttpAgent({ service, scheme, secret, timeout })` | `createAgent({ service, auth: { scheme, key, kid, timeout } })`                   |
| `secret: string`                                      | `key: Uint8Array` of 32 bytes; `new TextEncoder().encode(secret)` keeps the bytes |
| `agent.get(url).do()`, `agent.post(url, body).do()`   | `(await agent.get(url)).data`, `(await agent.post(url, body)).data`               |
| `.raw()`                                              | the axios response; add `validateStatus: () => true` to get error statuses back   |
| `makeRequest(HttpMethod.X, url, body)`, `del(url)`    | `agent.request({ method, url, data })`, `agent.delete(url)`                       |
| `.do(seconds)`                                        | the agent's `timeout: "5s"`, or axios's `{ timeout: ms }` per call                |
| `.query(params)`, `.set(headers)`                     | axios's `params` and `headers`                                                    |
| `.type("form")`, `.type("urlencoded")`                | a `FormData` or `URLSearchParams` body                                            |
| `.use(plugin)`                                        | axios interceptors                                                                |
| `.track(req)`, `X-Request-ID`, `X-Origin-Service`     | automatic `traceparent`; add `receive` at each service's edge                     |
| `.auth(req)` forwarding the user's `Authorization`    | automatic: the token carries `req.caller.user`                                    |
| `.auth(session)` for a job                            | `agent.for({ user })`                                                             |
| `.auth()` with `{ service, request_time }`            | every call; the claims are `{ service, user? }`                                   |
| `NoRequestIDError`, `NoAuthorizationTokenError`       | gone                                                                              |
| decoding the system token in each route               | `receive({ scheme, keys, user })` and `req.caller`                                |
| `HttpAgent` for an external API                       | a plain axios instance with `useLogger` and `useErrors`                           |

**System tokens** ([docs/JWT.md](docs/JWT.md))

| 0.3                                              | 0.4                                                  |
| ------------------------------------------------ | ---------------------------------------------------- |
| `const claims = await jwt.decode(secret, token)` | `const { claims } = await jwt.decode(secret, token)` |
| imports from `dist/http/jwt`                     | `import { jwt } from "@noxecane/octonet"`            |

**NATS** ([docs/NATS.md](docs/NATS.md))

| 0.3                                                                 | 0.4                                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `StreamFactory.init(url)`, `isConnected()`, `stop()`                | `connect()` from `@nats-io/transport-node`, and the connection's own methods |
| `factory.logStream(name, period)`, `stream_type: "log"`             | `ensureStream(nats, name, { type: "log", retention })`                       |
| `factory.broadcastStream(name, buffer)`, `stream_type: "broadcast"` | `ensureStream(nats, name, { type: "broadcast", buffer })`                    |
| `stream.add(path, data)`, `publisher.publish(subject, data)`        | `publish(nats, subject, data, { msgID })`                                    |
| `new Consumers(container).start(nats, logger, cfg)`                 | `consume(nats, [instances], { app, logger })`, which returns `Consumers`     |
| `NatsConfig`: `namespace`, `batch_size`, `timeout`                  | `ConsumeConfig`: `app`, `batch_size`, `ack_wait`, `max_deliver`              |
| `throw new RetryError()` to retry                                   | throw anything; catch and return to give up                                  |
| handler middleware and the decorator helpers                        | do it in the handler                                                         |

The new consumer names mean 0.4 starts new durable consumers, which begin with messages published after
they're created. On a log or broadcast stream, messages published between stopping 0.3 and starting 0.4
aren't delivered to them. Delete the old consumers once 0.4 runs.

**Sessions** ([docs/Sessions.md](docs/Sessions.md))

| 0.3                                       | 0.4                                                  |
| ----------------------------------------- | ---------------------------------------------------- |
| `new RedisStore(secret, redis)`           | `new RedisStore(redis)`; needs Redis 6.2 or newer    |
| `commision(key, value, time)`             | `commission(key, value, time)`                       |
| the same token for a key on every sign-in | a fresh token each time, which ends the previous one |

Existing sessions aren't carried over: users sign in again.

**Removed with no replacement in octonet**

| 0.3                                                                   | use instead              |
| --------------------------------------------------------------------- | ------------------------ |
| AMQP: `QueueFactory`, `Queue`, `Workers`, `@worker`, `@command`       | amqplib directly         |
| jobs: `@cron`, `@job`, `@query`, `JobRunner`, `RedisQueue`, schedules | a job library            |
| `retryOnError`, `retryOnRequest`, `ExitError`                         | a retry loop of your own |

`Logger`, the serializers and Loki shipping keep their API; log lines gain the context fields above.

## 0.3.0

### Added

- **Loki shipping for `Logger`.** Pass `loki: { url, labels }` to also send logs to Grafana Loki, batched
  (every 1s or 100 records) and in the background, next to stdout. Unset or empty `url` sends nothing.
  Call `await logger.flush()` before exiting. See [docs/Logging.md](docs/Logging.md#ship-logs-to-loki).

  ```ts
  new Logger({
    name: "billing",
    serializers: defaultSerializers(),
    loki: { url: process.env.LOKI_URL, labels: { service: "billing" } }
  });
  ```

- `redactHeaders`, `fingerprint` and the `REDACTED` marker for custom serializers.

### Changed

Redaction now has one defined behaviour, see [docs/Logging.md](docs/Logging.md#keep-secrets-out-of-logs):

- **Paths given to `defaultSerializers` are redacted, not removed.** `password: "hunter2"` is now logged as
  `password: "[REDACTED]"` instead of disappearing, so you can tell it was sent.
- **Credential headers are fingerprinted.** `Authorization`, `Proxy-Authorization`, `Cookie` and
  `Set-Cookie` are logged as e.g. `Bearer [REDACTED sha256:3f9a1c2e]`, in express and axios requests and
  responses. Previously they were logged in full.
- **Security: minimum dependency versions raised** so installs can't resolve versions with known advisories:
  axios `^1.20.0`, form-data `^4.0.6`, qs `^6.16.0`, lodash `^4.18.0`.
- **express is no longer a dependency.** octonet only uses its types; install express yourself if you relied on
  getting it through octonet.
- Dropped `prom-client` along with the unused, never-exported `src/metric.ts`.
- Dropped the `uuid` dependency: request ids, NATS message ids and job lock ids now come from Node's
  `crypto.randomUUID()` (same v4 format).
- The `axios_res` serializer now logs headers as a plain object rather than an `AxiosHeaders` instance (the
  JSON output is the same).

### Internal

- Releases are published locally (see [RELEASING.md](RELEASING.md)): `prepublishOnly` cleans `dist/` and
  rebuilds, and the `release`-branch deploy workflow is removed.
- CI pins Yarn through `packageManager` (4.18.1) instead of installing the latest release on every run, which
  had broken `yarn install --immutable`.
- multer (tests only) bumped to ^2.2.0, and @faker-js/faker replaced by a small local `tests/fake.ts`.
- Lockfile upgrades clear the open Dependabot alerts that have a fix. What's left has none: `braces` and
  `sprintf-js` (dev only, inside jest) and `uuid@8.3.2`, pinned by node-cron 3, whose advisory covers
  v3/v5/v6 with a buffer argument while node-cron only calls v4.
- Lockfile refreshes amqplib to 0.10.9 (still `^0.10.3`): RabbitMQ 4.1+ rejects the 4096-byte `frame_max` that
  0.10.3 offers.

## 0.2.2

### Fixed

- `runJob` never released the distributed lock after running a job.

## 0.2.1

### Fixed

- `.query()` only accepted string values; it now takes numbers, booleans, dates, arrays and nested objects.

## 0.2.0

### Changed

- **Breaking:** `RedisQueue.work` no longer polls an empty queue waiting for another instance to fill it
  (master/worker mode removed); it returns once the queue is empty.
- **Breaking:** the express response serializer no longer parses a stringified JSON `res.locals.body`; set it
  to the object instead.

## 0.1.0

- First release: HTTP agent, NATS and AMQP consumers, jobs, Redis token store and logging.
