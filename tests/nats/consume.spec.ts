import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";

import { Consumers, consume, ensureStream, publish, stream, subscribe } from "../../src";
import { durableName } from "../../src/nats/consume";
import { sleep } from "../helpers";
import { bufferLogger, natsFixture } from "./helpers";

chai.use(chaiAsPromised);

let fx: Awaited<ReturnType<typeof natsFixture>>;
let running: Consumers[] = [];

beforeAll(async () => {
  fx = await natsFixture();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map(c => c.stop()));
  await fx.cleanup();
});

afterAll(() => fx.close());

async function until(check: () => boolean, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check() && Date.now() < end) {
    await sleep(20);
  }
}

async function start(instances: object[], opts: { max_deliver?: number } = {}) {
  const { logger, records } = bufferLogger();
  const consumers = await consume(fx.nats, instances, { app: "tests", logger, ack_wait: "2s", ...opts });
  running.push(consumers);
  return records;
}

describe("consume", () => {
  it("should route each message to the method subscribed to its subject", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 });
    const credits: any[] = [];
    const debits: any[] = [];

    @stream(name)
    class Wallet {
      @subscribe("credit.*")
      credit(data: any) {
        credits.push(data);
      }

      @subscribe("debit")
      debit(data: any) {
        debits.push(data);
      }
    }

    await start([new Wallet()]);
    await publish(fx.nats, `${name}.credit.card`, { amount: 5 });
    await publish(fx.nats, `${name}.debit`, { amount: 2 });
    await until(() => credits.length === 1 && debits.length === 1);

    expect(credits).to.deep.eq([{ amount: 5 }]);
    expect(debits).to.deep.eq([{ amount: 2 }]);
  });

  it("should call methods on the instance passed in", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 });
    const seen: string[] = [];

    @stream(name)
    class Tagged {
      constructor(private tag: string) {}

      @subscribe("event")
      handle() {
        seen.push(this.tag);
      }
    }

    await start([new Tagged("built-by-the-app")]);
    await publish(fx.nats, `${name}.event`, {});
    await until(() => seen.length === 1);

    expect(seen).to.deep.eq(["built-by-the-app"]);
  });

  it("should redeliver a message whose handler throws, until it succeeds", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 });
    let attempts = 0;

    @stream(name)
    class Flaky {
      @subscribe("event")
      handle() {
        attempts++;
        if (attempts < 3) throw new Error("not yet");
      }
    }

    await start([new Flaky()]);
    await publish(fx.nats, `${name}.event`, {});
    await until(() => attempts === 3);
    await sleep(300);

    expect(attempts).to.eq(3);
  });

  it("should drop a message after max_deliver attempts and log it", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 });
    let attempts = 0;

    @stream(name)
    class Broken {
      @subscribe("event")
      handle() {
        attempts++;
        throw new Error("always");
      }
    }

    const records = await start([new Broken()], { max_deliver: 3 });
    await publish(fx.nats, `${name}.event`, {});
    await until(() => attempts === 3);
    await sleep(500);

    expect(attempts).to.eq(3);
    const last = records()
      .filter(r => r.err)
      .pop();
    expect(last.attempt).to.eq(3);
    expect(last.dropped).to.be.true;
  });

  it("should keep consuming after a message fails", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 });
    const ok: number[] = [];

    @stream(name)
    class Picky {
      @subscribe("event")
      handle(data: { n: number }) {
        if (data.n === 1) throw new Error("bad one");
        ok.push(data.n);
      }
    }

    await start([new Picky()], { max_deliver: 1 });
    await publish(fx.nats, `${name}.event`, { n: 1 });
    await publish(fx.nats, `${name}.event`, { n: 2 });
    await until(() => ok.length === 1);

    expect(ok).to.deep.eq([2]);
  });

  it("should only deliver messages published after it starts", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 });
    const seen: number[] = [];
    await publish(fx.nats, `${name}.event`, { n: 1 });

    @stream(name)
    class Late {
      @subscribe("event")
      handle(data: { n: number }) {
        seen.push(data.n);
      }
    }

    await start([new Late()]);
    await publish(fx.nats, `${name}.event`, { n: 2 });
    await until(() => seen.length >= 1);
    await sleep(200);

    expect(seen).to.deep.eq([2]);
  });

  it("should create one durable consumer per subscription, named for the app", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 });

    @stream(name)
    class Two {
      @subscribe("credit.*")
      a() {}

      @subscribe("debit.>")
      b() {}
    }

    await start([new Two()]);

    const names: string[] = [];
    for await (const c of fx.jsm.consumers.list(name)) names.push(c.name);
    expect(names.sort()).to.deep.eq(
      [durableName(name, "tests", "credit.*"), durableName(name, "tests", "debit.>")].sort()
    );
  });

  it("should stop delivering after stop()", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 });
    const seen: number[] = [];

    @stream(name)
    class Stoppable {
      @subscribe("event")
      handle(data: { n: number }) {
        seen.push(data.n);
      }
    }

    const { logger } = bufferLogger();
    const consumers = await consume(fx.nats, [new Stoppable()], { app: "tests", logger });
    await publish(fx.nats, `${name}.event`, { n: 1 });
    await until(() => seen.length === 1);

    await consumers.stop();
    await publish(fx.nats, `${name}.event`, { n: 2 });
    await sleep(300);

    expect(seen).to.deep.eq([1]);
  });

  it("should not crash the process when the stream is deleted under it", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);

    @stream(name)
    class Orphan {
      @subscribe("event")
      handle() {}
    }

    try {
      await start([new Orphan()]);
      await fx.jsm.streams.delete(name);
      await sleep(1000);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).to.deep.eq([]);
  });

  it("should refuse an instance of a class without @stream", async () => {
    class Plain {
      @subscribe("event")
      handle() {}
    }

    const { logger } = bufferLogger();
    await expect(consume(fx.nats, [new Plain()], { app: "tests", logger })).to.be.rejectedWith(
      "Plain has no @stream decorator"
    );
  });
});

