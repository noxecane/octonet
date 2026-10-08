# Changelog

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
