import { JSONCodec, JetStreamManager } from "nats";

import crypto from "crypto";
import { dateReviver } from "../src/strings";
import { promisify } from "util";

/**
 * Generates random HEX string
 * @param length lenght of random string
 */
export function randomString(length: number) {
  const rand = crypto.randomBytes(Math.ceil(length / 2));
  return rand.toString("hex").slice(0, length);
}

/**
 * Same as `randomString` but returns a promise.
 * @param length lenght of random string
 */
export const asyncRandomString = promisify<number, string>(randomString);

/**
 * Same as `setTimeout` with promise to wait the timeout out
 * @param delay how long in milliseconds to wait
 */
export const sleep = promisify(setTimeout);

/**
 * Run async job `fn` `n` times.
 * @param n number of times to run it
 * @param fn job to run
 */
export async function repeat(n: number, fn: (i?: number) => Promise<any>): Promise<any[]> {
  const jobs = Array.from({ length: n }).map((_x, i) => fn(i));
  return Promise.all(jobs);
}


export async function getFromStream<T>(manager: JetStreamManager, topic: string) {
  const [stream] = topic.split(".");
  const msg = await manager.streams.getMessage(stream, { last_by_subj: topic });

  // @ts-ignore nats typing is problematic here
  return JSONCodec<T>(dateReviver).decode(msg.data);
}
