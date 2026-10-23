import { EncryptJWT, JWTDecryptGetKey, errors, jwtDecrypt } from "jose";

/**
 * Keys to decode with: a single secret, a map from key id (`kid`) to secret, or a
 * function that finds the secret for a key id.
 */
export type DecodeKeys = Uint8Array | Record<string, Uint8Array> | ((kid: string) => Uint8Array | undefined);

export interface EncodeOptions {
  /**
   * key id of `secret`, put in the token's protected header so a decoder holding
   * several keys knows which one to use
   */
  kid?: string;
}

export interface Decoded<T> {
  claims: T;
  /**
   * key id from the token's header, if it had one. It's authenticated along with
   * the claims, so it can be trusted once `decode` succeeds
   */
  kid?: string;
}

/**
 * Sign and encrypt data as a JWT token
 * @param secret secret for signing and encrypting
 * @param timeout how long before the JWT expires. This is intentionally required
 * @param data data to encoode and encrypt
 * @param opts encoding options, e.g. `kid`
 * @returns encrypted JWT token
 */
export function encode(secret: Uint8Array, timeout: string, data: any, opts: EncodeOptions = {}) {
  return new EncryptJWT({ "urn:custom:claim": data })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", ...(opts.kid ? { kid: opts.kid } : {}) })
    .setIssuedAt()
    .setExpirationTime(timeout)
    .encrypt(secret);
}

/**
 * Decrypts and decodes tokens signed using `encode`. With a map or a lookup, the
 * key is picked by the token's `kid`; a missing or unknown `kid` fails like a bad
 * token.
 * @param keys the secret used to `encode`, or the secrets by key id
 * @param token token to be verified
 * @returns the claims and the token's key id
 */
export async function decode<T = any>(keys: DecodeKeys, token: string): Promise<Decoded<T>> {
  const { payload, protectedHeader } = await jwtDecrypt(token, keyFor(keys));
  return { claims: payload["urn:custom:claim"] as T, kid: protectedHeader.kid };
}

function keyFor(keys: DecodeKeys): JWTDecryptGetKey {
  if (keys instanceof Uint8Array) {
    return () => keys;
  }

  // own keys only, so a kid like "constructor" can't reach Object.prototype
  const lookup =
    typeof keys === "function" ? keys : (kid: string) => (Object.hasOwn(keys, kid) ? keys[kid] : undefined);

  return ({ kid }) => {
    const key = kid ? lookup(kid) : undefined;
    if (!key) {
      throw new errors.JWEInvalid(kid ? `no key for kid "${kid}"` : "token has no kid");
    }

    return key;
  };
}
