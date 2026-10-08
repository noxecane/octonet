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
- The `axios_res` serializer now logs headers as a plain object rather than an `AxiosHeaders` instance (the
  JSON output is the same).

### Internal

- CI pins Yarn through `packageManager` (4.18.1) instead of installing the latest release on every run, which
  had broken `yarn install --immutable`.
- Lockfile refreshes amqplib to 0.10.9 (still `^0.10.3`): RabbitMQ 4.1+ rejects the 4096-byte `frame_max` that
  0.10.3 offers.
