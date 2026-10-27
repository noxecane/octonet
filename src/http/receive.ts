import type { NextFunction, Request, RequestHandler, Response } from "express";

import { Caller, TRACEPARENT_HEADER, withContext } from "../context";
import { UnauthorizedError } from "./errors";
import { DecodeKeys, Decoded, decode } from "../jwt";

declare global {
  namespace Express {
    interface Request {
      /**
       * who made the request, set by `receive`
       */
      caller: Caller;
    }
  }
}

export interface ReceiveConfig {
  /**
   * scheme of system tokens, as in `Authorization: <scheme> <token>`
   */
  scheme: string;
  /**
   * keys of the services allowed to call, by key id (see `jwt.decode`)
   */
  keys: DecodeKeys;
  /**
   * find the user for any other `Authorization`, e.g. a `Bearer` session
   */
  user?: (req: Request) => Octonet.User | undefined | Promise<Octonet.User | undefined>;
}

/**
 * Middleware for an app's edge. It sets `req.caller` from the `Authorization`
 * header, and runs the rest of the request inside its trace (from `traceparent`,
 * or a new one) and caller, so agents and loggers pick them up. A bad system
 * token goes to the error handler as `UnauthorizedError`; no credentials leaves
 * the caller empty.
 * @param config how to recognise callers
 */
export function receive(config: ReceiveConfig): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const traceparent = req.get(TRACEPARENT_HEADER);
    req.caller = {};

    identify(config, req).then(
      caller => {
        req.caller = caller;
        withContext({ traceparent, caller }, () => next());
      },
      err => withContext({ traceparent, caller: req.caller }, () => next(err))
    );
  };
}

async function identify(config: ReceiveConfig, req: Request): Promise<Caller> {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return {};
  }

  const [scheme, token] = authorization.split(" ", 2);
  if (scheme.toLowerCase() === config.scheme.toLowerCase()) {
    return systemCaller(config.keys, token);
  }

  const user = await config.user?.(req);
  return user === undefined ? {} : { user };
}

async function systemCaller(keys: DecodeKeys, token: string): Promise<Caller> {
  // the user is whatever the calling service sent; it's trusted along with the token
  let decoded: Decoded<{ service?: unknown; user?: Octonet.User }>;
  try {
    decoded = await decode(keys, token);
  } catch {
    throw new UnauthorizedError("invalid system token");
  }

  const { claims, kid } = decoded;
  if (typeof claims?.service !== "string") {
    throw new UnauthorizedError("system token names no service");
  }

  if (kid !== undefined && claims.service !== kid) {
    throw new UnauthorizedError(`system token for "${claims.service}" is signed with the key of "${kid}"`);
  }

  return claims.user === undefined ? { system: claims.service } : { system: claims.service, user: claims.user };
}
