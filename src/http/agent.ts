import axios, { AxiosHeaders, AxiosInstance, InternalAxiosRequestConfig } from "axios";
import ms from "ms";

import { TRACEPARENT_HEADER, currentContext, nextTraceparent } from "../context";
import { useErrors } from "./errors";
import { useLogger } from "./logging";
import { encode } from "../jwt";
import { Logger } from "../logging/logger";

/**
 * Key for the system tokens the agent sends.
 */
export interface AgentAuthConfig {
  /**
   * scheme of the `Authorization` header, e.g. `Octonet` in `Octonet <token>`
   */
  scheme: string;
  /**
   * this service's key, which the services it calls decode its tokens with
   */
  key: Uint8Array;
  /**
   * key id put in the token's header. Receivers holding several keys expect it
   * to equal `service`
   */
  kid?: string;
  /**
   * how long a token lives, in `ms` format. Defaults to "10s"
   */
  timeout?: string;
}

export interface AgentConfig {
  /**
   * name of the service making the requests, sent in its token
   */
  service: string;
  /**
   * log every request, response and failure
   */
  logger?: Logger;
  /**
   * request timeout, in `ms` format. Defaults to "10s"
   */
  timeout?: string;
  auth: AgentAuthConfig;
}

/**
 * Who an agent's calls act for, instead of the incoming request's user.
 */
export interface Identity {
  user?: Octonet.User;
}

/**
 * An axios instance for calling other services. Every call carries the trace
 * and a system token.
 */
export type HttpAgent = AxiosInstance & {
  /**
   * a new agent whose calls act for `identity.user`, whatever request is being
   * handled. This agent is unchanged
   */
  for(identity: Identity): HttpAgent;
};

/**
 * Create an agent for calling other services. Every call continues the trace of
 * the request being handled (or starts one), and sends a system token naming
 * this service and the user it acts for: the one given to `for`, else the
 * caller's user. Failures come out as `APIError`, `TimeoutError` or `HttpError`.
 * @param config the agent's configuration
 */
export function createAgent(config: AgentConfig): HttpAgent {
  return build(config);
}

function build(config: AgentConfig, identity?: Identity): HttpAgent {
  const instance = axios.create({ timeout: ms(config.timeout ?? "10s") });

  // response interceptors run in order: the logger must see axios's own error
  if (config.logger) {
    useLogger(instance, config.logger);
  }
  useErrors(instance);

  // request interceptors run in reverse order: this runs first, so the logged
  // request has the final headers
  instance.interceptors.request.use(req => applyContracts(config, identity, req));

  return Object.assign(instance, { for: (next: Identity) => build(config, next) });
}

async function applyContracts(config: AgentConfig, identity: Identity | undefined, req: InternalAxiosRequestConfig) {
  const ctx = currentContext();
  const user = identity ? identity.user : ctx?.caller.user;
  const { auth } = config;

  const claims = user === undefined ? { service: config.service } : { service: config.service, user };
  const token = await encode(auth.key, auth.timeout ?? "10s", claims, { kid: auth.kid });

  const headers = AxiosHeaders.from(req.headers);
  headers.set(TRACEPARENT_HEADER, nextTraceparent(ctx?.traceparent));
  headers.set("Authorization", `${auth.scheme} ${token}`);

  req.headers = headers;
  return req;
}
