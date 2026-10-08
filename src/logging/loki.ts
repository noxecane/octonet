import Bunyan from "bunyan";
import ms from "ms";

export interface LokiConfig {
  /**
   * base URL of Loki e.g. `http://10.0.0.2:3100`. When empty or undefined nothing
   * is sent, so `process.env.LOKI_URL` can be passed as is.
   */
  url?: string;
  /**
   * static labels attached to every log stream e.g. `{ service: "billing" }`. Keep
   * them few and low-cardinality: Loki indexes every distinct label value, so ids
   * and other per-request values belong in the log line, not here.
   */
  labels: Record<string, string>;
  /**
   * name of the label carrying the bunyan level name (trace, debug, info, warn, error,
   * fatal). Set to false to leave the level out of the labels. Defaults to `level`
   */
  level_label?: string | false;
  /**
   * send a batch once it has this many records. Defaults to 100
   */
  batch_size?: number;
  /**
   * send a batch this long after its first record, in `ms` format. Defaults to 1s
   */
  interval?: string;
  /**
   * maximum number of records held while waiting to be sent. The oldest records
   * are dropped past this. Defaults to 10,000
   */
  max_queue?: number;
  /**
   * how long to wait for Loki before dropping a batch, in `ms` format. Defaults to 5s
   */
  timeout?: string;
}

interface Entry {
  level: string;
  value: [string, string];
}

/**
 * A raw bunyan stream that ships records to Loki in batches. It never throws and never
 * blocks the caller: failed batches are dropped, and an outage is reported once on stderr.
 */
export class LokiStream {
  private endpoint: string;
  private labels: Record<string, string>;
  private levelLabel: string | false;
  private batchSize: number;
  private interval: number;
  private maxQueue: number;
  private timeout: number;

  private queue: Entry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private failing = false;

  constructor(config: LokiConfig) {
    this.endpoint = `${config.url.replace(/\/+$/, "")}/loki/api/v1/push`;
    this.labels = { ...config.labels };
    this.levelLabel = config.level_label ?? "level";
    this.batchSize = config.batch_size ?? 100;
    this.interval = ms(config.interval ?? "1s");
    this.maxQueue = Math.max(config.max_queue ?? 10_000, this.batchSize);
    this.timeout = ms(config.timeout ?? "5s");
  }

  /**
   * Called by bunyan with each record.
   */
  write(record: any) {
    try {
      const level = Bunyan.nameFromLevel[record.level] ?? "info";
      const time = record.time instanceof Date ? record.time.getTime() : Date.now();
      const line = JSON.stringify(record, Bunyan.safeCycles());

      this.queue.push({ level, value: [`${time}000000`, line] });
      if (this.queue.length > this.maxQueue) {
        this.queue.splice(0, this.queue.length - this.maxQueue);
      }

      if (this.queue.length >= this.batchSize) {
        this.send();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.send(), this.interval);
        this.timer.unref();
      }
    } catch {
      // a record we can't serialize is not worth breaking the app for
    }
  }

  /**
   * Send everything that's been logged so far. Resolves once Loki has answered
   * (or failed to), never rejects. Call it before the process exits.
   */
  async flush() {
    while (this.inflight || this.queue.length > 0) {
      if (this.inflight) {
        await this.inflight;
      } else {
        this.send();
      }
    }
  }

  private send() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // one request at a time. The queue keeps filling (up to max_queue) meanwhile
    if (this.inflight || this.queue.length === 0) {
      return;
    }

    const batch = this.queue.splice(0, this.batchSize);
    this.inflight = this.push(batch).finally(() => {
      this.inflight = null;
      if (this.queue.length >= this.batchSize) {
        this.send();
      } else if (this.queue.length > 0 && !this.timer) {
        this.timer = setTimeout(() => this.send(), this.interval);
        this.timer.unref();
      }
    });
  }

  private async push(batch: Entry[]) {
    const streams = new Map<string, [string, string][]>();
    for (const entry of batch) {
      // without a level label every record belongs to the same stream
      const level = this.levelLabel ? entry.level : "";
      const value = entry.value;
      if (!streams.has(level)) {
        streams.set(level, []);
      }
      streams.get(level).push(value);
    }

    const body = {
      streams: Array.from(streams, ([level, values]) => ({
        stream: this.levelLabel ? { ...this.labels, [this.levelLabel]: level } : this.labels,
        values
      }))
    };

    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!res.ok) {
        throw new Error(`Loki responded with ${res.status}`);
      }

      if (this.failing) {
        this.failing = false;
        process.stderr.write(`octonet: logs are reaching Loki at ${this.endpoint} again\n`);
      }
    } catch (err) {
      if (!this.failing) {
        this.failing = true;
        process.stderr.write(
          `octonet: dropping logs, can't reach Loki at ${this.endpoint} (${err?.message ?? err}). ` +
            `Logs still go to stdout; this is reported once until Loki recovers\n`
        );
      }
    }
  }
}
