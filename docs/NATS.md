# NATS

octonet keeps publishers and consumers on the same rules, on top of NATS JetStream:

- A stream named `wallets` takes the subjects `wallets.<anything>`.
- Messages are plain JSON. Dates travel as ISO strings and stay strings.
- Each app gets its own durable consumer per subscription, so every app sees every message, and instances
  of one app share it.
- A handler that returns acknowledges its message; one that throws has it redelivered.
- Messages carry a W3C `traceparent`, so a trace continues from the publisher to every consumer.

Connect with nats 3 (`@nats-io/transport-node`) and pass the connection to every function:

```ts
import { connect } from "@nats-io/transport-node";

const nats = await connect({ servers: process.env.NATS_URL });
```

## Create the streams your service owns

`ensureStream(nats, name, preset)` creates the stream for `name.>`, or brings an existing one's settings in
line with the preset. Call it at startup in the service that owns the stream. The preset (`StreamPreset`)
says how the stream keeps messages:

```ts
import { ensureStream } from "@noxecane/octonet";

// log: on disk, each message kept for 90 days
await ensureStream(nats, "wallets", { type: "log", retention: "90d" });

// broadcast: in memory, the last 100 messages
await ensureStream(nats, "presence", { type: "broadcast", buffer: 100 });

// queue: on disk, each job kept until a worker acknowledges it (optionally at most `retention`)
await ensureStream(nats, "emails", { type: "queue" });
```

All three take an optional `duplicate_window`, e.g. `"10m"`: how long the stream remembers a message id to
drop repeats. NATS defaults to 2 minutes.

A stream can't change type: `ensureStream` refuses to turn, say, a log into a queue.

## Publish an event

`publish(nats, subject, data)` sends `data` as JSON and resolves once the stream has stored it. The subject
starts with the stream's name.

```ts
import { publish } from "@noxecane/octonet";

await publish(nats, "wallets.credited", { wallet_id, amount });
```

## Publish an event once, even when you retry

Give the message an id that's stable for the same event (`PublishOptions.msgID`). The stream drops a
repeat with the same id within its duplicate window. Without an id, repeats aren't detected.

```ts
await publish(nats, "wallets.credited", row, { msgID: `${row.id}@${row.updated_at}` });
```

## React to another service's events

Write handlers as methods of a class: `@stream` names the stream, `@subscribe` the subject after it.
Wildcards are allowed (`*` for one token, `>` for the rest). Build the instances however your app likes and
pass them to `consume`:

```ts
import { consume, stream, subscribe } from "@noxecane/octonet";

@stream("wallets")
class WalletEvents {
  constructor(private db: Database) {}

  @subscribe("credited")
  async credited(event: { wallet_id: string; amount: number }) {
    await this.db.recordCredit(event.wallet_id, event.amount);
  }

  @subscribe("closed.*")
  async closed(event: { wallet_id: string }) {
    // ...
  }
}

const consumers = await consume(nats, [new WalletEvents(db)], { app: "billing", logger });
```

A handler gets the decoded message only, and runs with `this` bound to your instance. The decorators need
`experimentalDecorators` in your tsconfig. `consume` refuses an instance whose class has no `@stream`.

The first time an app subscribes to a subject, its consumer starts with the messages published from then
on. After that, the durable consumer keeps its place across restarts.

On one subscription, messages are handled one at a time. Different subscriptions run side by side.

`consume`'s options (`ConsumeConfig`):

| option        | default | description                                                     |
| ------------- | ------- | --------------------------------------------------------------- |
| `app`         | —       | your app's name; each app gets its own copy of the messages     |
| `logger`      | —       | logs each message, and each failure with its attempt number     |
| `batch_size`  | `10`    | messages pulled at a time per subscription                      |
| `ack_wait`    | `"30s"` | how long a handler has before its message is redelivered (`ms`) |
| `max_deliver` | `5`     | attempts per message before it's dropped                        |

`ack_wait` starts when a message is delivered, and up to `batch_size` messages may wait their turn, so keep
handlers well within it.

## Retry a failed message, or give up on it

- The handler returns: the message is acknowledged.
- The handler throws: the error is logged with the attempt number, and the message is redelivered right
  away, up to `max_deliver` attempts. After the last one it's dropped and logged with `dropped: true`. On a
  log or broadcast stream the message itself stays until the stream's retention removes it; on a queue it's
  deleted, so the log line is all that's left of the job.
- To give up on a message for good, catch the error in the handler and return.

A failing message doesn't stop the ones behind it. A broken subscription (e.g. its stream was deleted) is
logged and never crashes the process.

## Run background jobs on a queue

A `queue` stream holds jobs: each message stays until a worker acknowledges it, then it's deleted.
Publishing and consuming work as for any stream:

```ts
await ensureStream(nats, "emails", { type: "queue" });

// enqueue once
await publish(nats, "emails.welcome", { user_id }, { msgID: `welcome-${user_id}` });

@stream("emails")
class Emails {
  constructor(private mailer: Mailer) {}

  @subscribe("welcome")
  async welcome(job: { user_id: string }) {
    await this.mailer.sendWelcome(job.user_id);
  }
}

await consume(nats, [new Emails(mailer)], { app: "emails", logger });
```

How a queue differs from the other streams:

- Workers get every pending job, including those enqueued before any worker started.
- A queue's subjects have one consuming app. A second app subscribing to the same subject is refused when it
  starts consuming.

## Run several instances of one app

Instances that pass the same `app` share its durable consumers: each message goes to one of them, once.
Scale workers by starting more instances.

## Follow a message through services

`publish` sends a `traceparent` that continues the trace of the request or message it's called from, or
starts one. Each handler runs inside its message's trace, so its HTTP calls and further publishes continue
it.

Every line a `Logger` writes while handling a message, your handler's own included, gets `trace_id`,
`consumer` (the durable consumer's name) and `subject`. With [Loki](Logging.md#ship-logs-to-loki):

```
{service="billing"} | json | consumer = "wallets_billing_credited"
```

`consume` itself logs each message's contents at info level, under `event`, and each failure with `event`,
`attempt` and `dropped`. The redaction paths of `defaultSerializers` apply to `event`.

## Name things so they don't collide

- A stream's subjects are `<stream>.>`. Stream names are used as given.
- A durable consumer is named `<stream>_<app>_<subject>`, with `.` → `_`, `*` → `opts`, `>` → `spread`.
  `@subscribe("closed.*")` in app `billing` on stream `wallets` is `wallets_billing_closed_opts`.
- Each start updates an existing consumer's filter, `ack_wait` and `max_deliver`. Renaming the app or a
  subject creates a new consumer; the old one stays on the server until you delete it.

## Shut down cleanly

`consume` returns `Consumers`. `stop()` stops receiving; messages in flight are redelivered later.

```ts
process.on("SIGTERM", async () => {
  await consumers.stop();
  await nats.drain();
  await logger.flush();
  process.exit(0);
});
```
