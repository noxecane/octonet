import { AxiosError, AxiosInstance } from "axios";

import { Logger } from "../logging/logger";

/**
 * Log every request, response and failure of an axios instance through the
 * logger's (redacting) serializers. Works on any instance, e.g. a client for an
 * external API.
 * @param axios the instance to install on
 * @param logger a logger with `defaultSerializers`
 */
export function useLogger(axios: AxiosInstance, logger: Logger) {
  axios.interceptors.request.use(config => {
    logger.axiosRequest(config);
    return config;
  });

  axios.interceptors.response.use(
    res => {
      logger.axiosResponse(res);
      return res;
    },
    (err: unknown) => {
      if (err instanceof AxiosError) {
        logger.axiosError(err);
      }

      throw err;
    }
  );

  return axios;
}
