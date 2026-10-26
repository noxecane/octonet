import { AxiosError, AxiosInstance } from "axios";

/**
 * The request carried a system token that isn't valid: it doesn't decode with the
 * known keys, or its key id doesn't match the service it claims to be.
 */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * The request never got a response, e.g. the connection was refused.
 */
export class HttpError extends Error {
  readonly axios_code: string;
  readonly axios_message: string;
  constructor(url: string, rawError: AxiosError) {
    super(`Request to ${url} failed`);
    this.axios_code = rawError.code;
    this.axios_message = rawError.message;
  }
}

export class TimeoutError extends Error {
  constructor(url: string, timeout: number) {
    super(`Request to ${url} failed: request timed out after ${timeout}ms`);
  }
}

/**
 * The server answered with an error status.
 */
export class APIError extends Error {
  constructor(url: string, readonly status: number, readonly data: any) {
    super(`Request to ${url} failed with status ${status}`);
  }
}

/**
 * Make an axios instance fail with `APIError` (an error status), `TimeoutError`
 * or `HttpError` (no response) instead of axios's own error. Install after
 * `useLogger`, so the logger still sees axios's error.
 * @param axios the instance to install on
 */
export function useErrors(axios: AxiosInstance) {
  axios.interceptors.response.use(undefined, (err: unknown) => {
    if (!(err instanceof AxiosError)) {
      throw err;
    }

    const url = err.config?.url;
    if (err.response) {
      throw new APIError(url, err.response.status, err.response.data);
    }

    if (err.code === AxiosError.ETIMEDOUT || err.code === AxiosError.ECONNABORTED) {
      throw new TimeoutError(url, err.config?.timeout);
    }

    if (err.request) {
      throw new HttpError(url, err);
    }

    throw err;
  });

  return axios;
}
