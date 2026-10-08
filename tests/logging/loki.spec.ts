import Bunyan from "bunyan";
import { expect } from "chai";
import http from "http";
import { AddressInfo } from "net";
import sinon from "sinon";

import { Logger, LokiConfig, defaultSerializers } from "../../src";
import { sleep } from "../helpers";

interface Push {
  url: string;
  contentType: string;
  body: { streams: { stream: Record<string, string>; values: [string, string][] }[] };
}

let server: http.Server;
let baseUrl: string;
let pushes: Push[] = [];
let status = 204;
let delay = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      pushes.push({ url: req.url, contentType: req.headers["content-type"], body: JSON.parse(raw) });
      setTimeout(() => {
        res.statusCode = status;
        res.end();
      }, delay);
    });
  });

  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  return new Promise<void>(resolve => server.close(() => resolve()));
});

afterEach(() => {
  pushes = [];
  status = 204;
  delay = 0;
  sinon.restore();
});

function lokiLogger(loki: Partial<LokiConfig> = {}, buffer = new Bunyan.RingBuffer({ limit: 100 })) {
  return new Logger({
    name: "loki_tests",
    serializers: defaultSerializers(),
    buffer,
    loki: { url: baseUrl, labels: { service: "billing" }, interval: "200ms", ...loki }
  });
}

function sentLines(ps = pushes) {
  return ps.flatMap(p => p.body.streams.flatMap(s => s.values.map(([, line]) => JSON.parse(line))));
}

