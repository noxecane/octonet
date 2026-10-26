import { expect } from "chai";

import { ensureStream, publish } from "../../src";
import { parseTraceparent, runInContext } from "../../src/context";
import { decode } from "../../src/nats/codec";
import { natsFixture } from "./helpers";

let fx: Awaited<ReturnType<typeof natsFixture>>;

beforeAll(async () => {
  fx = await natsFixture();
});

afterEach(() => fx.cleanup());

afterAll(() => fx.close());

async function messageCount(name: string) {
  const { state } = await fx.jsm.streams.info(name);
  return state.messages;
}

describe("publish", () => {
  it("should publish the data to the subject", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 });

    await publish(fx.nats, `${name}.credit`, { amount: 10 });

    const stored = await fx.jsm.streams.getMessage(name, { last_by_subj: `${name}.credit` });
    expect(decode(stored.data)).to.deep.eq({ amount: 10 });
  });

  it("should drop a repeat with the same msgID", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 });

    await publish(fx.nats, `${name}.credit`, { n: 1 }, { msgID: "row-1@t1" });
    await publish(fx.nats, `${name}.credit`, { n: 1 }, { msgID: "row-1@t1" });

    expect(await messageCount(name)).to.eq(1);
  });

  it("should continue the current trace, with a new span", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 });
    const current = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    await runInContext({ traceparent: current, caller: {} }, () => publish(fx.nats, `${name}.credit`, {}));

    const stored = await fx.jsm.streams.getMessage(name, { last_by_subj: `${name}.credit` });
    const sent = parseTraceparent(stored.header.get("traceparent"));
    expect(sent.traceId).to.eq("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(sent.spanId).to.not.eq("00f067aa0ba902b7");
  });

  it("should start a trace outside any context", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 });

    await publish(fx.nats, `${name}.credit`, {});

    const stored = await fx.jsm.streams.getMessage(name, { last_by_subj: `${name}.credit` });
    expect(parseTraceparent(stored.header.get("traceparent"))).to.not.be.undefined;
  });
});
