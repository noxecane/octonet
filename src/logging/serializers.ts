import crypto from "crypto";

import { AxiosRequestConfig, AxiosResponse } from "axios";
import { Request, Response } from "express";
import { cloneDeep, has, isPlainObject, set } from "lodash";

const axiosDefaultHeaders = ["common", "delete", "get", "head", "post", "put", "patch"];

/**
 * What a redacted value is replaced with. Every redaction starts with it, so
 * searching logs for `[REDACTED` finds them all.
 */
export const REDACTED = "[REDACTED]";

/**
 * Create serializers for common log entries. This entries would
 * be avoided for:
 * - Client log entries for axios request/response
 * - Server log entries requests and responses
 * - Consumer log entries for events
 * @param paths paths whose values are logged as `[REDACTED]`, wherever they appear
 */
export function defaultSerializers(...paths: string[]) {
  return {
    axios_req: axiosRequest(...paths),
    axios_res: axiosResponse(...paths),
    req: expressRequest(...paths),
    res: expressResponse(...paths),
    event: sanitized(...paths),
    err: serializeErr
  };
}

/*
 * This function dumps long stack traces for exceptions having a cause()
 * method. The error classes from
 * [verror](https://github.com/davepacheco/node-verror) and
 * [restify v2.0](https://github.com/mcavage/node-restify) are examples.
 *
 * Based on `dumpException` in
 * https://github.com/davepacheco/node-extsprintf/blob/master/lib/extsprintf.js
 */
function getFullErrorStack(ex: any) {
  let ret = ex.stack || ex.toString();
  if (ex.cause && typeof ex.cause === "function") {
    const cex = ex.cause();
    if (cex) {
      ret += "\nCaused by: " + getFullErrorStack(cex);
    }
  }

  return ret;
}

/**
 * Create serializer that exports the entire erro with a
 * custom stack
 * @param err error to serialize
 */
export function serializeErr(err: any) {
  if (!err || !err.stack) return err;
  return {
    stack: getFullErrorStack(err),
    message: err.message,
    name: err.name,
    ...err
  };
}

export function sanitized<T = any>(...paths: string[]) {
  return (data: T) => {
    if (!data || typeof data !== "object" || Object.keys(data).length === 0) return data;

    const dataCopy = deepSanitizeObj(data, ...paths);

    return dataCopy;
  };
}

/**
 * Create serializer for axios requests
 * @param paths sensitive data pasths
 */
export function axiosRequest(...paths: string[]) {
  return (conf: AxiosRequestConfig) => {
    const log = {
      method: conf.method,
      url: conf.url,
      headers: (conf.headers as any)?.toJSON?.() || {},
      params: conf.params
    };

    // remove default header config
    const headers: Record<string, string | undefined> = { ...log.headers };
    axiosDefaultHeaders.forEach(k => {
      delete headers[k];
    });

    log.headers = redactHeaders(headers);

    // Handle request data
    if (typeof conf.data === "string") {
      conf.data = JSON.parse(conf.data);
    }

    if (conf.data && Object.keys(conf.data).length !== 0) {
      const logBody = deepSanitizeObj(conf.data, ...paths);
      log["data"] = logBody;
    }

    return log;
  };
}

/**
 * Serializer for axios responses
 * @param res axios response object
 */
export function axiosResponse(...paths: string[]) {
  return (res: AxiosResponse<any>) => {
    const data = deepSanitizeObj(res.data, ...paths);

    return {
      statusCode: res.status,
      headers: redactHeaders({ ...res.headers }),
      body: data
    };
  };
}

/**
 * Create serializer for express requests
 * @param paths sensitive data paths
 */
export function expressRequest(...paths: string[]): (req: Request) => object {
  return (req: Request) => {
    if (!req || !req.socket) return req;

    const log = {
      method: req.method,
      url: req.url,
      headers: redactHeaders(req.headers),
      params: req.params,
      remoteAddress: req.socket.remoteAddress,
      remotePort: req.socket.remotePort
    };

    if (req.body && Object.keys(req.body).length !== 0) {
      const logBody = deepSanitizeObj(req.body, ...paths);

      log["body"] = logBody;
    }

    return log;
  };
}

