import { describe, expect, it } from "vite-plus/test";

import { environmentSupportsTeleport, threadSupportsTeleportExport } from "./teleport";

describe("environmentSupportsTeleport", () => {
  it("is false when the capability is absent, matching older servers", () => {
    expect(environmentSupportsTeleport(undefined)).toBe(false);
    expect(environmentSupportsTeleport({ repositoryIdentity: true })).toBe(false);
  });

  it("is true only when the server advertises teleport", () => {
    expect(
      environmentSupportsTeleport({
        repositoryIdentity: true,
        teleport: true,
      }),
    ).toBe(true);
    expect(
      environmentSupportsTeleport({
        repositoryIdentity: true,
        teleport: false,
      }),
    ).toBe(false);
  });
});

describe("threadSupportsTeleportExport", () => {
  it("accepts custom instances whose driver is a teleport provider", () => {
    expect(
      threadSupportsTeleportExport({
        teleportedOut: false,
        providerName: undefined,
        instanceId: "codex_work",
        providers: [{ instanceId: "codex_work", driver: "codex" }],
      }),
    ).toBe(true);
  });

  it("rejects custom instances whose driver is not a teleport provider", () => {
    expect(
      threadSupportsTeleportExport({
        teleportedOut: false,
        providerName: undefined,
        instanceId: "cursor_work",
        providers: [{ instanceId: "cursor_work", driver: "cursor" }],
      }),
    ).toBe(false);
  });

  it("does not treat Grok or OpenCode as teleport providers", () => {
    expect(
      threadSupportsTeleportExport({
        teleportedOut: false,
        providerName: undefined,
        instanceId: "grok",
        providers: [{ instanceId: "grok", driver: "grok" }],
      }),
    ).toBe(false);
    expect(
      threadSupportsTeleportExport({
        teleportedOut: false,
        providerName: "opencode",
        instanceId: "opencode",
        providers: [{ instanceId: "opencode", driver: "opencode" }],
      }),
    ).toBe(false);
  });

  it("keeps teleported-out threads exportable so they can be imported back", () => {
    expect(
      threadSupportsTeleportExport({
        teleportedOut: true,
        providerName: undefined,
        instanceId: "codex_work",
        providers: [],
      }),
    ).toBe(true);
  });
});
