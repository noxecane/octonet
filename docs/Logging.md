# Logging

`Logger` writes JSON lines with [Bunyan](https://github.com/trentm/node-bunyan#readme), in one format every
service shares:

- the same field names for requests, responses, outgoing calls and errors;
- the same redaction: chosen paths become `[REDACTED]`, credentials become fingerprints;
- the same [context](Context.md) fields (`trace_id`, `caller_system`, and labels such as `consumer` and
  `subject`), added for you;
- optionally, the same lines shipped to Grafana Loki.

## Create a logger for your service

```ts
import { Logger, defaultSerializers } from "@noxecane/octonet";

const logger = new Logger({
  name: "billing",
  serializers: defaultSerializers("password", "card.number")
});
```

`LoggerConfig`:

| option        | description                                                                              |
| ------------- | ---------------------------------------------------------------------------------------- |
| `name`        | your service's name, on every line                                                       |
| `serializers` | how fields are written; use `defaultSerializers(...paths)`, see below                    |
| `verbose`     | `false` writes errors only; otherwise info and above                                     |
| `buffer`      | write here instead of stdout. It gets each record as an object, like `Bunyan.RingBuffer` |
| `loki`        | also ship lines to Loki, see [below](#ship-logs-to-loki)                                 |

`defaultSerializers` covers the fields octonet writes: `req`, `res`, `axios_req`, `axios_res`, `event` and
`err`.

You can also wrap a Bunyan logger you built yourself: `new Logger(bunyanLogger)`. It gets no Loki shipping.

## Log events and errors

```ts
logger.log("charged card", { charge_id, amount }); // info, with a message
logger.log({ charge_id, amount }); // info, fields only

logger.error(err); // error, with the error under `err`
logger.error(err, { charge_id }); // with extra fields
logger.error(err, "charge failed"); // with a message
```

Errors are written with their stack (with the stacks of a VError-style `cause()` chain), `message`, `name`
and their own fields, with the redaction paths applied, so an `APIError`'s `data` is redacted like a response
body.

To log an event's payload with the redaction paths applied, put it under `event`:

```ts
logger.log("refund requested", { event: payload });
```

## Log the requests your service receives

`request(req)`, `response(req, res)` and `httpError(err, req, res)` write the express request (method, url,
headers, params, client address, body), the response (status, headers) and the error. The response body is
only logged if you put it in `res.locals.body`. Install the logging middleware after `receive`, so its lines
carry the request's trace.

```ts
app.use(receive(config));
app.use((req, res, next) => {
  logger.request(req);
  res.on("finish", () => logger.response(req, res));
  next();
});

app.use((err, req, res, next) => {
  res.status(500).json({ message: "something went wrong" });
  logger.httpError(err, req, res);
});
```

## Log the calls your service makes

Give `createAgent` a `logger`, or call `useLogger(instance, logger)` on any axios instance (see
[HTTP](HTTP.md)). Each request is logged as `axios_req`, each response as `axios_res`, and a failure at error
level with both. You can call `axiosRequest`, `axiosResponse` and `axiosError` on the logger yourself too.

## Follow one request or message through the logs

Every line written inside a [context](Context.md) gets:

- `trace_id`: the trace's id, the same in every service the request or message reaches;
- `caller_system`: the calling service, when there is one;
- the context's fields: `consumer` and `subject` for a NATS message, or your own from `withContext`.

[`receive`](HTTP.md#know-who-is-calling-you) starts a context for each request and
[`consume`](NATS.md#react-to-another-services-events) for each message; for cron jobs, scripts and other
work, [start one yourself](Context.md#start-a-context-for-other-work).

The user is never added: what to log about users is your app's call. Outside any context, lines have none
of these fields.

## Keep secrets out of logs

**Paths** given to `defaultSerializers(...paths)`, e.g. `"password"` or `"card.number"`, are found at any
depth of request and response bodies, outgoing call bodies and `event`, and their values written as
`[REDACTED]`. The field stays, so you can tell it was sent. Use paths for passwords and other low-entropy
values.

**Credential headers** (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, in any case) are
always replaced with a fingerprint, in incoming and outgoing requests and responses:

```
Authorization: Bearer [REDACTED sha256:3f9a1c2e]
Cookie:        sid=[REDACTED sha256:9b0e44d1]; theme=[REDACTED sha256:c1d07a52]
Set-Cookie:    sid=[REDACTED sha256:9b0e44d1]; Path=/; HttpOnly
```

The auth scheme, cookie names and cookie attributes are kept. Every redaction starts with `[REDACTED` (the
exported `REDACTED` is `"[REDACTED]"`), so one search finds them all.

To record _who_ made a request, log the identity you resolved, not the credential.

## Find where a leaked token was used

A fingerprint is the first 8 hex characters of the value's SHA-256. It tells you whether two requests used
the same credential, and can't be turned back into it. Hash a leaked token the same way and search for it:

```ts
import { fingerprint } from "@noxecane/octonet";

fingerprint(leakedToken); // "[REDACTED sha256:3f9a1c2e]"
```

Don't fingerprint passwords: their hashes can be brute-forced. Use a path instead.

## Write your own serializers

The pieces `defaultSerializers` is made of are exported, to build serializers for your own fields:

| export                      | what it returns                                                    |
| --------------------------- | ------------------------------------------------------------------ |
| `sanitized(...paths)`       | a serializer that copies an object, redacting `paths` at any depth |
| `redactHeaders(headers)`    | a copy of `headers` with credentials fingerprinted                 |
| `serializeErr`              | the error serializer                                               |
| `expressRequest(...paths)`  | the `req` serializer                                               |
| `expressResponse(...paths)` | the `res` serializer                                               |
| `axiosRequest(...paths)`    | the `axios_req` serializer                                         |
| `axiosResponse(...paths)`   | the `axios_res` serializer                                         |

None of them change what they're given.

```ts
import { Logger, defaultSerializers, redactHeaders, sanitized } from "@noxecane/octonet";

const logger = new Logger({
  name: "billing",
  serializers: {
    ...defaultSerializers("password"),
    webhook: (hook: Webhook) => ({ ...sanitized("secret")(hook.body), headers: redactHeaders(hook.headers) })
  }
});

logger.log({ webhook: incomingHook });
```

## Add fields to every line from one part of your app

`child(fields)` returns a logger that adds `fields` to every line. It shares the parent's Loki shipping.

```ts
const payouts = logger.child({ module: "payouts" });
payouts.log("payout sent", { payout_id });
```

## Check what your code logs, in tests

Pass a Bunyan `RingBuffer` as `buffer` and read its records:

```ts
import Bunyan from "bunyan";

const buffer = new Bunyan.RingBuffer({ limit: 10 });
const logger = new Logger({ name: "test", serializers: defaultSerializers("password"), buffer });

// ... run the code under test
expect(buffer.records[0].req.body.password).toBe("[REDACTED]");
```

## Ship logs to Loki

Pass `loki` and the same lines also go to [Grafana Loki](https://grafana.com/docs/loki/latest/), next to
stdout (or `buffer`). Nothing is sent while `loki.url` is empty, so you can pass an environment variable
that's only set where Loki runs.

```ts
const logger = new Logger({
  name: "billing",
  serializers: defaultSerializers("password"),
  loki: {
    url: process.env.LOKI_URL, // e.g. http://10.0.0.2:3100; unset → nothing is sent
    labels: { service: "billing" }
  }
});

// before the process exits, send what's still waiting
process.on("SIGTERM", async () => {
  await logger.flush();
  process.exit(0);
});
```

Lines are pushed to `${url}/loki/api/v1/push`, each one the whole record as JSON. Only lines at the logger's
level are shipped. `flush()` resolves once everything logged so far has been sent (or dropped); it never
rejects, and does nothing without Loki.

`LokiConfig`:

| option        | default   | description                                                                                  |
| ------------- | --------- | -------------------------------------------------------------------------------------------- |
| `url`         | —         | base URL of Loki. Empty or undefined disables shipping                                       |
| `labels`      | —         | static labels sent with every stream, as given                                               |
| `level_label` | `"level"` | label holding the level name (`trace` … `fatal`). `false` leaves the level out of the labels |
| `batch_size`  | `100`     | send once a batch has this many lines                                                        |
| `interval`    | `"1s"`    | send this long after a batch's first line                                                    |
| `max_queue`   | `10000`   | lines held while waiting to send; past this the oldest are dropped                           |
| `timeout`     | `"5s"`    | how long to wait for Loki before dropping a batch                                            |

Keep labels few and fixed: Loki indexes every distinct label value. Ids belong in the line, where `| json`
in LogQL can still filter on them.

### When Loki is down

Shipping never breaks or blocks your app:

- Lines are sent in the background, one request at a time. Meanwhile new lines queue, up to `max_queue`.
- If Loki is unreachable, too slow or answers with an error status, the batch is dropped. There are no
  retries.
- One line goes to stderr when shipping starts failing, and one when Loki is reachable again.
- stdout (or `buffer`) gets every line regardless.
