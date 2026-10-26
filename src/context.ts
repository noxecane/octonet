import { AsyncLocalStorage } from "async_hooks";
import { randomBytes } from "crypto";

/**
 * Header carrying the W3C trace context, e.g.
 * `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`.
 */
export const TRACEPARENT_HEADER = "traceparent";

/**
 * Who made the incoming request: another service (`system`), a user, or both
 * when a service calls on a user's behalf. Empty when the request carried no
 * credentials.
 */
declare global {
  namespace Octonet {
    /**
     * The user a request acts for. Empty here: describe your own in your app,
     * once, and `req.caller.user`, `receive`'s resolver and `agent.for` use it.
     *
     * ```ts
     * declare global {
     *   namespace Octonet {
     *     interface User { id: string }
     *   }
     * }
     * ```
     */
    interface User {}
  }
}

export interface Caller {
  /**
   * the calling service's name
   */
  system?: string;
  user?: Octonet.User;
}

/**
 * What every piece handling one incoming request, or one NATS message, shares.
 */
export interface Context {
  traceparent: string;
  caller: Caller;
  /**
   * the durable consumer handling the message, when this is a NATS message
   */
  consumer?: string;
  /**
   * the message's subject, when this is a NATS message
   */
  subject?: string;
}

const storage = new AsyncLocalStorage<Context>();

/**
 * Run `fn`, and everything it starts, inside `ctx`.
 */
export function runInContext<T>(ctx: Context, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * The context of the incoming request being handled, if any.
 */
export function currentContext(): Context | undefined {
  return storage.getStore();
}

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

interface TraceParent {
  traceId: string;
  spanId: string;
  flags: string;
}

/**
 * Parse a version 00 `traceparent`. All-zero ids are invalid, as the spec says.
 */
export function parseTraceparent(value: unknown): TraceParent | undefined {
  if (typeof value !== "string") return undefined;

  const match = traceparentPattern.exec(value);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;

  return { traceId: match[1], spanId: match[2], flags: match[3] };
}

/**
 * A `traceparent` for the next hop: the same trace with a new span, or a new
 * trace (sampled) when there's no parent.
 */
export function nextTraceparent(parent?: string) {
  const p = parseTraceparent(parent);
  const traceId = p?.traceId ?? randomBytes(16).toString("hex");
  return `00-${traceId}-${randomBytes(8).toString("hex")}-${p?.flags ?? "01"}`;
}
