import {
  DiscardPolicy,
  JetStreamApiError,
  RetentionPolicy,
  StorageType,
  StreamConfig,
  jetstreamManager
} from "@nats-io/jetstream";
import { NatsConnection, nanos } from "@nats-io/transport-node";
import ms from "ms";

const STREAM_NOT_FOUND = 10059;

/**
 * How a stream keeps its messages.
 * - `log`: on disk, each message kept for `retention` (e.g. `90d`)
 * - `broadcast`: in memory, the last `buffer` messages
 * - `queue`: on disk, each message kept until a consumer acknowledges it, or for
 *   an optional `retention`. A queue's subjects have a single consuming app.
 *
 * `duplicate_window` (e.g. `10m`) is how long a `msgID` is remembered to drop
 * repeats. NATS defaults to 2 minutes.
 */
export type StreamPreset =
  | { type: "log"; retention: string; duplicate_window?: string }
  | { type: "broadcast"; buffer: number; duplicate_window?: string }
  | { type: "queue"; retention?: string; duplicate_window?: string };

type StreamType = StreamPreset["type"];

function typeOf(config: Pick<StreamConfig, "storage" | "retention">): StreamType {
  if (config.retention === RetentionPolicy.Workqueue) return "queue";
  return config.storage === StorageType.Memory ? "broadcast" : "log";
}

/**
 * Create the stream `name` for subjects `name.>`, or bring an existing one's
 * settings in line with `preset`. A stream can't change type once created.
 * @param nats an open connection
 * @param name stream name, also the first token of its subjects
 * @param preset how the stream keeps messages
 */
export async function ensureStream(nats: NatsConnection, name: string, preset: StreamPreset) {
  const jsm = await jetstreamManager(nats);
  const storage = preset.type === "broadcast" ? StorageType.Memory : StorageType.File;
  const retention = preset.type === "queue" ? RetentionPolicy.Workqueue : RetentionPolicy.Limits;
  const maxAge = preset.type !== "broadcast" && preset.retention ? nanos(ms(preset.retention)) : 0;
  const settings: Partial<StreamConfig> = {
    subjects: [`${name}.>`],
    max_age: maxAge,
    max_msgs: preset.type === "broadcast" ? preset.buffer : -1,
    ...(preset.duplicate_window ? { duplicate_window: nanos(ms(preset.duplicate_window)) } : {})
  };

  try {
    const { config } = await jsm.streams.info(name);
    const existing = typeOf(config);
    if (existing !== preset.type) {
      throw new Error(`The ${name} stream already exists as a ${existing} stream`);
    }

    await jsm.streams.update(name, settings);
  } catch (err) {
    if (!(err instanceof JetStreamApiError && err.code === STREAM_NOT_FOUND)) {
      throw err;
    }

    await jsm.streams.add({ name, storage, retention, discard: DiscardPolicy.Old, ...settings });
  }
}
