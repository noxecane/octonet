export type AsyncNullable<T> = Promise<T | null>;

/**
 * Contract of stores used to manage session tokens. What's most important of
 * said tokens(vs JWT for instance) is the ability to revoke said token. Each key
 * has at most one live token.
 */
export interface TokenStore {
  /**
   * Create a random token that expires after the given timeout. It replaces any
   * live token for the same key.
   * @param key key to enabled reset and revoke
   * @param val value the token will refer to
   * @param time timeout before expiry
   */
  commission<T = any>(key: string, val: T, time: string): Promise<string>;
  /**
   * Get the data the token references without changing its lifetime
   * @param token token to check for
   */
  peek<T = any>(token: string): AsyncNullable<T>;
  /**
   * Set the new duration before an existing token times out. Note that it doesn't
   * take into account how long the old token had to expire, as it uses the new duration
   * entirely.
   * @param token generated token
   * @param time the new expiry duration of the token
   */
  extend<T = any>(token: string, time: string): AsyncNullable<T>;
  /**
   * Change the contents of the key's token without changing it's TTL
   * @param key key the token was created for
   * @param newVal value to replace token content
   */
  reset<T = any>(key: string, newVal: T): Promise<void>;
  /**
   * Load the value referenced by the token and dispenses of the token,
   * making it unvailable for further use.
   * @param token token to be decomissioned
   */
  decommission<T = any>(token: string): AsyncNullable<T>;
  /**
   * Render the token created for the given key useless.
   * @param key key the token was created for
   */
  revoke(key: string): Promise<void>;
}
