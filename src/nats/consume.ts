import {
  AckPolicy,
  ConsumerMessages,
  DeliverPolicy,
  JetStreamApiError,
  RetentionPolicy,
  jetstream,
  jetstreamManager
} from "@nats-io/jetstream";
import { NatsConnection, nanos } from "@nats-io/transport-node";
import ms from "ms";

import { Logger } from "../logging/logger";
import { decode } from "./codec";
import { Handler, handlersOf } from "./decorators";

const CONSUMER_NOT_FOUND = 10014;

export interface ConsumeConfig {
  /**
   * name of this app; part of every durable consumer's name, so each app gets
   * its own copy of the stream's messages
   */
  app: string;
  /**
   * logs each message, and each failure with its attempt number
   */
  logger: Logger;
  /**
   * how many messages to pull at a time per subject. Defaults to 10
   */
  batch_size?: number;
  /**
   * how long a handler has before its message is redelivered, in `ms` format.
   * Defaults to 30s
   */
  ack_wait?: string;
  /**
   * attempts per message before it's dropped. Defaults to 5
   */
  max_deliver?: number;
}

export interface Consumers {
  /**
   * stop receiving messages. Messages in flight are redelivered later.
   */
  stop(): Promise<void>;
}

/**
 * Start a durable consumer for every `@subscribe` method of the given `@stream`
 * class instances. New messages only, except on a queue stream, where every
 * pending message is delivered so no job is lost. A handler that returns acks its message;
 * one that throws has it redelivered, up to `max_deliver` attempts, after which
 * it's dropped and logged.
 * @param nats an open connection
 * @param instances the handler objects, built however the app likes
 * @param cfg consumer settings
 */
export async function consume(nats: NatsConnection, instances: object[], cfg: ConsumeConfig): Promise<Consumers> {
  const jsm = await jetstreamManager(nats);
  const js = jetstream(nats);
  const maxDeliver = cfg.max_deliver ?? 5;
  const running: ConsumerMessages[] = [];
  const queues = new Map<string, boolean>();

  for (const handler of instances.flatMap(handlersOf)) {
    if (!queues.has(handler.stream)) {
      const { config } = await jsm.streams.info(handler.stream);
      queues.set(handler.stream, config.retention === RetentionPolicy.Workqueue);
    }

    const subject = `${handler.stream}.${handler.subject}`;
    const durable = durableName(handler.stream, cfg.app, handler.subject);
    const settings = {
      filter_subject: subject,
      ack_wait: nanos(ms(cfg.ack_wait ?? "30s")),
      max_deliver: maxDeliver
    };

    try {
      await jsm.consumers.info(handler.stream, durable);
      await jsm.consumers.update(handler.stream, durable, settings);
    } catch (err) {
      if (!(err instanceof JetStreamApiError && err.code === CONSUMER_NOT_FOUND)) {
        throw err;
      }

      await jsm.consumers.add(handler.stream, {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        // a queue's pending jobs must not be skipped
        deliver_policy: queues.get(handler.stream) ? DeliverPolicy.All : DeliverPolicy.New,
        ...settings
      });
    }

    const consumer = await js.consumers.get(handler.stream, durable);
    const messages = await consumer.consume({ max_messages: cfg.batch_size ?? 10 });
    running.push(messages);
    run(messages, handler, cfg.logger.child({ subject, consumer: durable }), maxDeliver);
  }

  return {
    async stop() {
      await Promise.all(running.map(m => m.close()));
    }
  };
}

/**
 * Durable consumer name for an app's subscription, safe for NATS names.
 */
export function durableName(stream: string, app: string, subject: string) {
  const safe = { ".": "_", "*": "opts", ">": "spread" };
  return `${stream}_${app}_${subject.replace(/[.*>]/g, c => safe[c])}`;
}

async function run(messages: ConsumerMessages, handler: Handler, logger: Logger, maxDeliver: number) {
  try {
    for await (const msg of messages) {
      let data: unknown;
      try {
        data = decode(msg.data);
        logger.log({ data, subject: msg.subject });
        await handler.handle(data);
        msg.ack();
      } catch (err) {
        const attempt = msg.info.deliveryCount;
        const dropped = attempt >= maxDeliver;
        logger.error(err, { data, subject: msg.subject, attempt, dropped });
        if (dropped) {
          msg.term();
        } else {
          msg.nak();
        }
      }
    }
  } catch (err) {
    // never let a broken subscription take the process down
    logger.error(err, "subscription stopped");
  }
}
