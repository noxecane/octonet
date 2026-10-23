import { existsSync, readFileSync } from "fs";
import { parseEnv } from "util";

// local runs read .env; CI sets the variables itself. Assigned rather than
// process.loadEnvFile, which writes to the real env and misses jest's per-file copy
if (existsSync(".env")) {
  Object.assign(process.env, parseEnv(readFileSync(".env", "utf8")));
}

function required(key: string) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is not set: copy .env.example to .env and fill it in`);
  }

  return value;
}

export const REDIS_URL = required("REDIS_URL");
export const NATS_URL = required("NATS_URL");