/**
 * Serializer for express responses
 * @param paths sensitive data paths
 */
export function expressResponse(...paths: string[]): (res: Response) => object {
  return (res: Response) => {
    if (!res || !res.statusCode) return res;

    const log = {
      statusCode: res.statusCode,
      headers: redactHeaders(res.getHeaders())
    };

    if (res.locals.body && Object.keys(res.locals.body).length !== 0) {
      const logBody = deepSanitizeObj(res.locals.body, ...paths);
      log["body"] = logBody;
    }

    return log;
  };
}

/**
 * Replace a credential with a fingerprint: the first 8 hex characters of its SHA-256,
 * e.g. `[REDACTED sha256:3f9a1c2e]`. It's enough to tell whether two requests used the
 * same credential, or to find a leaked one (hash it and search), without revealing it.
 * Only use it on high-entropy secrets like tokens; a password's hash can be brute-forced.
 * @param secret the credential to hide
 */
export function fingerprint(secret: string) {
  const hash = crypto.createHash("sha256").update(secret).digest("hex").slice(0, 8);
  return `[REDACTED sha256:${hash}]`;
}

// `Bearer abc` → `Bearer [REDACTED sha256:…]`, keeping the scheme for debugging
function redactAuthorization(value: string) {
  const match = /^(\S+)\s+(.+)$/.exec(value);
  return match ? `${match[1]} ${fingerprint(match[2])}` : fingerprint(value);
}

// `a=1; b=2` → `a=[REDACTED sha256:…]; b=[REDACTED sha256:…]`, keeping cookie names
function redactCookie(value: string) {
  return value
    .split(";")
    .map(pair => {
      const i = pair.indexOf("=");
      return i === -1 ? pair : `${pair.slice(0, i + 1)}${fingerprint(pair.slice(i + 1).trim())}`;
    })
    .join(";");
}

// `sid=abc; Path=/; HttpOnly` → `sid=[REDACTED sha256:…]; Path=/; HttpOnly`, keeping attributes
function redactSetCookie(value: string) {
  const i = value.indexOf(";");
  const [cookie, attributes] = i === -1 ? [value, ""] : [value.slice(0, i), value.slice(i)];
  return redactCookie(cookie) + attributes;
}

const credentialHeaders: Record<string, (value: string) => string> = {
  authorization: redactAuthorization,
  "proxy-authorization": redactAuthorization,
  cookie: redactCookie,
  "set-cookie": redactSetCookie
};

/**
 * Copy headers, replacing credentials (`Authorization`, `Proxy-Authorization`, `Cookie`,
 * `Set-Cookie`) with fingerprints. The auth scheme, cookie names and cookie attributes
 * are kept.
 * @param headers request or response headers
 */
export function redactHeaders<T extends object>(headers: T): T {
  if (!headers) return headers;

  const copy = { ...headers };
  Object.keys(copy).forEach(k => {
    const redact = credentialHeaders[k.toLowerCase()];
    const value = copy[k];
    if (!redact || value === undefined || value === null) return;

    copy[k] = Array.isArray(value) ? value.map(v => redact(String(v))) : redact(String(value));
  });

  return copy;
}

function deepSanitizeObj(data: object, ...paths: string[]) {
  const clone = cloneDeep(data); // Deep clone to avoid any reference issues

  function sanitizeNode(node: any) {
    if (isPlainObject(node)) {
      paths.forEach(path => {
        if (has(node, path)) set(node, path, REDACTED);
      });

      Object.keys(node).forEach(key => sanitizeNode(node[key]));
    } else if (Array.isArray(node)) {
      node.forEach((item: any) => sanitizeNode(item));
    }
  }

  sanitizeNode(clone);

  return clone;
}