describe("consume: queues", () => {
  async function queue() {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "queue" });
    return name;
  }

  it("should remove a job once its handler succeeds", async () => {
    const name = await queue();
    const done: number[] = [];

    @stream(name)
    class Jobs {
      @subscribe("work")
      handle(job: { n: number }) {
        done.push(job.n);
      }
    }

    await start([new Jobs()]);
    await publish(fx.nats, `${name}.work`, { n: 1 });
    await until(() => done.length === 1);
    await sleep(200);

    const { state } = await fx.jsm.streams.info(name);
    expect(state.messages).to.eq(0);
  });

  it("should process jobs enqueued before any worker started", async () => {
    const name = await queue();
    const done: number[] = [];
    await publish(fx.nats, `${name}.work`, { n: 1 });
    await publish(fx.nats, `${name}.work`, { n: 2 });

    @stream(name)
    class Jobs {
      @subscribe("work")
      handle(job: { n: number }) {
        done.push(job.n);
      }
    }

    await start([new Jobs()]);
    await until(() => done.length === 2);

    expect(done.sort()).to.deep.eq([1, 2]);
  });

  it("should give each job to one of the app's instances, once", async () => {
    const name = await queue();
    const done: number[] = [];

    @stream(name)
    class Jobs {
      @subscribe("work")
      handle(job: { n: number }) {
        done.push(job.n);
      }
    }

    // two instances of the same app share its durable consumer
    await start([new Jobs()]);
    await start([new Jobs()]);
    for (let n = 1; n <= 20; n++) {
      await publish(fx.nats, `${name}.work`, { n });
    }
    await until(() => done.length >= 20);
    await sleep(300);

    expect(done.sort((a, b) => a - b)).to.deep.eq(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("should refuse a second app on the same queue subject", async () => {
    const name = await queue();

    @stream(name)
    class Jobs {
      @subscribe("work")
      handle() {}
    }

    await start([new Jobs()]);
    const { logger } = bufferLogger();

    await expect(consume(fx.nats, [new Jobs()], { app: "other", logger })).to.be.rejected;
  });
});
