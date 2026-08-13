import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type TeleportImportSessionResult,
  type TeleportSessionCandidate,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { ImportIcon, RefreshCwIcon } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import type { Project } from "../../types";
import { readEnvironmentApi } from "../../environmentApi";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import {
  buildTeleportCandidateModelSelection,
  buildTeleportModelSelection,
  filterTeleportProviderEntries,
  formatTeleportSessionSubtitle,
  prioritizeTeleportSessions,
  providerSessionIdLabel,
} from "./teleportForm";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

interface TeleportImportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly activeProject: Project | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly selectedModelSelection: ModelSelection | null | undefined;
  readonly onImported: (result: TeleportImportSessionResult) => void;
}

const runtimeModeOptions: Array<{ value: RuntimeMode; label: string }> = [
  { value: "approval-required", label: "Supervised" },
  { value: "auto-accept-edits", label: "Auto-accept edits" },
  { value: "full-access", label: "Full access" },
];

function modelPlaceholder(provider: ProviderInstanceEntry | undefined): string {
  const firstModel = provider?.models[0]?.slug;
  return firstModel ? `Default (${firstModel})` : "Use provider default";
}

export function TeleportImportDialog(props: TeleportImportDialogProps) {
  const providers = useMemo(
    () => filterTeleportProviderEntries(deriveProviderInstanceEntries(props.providerStatuses)),
    [props.providerStatuses],
  );
  const [providerInstanceId, setProviderInstanceId] = useState<string>("");
  const [externalSessionId, setExternalSessionId] = useState("");
  const [cwd, setCwd] = useState("");
  const [title, setTitle] = useState("");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(props.runtimeMode);
  const [model, setModel] = useState("");
  const [startSession, setStartSession] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sessions, setSessions] = useState<ReadonlyArray<TeleportSessionCandidate>>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [importingSessionId, setImportingSessionId] = useState<string | null>(null);

  const selectedProvider = providers.find((provider) => provider.instanceId === providerInstanceId);
  const prioritizedSessions = useMemo(
    () => prioritizeTeleportSessions(sessions, providerInstanceId),
    [providerInstanceId, sessions],
  );

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const initialProvider =
      providers.find((entry) => entry.instanceId === props.selectedModelSelection?.instanceId) ??
      providers[0];
    setProviderInstanceId(initialProvider?.instanceId ?? "");
    setExternalSessionId("");
    setCwd(props.activeProject?.cwd ?? "");
    setTitle("");
    setRuntimeMode(props.runtimeMode);
    setModel(
      initialProvider?.instanceId === props.selectedModelSelection?.instanceId
        ? (props.selectedModelSelection?.model ?? "")
        : "",
    );
    setStartSession(true);
    setIsSubmitting(false);
    setImportingSessionId(null);
  }, [
    props.activeProject?.cwd,
    props.open,
    props.runtimeMode,
    props.selectedModelSelection?.instanceId,
    props.selectedModelSelection?.model,
    providers,
  ]);

  const canSubmit =
    Boolean(selectedProvider) &&
    externalSessionId.trim().length > 0 &&
    cwd.trim().length > 0 &&
    !isSubmitting;

  const loadSessions = async () => {
    const api = readEnvironmentApi(props.environmentId);
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Teleport scan failed",
        description: "This environment is not connected.",
      });
      return;
    }
    setIsLoadingSessions(true);
    setSessionError(null);
    try {
      const result = await api.teleport.listSessions({
        providers: [
          ProviderDriverKind.make("codex"),
          ProviderDriverKind.make("opencode"),
          ProviderDriverKind.make("cursor"),
        ],
      });
      setSessions(result.sessions);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Scan failed.";
      setSessionError(message);
      toastManager.add({
        type: "error",
        title: "Teleport scan failed",
        description: message,
      });
    } finally {
      setIsLoadingSessions(false);
    }
  };

  useEffect(() => {
    if (!props.open) {
      return;
    }
    void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.environmentId]);

  const importWithProvider = async (input: {
    readonly provider: ProviderInstanceEntry;
    readonly externalSessionId: string;
    readonly cwd: string;
    readonly title?: string | undefined;
    readonly modelSelection?: ModelSelection | undefined;
  }) => {
    const api = readEnvironmentApi(props.environmentId);
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Teleport import failed",
        description: "This environment is not connected.",
      });
      return;
    }
    setIsSubmitting(true);
    try {
      const trimmedCwd = input.cwd.trim();
      const trimmedTitle = input.title?.trim();
      const activeProjectMatchesCwd = props.activeProject?.cwd === trimmedCwd;
      const result = await api.teleport.importSession({
        providerInstanceId: input.provider.instanceId,
        provider: input.provider.driverKind,
        externalSessionId: input.externalSessionId.trim(),
        cwd: trimmedCwd,
        ...(activeProjectMatchesCwd && props.activeProject?.id
          ? { projectId: props.activeProject.id }
          : {}),
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        runtimeMode,
        interactionMode: props.interactionMode,
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        startSession,
      });
      props.onOpenChange(false);
      props.onImported(result);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Import failed.";
      toastManager.add({
        type: "error",
        title: "Teleport import failed",
        description: message,
      });
    } finally {
      setIsSubmitting(false);
      setImportingSessionId(null);
    }
  };

  const handleCandidateImport = async (session: TeleportSessionCandidate) => {
    const provider =
      providers.find(
        (entry) =>
          entry.instanceId === session.providerInstanceId && entry.driverKind === session.provider,
      ) ?? providers.find((entry) => entry.driverKind === session.provider);
    if (!provider) {
      toastManager.add({
        type: "error",
        title: "Teleport import failed",
        description: `No enabled ${session.provider} provider instance is configured.`,
      });
      return;
    }
    setImportingSessionId(session.externalSessionId);
    await importWithProvider({
      provider,
      externalSessionId: session.externalSessionId,
      cwd: session.cwd,
      title: session.title,
      modelSelection: buildTeleportCandidateModelSelection({
        provider,
        candidateModelSelection: session.modelSelection,
        model,
        fallback: props.selectedModelSelection,
      }),
    });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProvider || !canSubmit) {
      return;
    }
    const modelSelection = buildTeleportModelSelection({
      provider: selectedProvider,
      model,
      fallback: props.selectedModelSelection,
    });
    await importWithProvider({
      provider: selectedProvider,
      externalSessionId,
      cwd,
      title,
      ...(modelSelection ? { modelSelection } : {}),
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Teleport Import</DialogTitle>
          <DialogDescription>
            Import an idle external Codex, OpenCode, or Cursor session into T3 Code.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogPanel className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Available sessions</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void loadSessions()}
                  disabled={isLoadingSessions || isSubmitting}
                >
                  {isLoadingSessions ? (
                    <Spinner className="size-3" />
                  ) : (
                    <RefreshCwIcon className="size-3" />
                  )}
                  Scan
                </Button>
              </div>
              <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                {isLoadingSessions ? (
                  <div className="flex items-center gap-2 px-3 py-3 text-muted-foreground text-sm">
                    <Spinner className="size-4" />
                    Scanning provider sessions...
                  </div>
                ) : prioritizedSessions.length > 0 ? (
                  <div className="divide-y divide-border">
                    {prioritizedSessions.map((session) => {
                      const provider =
                        providers.find(
                          (entry) =>
                            entry.instanceId === session.providerInstanceId &&
                            entry.driverKind === session.provider,
                        ) ?? providers.find((entry) => entry.driverKind === session.provider);
                      const importing = importingSessionId === session.externalSessionId;
                      return (
                        <button
                          key={`${session.provider}:${session.externalSessionId}`}
                          type="button"
                          className="grid w-full grid-cols-[1fr_auto] gap-3 px-3 py-2 text-left hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => void handleCandidateImport(session)}
                          disabled={!provider || isSubmitting}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {session.title ?? session.externalSessionId}
                            </span>
                            <span className="block truncate text-muted-foreground text-xs">
                              {formatTeleportSessionSubtitle({
                                providerLabel: provider?.displayName ?? session.provider,
                                session,
                              })}
                            </span>
                          </span>
                          <span className="flex items-center gap-2 self-center text-xs text-muted-foreground">
                            {importing ? (
                              <Spinner className="size-3" />
                            ) : (
                              <ImportIcon className="size-3" />
                            )}
                            Teleport
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-3 py-3 text-muted-foreground text-sm">
                    {sessionError ?? "No local provider sessions found."}
                  </div>
                )}
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>Provider instance</Label>
              <Select
                value={providerInstanceId}
                onValueChange={(value) => {
                  const nextValue = value ?? "";
                  setProviderInstanceId(nextValue);
                  const nextProvider = providers.find((entry) => entry.instanceId === nextValue);
                  setModel(
                    nextProvider?.instanceId === props.selectedModelSelection?.instanceId
                      ? (props.selectedModelSelection?.model ?? "")
                      : "",
                  );
                }}
                disabled={providers.length === 0 || isSubmitting}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose provider" />
                </SelectTrigger>
                <SelectPopup>
                  {providers.map((provider) => (
                    <SelectItem key={provider.instanceId} value={provider.instanceId}>
                      {provider.displayName}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label>
                {providerSessionIdLabel(
                  selectedProvider?.driverKind ?? ProviderDriverKind.make("codex"),
                )}
              </Label>
              <Input
                value={externalSessionId}
                onChange={(event) => setExternalSessionId(event.currentTarget.value)}
                placeholder="Paste the external provider id"
                disabled={isSubmitting}
                nativeInput
              />
            </div>

            <div className="grid gap-1.5">
              <Label>Project path</Label>
              <Input
                value={cwd}
                onChange={(event) => setCwd(event.currentTarget.value)}
                placeholder="/path/to/project"
                disabled={isSubmitting}
                nativeInput
              />
            </div>

            <div className="grid gap-1.5">
              <Label>Title</Label>
              <Input
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder="Optional"
                disabled={isSubmitting}
                nativeInput
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Runtime mode</Label>
                <Select
                  value={runtimeMode}
                  onValueChange={(value) => setRuntimeMode(value as RuntimeMode)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {runtimeModeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>

              <div className="grid gap-1.5">
                <Label>Model</Label>
                <Input
                  value={model}
                  onChange={(event) => setModel(event.currentTarget.value)}
                  placeholder={modelPlaceholder(selectedProvider)}
                  disabled={isSubmitting}
                  nativeInput
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={startSession}
                onCheckedChange={(checked) => setStartSession(checked === true)}
                disabled={isSubmitting}
              />
              <span>Start session after import</span>
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? <Spinner className="size-4" /> : <ImportIcon />}
              Import
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
