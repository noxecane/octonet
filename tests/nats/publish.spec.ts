import { expect } from "chai";

import { ensureStream, publish } from "../../src";
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
});
