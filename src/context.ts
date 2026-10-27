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
 * Starts a unit of work: a request, a message, a cron tick, a script run.
 */
export interface ContextOptions {
  /**
   * the `traceparent` that came with the work. When missing or malformed, the
   * work continues the enclosing context's trace, or starts a new one.
   */
  traceparent?: string;
  /**
   * who the work is for. When not given, the enclosing context's caller, or
   * empty.
   */
  caller?: Caller;
  /**
   * what to log about where the work came from, e.g. `{ job: "nightly-sync" }`.
   * Added to the enclosing context's fields; these win on the same key.
   */
  fields?: Record<string, string>;
}

/**
 * The unit of work being handled.
 */
export interface Context {
  traceId: string;
  caller: Caller;
  fields: Record<string, string>;
}

interface Store {
  traceparent: string;
  caller: Caller;
  fields: Record<string, string>;
}

const storage = new AsyncLocalStorage<Store>();

/**
 * Run `fn`, and everything it starts, as one unit of work. Agents, `publish`
 * and loggers called from it see its trace, caller and fields. Inside another
 * context, it inherits all three and overrides only what you pass.
 */
export function withContext<T>(opts: ContextOptions, fn: () => T): T {
  const parent = storage.getStore();
  const traceparent = parseTraceparent(opts.traceparent) ? opts.traceparent! : outgoingTraceparent();
  const caller = opts.caller ?? parent?.caller ?? {};
  const fields = { ...parent?.fields, ...opts.fields };

  return storage.run({ traceparent, caller, fields }, fn);
}

/**
 * The unit of work being handled, if any.
 */
export function currentContext(): Context | undefined {
  const store = storage.getStore();
  if (!store) return undefined;

  return { traceId: parseTraceparent(store.traceparent)!.traceId, caller: store.caller, fields: store.fields };
}

/**
 * The `traceparent` to send with work leaving this one: the current trace with
 * a new span, or a new trace (sampled) outside any context.
 */
export function outgoingTraceparent() {
  const parent = parseTraceparent(storage.getStore()?.traceparent);
  const traceId = parent?.traceId ?? randomBytes(16).toString("hex");
  return `00-${traceId}-${randomBytes(8).toString("hex")}-${parent?.flags ?? "01"}`;
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
