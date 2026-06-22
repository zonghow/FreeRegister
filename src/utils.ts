import { createHash, randomBytes } from "node:crypto";

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

export function randomUrlSafeString(length: number): string {
  const size = length > 0 ? length : 32;
  return randomBytes(size).toString("base64url");
}

export function pkceCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

export function formatUtc8Timestamp(value: Date | number | string = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const shifted = new Date(timestamp + UTC8_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hour = String(shifted.getUTCHours()).padStart(2, "0");
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
  const second = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second} UTC+8`;
}
