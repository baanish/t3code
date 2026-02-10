import { describe, expect, it } from "vitest";

import {
  WS_CLOSE_CODES,
  WS_CLOSE_REASONS,
  WS_ERROR_CODE_MAX_CHARS,
  WS_ERROR_MESSAGE_MAX_CHARS,
  WS_EVENT_CHANNELS,
  WS_METHOD_MAX_CHARS,
  WS_REQUEST_ID_MAX_CHARS,
  wsClientMessageSchema,
  wsServerMessageSchema,
} from "./ws";

describe("wsClientMessageSchema", () => {
  it("accepts request messages", () => {
    const parsed = wsClientMessageSchema.parse({
      type: "request",
      id: "req-1",
      method: "providers.startSession",
      params: { provider: "codex" },
    });

    expect(parsed.method).toBe("providers.startSession");
  });

  it("rejects empty request ids", () => {
    expect(() =>
      wsClientMessageSchema.parse({
        type: "request",
        id: "",
        method: "providers.startSession",
      }),
    ).toThrow();
  });

  it("rejects empty request methods", () => {
    expect(() =>
      wsClientMessageSchema.parse({
        type: "request",
        id: "req-1",
        method: "",
      }),
    ).toThrow();
  });

  it("rejects overly long request ids", () => {
    expect(() =>
      wsClientMessageSchema.parse({
        type: "request",
        id: "r".repeat(WS_REQUEST_ID_MAX_CHARS + 1),
        method: "providers.startSession",
      }),
    ).toThrow();
  });

  it("accepts request ids at max length", () => {
    const parsed = wsClientMessageSchema.parse({
      type: "request",
      id: "r".repeat(WS_REQUEST_ID_MAX_CHARS),
      method: "providers.startSession",
    });

    expect(parsed.id).toHaveLength(WS_REQUEST_ID_MAX_CHARS);
  });

  it("rejects overly long request methods", () => {
    expect(() =>
      wsClientMessageSchema.parse({
        type: "request",
        id: "req-1",
        method: "m".repeat(WS_METHOD_MAX_CHARS + 1),
      }),
    ).toThrow();
  });

  it("accepts request methods at max length", () => {
    const parsed = wsClientMessageSchema.parse({
      type: "request",
      id: "req-1",
      method: "m".repeat(WS_METHOD_MAX_CHARS),
    });

    expect(parsed.method).toHaveLength(WS_METHOD_MAX_CHARS);
  });

  it("rejects unexpected request properties", () => {
    expect(() =>
      wsClientMessageSchema.parse({
        type: "request",
        id: "req-1",
        method: "providers.listSessions",
        unexpected: true,
      }),
    ).toThrow();
  });
});

