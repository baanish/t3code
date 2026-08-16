import { describe, expect, it } from "vite-plus/test";

import { environmentSupportsTeleport } from "./teleport";

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
