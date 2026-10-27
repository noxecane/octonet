# Context

A context is one unit of work your service does: handling a request, a message, a cron tick, a script
run. Agents, `publish` and loggers called anywhere inside it, across `await`s, read it, so nothing is
passed along by hand.

It carries three things:

| Part     | What it is                                      | Who reads it                                                                                                         |
| -------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| trace    | where this work sits in a trace across services | [agents](HTTP.md#call-another-service) and [`publish`](NATS.md#publish-an-event) continue it; loggers add `trace_id` |
| `caller` | who the work is for: `{ system?, user? }`       | agents send its user in their token; loggers add `caller_system`, never the user                                     |
| `fields` | what to log about where the work came from      | only loggers, which add them to every line                                                                           |

[`receive`](HTTP.md#know-who-is-calling-you) starts one for each request, and
[`consume`](NATS.md#react-to-another-services-events) for each message, with `consumer` and `subject` as
fields. For any other kind of work, start one yourself with `withContext`.

## Start a context for other work

Wrap the work in `withContext`. Without a `traceparent`, it starts a new trace.

```ts
import { withContext } from "@noxecane/octonet";

cron.schedule("0 2 * * *", () =>
  withContext({ fields: { job: "nightly-sync" } }, async () => {
    logger.log("sync started"); // has trace_id and job
    await wallets.post(`${WALLETS_URL}/sync`); // continues the same trace
  })
);
```

`withContext(options, fn)` returns what `fn` returns. Its options, `ContextOptions`, are all optional:

| Option        | What it does                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `traceparent` | the `traceparent` that came with the work. Kept when valid; otherwise the trace is continued or started as below |
| `caller`      | who the work is for                                                                                              |
| `fields`      | string labels for every log line, e.g. `{ job: "nightly-sync" }`                                                 |

`trace_id` and `caller_system` come from the trace and caller: a field can't replace them.

## Act for a user from your own entry point

When your own entry point knows who the work is for, after checking it the way its source requires, pass
the caller. Agent calls inside then act for that user, as they do inside a request.

```ts
socket.on("message", async event =>
  withContext({ caller: { user: await findUser(event.user) }, fields: { channel: event.channel } }, () => handle(event))
);
```

`withContext` trusts the caller you give it: checking it is the entry point's job, as checking the token
is `receive`'s.

## Carry a trace across something octonet doesn't own

Every boundary works the same way: the sending side attaches `outgoingTraceparent()`, and the receiving
side opens a context from it. Agents and `publish` do this for HTTP and NATS. Do the same for anything
else, such as an in-process queue or a job library:

```ts
import { currentContext, outgoingTraceparent, withContext } from "@noxecane/octonet";

// inside a request
queue.push({ name: "resize", image_id, traceparent: outgoingTraceparent(), user: currentContext()?.caller.user });

// in the worker
queue.process(job =>
  withContext({ traceparent: job.traceparent, caller: { user: job.user }, fields: { job: job.name } }, () =>
    resize(job.image_id)
  )
);
```

`outgoingTraceparent()` is the current trace with a new span id, or a new trace outside any context. Carry
the user only if the worker should act for them.

## Start a context inside another

A `withContext` inside another context inherits all three parts and overrides only what you pass:

- the trace continues with a new span, unless you pass a valid `traceparent`;
- the caller stays, unless you pass `caller`;
- fields are merged, and yours win on the same key.

So a library can wrap its own work in `withContext` and still log with the request's trace, caller and
labels:

```ts
// inside a request from the "web" service
withContext({ fields: { step: "reply" } }, () => {
  logger.log("calling the engine"); // trace_id of the request, caller_system: "web", step: "reply"
});
```

## Read the current context

`currentContext()` returns the `Context` being handled, `{ traceId, caller, fields }`, or `undefined`
outside one. For example, to give a user a reference to quote when something fails:

```ts
res.status(500).json({ message: "something went wrong", reference: currentContext()?.traceId });
```
