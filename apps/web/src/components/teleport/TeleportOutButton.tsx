import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isTeleportProvider, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { LogOutIcon } from "lucide-react";
import { useRef, useState } from "react";

import { buildLoadingThreadFromShell } from "../ChatView.logic";
import {
  environmentSupportsTeleport,
  isTeleportedOut,
  teleportFailureMessage,
} from "../../lib/teleport";
import { useServerConfigs, useThread, useThreadShell } from "../../state/entities";
import { teleportEnvironment } from "../../state/teleport";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface TeleportOutButtonProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isServerThread: boolean;
  readonly cwd: string | null;
}

export function TeleportOutButton({
  environmentId,
  threadId,
  isServerThread,
  cwd,
}: TeleportOutButtonProps) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const detail = useThread(threadRef);
  const shell = useThreadShell(threadRef);
  const serverConfigs = useServerConfigs();
  const exportSession = useAtomCommand(teleportEnvironment.exportSession, {
    reportFailure: false,
  });
  const importSessions = useAtomCommand(teleportEnvironment.importSessions, {
    reportFailure: false,
  });
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const thread = detail ?? (shell === null ? null : buildLoadingThreadFromShell(shell));
  if (
    !isServerThread ||
    thread === null ||
    !environmentSupportsTeleport(serverConfigs.get(environmentId)?.environment.capabilities)
  ) {
    return null;
  }

  const teleport = thread.teleport ?? null;
  const teleportedOut = isTeleportedOut(teleport);
  const providerName = thread.session?.providerName;
  const supported =
    teleportedOut ||
    (typeof providerName === "string" && isTeleportProvider(providerName)) ||
    isTeleportProvider(thread.modelSelection.instanceId);
  if (!supported) {
    return null;
  }

  const sessionBusy = thread.session?.status === "starting" || thread.session?.status === "running";
  const importNeedsCwd = teleportedOut && (cwd === null || cwd.length === 0);
  const busy = pending || sessionBusy || importNeedsCwd;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            className="shrink-0"
            variant="outline"
            size="icon-xs"
            aria-label={
              teleportedOut
                ? "Import this thread from the native CLI"
                : "Teleport this thread to the native CLI"
            }
            disabled={busy}
            onClick={() => {
              if (pendingRef.current || busy) {
                return;
              }
              pendingRef.current = true;
              setPending(true);
              void (async () => {
                try {
                  if (teleportedOut) {
                    if (teleport === null || cwd === null || cwd.length === 0) {
                      return;
                    }
                    const result = await importSessions({
                      environmentId,
                      input: {
                        projectId: thread.projectId,
                        cwd,
                        sessions: [
                          {
                            provider: teleport.provider,
                            externalSessionId: teleport.externalSessionId,
                          },
                        ],
                      },
                    });
                    if (result._tag === "Success") {
                      toastManager.add({
                        type: "success",
                        title: "Imported from native session",
                        description: teleport.nativePath,
                      });
                      return;
                    }
                    if (isAtomCommandInterrupted(result)) {
                      return;
                    }
                    toastManager.add(
                      stackedThreadToast({
                        type: "error",
                        title: "Could not teleport in",
                        description: teleportFailureMessage(squashAtomCommandFailure(result)),
                      }),
                    );
                    return;
                  }

                  const result = await exportSession({
                    environmentId,
                    input: { threadId },
                  });
                  if (result._tag === "Success") {
                    toastManager.add({
                      type: "success",
                      title: "Teleported to native session",
                      description: result.value.nativePath,
                    });
                    return;
                  }
                  if (isAtomCommandInterrupted(result)) {
                    return;
                  }
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Could not teleport out",
                      description: teleportFailureMessage(squashAtomCommandFailure(result)),
                    }),
                  );
                } finally {
                  pendingRef.current = false;
                  setPending(false);
                }
              })();
            }}
          >
            <LogOutIcon className={teleportedOut ? "-scale-x-100" : ""} />
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {teleportedOut
          ? importNeedsCwd
            ? "Import needs the project workspace path"
            : sessionBusy
              ? "Import is available when this provider thread is idle"
              : "Read this thread back from the native CLI session"
          : sessionBusy
            ? "Teleport out is available when this provider thread is idle"
            : "Write this idle thread to the native CLI session"}
      </TooltipPopup>
    </Tooltip>
  );
}
