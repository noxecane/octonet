# NATS

octonet's NATS module keeps publishers and consumers on the same conventions, on top of NATS JetStream
(`@nats-io/transport-node` and `@nats-io/jetstream`):

- a stream named `transactions` takes subjects `transactions.<anything>`
- messages are plain JSON (dates travel as ISO strings)
- each app gets its own durable consumer per subscription, so every app sees every message
- consumers only get messages published after they first start (except on queues, below)
- a handler that returns acknowledges its message; one that throws has it redelivered

Connect with nats 3 and pass the connection to every function:

```ts
import { connect } from "@nats-io/transport-node";

const nats = await connect({ servers: process.env.NATS_URL });
```

## Streams

`ensureStream` creates a stream, or brings an existing one's settings in line. Call it at startup in the
service that owns the stream.

```ts
import { ensureStream } from "@noxecane/octonet";

// on disk, each message kept for 90 days
await ensureStream(nats, "transactions", { type: "log", retention: "90d" });

// in memory, the last 100 messages
await ensureStream(nats, "presence", { type: "broadcast", buffer: 100 });

// on disk, each job kept until a worker acknowledges it
await ensureStream(nats, "emails", { type: "queue" });
```

Both presets take an optional `duplicate_window` (e.g. `"10m"`): how long the stream remembers a message id
to drop repeats. NATS defaults to 2 minutes. A stream can't change type once created.

## Queues

A `queue` stream holds jobs: each message stays until one consumer acknowledges it, then it's deleted.
Publish and consume work as for any stream:

```ts
await ensureStream(nats, "emails", { type: "queue" }); // optional retention, e.g. "7d", for jobs nobody takes

await publish(nats, "emails.welcome", { user_id }, { msgID: `welcome-${user_id}` }); // enqueue once

@stream("emails")
class Emails {
  @subscribe("welcome")
  async welcome(job: { user_id: string }) {
    await mailer.sendWelcome(job.user_id);
  }
}
await consume(nats, [new Emails(mailer)], { app: "mailer", logger });
```

How a queue differs from the other streams:

- Workers get every pending job, including those enqueued while no worker was running.
- Instances of the same app share the work: each job goes to one of them, once.
- A queue's subjects have one consuming app. A second app subscribing to the same subject is refused when it
  starts consuming.
- Retries are the same as for any message: a throw redelivers the job, up to `max_deliver`.

## Publishing

```ts
import { publish } from "@noxecane/octonet";

await publish(nats, "transactions.credit.wallet", { wallet_id, amount });

// a stable id lets the stream drop a repeat of the same event within its duplicate window
await publish(nats, "transactions.credit.wallet", row, { msgID: `${row.id}@${row.written_at}` });
```

Without a `msgID`, repeats aren't detected.

## Consuming

Write handlers as methods on a class. `@stream` names the stream, `@subscribe` the subject after it
(wildcards allowed). Build the instance however your app likes, then start consuming:

```ts
import { consume, stream, subscribe } from "@noxecane/octonet";

@stream("transactions")
class Wallets {
  constructor(private db: Database) {}

  @subscribe("credit.*")
  async credit(event: CreditEvent) {
    await this.db.credit(event.wallet_id, event.amount);
  }
}

const consumers = await consume(nats, [new Wallets(db)], {
  app: "billing", // part of each durable consumer's name
  logger
});

// on shutdown
await consumers.stop();
```

The decorators need `experimentalDecorators` in your tsconfig.

### What happens to a message

- The handler returns: the message is acknowledged.
- The handler throws: the error is logged with the attempt number and the message is redelivered, up to
  `max_deliver` attempts. After the last one it's dropped and logged as dropped. It stays in the stream until
  the stream's retention ends.
- To give up on a message for good, catch the error in the handler and return.

A broken subscription (e.g. the stream is deleted) is logged and never crashes the process.

### Tracing and logs

Messages carry a W3C `traceparent`. `publish` continues the trace of the request or message it's called from,
or starts one. Each handler runs inside its message's trace, so its HTTP calls and further publishes continue
the same trace.

Every log line written while handling a message, including your handler's own logs, gets `trace_id`,
`consumer` (the durable consumer's name) and `subject`. One event can then be followed from the request that
published it, through each consumer, in Loki:

```
{service="billing"} | json | consumer = "transactions_billing_credit_opts"
```

### Options

| option        | default | description                                                 |
| ------------- | ------- | ----------------------------------------------------------- |
| `app`         | —       | your app's name; each app gets its own copy of the messages |
| `logger`      | —       | logs each message and each failure                          |
| `batch_size`  | `10`    | messages pulled at a time per subscription                  |
| `ack_wait`    | `"30s"` | how long a handler has before its message is redelivered    |
| `max_deliver` | `5`     | attempts per message before it's dropped                    |
