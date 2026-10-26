# Changelog

## Unreleased

### Added

- **Per-system keys in `jwt`.** `encode(secret, timeout, data, { kid })` puts a key id in the token's protected
  header. `decode` also accepts a map from `kid` to secret, or a lookup function, and picks the key by the
  token's `kid`; a missing or unknown `kid` fails like a bad token. See
  [docs/Authentication.md](docs/Authentication.md#several-systems-one-key-each).

### Changed

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
  - Handler middleware is gone.
  - A deleted stream or consumer no longer crashes the process.
  - Apps connect with `@nats-io/transport-node` (nats 3) and need `"moduleResolution": "node16"` or newer.
- **Breaking: JSON dates are no longer converted.** `HttpAgent` responses, `RedisStore` sessions and NATS
  messages used to turn any ISO-looking string into a `Date`, including invalid dates and date-only strings in
  plain text fields. They now stay strings, as in standard JSON; convert them where you need a `Date`.

- **Breaking:** `jwt.decode` returns `{ claims, kid }` instead of the claims alone.
- **Breaking:** the JWT helpers moved from `dist/http/jwt` to `dist/jwt`. Import them as `jwt` from
  `@noxecane/octonet`; deep imports into `dist` aren't part of the API.
- jose `^4` → `^5`. octonet stays CommonJS; jose 6 is ESM-only.

### Fixed

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

- **Breaking:** the `qs` and `form-data` dependencies, with the request wrapper that used them.
- **Breaking:** AMQP support (`QueueFactory`, `Queue`, `Workers`, `@worker`, `@command`) and the `amqplib`
  dependency. Use amqplib directly if you need RabbitMQ.
- **Breaking:** jobs (`@cron`, `@job`, `@query`, `hourly`/`daily`/`weekly`/`monthly`, `JobRunner`,
  `RedisQueue`) and the `node-cron` dependency, along with `wrapHandler` from the retry helpers. Use a
  dedicated job library instead.
- **Breaking:** the retry helpers `retryOnError`, `retryOnRequest` and `ExitError`, and `RetryError` (see the
  NATS change above).
- **Breaking:** the `inversify`, `reflect-metadata` and `nats` (2) dependencies.

## 0.3.0

### Added

- **Loki shipping for `Logger`.** Pass `loki: { url, labels }` to also send logs to Grafana Loki, batched
  (every 1s or 100 records) and in the background, next to stdout. Unset or empty `url` sends nothing.
  Call `await logger.flush()` before exiting. See [docs/Logging.md](docs/Logging.md#shipping-logs-to-loki).

  ```ts
  new Logger({
    name: "billing",
    serializers: defaultSerializers(),
    loki: { url: process.env.LOKI_URL, labels: { service: "billing" } }
  });
  ```

- `redactHeaders`, `fingerprint` and the `REDACTED` marker for custom serializers.

### Changed

Redaction now has one defined behaviour, see [docs/Logging.md](docs/Logging.md#redaction):

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
