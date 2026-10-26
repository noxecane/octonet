# HTTP (Interservice communication)

Two pieces work together:

- `receive`, an express middleware at each service's edge, finds out who is calling and which trace the
  request belongs to.
- `createAgent` gives a plain [axios](https://axios-http.com/docs/intro) instance for calling other
  services. Every call continues the trace and proves which service is calling, and for which user.

Nothing has to be passed along by hand: while a request is being handled, the agent and the logger see its
trace and caller.

## Receiving: `receive`

```ts
import express from "express";
import { receive } from "@noxecane/octonet";

const app = express();
app.use(
  receive({
    scheme: "Octonet", // system tokens come as `Authorization: Octonet <token>`
    keys: { billing: billingKey, web: webKey }, // the key of each service allowed to call, by kid
    user: req => sessions.find(req.headers.authorization) // optional: any other Authorization
  })
);

app.get("/wallets/:id", (req, res) => {
  req.caller; // { system?: "billing", user?: User }
});
```

`receive` sets `req.caller`:

- **A system token** (`Authorization: <scheme> <token>`) is decoded with `jwt.decode(keys, token)`. The
  caller's `system` is the token's kid (which must equal the `service` it claims), or its `service` when it
  has no kid. Its `user` is the user the calling service acts for, if any.
- **Any other `Authorization`** is handed to your `user` resolver, and its result becomes `caller.user`.
- **No `Authorization`** leaves the caller empty. That's not an error: each route decides what it requires.

A bad system token (it doesn't decode, its kid doesn't match its service, or its kid is unknown) goes to your
error handler as `UnauthorizedError`. `receive` doesn't answer the request itself.

Describe your user once, and `req.caller.user`, the `user` resolver and `agent.for` are typed with it:

```ts
declare global {
  namespace Octonet {
    interface User {
      id: string;
      email: string;
    }
  }
}
```

## Calling: `createAgent`

```ts
import { Logger, createAgent, defaultSerializers } from "@noxecane/octonet";

const http = createAgent({
  service: "billing", // who this service is, sent in its token
  auth: {
    scheme: "Octonet",
    key: billingKey, // 32 bytes; the receivers hold it under kid "billing"
    kid: "billing", // optional key id, see docs/Authentication.md
    timeout: "10s" // optional lifetime of a token, the default
  },
  logger, // optional: log every request, response and failure
  timeout: "10s" // optional request timeout, the default
});

app.post("/payouts", async (req, res) => {
  const { data } = await http.get(`http://wallets/wallets/${req.body.wallet}`);
  res.json(data);
});
```

Every call carries:

- `traceparent`: the trace of the request being handled, with a new span id. Outside a request, a new trace.
- `Authorization: <auth.scheme> <token>`: a short-lived token with the claims `{ service, user? }`. `user` is
  the user of the request being handled (`req.caller.user`), if any. So when a user's request passes through
  several services, each one sees the same user.

To act for a specific user, for example in a job, use `for`. It returns a new agent; the original is
unchanged.

```ts
await http.for({ user: { id: "123" } }).post("http://wallets/payouts", body);
```

The agent is only for services that share a key with you. For other APIs, see [External APIs](#external-apis).

## Tracing

The trace follows the [W3C Trace Context](https://www.w3.org/TR/trace-context/) `traceparent` header
(`00-<trace-id>-<span-id>-<flags>`). `receive` keeps a valid incoming one, or starts a new trace when it's
missing or malformed. The header name is exported as `TRACEPARENT_HEADER`.

## Logging

Anything a `Logger` writes while a request is being handled gets two fields:

- `trace_id`: the trace's id, to find every record of one user action across services.
- `caller_system`: the calling service, when there is one.

The user is never added: what to log about users is up to your app.

## Errors

Failed calls reject with one of these instead of axios's own error:

| Error          | When                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| `APIError`     | The server answered with an error status. Has `status` and `data` (the body).            |
| `TimeoutError` | No answer within the timeout.                                                            |
| `HttpError`    | No answer at all, e.g. the connection was refused. Has `axios_code` and `axios_message`. |

`data` is parsed JSON when the body is JSON, and text otherwise (e.g. an HTML page from a proxy).

```ts
try {
  await http.get(url);
} catch (err) {
  if (err instanceof APIError && err.status === 404) {
    // not found
  }
  throw err;
}
```

On the receiving side, `UnauthorizedError` is what `receive` passes to the error handler for a bad system
token.

## Bodies

Pass what you'd pass to axios. Objects go as JSON; `URLSearchParams` goes as a form; `FormData` goes as
multipart.

```ts
await http.post(url, { name: "ada" });
await http.post(url, new URLSearchParams({ name: "ada" }));

const form = new FormData();
form.append("file", new Blob([buffer]), "report.pdf");
await http.post(url, form);
```

Only JSON bodies appear in the logs, since only they can be redacted.

## External APIs

For a third-party API you don't want octonet's trace or tokens. Use a plain axios instance and add the parts
you want:

```ts
import axios from "axios";
import { useErrors, useLogger } from "@noxecane/octonet";

const stripe = axios.create({ baseURL: "https://api.stripe.com", timeout: 10_000 });
useLogger(stripe, logger); // log through the redacting serializers
useErrors(stripe); // reject with APIError, TimeoutError or HttpError
```

Install `useLogger` before `useErrors`, so the logger sees axios's raw error.
