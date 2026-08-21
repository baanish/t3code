import type { TeleportProvider, TeleportThreadState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const PENDING_TELEPORT_NATIVE_PATH_PREFIX = "teleport-pending:";

export function pendingTeleportNativePath(
  provider: TeleportProvider,
  externalSessionId: string,
): string {
  return `${PENDING_TELEPORT_NATIVE_PATH_PREFIX}${provider}:${externalSessionId}`;
}

export function isPendingTeleportNativePath(nativePath: string): boolean {
  return nativePath.startsWith(PENDING_TELEPORT_NATIVE_PATH_PREFIX);
}

export function realExportNativePath(nativePath: string | undefined): string | undefined {
  if (nativePath === undefined || isPendingTeleportNativePath(nativePath)) {
    return undefined;
  }
  return nativePath;
}

export function recoveredInterruptedExportState(
  teleport: TeleportThreadState,
  discoveredNativePath: string | undefined,
): TeleportThreadState | null {
  if (
    teleport.presence !== "native" ||
    !isPendingTeleportNativePath(teleport.nativePath)
  ) {
    return null;
  }
  return {
    ...teleport,
    presence: discoveredNativePath === undefined ? "t3" : "native",
    nativePath: discoveredNativePath ?? teleport.nativePath,
  };
}

/**
 * After pending native presence is set, a failed or interrupted export must
 * either restore T3 presence or persist the real native path if the file was
 * already written. Leaving `teleport-pending:...` strands the thread: the UI
 * only offers Import, which then rejects the fake path.
 */
export function teleportExportPresenceOnFailure<R>(input: {
  readonly writtenNativePath: string | undefined;
  readonly revert: Effect.Effect<void, never, R>;
  readonly persistWritten: (nativePath: string) => Effect.Effect<void, never, R>;
}): Effect.Effect<void, never, R> {
  if (input.writtenNativePath !== undefined) {
    return input.persistWritten(input.writtenNativePath);
  }
  return input.revert;
}
