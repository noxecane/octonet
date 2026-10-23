/**
 * Custom error instance to allow handlers request a retry
 */
export class RetryError extends Error {
  constructor(public readonly wrapped?: Error) {
    super(wrapped?.message);
  }
}
