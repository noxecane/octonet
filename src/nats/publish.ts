import { jetstream } from "@nats-io/jetstream";
import { NatsConnection } from "@nats-io/transport-node";

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
 * Publish `data` as JSON to a stream subject.
 * @param nats an open connection
 * @param subject e.g. `transactions.credit.wallet`
 * @param data the message
 * @param opts optional message id for duplicate detection
 */
export async function publish(nats: NatsConnection, subject: string, data: unknown, opts: PublishOptions = {}) {
  await jetstream(nats).publish(subject, encode(data), opts.msgID ? { msgID: opts.msgID } : undefined);
}
