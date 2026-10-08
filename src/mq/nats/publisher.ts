import { randomUUID } from "crypto";

import { JSONCodec, JetStreamClient } from "nats";

import { injectable } from "inversify";

@injectable()
export class NatsPublisher {
  private codec = JSONCodec();

  constructor(private client: JetStreamClient) {}

  async publish(subject: string, data: any): Promise<void> {
    const message = this.codec.encode(data);
    await this.client.publish(subject, message, { msgID: randomUUID() });
  }
}
