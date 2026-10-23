# NATS

octonet's NATS module keeps publishers and consumers on the same conventions, on top of NATS JetStream
(`@nats-io/transport-node` and `@nats-io/jetstream`):

- a stream named `transactions` takes subjects `transactions.<anything>`
- messages are plain JSON (dates travel as ISO strings)
- each app gets its own durable consumer per subscription, so every app sees every message
- consumers only get messages published after they first start
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
```

Both presets take an optional `duplicate_window` (e.g. `"10m"`): how long the stream remembers a message id
to drop repeats. NATS defaults to 2 minutes. A stream can't change type once created.

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

### Options

| option        | default | description                                                 |
| ------------- | ------- | ----------------------------------------------------------- |
| `app`         | —       | your app's name; each app gets its own copy of the messages |
| `logger`      | —       | logs each message and each failure                          |
| `batch_size`  | `10`    | messages pulled at a time per subscription                  |
| `ack_wait`    | `"30s"` | how long a handler has before its message is redelivered    |
| `max_deliver` | `5`     | attempts per message before it's dropped                    |
