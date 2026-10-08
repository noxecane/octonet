# Logger

The Logger is a feature in Octonet which provides utility functions that enables logging for the purpose of distributed tracing, metrics collection or other purposes. It utilises the [Bunyan](https://github.com/trentm/node-bunyan#readme) library for its functionalities,as well as the [Express](https://expressjs.com/en/api.html#express) [Request](https://expressjs.com/en/api.html#req) and [Response](https://expressjs.com/en/api.html#res) objects as inputs.

## Utility Functions

The utility functions are as described below:

### request(req: Request)

The _request_ function logs an incoming HTTP request.

#### Parameters

**req:** Express request object

### response(res: Response)

The _response_ function logs an outgoing HTTP response

#### Parameters

**res:** Express request object

### httpError(err: Error, req: Request, res: Response)

The _httpError_ function Logs an error that occured during the handling of an HTTP request.

#### Parameters

**err:** Error object
**req:** Express request object
**res:** Express response object

### axiosRequest(req: AxiosRequestConfig)

The _axiosRequest_ function logs an axios request

#### Parameters

**req:** [AxiosRequestConfig](https://axios-http.com/docs/req_config) object

### axiosResponse(res: AxiosResponse)

The _axiosResponse_ function logs response to axios request

#### Parameters

**res:** [AxiosResponse](https://axios-http.com/docs/res_schema) object

### axiosError(err: AxiosError)

The _axiosError_ function logs error response to axios request

#### Parameters

**err:** [AxiosError](https://axios-http.com/docs/handling_errors) object

### log(entry: string | object)

The _log_ message logs simple messages

#### Parameters

**entry:** Entry message to be logged

### error(entry: string | LogError)

The _error_ function logs internal application error.

#### Parameters

**entry:** additional error description

## Practical examples

Let's look at practical examples of the Logger module

```js
import express from "express";
import { Logger, defaultSerializers } from "@noxecane/octonet";

// create the Logger instance
const logger: Logger = new Logger({
  name: "wallet_demo",
  serializers: defaultSerializers("password"),
  verbose: false
});

// Express-related Logger utility functions
app.get("/test", (err, req, res) => {
  logger.request(req);
  logger.response(res);
  logger.httpError(err, req, res);
});

// axios-related utility functions

// others
logger.log("transactionn service called");
logger.error("an internal server error has occured");
```

## Shipping logs to Loki

The logger can also send every record to [Grafana Loki](https://grafana.com/docs/loki/latest/), next to
stdout (or `buffer`). Nothing changes until you pass `loki`, and nothing is sent while `loki.url` is empty,
so you can hand it an environment variable that's only set where Loki exists.

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

Records are pushed to `${url}/loki/api/v1/push` with each line being the whole record as JSON, the same
record you see on stdout. Child loggers share their parent's Loki stream.

### Options

| option        | default   | description                                                                                    |
| ------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `url`         | —         | base URL of Loki. Empty or undefined disables shipping                                          |
| `labels`      | —         | static labels sent with every stream, as given                                                  |
| `level_label` | `"level"` | label holding the level name (`trace` … `fatal`). `false` leaves the level out of the labels   |
| `batch_size`  | `100`     | send once a batch has this many records                                                         |
| `interval`    | `"1s"`    | send this long after a batch's first record                                                     |
| `max_queue`   | `10000`   | records held while waiting to send; past this the oldest are dropped                            |
| `timeout`     | `"5s"`    | how long to wait for Loki before dropping a batch                                               |

Keep labels few and low-cardinality: Loki indexes every distinct label value. Request ids, user ids and the
like belong in the log line, where `| json` in LogQL can still filter on them.

### Failure behaviour

Shipping never breaks the app. Records are sent in the background, one request at a time. If Loki is down,
slow or answers with a non-2xx status the batch is dropped (no retries), and a single line goes to stderr
for the whole outage, plus one when Loki is reachable again. While a request is in flight new records queue
up to `max_queue`. Logging only goes to Loki at the logger's level (`verbose: false` → errors only).

## Redacted headers

The default serializers replace the values of `Authorization`, `Proxy-Authorization`, `Cookie` and
`Set-Cookie` with `[REDACTED]` in logged requests and responses (express and axios). `redactHeaders` is
exported if you write your own serializers.
