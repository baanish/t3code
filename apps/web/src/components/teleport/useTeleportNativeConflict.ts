import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  TeleportCheckNativeRevisionResult,
  TeleportThreadState,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  environmentSupportsTeleport,
  teleportFailureMessage,
  teleportNativeRevisionSendDisabledReason,
} from "../../lib/teleport";
import {
  canForkTeleportNativeConflict,
  shouldShowTeleportNativeConflict,
  teleportNativeConflictResultForThread,
} from "../../lib/teleportNativeConflict";
import { useServerConfigs } from "../../state/entities";
import { teleportEnvironment } from "../../state/teleport";
import { useAtomCommand } from "../../state/use-atom-command";

export function useTeleportNativeConflict(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly isServerThread: boolean;
  readonly teleport: TeleportThreadState | null | undefined;
  readonly sessionUpdatedAt: string | null | undefined;
  readonly onForked: (threadId: ThreadId) => void;
}) {
  const serverConfigs = useServerConfigs();
  const checkNativeRevision = useAtomCommand(teleportEnvironment.checkNativeRevision, {
    reportFailure: false,
  });
  const forkNativeDivergence = useAtomCommand(teleportEnvironment.forkNativeDivergence, {
    reportFailure: false,
  });
  const [result, setResult] = useState<TeleportCheckNativeRevisionResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const forkingRef = useRef(false);
  const onForkedRef = useRef(input.onForked);
  onForkedRef.current = input.onForked;
  const supportsTeleport = environmentSupportsTeleport(
    serverConfigs.get(input.environmentId)?.environment.capabilities,
  );
  const watchKey =
    input.isServerThread &&
    input.threadId !== null &&
    supportsTeleport &&
    input.teleport?.presence === "t3" &&
    input.teleport.forkedFromThreadId === undefined
      ? [
          input.environmentId,
          input.threadId,
          input.teleport.nativePath,
          input.teleport.lastSyncedAt,
          input.teleport.nativeRevision?.digest ?? "",
          input.sessionUpdatedAt ?? "",
        ].join(":")
      : null;

  const refresh = useCallback(async () => {
    if (watchKey === null || input.threadId === null) {
      setResult(null);
      setCheckError(null);
      return null;
    }
    const requestId = ++requestIdRef.current;
    const checked = await checkNativeRevision({
      environmentId: input.environmentId,
      input: { threadId: input.threadId },
    });
    if (requestId !== requestIdRef.current) {
      return null;
    }
    if (checked._tag === "Success") {
      setResult(checked.value);
      setCheckError(null);
      return checked.value;
    }
    if (isAtomCommandInterrupted(checked)) {
      return null;
    }
    setResult(null);
    setCheckError(teleportFailureMessage(squashAtomCommandFailure(checked)));
    return null;
  }, [checkNativeRevision, input.environmentId, input.threadId, watchKey]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  const currentResult = teleportNativeConflictResultForThread({
    threadId: input.threadId,
    watching: watchKey !== null,
    result,
  });

  const forkNativeChanges = useCallback(async () => {
    if (forkingRef.current || input.threadId === null || watchKey === null) {
      return;
    }
    if (currentResult !== null && !canForkTeleportNativeConflict(currentResult)) {
      return;
    }
    forkingRef.current = true;
    setForking(true);
    setForkError(null);
    try {
      const forked = await forkNativeDivergence({
        environmentId: input.environmentId,
        input: { threadId: input.threadId },
      });
      if (forked._tag === "Success") {
        onForkedRef.current(forked.value.threadId);
        setResult((current) =>
          current === null
            ? current
            : {
                ...current,
                status: "forked",
                forkedThreadId: forked.value.threadId,
              },
        );
        return;
      }
      if (isAtomCommandInterrupted(forked)) {
        return;
      }
      setForkError(teleportFailureMessage(squashAtomCommandFailure(forked)));
    } finally {
      forkingRef.current = false;
      setForking(false);
    }
  }, [currentResult, forkNativeDivergence, input.environmentId, input.threadId, watchKey]);

  const sendDisabledReason = teleportNativeRevisionSendDisabledReason(currentResult?.status);
  const visible = shouldShowTeleportNativeConflict(currentResult?.status);

  return {
    result: currentResult,
    checkError,
    forking,
    forkError,
    visible,
    sendDisabledReason,
    refresh,
    forkNativeChanges,
  };
}
