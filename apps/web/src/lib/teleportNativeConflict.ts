import type {
  TeleportCheckNativeRevisionResult,
  TeleportNativeRevisionStatus,
  ThreadId,
} from "@t3tools/contracts";

export function teleportNativeConflictTitle(status: TeleportNativeRevisionStatus): string {
  switch (status) {
    case "diverged":
      return "Native CLI session changed";
    case "missing":
      return "Native session file is missing";
    case "oversize":
      return "Native session file is too large";
    case "not-applicable":
    case "untracked":
    case "unchanged":
    case "forked":
      return "Native session";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function teleportNativeConflictDescription(
  result: Pick<TeleportCheckNativeRevisionResult, "status">,
): string {
  switch (result.status) {
    case "diverged":
      return "The original CLI file changed after import. Fork those changes into a new thread to keep both.";
    case "missing":
      return "T3 still has this imported thread, but the original CLI file is gone. Sending is blocked so neither side is overwritten.";
    case "oversize":
      return "The original CLI file is too large to compare or fork. Sending is blocked so neither side is overwritten.";
    case "not-applicable":
    case "untracked":
    case "unchanged":
    case "forked":
      return "";
    default: {
      const _exhaustive: never = result.status;
      return _exhaustive;
    }
  }
}

export function teleportNativeConflictResultForThread(input: {
  readonly threadId: ThreadId | null;
  readonly watching: boolean;
  readonly result: TeleportCheckNativeRevisionResult | null;
}): TeleportCheckNativeRevisionResult | null {
  if (!input.watching || input.threadId === null || input.result === null) {
    return null;
  }
  return input.result.threadId === input.threadId ? input.result : null;
}

export function shouldShowTeleportNativeConflict(
  status: TeleportNativeRevisionStatus | null | undefined,
): boolean {
  switch (status) {
    case "diverged":
    case "missing":
    case "oversize":
      return true;
    case "not-applicable":
    case "untracked":
    case "unchanged":
    case "forked":
    case null:
    case undefined:
      return false;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function canForkTeleportNativeConflict(
  result: Pick<TeleportCheckNativeRevisionResult, "status" | "observedRevision">,
): boolean {
  return result.status === "diverged" && result.observedRevision !== undefined;
}
