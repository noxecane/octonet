# octonet

![Github Actions](https://github.com/noxecane/octonet/actions/workflows/build-test.yml/badge.svg)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://github.com/prettier/prettier)

octonet is a small library of what Node services need to work together. It keeps two kinds of thing:

- **Contracts**, which must be identical in every service: the system-token format, trace propagation (W3C
  `traceparent`), the log format and its redaction, and NATS naming and delivery rules.
- **Abstractions worth sharing**, because they're hard to get right: shipping logs to Loki in batches
  without ever breaking the app, NATS consumer delivery and retries, and revocable session tokens.

It leaves out generic wrappers and helpers you can write yourself in a few lines.

> **0.4.0 is a breaking release, with no compatibility shims.** See [CHANGELOG.md](CHANGELOG.md#migrating-from-03) to
> migrate from 0.3.

## Requirements

- **Node 24** or newer.
- **TypeScript 5**, if you use TypeScript. Your `tsconfig.json` needs Node-style module resolution, because
  the NATS 3 typings are only found through their package `exports`, and `experimentalDecorators` for NATS
  handlers:

  ```json
  {
    "compilerOptions": {
      "module": "node16",
      "moduleResolution": "node16",
      "experimentalDecorators": true
    }
  }
  ```

  `nodenext` works too. octonet's typings refer to express's and Bunyan's, so install `@types/express` and
  `@types/bunyan` as well.

- For the parts you use: express (for `receive`), a NATS server with JetStream, Redis 6.2 or newer (for
  sessions), and Loki (optional).

## Install

```sh
npm install @noxecane/octonet @nats-io/transport-node
```

`@nats-io/transport-node` is only needed to connect to NATS.

## A whole service

A `billing` service that receives requests, calls a `wallets` service, logs, publishes an event and
consumes another service's events. Each service has its own 32-byte key, and the services it calls hold it
under its name.

```ts
import { connect } from "@nats-io/transport-node";
import express, { NextFunction, Request, Response } from "express";
import {
  Logger,
  UnauthorizedError,
  consume,
  createAgent,
  defaultSerializers,
  ensureStream,
  publish,
  receive,
  stream,
  subscribe
} from "@noxecane/octonet";

declare global {
  namespace Octonet {
    interface User {
      id: string;
    }
  }
}

const key = (name: string) => Buffer.from(process.env[name]!, "base64");

const logger = new Logger({
  name: "billing",
  serializers: defaultSerializers("card.number"),
  loki: { url: process.env.LOKI_URL, labels: { service: "billing" } }
});

// calls to other services carry the trace and a token naming billing and the current user
const wallets = createAgent({
  service: "billing",
  auth: { scheme: "Octonet", key: key("BILLING_KEY"), kid: "billing" },
  logger
});

@stream("wallets")
class WalletEvents {
  @subscribe("closed")
  async closed(event: { wallet_id: string }) {
    logger.log("wallet closed, cancelling its charges", event);
  }
}

async function main() {
  const nats = await connect({ servers: process.env.NATS_URL });
  await ensureStream(nats, "billing", { type: "log", retention: "90d" });

  const app = express();
  app.use(express.json());
  // who is calling (a service, a user, or both) and which trace this request is part of
  app.use(receive({ scheme: "Octonet", keys: { web: key("WEB_KEY") } }));

  app.post("/charges", async (req, res, next) => {
    try {
      if (!req.caller.user) return res.status(401).end();

      const { data: wallet } = await wallets.get(`${process.env.WALLETS_URL}/wallets/${req.body.wallet_id}`);
      const charge = { id: crypto.randomUUID(), wallet_id: wallet.id, amount: req.body.amount };

      await publish(nats, "billing.charge.created", charge, { msgID: charge.id });
      logger.log("charged", { charge_id: charge.id });
      res.status(201).json(charge);
    } catch (err) {
      next(err);
    }
  });

  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.httpError(err, req, res);
    res.status(err instanceof UnauthorizedError ? 401 : 500).json({ message: err.message });
  });

  const consumers = await consume(nats, [new WalletEvents()], { app: "billing", logger });
  const server = app.listen(3000);

  process.on("SIGTERM", async () => {
    server.close();
    await consumers.stop();
    await nats.drain();
    await logger.flush();
    process.exit(0);
  });
}

main();
```

Every log line written while handling a request carries its `trace_id`, and the call to `wallets` and the
published event continue the same trace. Lines written while handling a `wallets` event carry that event's
trace.

## Guides

Each guide is organised by what you want to do.

- [HTTP](docs/HTTP.md): know who is calling, call other services as yourself or for a user, handle
  failures, call external APIs.
- [NATS](docs/NATS.md): create streams, publish events once, consume events, run job queues, shut down.
- [Logging](docs/Logging.md): log requests, calls and errors, keep secrets out, follow a trace, ship to
  Loki.
- [Context](docs/Context.md): give cron jobs, scripts and your own entry points the trace, caller and log
  labels that requests and messages get, and carry a trace across boundaries octonet doesn't own.
- [System tokens (JWT)](docs/JWT.md): the token format services prove themselves with, one key per
  service.
- [Sessions](docs/Sessions.md): revocable user sessions on Redis.
