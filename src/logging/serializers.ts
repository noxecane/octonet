import { AxiosRequestConfig, AxiosResponse, AxiosResponseHeaders } from "axios";
import { Request, Response } from "express";
import { cloneDeep, isPlainObject, unset } from "lodash";

const axiosDefaultHeaders = ["common", "delete", "get", "head", "post", "put", "patch"];

/**
 * Create serializers for common log entries. This entries would
 * be avoided for:
 * - Client log entries for axios request/response
 * - Server log entries requests and responses
 * - Consumer log entries for events
 * @param paths paths to not print anywhere
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

    log.headers = headers;

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
      headers: res.headers as AxiosResponseHeaders,
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
      headers: req.headers,
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
      headers: res.getHeaders()
    };

    if (res.locals.body && Object.keys(res.locals.body).length !== 0) {
      const logBody = deepSanitizeObj(res.locals.body, ...paths);
      log["body"] = logBody;
    }

    return log;
  };
}

function deepSanitizeObj(data: object, ...paths: string[]) {
  const clone = cloneDeep(data); // Deep clone to avoid any reference issues

  function sanitizeNode(node: any) {
    if (isPlainObject(node)) {
      paths.forEach(path => unset(node, path));

      Object.keys(node).forEach(key => sanitizeNode(node[key]));
    } else if (Array.isArray(node)) {
      node.forEach((item: any) => sanitizeNode(item));
    }
  }

  sanitizeNode(clone);

  return clone;
}
