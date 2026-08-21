import type { TeleportCheckNativeRevisionResult } from "@t3tools/contracts";
import { CircleAlertIcon } from "lucide-react";

import {
  canForkTeleportNativeConflict,
  teleportNativeConflictDescription,
  teleportNativeConflictTitle,
} from "../../lib/teleportNativeConflict";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";

export function teleportNativeConflictBannerItem(input: {
  readonly result: TeleportCheckNativeRevisionResult;
  readonly forking: boolean;
  readonly forkError: string | null;
  readonly onFork: () => void;
}): ComposerBannerStackItem {
  const canFork = canForkTeleportNativeConflict(input.result);
  return {
    id: `teleport-native-conflict:${input.result.threadId}:${input.result.status}:${input.result.observedRevision?.digest ?? "missing"}`,
    variant: "warning",
    urgent: true,
    icon: <CircleAlertIcon />,
    title: teleportNativeConflictTitle(input.result.status),
    description: (
      <span className="flex flex-col gap-1">
        <span>{teleportNativeConflictDescription(input.result)}</span>
        {input.forkError !== null ? <span>{input.forkError}</span> : null}
      </span>
    ),
    actions: canFork ? (
      <Button
        size="xs"
        disabled={input.forking}
        aria-label="Fork native changes"
        aria-busy={input.forking}
        onClick={input.onFork}
      >
        {input.forking ? "Forking..." : "Fork native changes"}
      </Button>
    ) : undefined,
  };
}
