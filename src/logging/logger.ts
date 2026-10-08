import { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";
import Bunyan, { ERROR, INFO } from "bunyan";
import { Request, Response } from "express";

import { LokiConfig, LokiStream } from "./loki";

export interface LogError {
  err: Error;
  [key: string]: any;
}

type Serializer = (input: any) => any;
type Serializers = {
  [key: string]: Serializer;
};

export interface LoggerConfig {
  name: string;
  serializers: Serializers;
  verbose?: boolean;
  buffer?: NodeJS.WritableStream | Bunyan.WriteFn;
  /**
   * also ship logs to Loki, next to stdout(or `buffer`). Nothing is sent when unset
   * or when `url` is empty.
   */
  loki?: LokiConfig;
}

export class Logger {
  private logger: Bunyan;
  private loki?: LokiStream;

  constructor(logger: Bunyan);
  constructor(config: LoggerConfig);
  constructor(config: LoggerConfig | Bunyan) {
    if (config instanceof Bunyan) {
      this.logger = config;
    } else {
      const level = config.verbose === false ? ERROR : INFO;
      const streams: Bunyan.Stream[] = [
        {
          stream: config.buffer || process.stdout,
          level,
          type: !!config.buffer ? "raw" : "stream"
        }
      ];

      if (config.loki?.url) {
        this.loki = new LokiStream(config.loki);
        streams.push({ stream: this.loki as any, level, type: "raw" });
      }

      this.logger = new Bunyan({
        name: config.name,
        serializers: config.serializers,
        streams
      });
    }
  }

  /**
   * Wait for logs still on their way to Loki. Call it before the process exits.
   * It's a no-op without Loki and never rejects.
   */
  flush(): Promise<void> {
    return this.loki?.flush() ?? Promise.resolve();
  }

  /**
   * Create a child logger with labels to annotate it as such
   * @param labels annotation of new sub logger
   */
  child(labels: object) {
    const child = new Logger(this.logger.child(labels));
    child.loki = this.loki;
    return child;
  }

  /**
   * Logs an incoming HTTP request
   * @param req Express request
   */
  request(req: Request) {
    this.logger.info({ req });
  }

  /**
   * Logs an outgoing HTTP response
   * @param req Express request
   * @param res Express responser
   */
  response(req: Request, res: Response) {
    this.logger.info({ res, req });
  }

  /**
   * Logs an error that occured during the handling of an HTTP request
   * @param err Error object
   * @param req express request
   * @param res express responser
   */
  httpError(err: Error, req: Request, res: Response) {
    this.logger.error({ err, res, req });
  }

  /**
   * Logs an axios request
   * @param req Axios Request
   */
  axiosRequest(req: AxiosRequestConfig) {
    this.logger.info({ axios_req: req });
  }

  /**
   * Logs response to axios reequest
   * @param res Axios Response
   */
  axiosResponse(res: AxiosResponse) {
    this.logger.info({ axios_req: res.config, axios_res: res });
  }

  /**
   * Logs error response to axios request
   * @param err
   */
  axiosError(err: AxiosError) {
    this.logger.error({ axios_req: err.response?.config || err.config, axios_res: err.response });
  }

  /**
   * Log data
   * @param metadata data to be loggwed
   */
  log(metadata: object): void;
  /**
   * Logs data with a message
   * @param message message to be logged
   * @param metadata data to be logged
   */
  log(message: string, metadata?: object): void;
  log(entry: string | any, metadata?: object) {
    if (typeof entry === "string" && metadata) {
      this.logger.info(metadata, entry);
    } else {
      this.logger.info(entry);
    }
  }

  /**
   * Log internal application error
   * @param err actual error being logged
   * @param extras anything else to log with the error
   */
  error(err: Error, extras?: object): void;
  /**
   * Log internal application error
   * @param err actual error being logged
   * @param message optional custom error message
   */
  error(err: Error, message?: string): void;
  error(err: Error, extras?: object | string) {
    if (typeof extras === "string") {
      this.logger.error(err, extras);
    } else {
      this.logger.error({ err, ...extras });
    }
  }
}
