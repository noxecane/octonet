# HTTP between services

Two pieces, one on each side of a call:

- `receive` is express middleware for your service's edge. It finds out who is calling and which trace the
  request belongs to.
- `createAgent` gives an [axios](https://axios-http.com/docs/intro) instance for calling other services.
  Every call carries the trace and a [system token](JWT.md) naming your service and the user it acts for.

Nothing is passed along by hand. While `receive` handles a request, agents, `publish` and loggers called
from it see its trace and caller, including across `await`s.

## Describe your user

Say once what a user is in your app. `req.caller.user`, the `user` resolver and `agent.for` are then typed
with it.

```ts
declare global {
  namespace Octonet {
    interface User {
      id: string;
      role: string;
    }
  }
}
```

## Know who is calling you

Put `receive` before your routes. It sets `req.caller`, a `Caller`: `{ system?, user? }`.

```ts
import express from "express";
import { receive } from "@noxecane/octonet";

const app = express();
app.use(
  receive({
    scheme: "Octonet", // system tokens come as `Authorization: Octonet <token>`
    keys: { billing: billingKey, emails: emailsKey }, // each calling service's key, by its name
    user: req => findUser(req) // optional: any other Authorization, e.g. a Bearer session
  })
);

app.get("/wallets/:id", (req, res) => {
  req.caller; // { system: "billing", user: { id: "u1", ... } }
});
```

How `receive` fills `req.caller` from the `Authorization` header:

| `Authorization`                         | `req.caller`                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `<scheme> <token>` (scheme in any case) | `system`: the token's `service`; `user`: the user the calling service acts for |
| anything else                           | `user`: what your `user` resolver returns, if it returns one                   |
| none                                    | `{}`                                                                           |

`keys` is anything [`jwt.decode`](JWT.md) takes: one key, a map by `kid`, or a lookup. With a map, the
calling agent must send a `kid`, and it must equal the `service` it claims.

An empty caller isn't an error: each route decides what it requires. `receive` never answers a request
itself.

`ReceiveConfig` is the type of `receive`'s options.

## Reject callers you don't trust

A system token that doesn't decode with your keys, names no service, or whose `kid` differs from its
`service` goes to your error handler as `UnauthorizedError`. If your `user` resolver throws, its error goes
there too.

```ts
import { UnauthorizedError } from "@noxecane/octonet";

app.use((err, req, res, next) => {
  if (err instanceof UnauthorizedError) {
    return res.status(401).json({ message: err.message });
  }
  res.status(500).json({ message: "something went wrong" });
});
```

To let only services into a route, check the caller yourself:

```ts
app.post("/internal/refunds", (req, res, next) => {
  if (!req.caller.system) return res.status(403).end();
  // ...
});
```

The `user` in a system token is whatever the calling service sent. `receive` trusts it because it trusts
the service.

## Call another service

```ts
import { createAgent } from "@noxecane/octonet";

const http = createAgent({
  service: "billing", // your service's name, sent in every token
  auth: {
    scheme: "Octonet",
    key: billingKey, // your key; the services you call hold it under "billing"
    kid: "billing", // needed when they hold several keys; must equal `service`
    timeout: "10s" // optional: how long each token lives (the default)
  },
  logger, // optional: log every request, response and failure
  timeout: "10s" // optional: request timeout (the default)
});

const { data } = await http.get(`${WALLETS_URL}/wallets/${id}`);
```

The agent is a plain axios instance (typed `HttpAgent`), so call it as you would axios. Its options are
`AgentConfig`, and `auth` is `AgentAuthConfig`. Both timeouts are `ms` strings such as `"500ms"` or `"10s"`;
a token's lifetime is rounded up to whole seconds.

Every call carries:

- `traceparent`: the current trace with a new span id, or a new trace outside a request.
- `Authorization: <scheme> <token>`, a fresh token with the claims `{ service, user? }`.

`user` is the user of the request being handled (`req.caller.user`). So when a user's request passes through
several services, each one sees the same user. Outside a request, no user is sent.

## Act for a user from a background job

A job or a NATS handler has no incoming user. `for` returns a new agent whose calls act for the user you
give it, whatever request is being handled. The original agent is unchanged.

```ts
await http.for({ user: { id: "u1", role: "member" } }).post(`${WALLETS_URL}/payouts`, body);
```

`for` takes an `Identity`, `{ user? }`. Passing `for({})` sends no user, even inside a request.

## Handle a failed call

Failed calls reject with one of these instead of axios's own error:

| Error          | When                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| `APIError`     | The server answered with an error status. Has `status` and `data` (the body).            |
| `TimeoutError` | No answer within the timeout. Its message gives the timeout in ms.                       |
| `HttpError`    | No answer at all, e.g. the connection was refused. Has `axios_code` and `axios_message`. |

`data` is parsed JSON when the body is JSON, and text otherwise (e.g. an HTML page from a proxy). Any other
error (e.g. a bad request config) passes through unchanged.

```ts
import { APIError } from "@noxecane/octonet";

try {
  await http.get(url);
} catch (err) {
  if (err instanceof APIError && err.status === 404) {
    return null;
  }
  throw err;
}
```

## Send JSON, forms and files

Pass what you'd pass to axios: objects go as JSON, `URLSearchParams` as a form, `FormData` as multipart.

```ts
await http.post(url, { name: "ada" });
await http.post(url, new URLSearchParams({ name: "ada" }));

const form = new FormData();
form.append("file", new Blob([buffer]), "report.pdf");
await http.post(url, form);
```

Only JSON bodies appear in the agent's logs, since only they can be redacted.

## Follow one request across services

The trace follows the [W3C Trace Context](https://www.w3.org/TR/trace-context/) `traceparent` header
(`00-<trace-id>-<span-id>-<flags>`). `receive` keeps a valid incoming one, or starts a new trace when it's
missing or malformed. Agent calls and `publish` continue it with a new span.

Every line a `Logger` writes while handling the request gets `trace_id`, plus `caller_system` when a service
called. The user is never added. See [Logging](Logging.md#follow-one-request-or-message-through-the-logs).

To let browsers send it across origins, allow the `traceparent` header:

```ts
import cors from "cors";

app.use(cors({ allowedHeaders: ["Authorization", "Content-Type", "traceparent"] }));
```

## Call an external API

For a third-party API you don't want octonet's trace or tokens. Use a plain axios instance and add only
what you want:

```ts
import axios from "axios";
import { useErrors, useLogger } from "@noxecane/octonet";

const payments = axios.create({ baseURL: "https://api.payments.example", timeout: 10_000 });
useLogger(payments, logger); // log every request, response and failure, redacted
useErrors(payments); // reject with APIError, TimeoutError or HttpError
```

Call `useLogger` before `useErrors`, so the logger sees axios's own error. Both return the instance.
