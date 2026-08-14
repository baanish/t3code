import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isTeleportProvider, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { LogOutIcon } from "lucide-react";
import { useRef, useState } from "react";

import { teleportFailureMessage } from "../../lib/teleport";
import { teleportEnvironment } from "../../state/teleport";
import { useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface TeleportOutButtonProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isServerThread: boolean;
}

export function TeleportOutButton({
  environmentId,
  threadId,
  isServerThread,
}: TeleportOutButtonProps) {
  const threadState = useEnvironmentThread(environmentId, threadId);
  const exportSession = useAtomCommand(teleportEnvironment.exportSession, {
    reportFailure: false,
  });
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const thread = Option.getOrUndefined(threadState.data);
  if (!isServerThread || thread === undefined) {
    return null;
  }

  const providerName = thread.session?.providerName;
  const supported =
    (typeof providerName === "string" && isTeleportProvider(providerName)) ||
    isTeleportProvider(thread.modelSelection.instanceId);
  if (!supported) {
    return null;
  }

  const busy =
    pending || thread.session?.status === "starting" || thread.session?.status === "running";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            className="shrink-0"
            variant="outline"
            size="xs"
            aria-label="Teleport this thread to the native CLI"
            disabled={busy}
            onClick={() => {
              if (pendingRef.current || busy) {
                return;
              }
              pendingRef.current = true;
              setPending(true);
              void (async () => {
                try {
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
            <LogOutIcon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {busy
          ? "Teleport out is available when this provider thread is idle"
          : "Write this idle thread to the native CLI session"}
      </TooltipPopup>
    </Tooltip>
  );
}
