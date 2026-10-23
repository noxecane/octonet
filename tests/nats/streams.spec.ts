import { StorageType } from "@nats-io/jetstream";
import { nanos } from "@nats-io/transport-node";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import ms from "ms";

import { ensureStream } from "../../src";
import { natsFixture } from "./helpers";

chai.use(chaiAsPromised);

let fx: Awaited<ReturnType<typeof natsFixture>>;

beforeAll(async () => {
  fx = await natsFixture();
});

afterEach(() => fx.cleanup());

afterAll(() => fx.close());

describe("ensureStream", () => {
  it("should create a log stream on disk with its retention", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "log", retention: "90d" });

    const { config } = await fx.jsm.streams.info(name);
    expect(config.subjects).to.deep.eq([`${name}.>`]);
    expect(config.storage).to.eq(StorageType.File);
    expect(config.max_age).to.eq(nanos(ms("90d")));
  });

  it("should create a broadcast stream in memory with its buffer", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "broadcast", buffer: 50 });

    const { config } = await fx.jsm.streams.info(name);
    expect(config.storage).to.eq(StorageType.Memory);
    expect(config.max_msgs).to.eq(50);
  });

  it("should set the duplicate window", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "log", retention: "1d", duplicate_window: "10m" });

    const { config } = await fx.jsm.streams.info(name);
    expect(config.duplicate_window).to.eq(nanos(ms("10m")));
  });

  it("should update an existing stream's settings", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "log", retention: "1d" });
    await ensureStream(fx.nats, name, { type: "log", retention: "30d" });

    const { config } = await fx.jsm.streams.info(name);
    expect(config.max_age).to.eq(nanos(ms("30d")));
  });

  it("should refuse to change a stream's type", async () => {
    const name = fx.streamName();
    await ensureStream(fx.nats, name, { type: "log", retention: "1d" });

    await expect(ensureStream(fx.nats, name, { type: "broadcast", buffer: 10 })).to.be.rejectedWith(
      "already exists as a log stream"
    );
  });
});
