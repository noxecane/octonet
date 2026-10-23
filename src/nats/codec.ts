const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Messages travel as plain JSON. Dates go out as ISO strings and stay strings;
 * convert them where a `Date` is needed.
 */
export function encode(data: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(data));
}

export function decode<T = any>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes));
}
