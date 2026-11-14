import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { jsonSchema } from "./schemas.js";

export function canonicalJson(value: unknown): string {
  const parsed = jsonSchema.parse(value);
  const encode = (item: typeof parsed): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(item[key]!)}`).join(",")}}`;
  };
  return encode(parsed);
}
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function hashJson(value: unknown): string { return sha256(canonicalJson(value)); }
export function sha256File(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally { closeSync(descriptor); }
}
