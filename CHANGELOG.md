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

- `redactHeaders` helper for custom serializers.

### Changed

- The default serializers now log `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie` header
  values as `[REDACTED]` (express requests/responses and axios requests). Pass your own serializers if you
  relied on seeing them.

### Internal

- CI pins Yarn through `packageManager` (4.18.1) instead of installing the latest release on every run, which
  had broken `yarn install --immutable`.
