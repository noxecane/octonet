import { randomUUID } from "crypto";

import { JetStreamManager, jetstreamManager } from "@nats-io/jetstream";
import { NatsConnection, connect } from "@nats-io/transport-node";
import Bunyan from "bunyan";

import { NATS_URL } from "../config";
import { Logger, defaultSerializers } from "../../src";

/**
 * A connection, its manager and a way to make stream names that clean up after
 * themselves: every name handed out is deleted by `cleanup`.
 */
export async function natsFixture() {
  const nats: NatsConnection = await connect({ servers: NATS_URL });
  const jsm: JetStreamManager = await jetstreamManager(nats);
  const names: string[] = [];

  return {
    nats,
    jsm,
    streamName() {
      const name = `octonettest${randomUUID().slice(0, 8)}`;
      names.push(name);
      return name;
    },
    async cleanup() {
      for (const name of names.splice(0)) {
        await jsm.streams.delete(name).catch(() => undefined);
      }
    },
    async close() {
      await nats.close();
    }
  };
}

export function bufferLogger() {
  const buffer = new Bunyan.RingBuffer({ limit: 100 });
  const logger = new Logger({ name: "nats_tests", serializers: defaultSerializers(), buffer });
  return { logger, records: () => buffer.records };
}
