import { randomBytes } from "crypto";

import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { decodeProtectedHeader } from "jose";

import { jwt } from "../src";

chai.use(chaiAsPromised);

const key = () => new Uint8Array(randomBytes(32));
const claims = { system: "slack", user: "u-1" };

describe("jwt#encode", () => {
  it("should put the kid in the protected header", async () => {
    const token = await jwt.encode(key(), "5m", claims, { kid: "slack" });

    expect(decodeProtectedHeader(token)).to.deep.eq({ alg: "dir", enc: "A256GCM", kid: "slack" });
  });
});

describe("jwt#encode lifetime", () => {
  it("should take an ms-format lifetime and expire after it", async () => {
    const secret = key();
    const token = await jwt.encode(secret, "500ms", claims);

    expect((await jwt.decode(secret, token)).claims).to.deep.eq(claims);

    // expiry is in whole seconds, so it lands within a second after the lifetime
    await new Promise(r => setTimeout(r, 1600));
    await expect(jwt.decode(secret, token)).to.be.rejected;
  });
});

describe("jwt#decode", () => {
  it("should decode with a single secret and return the kid", async () => {
    const secret = key();
    const token = await jwt.encode(secret, "5m", claims, { kid: "slack" });

    expect(await jwt.decode(secret, token)).to.deep.eq({ claims, kid: "slack" });
  });

  it("should decode a token without a kid with a single secret", async () => {
    const secret = key();
    const token = await jwt.encode(secret, "5m", claims);

    expect(await jwt.decode(secret, token)).to.deep.eq({ claims, kid: undefined });
  });

  it("should pick the key from a map by kid", async () => {
    const keys = { slack: key(), web: key() };
    const token = await jwt.encode(keys.web, "5m", claims, { kid: "web" });

    const decoded = await jwt.decode(keys, token);

    expect(decoded.kid).to.eq("web");
    expect(decoded.claims).to.deep.eq(claims);
  });

  it("should pick the key with a lookup function", async () => {
    const keys = { slack: key() };
    const token = await jwt.encode(keys.slack, "5m", claims, { kid: "slack" });

    const decoded = await jwt.decode(kid => keys[kid], token);

    expect(decoded.claims).to.deep.eq(claims);
  });

  it("should fail for an unknown kid", async () => {
    const token = await jwt.encode(key(), "5m", claims, { kid: "reports" });

    await expect(jwt.decode({ slack: key() }, token)).to.be.rejectedWith('no key for kid "reports"');
  });

  it("should fail for a kid that only exists on Object.prototype", async () => {
    const token = await jwt.encode(key(), "5m", claims, { kid: "constructor" });

    await expect(jwt.decode({ slack: key() }, token)).to.be.rejectedWith('no key for kid "constructor"');
  });

  it("should fail when a map is used on a token without a kid", async () => {
    const token = await jwt.encode(key(), "5m", claims);

    await expect(jwt.decode({ slack: key() }, token)).to.be.rejectedWith("token has no kid");
  });

  it("should fail when a kid names the wrong key", async () => {
    const keys = { slack: key(), web: key() };
    // minted with web's key but claiming to be slack
    const token = await jwt.encode(keys.web, "5m", claims, { kid: "slack" });

    await expect(jwt.decode(keys, token)).to.be.rejected;
  });
});
