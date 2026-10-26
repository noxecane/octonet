import { Server } from "http";

import axios from "axios";
import Bunyan from "bunyan";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import express, { NextFunction, Request, Response } from "express";

import {
  APIError,
  HttpError,
  Logger,
  ReceiveConfig,
  TimeoutError,
  UnauthorizedError,
  createAgent,
  defaultSerializers,
  fingerprint,
  jwt,
  receive,
  useErrors,
  useLogger
} from "../../src";
import { parseTraceparent, runInContext } from "../../src/context";
import { randomString } from "../helpers";
import { TestRequest, createTestApp, startServer, stopServer } from "./server";

chai.use(chaiAsPromised);

const scheme = "Test";
const keyA = new TextEncoder().encode(randomString(32));
const auth = { scheme, key: keyA, kid: "a" };
const agentA = createAgent({ service: "a", auth });

// what an app does once to type req.caller.user, the resolver and agent.for
declare global {
  namespace Octonet {
    interface User {
      id: string;
      email?: string;
    }
  }
}

const ada: Octonet.User = { id: "u1", email: "ada@example.com" };
const resolveUser = (req: Request) => (req.headers.authorization === "Bearer ada-session" ? ada : undefined);

const servers: Server[] = [];
let echo: string;

async function listen(app: express.Application) {
  const [server, port] = await startServer(app);
  servers.push(server);
  return `http://localhost:${port}`;
}

/**
 * An app with `receive` at its edge. By default its one route answers with the
 * caller and the traceparent it got.
 */
function edge(config: ReceiveConfig, handle?: (req: Request, res: Response) => Promise<unknown>) {
  const app = express();
  app.use(receive(config));
  app.get("/", (req, res, next) => {
    const done = handle
      ? handle(req, res)
      : Promise.resolve(res.json({ caller: req.caller, traceparent: req.headers.traceparent }));
    done.catch(next);
  });
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err instanceof UnauthorizedError ? 401 : 500).json({ error: err.constructor.name });
  });

  return listen(app);
}

// a plain client, standing in for a browser or another system
const client = axios.create({ validateStatus: () => true });

function traceId(traceparent: string) {
  return parseTraceparent(traceparent)?.traceId;
}

async function claimsOf(data: TestRequest) {
  const [, token] = data.headers.authorization.split(" ");
  return (await jwt.decode({ a: keyA }, token)).claims;
}

let serviceB: string;
let serviceA: string;

beforeAll(async () => {
  echo = `${await listen(createTestApp())}/test`;
  serviceB = await edge({ scheme, keys: { a: keyA } });
  serviceA = await edge({ scheme, keys: { a: keyA }, user: resolveUser }, async (req, res) => {
    const { data } = await agentA.get(serviceB);
    res.json({ caller: req.caller, b: data });
  });
});

afterAll(async () => {
  await Promise.all(servers.map(stopServer));
});

