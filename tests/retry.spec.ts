import { expect } from "chai";

import { faker } from "./fake";
import { ExitError, RetryError, retryOnError, retryOnRequest, retryTimeouts } from "../src/retry";

describe("retryTimeouts", () => {
  it("should generate timeouts of exponential distance", () => {
    const timeout = faker.datatype.number({ min: 5, max: 30 });
    const timeouts = retryTimeouts(5, timeout);

    timeouts.forEach((t, i) => {
      const expectedT = timeout * Math.pow(2, i);
      expect(t).to.be.eq(expectedT);
    });
  });
});

describe("retryOnError", () => {
  it("should increment attempt number on each retry", async () => {
    let attempts: number[] = [];

    try {
      await retryOnError(2, "10ms", async attempt => {
        attempts.push(attempt);

        throw new Error("error");
      });
    } catch (error) {}

    expect(attempts).to.have.length(3);
    attempts.forEach((a, i) => {
      expect(a).to.eql(i + 1);
    });
  });

  it("should not retry when maxRetries is 0", async () => {
    let count = 0;

    try {
      await retryOnError(0, "10ms", async () => {
        ++count;

        throw new Error("error");
      });
    } catch (err) {}

    expect(count).to.eq(1);
  });

  it("should retry according to maxRetries", async () => {
    let count = 0;

    try {
      await retryOnError(4, "10ms", async () => {
        ++count;

        throw new Error("error");
      });
    } catch (err) {}

    expect(count).to.eq(5);
  });

  it("should exit when no error", async () => {
    let count = 0;

    try {
      await retryOnError(4, "10ms", async () => {
        ++count;

        if (count === 2) {
          return;
        }

        throw new Error("error");
      });
    } catch (err) {}

    expect(count).to.eq(2);
  });

  it("should exit early", async () => {
    let count = 0;

    try {
      await retryOnError(4, "10ms", async () => {
        ++count;

        if (count === 3) {
          throw new ExitError();
        }

        throw new Error("error");
      });
    } catch (err) {}

    expect(count).to.eq(3);
  });
});

describe("retryOnRequest", () => {
  it("should increment attempt number on each retry", async () => {
    let attempts: number[] = [];

    try {
      await retryOnRequest(5, "10ms", async attempt => {
        attempts.push(attempt);

        throw new RetryError();
      });
    } catch (error) {}

    expect(attempts).to.have.length(6);
    attempts.forEach((a, i) => {
      expect(a).to.eql(i + 1);
    });
  });

  it("should try only one attempt by default", async () => {
    let count = 0;

    try {
      await retryOnRequest(4, "10ms", async () => {
        ++count;

        throw new Error("error");
      });
    } catch (err) {}

    expect(count).to.eq(1);
  });

  it("should retry on RetryError", async () => {
    let count = 0;

    try {
      await retryOnRequest(4, "10ms", async () => {
        ++count;

        if (count === 3) {
          throw new Error();
        }

        throw new RetryError();
      });
    } catch (err) {}

    expect(count).to.eq(3);
  });
});
