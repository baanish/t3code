// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";

import { isSafeTeleportSessionId } from "../json.ts";

const OPENCODE_ID_LENGTH = 26;
const OPENCODE_BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastOpenCodeTimestamp = 0;
let openCodeCounter = 0;

export type OpenCodeIdPrefix = "ses" | "msg" | "prt";

function randomBase62(length: number): string {
  const bytes = NodeCrypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    const byte = bytes[i];
    result += OPENCODE_BASE62[(byte ?? 0) % 62];
  }
  return result;
}

export function createOpenCodeId(prefix: OpenCodeIdPrefix): string {
  const currentTimestamp = Date.now();
  if (currentTimestamp !== lastOpenCodeTimestamp) {
    lastOpenCodeTimestamp = currentTimestamp;
    openCodeCounter = 0;
  }
  openCodeCounter += 1;
  const encoded = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(openCodeCounter);
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((encoded >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  return `${prefix}_${timeBytes.toString("hex")}${randomBase62(OPENCODE_ID_LENGTH - 12)}`;
}

export function ensureOpenCodeId(prefix: OpenCodeIdPrefix, given: string | undefined): string {
  if (given !== undefined && given.startsWith(`${prefix}_`) && isSafeTeleportSessionId(given)) {
    return given;
  }
  return createOpenCodeId(prefix);
}
