import Bunyan from "bunyan";
import { expect } from "chai";

import { Logger, currentContext, defaultSerializers, outgoingTraceparent, withContext } from "../src";
import { parseTraceparent } from "../src/context";

const incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

describe("context", () => {
  it("should have no context outside withContext", () => {
    expect(currentContext()).to.be.undefined;
  });

  it("should send a new trace each time outside any context", () => {
    const [a, b] = [outgoingTraceparent(), outgoingTraceparent()].map(t => parseTraceparent(t));

    expect(a).to.not.be.undefined;
    expect(a!.traceId).to.not.eq(b!.traceId);
  });

  it("should keep a valid traceparent, and continue it with a new span", () => {
    withContext({ traceparent: incoming }, () => {
      const outgoing = parseTraceparent(outgoingTraceparent());

      expect(currentContext()!.traceId).to.eq(traceId);
      expect(outgoing!.traceId).to.eq(traceId);
      expect(outgoing!.spanId).to.not.eq("00f067aa0ba902b7");
    });
  });

  it("should start a new trace when traceparent is missing or malformed", () => {
    const ids = [undefined, "00-nope"].map(traceparent =>
      withContext({ traceparent }, () => currentContext()!.traceId)
    );

    expect(ids[0]).to.match(/^[0-9a-f]{32}$/);
    expect(ids[1]).to.match(/^[0-9a-f]{32}$/);
    expect(ids[0]).to.not.eq(ids[1]);
  });

  it("should carry the context across awaits", async () => {
    const ctx = await withContext({ traceparent: incoming, caller: { system: "a" } }, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return currentContext();
    });

    expect(ctx).to.deep.eq({ traceId, caller: { system: "a" }, fields: {} });
  });

  it("should inherit the enclosing trace, caller and fields", () => {
    const outer = { traceparent: incoming, caller: { system: "a" }, fields: { job: "outer", channel: "c1" } };
    const inner = withContext(outer, () => withContext({ fields: { job: "inner" } }, () => currentContext()));

    expect(inner).to.deep.eq({ traceId, caller: { system: "a" }, fields: { job: "inner", channel: "c1" } });
  });

  it("should replace the enclosing caller with one it's given", () => {
    const inner = withContext({ caller: { system: "a" } }, () =>
      withContext({ caller: { system: "b" } }, () => currentContext()!.caller)
    );

    expect(inner).to.deep.eq({ system: "b" });
  });

  it("should prefer its own valid traceparent over the enclosing trace", () => {
    const own = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const inner = withContext({ traceparent: incoming }, () =>
      withContext({ traceparent: own }, () => currentContext()!.traceId)
    );

    expect(inner).to.eq("0af7651916cd43dd8448eb211c80319c");
  });
});

describe("Logger: context fields", () => {
  it("should tag records with the context's fields, without letting them replace the trace", () => {
    const ringbuffer = new Bunyan.RingBuffer({ limit: 5 });
    const logger = new Logger({ name: "context_tests", buffer: ringbuffer, serializers: defaultSerializers() });

    withContext({ traceparent: incoming, fields: { job: "nightly-sync", trace_id: "fake" } }, () =>
      logger.log("synced")
    );

    const [record] = ringbuffer.records;
    expect(record.job).to.eq("nightly-sync");
    expect(record.trace_id).to.eq(traceId);
  });
});
