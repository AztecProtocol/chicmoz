import { z } from "zod";

/** The run owner hands this to the Vitest process as one JSON env var. */
export const ENDPOINTS_ENV = "NETWORK_SMOKE_ENDPOINTS";

const commonSchema = z.object({
  runId: z.string(),
  logDir: z.string(),
  aztecNodeUrl: z.string().url(),
  explorerApiUrl: z.string().url(),
  /** Log files (without `.log`) of the services that consume Kafka. */
  consumerLogs: z.array(z.string()),
});

export const endpointsSchema = commonSchema.extend({
  anvilUrl: z.string().url(),
  wsUrl: z.string().startsWith("ws://"),
});

export const scriptedEndpointsSchema = commonSchema.extend({
  /** The scripted node's control port (`script-control.ts`). */
  controlUrl: z.string().url(),
});

export type Endpoints = z.infer<typeof endpointsSchema>;
export type ScriptedEndpoints = z.infer<typeof scriptedEndpointsSchema>;

const fromEnv = () =>
  JSON.parse(process.env[ENDPOINTS_ENV] ?? "null") as unknown;

export const readEndpoints = (): Endpoints => endpointsSchema.parse(fromEnv());

export const readScriptedEndpoints = (): ScriptedEndpoints =>
  scriptedEndpointsSchema.parse(fromEnv());