describe("receive: trace", () => {
  it("should keep the incoming trace, and calls made while handling it continue it with a new span", async () => {
    const incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const { data } = await client.get(serviceA, { headers: { traceparent: incoming } });

    const outgoing = parseTraceparent(data.b.traceparent);
    expect(outgoing.traceId).to.eq("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(outgoing.spanId).to.not.eq("00f067aa0ba902b7");
  });

  it("should start a new trace when traceparent is missing or malformed", async () => {
    const malformed = "00-4bf92f3577b34da6a3ce929d0e0e4736-xyz-01";
    const missing = await client.get(serviceA);
    const bad = await client.get(serviceA, { headers: { traceparent: malformed } });

    const ids = [missing, bad].map(r => traceId(r.data.b.traceparent));
    expect(ids[0]).to.match(/^[0-9a-f]{32}$/);
    expect(ids[1]).to.match(/^[0-9a-f]{32}$/);
    expect(ids[0]).to.not.eq(ids[1]);
    expect(ids[1]).to.not.eq("4bf92f3577b34da6a3ce929d0e0e4736");
  });
});

describe("receive: caller", () => {
  const systemToken = async (key: Uint8Array, claims: object, kid?: string) =>
    `${scheme} ${await jwt.encode(key, "10s", claims, { kid })}`;

  it("should take the system and its user from a valid system token", async () => {
    const authorization = await systemToken(keyA, { service: "a", user: ada }, "a");
    const { data } = await client.get(serviceB, { headers: { authorization } });

    expect(data.caller).to.deep.eq({ system: "a", user: ada });
  });

  it("should pass UnauthorizedError to the error handler for a bad token, a kid/service mismatch or an unknown kid", async () => {
    const stranger = new TextEncoder().encode(randomString(32));
    const tokens = [
      `${scheme} not-a-token`,
      await systemToken(keyA, { service: "b" }, "a"),
      await systemToken(stranger, { service: "c" }, "c")
    ];

    for (const authorization of tokens) {
      const res = await client.get(serviceB, { headers: { authorization } });
      expect(res.status).to.eq(401);
      expect(res.data.error).to.eq("UnauthorizedError");
    }
  });

  it("should leave the caller empty without Authorization", async () => {
    const { data } = await client.get(serviceB);
    expect(data.caller).to.deep.eq({});
  });

  it("should set the user from the resolver for other Authorization", async () => {
    const { data } = await client.get(serviceA, { headers: { authorization: "Bearer ada-session" } });
    expect(data.caller).to.deep.eq({ user: ada });
  });
});

describe("createAgent", () => {
  it("should carry the user and the trace to the next service", async () => {
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const { data } = await client.get(serviceA, { headers: { authorization: "Bearer ada-session", traceparent } });

    expect(data.b.caller).to.deep.eq({ system: "a", user: ada });
    expect(traceId(data.b.traceparent)).to.eq("0af7651916cd43dd8448eb211c80319c");
  });

  it("should start a new trace and send no user outside any request", async () => {
    const { data: first } = await agentA.get<TestRequest>(echo);
    const { data: second } = await agentA.get<TestRequest>(echo);

    expect(traceId(first.headers.traceparent)).to.match(/^[0-9a-f]{32}$/);
    expect(traceId(first.headers.traceparent)).to.not.eq(traceId(second.headers.traceparent));
    expect(await claimsOf(first)).to.deep.eq({ service: "a" });
  });

  it("should act for the user given to for(), whatever the context, and leave the original agent alone", async () => {
    const bob = { id: "u2" };
    const context = { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", caller: { user: bob } };

    const [forAda, original] = await runInContext(context, () =>
      Promise.all([agentA.for({ user: ada }).get<TestRequest>(echo), agentA.get<TestRequest>(echo)])
    );

    expect((await claimsOf(forAda.data)).user).to.deep.eq(ada);
    expect((await claimsOf(original.data)).user).to.deep.eq(bob);
  });
});

describe("createAgent: errors", () => {
  const agent = createAgent({ service: "a", auth });

  it("should fail with APIError carrying the status and parsed data", async () => {
    const err = await rejection<APIError>(agent.get(`${echo}/error`));

    expect(err).to.be.instanceOf(APIError);
    expect(err.status).to.eq(422);
    expect(err.data).to.deep.eq({ message: "an error occurred" });
  });

  it("should keep the status of a non-JSON error and give its body as text", async () => {
    const err = await rejection<APIError>(agent.get(`${echo}/bad-gateway`));

    expect(err).to.be.instanceOf(APIError);
    expect(err.status).to.eq(502);
    expect(err.data).to.contain("Bad Gateway");
  });

  it("should fail with TimeoutError, in ms, when the server is too slow", async () => {
    const slow = createAgent({ service: "a", auth, timeout: "200ms" });
    const err = await rejection<TimeoutError>(slow.get(`${echo}/timeout`));

    expect(err).to.be.instanceOf(TimeoutError);
    expect(err.message).to.contain("200ms");
  });

  it("should fail with HttpError when the connection is refused", async () => {
    const [closed, port] = await startServer(createTestApp());
    await stopServer(closed);

    const err = await rejection<HttpError>(agent.get(`http://localhost:${port}/test`));

    expect(err).to.be.instanceOf(HttpError);
    expect(err.axios_code).to.eq("ECONNREFUSED");
  });
});

describe("createAgent: logging", () => {
  const ringbuffer = new Bunyan.RingBuffer({ limit: 5 });
  const logger = new Logger({ name: "http_tests", buffer: ringbuffer, serializers: defaultSerializers("hidden") });
  const agent = createAgent({ service: "a", logger, auth });

  afterEach(() => {
    ringbuffer.records = [];
  });

  it("should log the request as sent and the response, with paths redacted", async () => {
    const { data } = await agent.post<TestRequest>(echo, { name: "ada", hidden: "secret" });

    expect(ringbuffer.records).to.have.length(2);
    const [requestLog, responseLog] = ringbuffer.records;

    expect(requestLog.axios_req.headers.traceparent).to.eq(data.headers.traceparent);
    expect(requestLog.axios_req.data).to.deep.eq({ name: "ada", hidden: "[REDACTED]" });
    expect(responseLog.axios_res.statusCode).to.eq(200);
    expect(responseLog.axios_res.body.body).to.deep.eq({ name: "ada", hidden: "[REDACTED]" });
  });

  it("should log a fingerprint of the system token, not the token", async () => {
    const { data } = await agent.get<TestRequest>(echo);
    const [, token] = data.headers.authorization.split(" ");

    const [requestLog] = ringbuffer.records;
    expect(requestLog.axios_req.headers.Authorization).to.eq(`Test ${fingerprint(token)}`);
    expect(JSON.stringify(requestLog)).to.not.contain(token);
  });

  it("should log a failed request with its status and still fail with APIError", async () => {
    await expect(agent.get(`${echo}/error`)).rejectedWith(APIError);

    expect(ringbuffer.records).to.have.length(2);
    const [, errorLog] = ringbuffer.records;
    expect(errorLog.level).to.eq(Bunyan.ERROR);
    expect(errorLog.axios_res.statusCode).to.eq(422);
  });

  it("should send and log a urlencoded body", async () => {
    const { data } = await agent.post<TestRequest>(echo, new URLSearchParams({ name: "ada" }));

    expect(data.body).to.deep.eq({ name: "ada" });
    expect(ringbuffer.records.map(r => typeof r.axios_req)).to.deep.eq(["object", "object"]);
  });

  it("should leave the request config as axios sent it", async () => {
    const res = await agent.post(echo, { name: "ada" });
    expect(res.config.data).to.eq(JSON.stringify({ name: "ada" }));
  });
});

describe("Logger: request context", () => {
  it("should tag records written while handling a request with the trace and calling system, not the user", async () => {
    const ringbuffer = new Bunyan.RingBuffer({ limit: 5 });
    const logger = new Logger({ name: "http_tests", buffer: ringbuffer, serializers: defaultSerializers() });
    const url = await edge({ scheme, keys: { a: keyA } }, async (_req, res) => {
      logger.log("handled");
      res.json({});
    });

    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const authorization = `${scheme} ${await jwt.encode(keyA, "10s", { service: "a", user: ada }, { kid: "a" })}`;
    await client.get(url, { headers: { traceparent, authorization } });

    const [record] = ringbuffer.records;
    expect(record.trace_id).to.eq("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(record.caller_system).to.eq("a");
    expect(JSON.stringify(record)).to.not.contain(ada.email);
  });
});

describe("external clients", () => {
  it("should log a plain axios instance with useLogger", async () => {
    const ringbuffer = new Bunyan.RingBuffer({ limit: 5 });
    const logger = new Logger({ name: "http_tests", buffer: ringbuffer, serializers: defaultSerializers() });
    const plain = useLogger(axios.create(), logger);

    await plain.get(echo);

    expect(ringbuffer.records.map(r => r.axios_res?.statusCode)).to.deep.eq([undefined, 200]);
    expect(ringbuffer.records[0].axios_req.url).to.eq(echo);
  });

  it("should give a plain axios instance APIError with useErrors", async () => {
    const plain = useErrors(axios.create());
    const err = await rejection<APIError>(plain.get(`${echo}/error`));

    expect(err).to.be.instanceOf(APIError);
    expect(err.status).to.eq(422);
  });
});

function rejection<T extends Error>(promise: Promise<unknown>) {
  return promise.then(
    () => expect.fail("expected the request to fail"),
    (err: T) => err
  );
}
