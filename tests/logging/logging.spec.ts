import { APIError, Logger, defaultSerializers, fingerprint, redactHeaders, sanitized } from "../../src";

import Bunyan from "bunyan";
import axios from "axios";
import { createLoggingApp } from "./server";
import { expect } from "chai";
import http from "http";

const ringbuffer = new Bunyan.RingBuffer({ limit: 5 });
const logger = new Logger({
  name: "logger_tests",
  buffer: ringbuffer,
  serializers: defaultSerializers("admin.password", "password")
});

const baseUrl = "http://localhost:3005";
let server: http.Server;

beforeAll(() => {
  const app = createLoggingApp(logger);
  server = http.createServer(app).listen(3005);
});

afterAll(() => {
  return new Promise<void>((resolve, reject) => {
    server.close(err => {
      if (err) return reject(err);
      resolve();
    });
  });
});

afterEach(() => {
  ringbuffer.records = [];
});

describe("Logger#request", () => {
  it("should log the request's method, url, headers and client address", async () => {
    await axios.get(`${baseUrl}/req`);

    expect(ringbuffer.records).to.have.length(1);
    const { req } = ringbuffer.records[0];
    expect(req).to.include({ method: "GET", url: "/req" });
    expect(req.headers).to.be.an("object");
    expect(req.remoteAddress).to.be.a("string");
  });

  it("should redact sensitive paths in the body at any depth and keep the rest", async () => {
    await axios.post(`${baseUrl}/req`, { password: "password", user: { password: "password", other_prop: "other" } });

    expect(ringbuffer.records[0].req.body).to.deep.eq({
      password: "[REDACTED]",
      user: { password: "[REDACTED]", other_prop: "other" }
    });
  });

  it("should redact credential headers", async () => {
    await axios.get(`${baseUrl}/req`, {
      headers: { Authorization: "Bearer secret", Cookie: "sid=secret", "X-Other": "kept" }
    });
    const { headers } = ringbuffer.records[0].req;
    expect(headers.authorization).to.eq(`Bearer ${fingerprint("secret")}`);
    expect(headers.cookie).to.eq(`sid=${fingerprint("secret")}`);
    expect(headers["x-other"]).to.eq("kept");
  });
});

describe("Logger#response", () => {
  it("should log the status and the response body with sensitive paths redacted", async () => {
    await axios.post(`${baseUrl}/req-res`, { password: "password", other_prop: "other" });

    const { res } = ringbuffer.records[0];
    expect(res.statusCode).to.eq(200);
    expect(res.body).to.deep.eq({ password: "[REDACTED]", other_prop: "other" });
  });
});

describe("Logger#error", () => {
  it("should redact sensitive paths in an error's data, like a response body", () => {
    logger.error(new APIError("http://wallets/charge", 422, { password: "hunter2", reason: "declined" }));

    expect(ringbuffer.records[0].err.data).to.deep.eq({ password: "[REDACTED]", reason: "declined" });
  });
});

describe("Logger#httpError", () => {
  it("should log the error with its request and response", async () => {
    await axios.get(`${baseUrl}/error`);

    const record = ringbuffer.records[0];
    expect(record.err.message).to.eq("Error");
    expect(record.req).to.include({ method: "GET", url: "/error" });
    expect(record.res).to.have.property("statusCode");
  });
});

describe("sanitized", () => {
  it("should redact paths at any depth and leave absent ones out", () => {
    const redact = sanitized("password", "card.number");
    const data = {
      name: "ada",
      password: "hunter2",
      users: [{ password: "x" }],
      card: { number: "4242", exp: "12/30" }
    };

    expect(redact(data)).to.deep.eq({
      name: "ada",
      password: "[REDACTED]",
      users: [{ password: "[REDACTED]" }],
      card: { number: "[REDACTED]", exp: "12/30" }
    });
    expect(redact({ name: "ada" })).to.deep.eq({ name: "ada" });
    expect(data.password).to.eq("hunter2");
  });
});

describe("fingerprint", () => {
  it("should give the same short fingerprint for the same secret", () => {
    expect(fingerprint("token-a")).to.match(/^\[REDACTED sha256:[0-9a-f]{8}\]$/);
    expect(fingerprint("token-a")).to.eq(fingerprint("token-a"));
    expect(fingerprint("token-a")).to.not.eq(fingerprint("token-b"));
    expect(fingerprint("token-a")).to.not.contain("token-a");
  });
});

describe("redactHeaders", () => {
  it("should keep the auth scheme and fingerprint the credential, regardless of case", () => {
    const redacted = redactHeaders({
      Authorization: "Bearer abc.def",
      "proxy-authorization": "Basic dXNlcjpwYXNz",
      "Content-Type": "application/json"
    });

    expect(redacted).to.deep.eq({
      Authorization: `Bearer ${fingerprint("abc.def")}`,
      "proxy-authorization": `Basic ${fingerprint("dXNlcjpwYXNz")}`,
      "Content-Type": "application/json"
    });
  });

  it("should fingerprint a credential without a scheme", () => {
    expect(redactHeaders({ authorization: "raw-api-key" })).to.deep.eq({ authorization: fingerprint("raw-api-key") });
  });

  it("should keep cookie names and fingerprint each value", () => {
    expect(redactHeaders({ cookie: "sid=abc; theme=dark" })).to.deep.eq({
      cookie: `sid=${fingerprint("abc")}; theme=${fingerprint("dark")}`
    });
  });

  it("should keep set-cookie attributes and handle several cookies", () => {
    expect(redactHeaders({ "set-cookie": ["sid=abc; Path=/; HttpOnly", "csrf=xyz"] })).to.deep.eq({
      "set-cookie": [`sid=${fingerprint("abc")}; Path=/; HttpOnly`, `csrf=${fingerprint("xyz")}`]
    });
  });

  it("should not touch the original headers", () => {
    const headers = { Authorization: "Bearer secret" };
    redactHeaders(headers);
    expect(headers.Authorization).to.eq("Bearer secret");
  });
});