describe("wsServerMessageSchema", () => {
  it("accepts successful response messages", () => {
    const parsed = wsServerMessageSchema.parse({
      type: "response",
      id: "req-1",
      ok: true,
      result: { sessionId: "sess-1" },
    });

    expect(parsed.type).toBe("response");
  });

  it("requires errors for failed responses", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "req-1",
        ok: false,
      }),
    ).toThrow();
  });

  it("accepts response errors at max field lengths", () => {
    const parsed = wsServerMessageSchema.parse({
      type: "response",
      id: "req-1",
      ok: false,
      error: {
        code: "c".repeat(WS_ERROR_CODE_MAX_CHARS),
        message: "m".repeat(WS_ERROR_MESSAGE_MAX_CHARS),
      },
    });

    expect(parsed.type).toBe("response");
  });

  it("rejects overlong response error fields", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "req-1",
        ok: false,
        error: {
          code: "c".repeat(WS_ERROR_CODE_MAX_CHARS + 1),
          message: "valid",
        },
      }),
    ).toThrow();

    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "req-1",
        ok: false,
        error: {
          code: "request_failed",
          message: "m".repeat(WS_ERROR_MESSAGE_MAX_CHARS + 1),
        },
      }),
    ).toThrow();
  });

  it("requires result for successful responses", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "req-1",
        ok: true,
      }),
    ).toThrow();
  });

  it("rejects errors for successful responses", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "req-1",
        ok: true,
        result: { status: "ok" },
        error: {
          code: "unexpected",
          message: "should-not-be-present",
        },
      }),
    ).toThrow();
  });

  it("rejects result payloads for failed responses", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "req-1",
        ok: false,
        result: { status: "unexpected" },
        error: {
          code: "request_failed",
          message: "expected-failure",
        },
      }),
    ).toThrow();
  });

  it("rejects unexpected response properties", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "req-1",
        ok: true,
        result: { status: "ok" },
        unexpected: true,
      }),
    ).toThrow();
  });

  it("rejects overly long response ids", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "r".repeat(WS_REQUEST_ID_MAX_CHARS + 1),
        ok: true,
        result: {},
      }),
    ).toThrow();
  });

  it("accepts response ids at max length", () => {
    const parsed = wsServerMessageSchema.parse({
      type: "response",
      id: "r".repeat(WS_REQUEST_ID_MAX_CHARS),
      ok: true,
      result: {},
    });

    expect(parsed.type).toBe("response");
  });

  it("accepts typed event channels", () => {
    const parsed = wsServerMessageSchema.parse({
      type: "event",
      channel: WS_EVENT_CHANNELS.providerEvent,
      payload: {
        id: "evt-1",
        kind: "notification",
        provider: "codex",
        sessionId: "sess-1",
        createdAt: "2026-02-01T00:00:00.000Z",
        method: "turn/started",
      },
    });

    expect(parsed.type).toBe("event");
  });

  it("accepts typed agent output and exit events", () => {
    const output = wsServerMessageSchema.parse({
      type: "event",
      channel: WS_EVENT_CHANNELS.agentOutput,
      payload: {
        sessionId: "agent-1",
        stream: "stdout",
        data: "hello",
      },
    });
    const exit = wsServerMessageSchema.parse({
      type: "event",
      channel: WS_EVENT_CHANNELS.agentExit,
      payload: {
        sessionId: "agent-1",
        code: 0,
        signal: null,
      },
    });

    expect(output.type).toBe("event");
    expect(exit.type).toBe("event");
  });

  it("rejects unknown event channels", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "event",
        channel: "provider:unknown",
        payload: {
          id: "evt-1",
          kind: "notification",
          provider: "codex",
          sessionId: "sess-1",
          createdAt: "2026-02-01T00:00:00.000Z",
          method: "turn/started",
        },
      }),
    ).toThrow();
  });

  it("rejects malformed payloads for typed channels", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "event",
        channel: WS_EVENT_CHANNELS.providerEvent,
        payload: {
          sessionId: "sess-1",
        },
      }),
    ).toThrow();

    expect(() =>
      wsServerMessageSchema.parse({
        type: "event",
        channel: WS_EVENT_CHANNELS.agentOutput,
        payload: {
          sessionId: "agent-1",
          stream: "invalid-stream",
          data: "oops",
        },
      }),
    ).toThrow();

    expect(() =>
      wsServerMessageSchema.parse({
        type: "event",
        channel: WS_EVENT_CHANNELS.agentExit,
        payload: {
          sessionId: "agent-1",
          code: "0",
          signal: null,
        },
      }),
    ).toThrow();
  });

  it("rejects unexpected event properties", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "event",
        channel: WS_EVENT_CHANNELS.providerEvent,
        payload: {
          id: "evt-1",
          kind: "notification",
          provider: "codex",
          sessionId: "sess-1",
          createdAt: "2026-02-01T00:00:00.000Z",
          method: "turn/started",
        },
        unexpected: true,
      }),
    ).toThrow();
  });

  it("rejects unexpected response error properties", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "response",
        id: "req-1",
        ok: false,
        error: {
          code: "request_failed",
          message: "boom",
          unexpected: true,
        },
      }),
    ).toThrow();
  });

  it("accepts hello server messages", () => {
    const parsed = wsServerMessageSchema.parse({
      type: "hello",
      version: 1,
      launchCwd: "/workspace",
    });

    expect(parsed.type).toBe("hello");
  });

  it("rejects hello messages with unsupported versions", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "hello",
        version: 2,
        launchCwd: "/workspace",
      }),
    ).toThrow();
  });

  it("rejects unexpected hello properties", () => {
    expect(() =>
      wsServerMessageSchema.parse({
        type: "hello",
        version: 1,
        launchCwd: "/workspace",
        unexpected: true,
      }),
    ).toThrow();
  });
});

describe("ws close metadata", () => {
  it("exposes stable unauthorized close semantics", () => {
    expect(WS_CLOSE_CODES.unauthorized).toBe(4001);
    expect(WS_CLOSE_REASONS.unauthorized).toBe("unauthorized");
  });

  it("exposes stable replacement close semantics", () => {
    expect(WS_CLOSE_CODES.replacedByNewClient).toBe(4000);
    expect(WS_CLOSE_REASONS.replacedByNewClient).toBe("replaced-by-new-client");
  });

  it("keeps close codes and reasons unique", () => {
    expect(
      new Set([WS_CLOSE_CODES.unauthorized, WS_CLOSE_CODES.replacedByNewClient]).size,
    ).toBe(2);
    expect(
      new Set([WS_CLOSE_REASONS.unauthorized, WS_CLOSE_REASONS.replacedByNewClient]).size,
    ).toBe(2);
  });
});