describe("Logger#loki", () => {
  it("should push records in Loki's format", async () => {
    const logger = lokiLogger();
    const before = Date.now();

    logger.log("charged card", { card: "4242" });
    await logger.flush();

    expect(pushes).to.have.length(1);
    const [push] = pushes;
    expect(push.url).to.eq("/loki/api/v1/push");
    expect(push.contentType).to.eq("application/json");
    expect(push.body.streams).to.have.length(1);

    const [stream] = push.body.streams;
    expect(stream.stream).to.deep.eq({ service: "billing", level: "info" });
    expect(stream.values).to.have.length(1);

    const [ts, line] = stream.values[0];
    expect(ts)
      .to.be.a("string")
      .and.match(/^\d{19}$/);
    expect(Number(ts.slice(0, -6))).to.be.within(before, Date.now());

    const record = JSON.parse(line);
    expect(record).to.include({ msg: "charged card", card: "4242", name: "loki_tests", level: 30 });
  });

  it("should send the caller's labels as given", async () => {
    const logger = lokiLogger({ labels: { app: "billing", team: "payments" } });

    logger.log({ hello: "world" });
    await logger.flush();

    expect(pushes[0].body.streams[0].stream).to.deep.eq({ app: "billing", team: "payments", level: "info" });
  });

  it("should rename the level label", async () => {
    const logger = lokiLogger({ level_label: "severity" });

    logger.log({ hello: "world" });
    await logger.flush();

    expect(pushes[0].body.streams[0].stream).to.deep.eq({ service: "billing", severity: "info" });
  });

  it("should leave out the level label and use a single stream when it's turned off", async () => {
    const logger = lokiLogger({ level_label: false });

    logger.log({ hello: "world" });
    logger.error(new Error("boom"));
    await logger.flush();

    expect(pushes).to.have.length(1);
    expect(pushes[0].body.streams).to.have.length(1);
    expect(pushes[0].body.streams[0].stream).to.deep.eq({ service: "billing" });
    expect(pushes[0].body.streams[0].values).to.have.length(2);
  });

  it("should send one stream per level in a batch", async () => {
    const logger = lokiLogger();

    logger.log({ n: 1 });
    logger.error(new Error("boom"));
    logger.log({ n: 2 });
    await logger.flush();

    expect(pushes).to.have.length(1);
    const streams = pushes[0].body.streams;
    expect(streams).to.have.length(2);

    const info = streams.find(s => s.stream.level === "info");
    const error = streams.find(s => s.stream.level === "error");
    expect(info.values.map(([, l]) => JSON.parse(l).n)).to.deep.eq([1, 2]);
    expect(error.values).to.have.length(1);
    expect(JSON.parse(error.values[0][1]).err.message).to.eq("boom");
  });

  it("should batch records logged within the interval", async () => {
    const logger = lokiLogger({ interval: "200ms" });

    logger.log({ n: 1 });
    logger.log({ n: 2 });
    logger.log({ n: 3 });

    await sleep(100);
    expect(pushes).to.have.length(0);

    await sleep(250);
    expect(pushes).to.have.length(1);
    expect(sentLines().map(r => r.n)).to.deep.eq([1, 2, 3]);
  });

  it("should send as soon as a batch is full", async () => {
    const logger = lokiLogger({ batch_size: 5, interval: "10s" });

    for (let n = 1; n <= 12; n++) {
      logger.log({ n });
    }

    await sleep(100);
    expect(pushes).to.have.length(2);
    expect(pushes.map(p => p.body.streams[0].values.length)).to.deep.eq([5, 5]);

    await logger.flush();
    expect(pushes).to.have.length(3);
    expect(sentLines().map(r => r.n)).to.deep.eq([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("should send nothing when nothing was logged", async () => {
    const logger = lokiLogger({ interval: "100ms" });

    await sleep(300);
    await logger.flush();

    expect(pushes).to.have.length(0);
  });

  it("should respect the logger's level", async () => {
    const logger = new Logger({
      name: "loki_tests",
      serializers: {},
      buffer: new Bunyan.RingBuffer({ limit: 10 }),
      verbose: false,
      loki: { url: baseUrl, labels: { service: "billing" } }
    });

    logger.log({ ignored: true });
    logger.error(new Error("boom"));
    await logger.flush();

    expect(pushes).to.have.length(1);
    expect(pushes[0].body.streams.map(s => s.stream.level)).to.deep.eq(["error"]);
  });

  it("should keep logging to stdout (or the buffer) too", async () => {
    const buffer = new Bunyan.RingBuffer({ limit: 10 });
    const logger = lokiLogger({}, buffer);

    logger.log({ n: 1 });
    await logger.flush();

    expect(buffer.records).to.have.length(1);
    expect(pushes).to.have.length(1);
  });

  it("should flush records logged through child loggers", async () => {
    const logger = lokiLogger({ interval: "10s" });
    const child = logger.child({ topic: "payments" });

    child.log({ n: 1 });
    await child.flush();

    expect(sentLines()).to.have.length(1);
    expect(sentLines()[0]).to.include({ topic: "payments", n: 1 });
  });

  it("should flush everything left", async () => {
    const logger = lokiLogger({ batch_size: 3, interval: "10s" });

    for (let n = 1; n <= 7; n++) {
      logger.log({ n });
    }
    await logger.flush();

    expect(sentLines().map(r => r.n)).to.deep.eq([1, 2, 3, 4, 5, 6, 7]);
  });

  it("should not send anything when the url is empty", async () => {
    const logger = lokiLogger({ url: "" });

    logger.log({ n: 1 });
    await logger.flush();
    await sleep(300);

    expect(pushes).to.have.length(0);
  });

  it("should not throw and report an outage once when Loki is unreachable", async () => {
    const stderr = sinon.stub(process.stderr, "write").returns(true);
    const logger = lokiLogger({ url: "http://127.0.0.1:1", batch_size: 1 });

    expect(() => {
      logger.log({ n: 1 });
      logger.log({ n: 2 });
      logger.log({ n: 3 });
    }).not.to.throw();
    await logger.flush();

    expect(stderr.callCount).to.eq(1);
    expect(String(stderr.firstCall.args[0])).to.include("can't reach Loki");
  });

  it("should drop the batch on a non-2xx response and report recovery", async () => {
    const stderr = sinon.stub(process.stderr, "write").returns(true);
    const logger = lokiLogger();

    status = 500;
    logger.log({ n: 1 });
    await logger.flush();
    logger.log({ n: 2 });
    await logger.flush();

    status = 204;
    logger.log({ n: 3 });
    await logger.flush();
    logger.log({ n: 4 });
    await logger.flush();

    // dropped batches are not retried
    expect(pushes.map(p => sentLines([p])[0].n)).to.deep.eq([1, 2, 3, 4]);
    expect(stderr.callCount).to.eq(2);
    expect(String(stderr.firstCall.args[0])).to.include("500");
    expect(String(stderr.secondCall.args[0])).to.include("again");
  });

  it("should drop the batch when Loki is too slow", async () => {
    const stderr = sinon.stub(process.stderr, "write").returns(true);
    const logger = lokiLogger({ timeout: "100ms" });

    delay = 500;
    logger.log({ n: 1 });
    const start = Date.now();
    await logger.flush();

    expect(Date.now() - start).to.be.below(400);
    expect(stderr.callCount).to.eq(1);
  });

  it("should cap the queue, dropping the oldest records", async () => {
    const logger = lokiLogger({ batch_size: 2, max_queue: 4, interval: "10s" });

    // the first batch goes out at once and stays in flight while the rest queue up
    delay = 200;
    for (let n = 1; n <= 10; n++) {
      logger.log({ n });
    }
    await logger.flush();

    expect(sentLines().map(r => r.n)).to.deep.eq([1, 2, 7, 8, 9, 10]);
  });
});
