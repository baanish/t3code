import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import type { Project, Thread } from "../../types";
import { readEnvironmentApi } from "../../environmentApi";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { TeleportImportDialog } from "./TeleportImportDialog";
import { TeleportImportButton, TeleportOutButton } from "./TeleportActions";

interface TeleportChatIntegrationInput {
  readonly environmentId: EnvironmentId;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly activeProject: Project | null | undefined;
  readonly activeThread: Thread | null | undefined;
  readonly activeProviderStatus: ServerProvider | null;
  readonly isServerThread: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

function supportsTeleportOut(provider: ServerProvider | null): boolean {
  return (
    provider?.driver === "codex" || provider?.driver === "opencode" || provider?.driver === "cursor"
  );
}

export function useTeleportChatIntegration(input: TeleportChatIntegrationInput) {
  const navigate = useNavigate();
  const [importOpen, setImportOpen] = useState(false);
  const [initialModelSelection, setInitialModelSelection] = useState<ModelSelection | null>(null);
  const [outBusy, setOutBusy] = useState(false);

  const openImportDialog = useCallback(() => {
    setInitialModelSelection(input.activeThread?.modelSelection ?? null);
    setImportOpen(true);
  }, [input.activeThread?.modelSelection]);

  const handleImported = useCallback(
    async (result: { readonly threadId: Thread["id"] }) => {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Session imported",
          description: "Teleport imported the provider session into a T3 thread.",
        }),
      );
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: input.environmentId,
          threadId: result.threadId,
        },
      });
    },
    [input.environmentId, navigate],
  );

  const handleTeleportOut = useCallback(async () => {
    if (!input.activeThread) {
      return;
    }
    const api = readEnvironmentApi(input.activeThread.environmentId);
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Teleport out failed",
        description: "This environment is not connected.",
      });
      return;
    }
    setOutBusy(true);
    try {
      const result = await api.teleport.launchExternalSession({ threadId: input.activeThread.id });
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "CLI launched",
          description: `Teleport opened ${result.provider} in your terminal.`,
        }),
      );
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Teleport out failed",
        description: cause instanceof Error ? cause.message : "Teleport out failed.",
      });
    } finally {
      setOutBusy(false);
    }
  }, [input.activeThread]);

  const outAvailable =
    input.isServerThread &&
    supportsTeleportOut(input.activeProviderStatus) &&
    (input.activeThread?.session?.orchestrationStatus === "ready" ||
      input.activeThread?.session?.orchestrationStatus === "stopped");

  return useMemo(
    () => ({
      dialog: (
        <TeleportImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          environmentId={input.environmentId}
          providerStatuses={input.providerStatuses}
          activeProject={input.activeProject}
          runtimeMode={input.runtimeMode}
          interactionMode={input.interactionMode}
          selectedModelSelection={initialModelSelection ?? input.activeThread?.modelSelection}
          onImported={(result) => void handleImported(result)}
        />
      ),
      emptyStateAction: <TeleportImportButton onClick={openImportDialog} showLabel />,
      headerActions: (
        <>
          <TeleportImportButton onClick={openImportDialog} />
          <TeleportOutButton
            available={outAvailable}
            busy={outBusy}
            onClick={() => void handleTeleportOut()}
          />
        </>
      ),
      openImportDialog,
    }),
    [
      handleImported,
      handleTeleportOut,
      importOpen,
      initialModelSelection,
      input.activeProject,
      input.activeThread?.modelSelection,
      input.environmentId,
      input.interactionMode,
      input.providerStatuses,
      input.runtimeMode,
      openImportDialog,
      outAvailable,
      outBusy,
    ],
  );
}
