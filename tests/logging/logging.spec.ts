import { Logger, defaultSerializers, fingerprint, redactHeaders, sanitized } from "../../src";

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

describe("Bunyan#Request", () => {
  it("should be able to log a request", async () => {
    await axios.get(`${baseUrl}/req`);
    const properties = ringbuffer.records[0];
    expect(ringbuffer.records).to.be.length(1);
    expect(properties.req).to.have.property("method");
    expect(properties.req).to.have.property("url");
    expect(properties.req).to.have.property("headers");
    expect(properties.req).to.have.property("remoteAddress");
    expect(properties.req).to.have.property("remotePort");
    expect(properties).to.have.property("req");
  });

  it("should ensure sensitive data are not being logged on request", async () => {
    await axios.post(`${baseUrl}/req`, { password: "password" });
    const properties = ringbuffer.records[0];
    expect(ringbuffer.records).to.be.length(1);
    expect(properties.req).to.have.property("method");
    expect(properties.req).to.have.property("url");
    expect(properties.req).to.have.property("headers");
    expect(properties.req).to.have.property("remoteAddress");
    expect(properties.req).to.have.property("remotePort");
    expect(properties).to.have.property("req");
    expect(properties.req.body).to.have.property("password", "[REDACTED]");
  });

  it("should ensure sensitive data are not being logged on request even if nested", async () => {
    await axios.post(`${baseUrl}/req`, { password: "password", user: { password: "password", other_prop: "other" } });
    const properties = ringbuffer.records[0];
    expect(ringbuffer.records).to.be.length(1);
    expect(properties.req).to.have.property("method");
    expect(properties.req).to.have.property("url");
    expect(properties.req).to.have.property("headers");
    expect(properties.req).to.have.property("remoteAddress");
    expect(properties.req).to.have.property("remotePort");
    expect(properties).to.have.property("req");
    expect(properties.req.body).to.have.property("password", "[REDACTED]");
    expect(properties.req.body.user).to.have.property("password", "[REDACTED]");
    expect(properties.req.body.user).to.have.property("other_prop");
  });

  it("should redact credential headers on request", async () => {
    await axios.get(`${baseUrl}/req`, {
      headers: { Authorization: "Bearer secret", Cookie: "sid=secret", "X-Other": "kept" }
    });
    const { headers } = ringbuffer.records[0].req;
    expect(headers.authorization).to.eq(`Bearer ${fingerprint("secret")}`);
    expect(headers.cookie).to.eq(`sid=${fingerprint("secret")}`);
    expect(headers["x-other"]).to.eq("kept");
  });

  it("should ensure non-sensitive data are logged on request", async () => {
    await axios.post(`${baseUrl}/req`, { password: "password", other_prop: "other" });
    const properties = ringbuffer.records[0];
    expect(ringbuffer.records).to.be.length(1);
    expect(properties.req).to.have.property("method");
    expect(properties.req).to.have.property("url");
    expect(properties.req).to.have.property("headers");
    expect(properties.req).to.have.property("remoteAddress");
    expect(properties.req).to.have.property("remotePort");
    expect(properties).to.have.property("req");
    expect(properties.req.body).to.have.property("password", "[REDACTED]");
    expect(properties.req.body).to.have.property("other_prop");
  });
});

describe("Bunyan#Response", () => {
  it("should be able to log a response", async () => {
    await axios.get(`${baseUrl}/req-res`);
    const properties = ringbuffer.records[0];
    expect(ringbuffer.records).to.be.length(1);
    expect(properties.req).to.have.property("method");
    expect(properties.req).to.have.property("url");
    expect(properties.req).to.have.property("headers");
    expect(properties.req).to.have.property("remoteAddress");
    expect(properties.req).to.have.property("remotePort");
    expect(properties).to.have.property("req");
    expect(properties).to.have.property("res");
  });

  it("should ensure sensitive data are not being logged on response", async () => {
    await axios.post(`${baseUrl}/req-res`, { password: "password" });
    const properties = ringbuffer.records[0];
    expect(ringbuffer.records).to.be.length(1);
    expect(properties.req).to.have.property("method");
    expect(properties.req).to.have.property("url");
    expect(properties.req).to.have.property("headers");
    expect(properties.req).to.have.property("remoteAddress");
    expect(properties.req).to.have.property("remotePort");
    expect(properties).to.have.property("req");
    expect(properties).to.have.property("res");
    expect(properties.req.body).to.have.property("password", "[REDACTED]");
  });

  it("should ensure sensitive data are not being logged on response even if nested", async () => {
    await axios.post(`${baseUrl}/req-res`, {
      password: "password",
      user: { password: "password", other_prop: "other" }
    });
    const properties = ringbuffer.records[0];
    expect(ringbuffer.records).to.be.length(1);
    expect(properties.req).to.have.property("method");
    expect(properties.req).to.have.property("url");
    expect(properties.req).to.have.property("headers");
    expect(properties.req).to.have.property("remoteAddress");
    expect(properties.req).to.have.property("remotePort");
    expect(properties).to.have.property("req");
    expect(properties).to.have.property("res");
    expect(properties.req.body).to.have.property("password", "[REDACTED]");
    expect(properties.req.body.user).to.have.property("password", "[REDACTED]");
    expect(properties.req.body.user).to.have.property("other_prop");
  });

  it("should ensure non-sensitive data are logged on response", async () => {
    await axios.post(`${baseUrl}/req-res`, { password: "password", other_prop: "other" });
    const properties = ringbuffer.records[0];
    expect(ringbuffer.records).to.be.length(1);
    expect(properties.req).to.have.property("method");
    expect(properties.req).to.have.property("url");
    expect(properties.req).to.have.property("headers");
    expect(properties.req).to.have.property("remoteAddress");
    expect(properties.req).to.have.property("remotePort");
    expect(properties).to.have.property("req");
    expect(properties).to.have.property("res");
    expect(properties.req.body).to.have.property("password", "[REDACTED]");
    expect(properties.req.body).to.have.property("other_prop");
  });
});

describe("Bunyan#httpError", () => {
  it("should be able to log a http error", async () => {
    await axios.get(`${baseUrl}/error`);
    const properties = ringbuffer.records[0];
    expect(ringbuffer.records).to.be.length(1);
    expect(properties.req).to.have.property("method");
    expect(properties.req).to.have.property("url");
    expect(properties.req).to.have.property("headers");
    expect(properties.req).to.have.property("remoteAddress");
    expect(properties.req).to.have.property("remotePort");
    expect(properties).to.have.property("err");
    expect(properties).to.have.property("req");
    expect(properties).to.have.property("res");
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

  it("should pass through missing headers", () => {
    expect(redactHeaders(undefined)).to.be.undefined;
  });
});
