import { z } from "zod";
import { agentExitSchema, outputChunkSchema } from "./agent";
import { providerEventSchema } from "./provider";

export const WS_EVENT_CHANNELS = {
  providerEvent: "provider:event",
  agentOutput: "agent:output",
  agentExit: "agent:exit",
} as const;

export const WS_CLOSE_CODES = {
  replacedByNewClient: 4000,
  unauthorized: 4001,
} as const;

export const WS_CLOSE_REASONS = {
  replacedByNewClient: "replaced-by-new-client",
  unauthorized: "unauthorized",
} as const;

export const WS_REQUEST_ID_MAX_CHARS = 256;
export const WS_METHOD_MAX_CHARS = 256;
export const WS_ERROR_CODE_MAX_CHARS = 128;
export const WS_ERROR_MESSAGE_MAX_CHARS = 8_192;

const wsRequestSchema = z.object({
  type: z.literal("request"),
  id: z.string().min(1).max(WS_REQUEST_ID_MAX_CHARS),
  method: z.string().min(1).max(WS_METHOD_MAX_CHARS),
  params: z.unknown().optional(),
}).strict();

const wsResponseErrorSchema = z.object({
  code: z.string().min(1).max(WS_ERROR_CODE_MAX_CHARS),
  message: z.string().min(1).max(WS_ERROR_MESSAGE_MAX_CHARS),
}).strict();

const wsResponseSchema = z
  .object({
    type: z.literal("response"),
    id: z.string().min(1).max(WS_REQUEST_ID_MAX_CHARS),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: wsResponseErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.ok && value.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "response.error must be undefined when ok=true",
      });
    }

    if (value.ok && value.result === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "response.result is required when ok=true",
      });
    }

    if (!value.ok && !value.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "response.error is required when ok=false",
      });
    }

    if (!value.ok && value.result !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "response.result must be undefined when ok=false",
      });
    }
  });

const wsEventSchema = z.union([
  z.object({
    type: z.literal("event"),
    channel: z.literal(WS_EVENT_CHANNELS.providerEvent),
    payload: providerEventSchema,
  }).strict(),
  z.object({
    type: z.literal("event"),
    channel: z.literal(WS_EVENT_CHANNELS.agentOutput),
    payload: outputChunkSchema,
  }).strict(),
  z.object({
    type: z.literal("event"),
    channel: z.literal(WS_EVENT_CHANNELS.agentExit),
    payload: agentExitSchema,
  }).strict(),
]);

const wsHelloSchema = z.object({
  type: z.literal("hello"),
  version: z.literal(1),
  launchCwd: z.string().min(1),
}).strict();

export const wsClientMessageSchema = wsRequestSchema;
export const wsServerMessageSchema = z.union([wsResponseSchema, wsEventSchema, wsHelloSchema]);

export type WsEventChannel = z.infer<typeof wsEventSchema>["channel"];
export type WsRequestMessage = z.infer<typeof wsRequestSchema>;
export type WsResponseMessage = z.infer<typeof wsResponseSchema>;
export type WsEventMessage = z.infer<typeof wsEventSchema>;
export type WsHelloMessage = z.infer<typeof wsHelloSchema>;
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;
