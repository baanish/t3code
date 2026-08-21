import { ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerBannerStack } from "../chat/ComposerBannerStack";
import { teleportNativeConflictBannerItem } from "./TeleportNativeConflictBanner";

describe("TeleportNativeConflictBanner", () => {
  it("renders an accessible fork action for a diverged native file", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          teleportNativeConflictBannerItem({
            result: {
              schemaVersion: 1,
              threadId: ThreadId.make("thread-1"),
              status: "diverged",
              nativePath: "/tmp/session.jsonl",
              observedRevision: { algorithm: "sha256", digest: "def", byteLength: 16 },
            },
            forking: false,
            forkError: null,
            onFork: () => {},
          }),
        ]}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Native CLI session changed");
    expect(markup).toContain('aria-label="Fork native changes"');
    expect(markup).toContain("Fork native changes");
  });

  it("hides the fork action when the native file is missing", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          teleportNativeConflictBannerItem({
            result: {
              schemaVersion: 1,
              threadId: ThreadId.make("thread-1"),
              status: "missing",
              nativePath: "/tmp/session.jsonl",
            },
            forking: false,
            forkError: null,
            onFork: () => {},
          }),
        ]}
      />,
    );
    expect(markup).toContain("Native session file is missing");
    expect(markup).not.toContain("Fork native changes");
  });

  it("hides the fork action when the native file is oversize or has no observed digest", () => {
    const oversize = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          teleportNativeConflictBannerItem({
            result: {
              schemaVersion: 1,
              threadId: ThreadId.make("thread-1"),
              status: "oversize",
              nativePath: "/tmp/session.jsonl",
            },
            forking: false,
            forkError: null,
            onFork: () => {},
          }),
        ]}
      />,
    );
    expect(oversize).toContain("Native session file is too large");
    expect(oversize).not.toContain("Fork native changes");

    const divergedWithoutDigest = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          teleportNativeConflictBannerItem({
            result: {
              schemaVersion: 1,
              threadId: ThreadId.make("thread-1"),
              status: "diverged",
              nativePath: "/tmp/session.jsonl",
            },
            forking: false,
            forkError: null,
            onFork: () => {},
          }),
        ]}
      />,
    );
    expect(divergedWithoutDigest).toContain("Native CLI session changed");
    expect(divergedWithoutDigest).not.toContain("Fork native changes");
  });

  it("exposes a busy state while the fork is running", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          teleportNativeConflictBannerItem({
            result: {
              schemaVersion: 1,
              threadId: ThreadId.make("thread-1"),
              status: "diverged",
              observedRevision: { algorithm: "sha256", digest: "def", byteLength: 16 },
            },
            forking: true,
            forkError: "Could not fork",
            onFork: () => {},
          }),
        ]}
      />,
    );
    expect(markup).toContain("Forking...");
    expect(markup).toContain("aria-busy");
    expect(markup).toContain("Could not fork");
  });
});
