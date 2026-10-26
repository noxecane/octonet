import { jetstream } from "@nats-io/jetstream";
import { NatsConnection, headers } from "@nats-io/transport-node";

import { TRACEPARENT_HEADER, currentContext, nextTraceparent } from "../context";
import { encode } from "./codec";

export interface PublishOptions {
  /**
   * id the stream uses to drop a repeat of this message within its duplicate
   * window. Make it stable for the same event, e.g. `${row.id}@${written_at}`.
   * Without it, repeats aren't detected.
   */
  msgID?: string;
}

/**
 * Publish `data` as JSON to a stream subject. The message carries a
 * `traceparent` that continues the current request's or message's trace, or
 * starts one.
 * @param nats an open connection
 * @param subject e.g. `transactions.credit.wallet`
 * @param data the message
 * @param opts optional message id for duplicate detection
 */
export async function publish(nats: NatsConnection, subject: string, data: unknown, opts: PublishOptions = {}) {
  const h = headers();
  h.set(TRACEPARENT_HEADER, nextTraceparent(currentContext()?.traceparent));

  await jetstream(nats).publish(subject, encode(data), { headers: h, ...(opts.msgID ? { msgID: opts.msgID } : {}) });
}
