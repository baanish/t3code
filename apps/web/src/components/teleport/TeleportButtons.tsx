import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { LogInIcon, LogOutIcon } from "lucide-react";
import { useRef, useState } from "react";

import { teleportEnvironment } from "../../state/teleport";
import { useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function TeleportButtons(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isServerThread: boolean;
}) {
  const threadState = useEnvironmentThread(props.environmentId, props.threadId);
  const exportSession = useAtomCommand(teleportEnvironment.exportSession);
  const importSession = useAtomCommand(teleportEnvironment.importSession);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const thread = Option.getOrUndefined(threadState.data);
  if (!props.isServerThread || thread === undefined) return null;
  if (thread.session?.providerName !== "grok" && thread.modelSelection.instanceId !== "grok") {
    return null;
  }
  const busy =
    pending || thread.session?.status === "starting" || thread.session?.status === "running";
  const run = async (action: "out" | "in", command: typeof exportSession) => {
    if (pendingRef.current || busy) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const result = await command({
        environmentId: props.environmentId,
        input: { threadId: props.threadId },
      });
      if (result._tag !== "Success") return;
      toastManager.add({
        type: "success",
        title:
          action === "out" ? "Teleported to native session" : "Updated thread from native session",
        description: result.value.nativePath,
      });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return (
    <>
      <Button
        type="button"
        className="shrink-0"
        variant="outline"
        size="xs"
        aria-label="Teleport this thread to the native CLI"
        disabled={busy}
        onClick={() => void run("out", exportSession)}
      >
        <LogOutIcon className="size-3" />
      </Button>
      <Button
        type="button"
        className="shrink-0"
        variant="outline"
        size="xs"
        aria-label="Teleport this thread back from the native CLI"
        disabled={busy}
        onClick={() => void run("in", importSession)}
      >
        <LogInIcon className="size-3" />
      </Button>
    </>
  );
}
