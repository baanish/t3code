import { ImportIcon, LogOutIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface TeleportImportButtonProps {
  readonly onClick: () => void;
  readonly showLabel?: boolean;
}

export function TeleportImportButton({ onClick, showLabel = false }: TeleportImportButtonProps) {
  const button = (
    <Button
      type="button"
      className="shrink-0"
      variant="outline"
      size="xs"
      aria-label="Teleport in a provider session"
      onClick={onClick}
    >
      <ImportIcon className="size-3" />
      {showLabel ? "Teleport" : null}
    </Button>
  );

  if (showLabel) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="bottom">Teleport in a provider session</TooltipPopup>
    </Tooltip>
  );
}

interface TeleportOutButtonProps {
  readonly available: boolean;
  readonly busy: boolean;
  readonly onClick: () => void;
}

export function TeleportOutButton({ available, busy, onClick }: TeleportOutButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            className="shrink-0"
            variant="outline"
            size="xs"
            aria-label="Teleport this thread to the CLI"
            onClick={onClick}
            disabled={!available || busy}
          >
            <LogOutIcon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {available
          ? "Teleport this idle thread to the CLI"
          : "Teleport out is available when this provider thread is idle"}
      </TooltipPopup>
    </Tooltip>
  );
}
