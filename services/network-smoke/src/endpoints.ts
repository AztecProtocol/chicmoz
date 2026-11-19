import { z } from "zod";

/** The run owner hands this to the Vitest process as one JSON env var. */
export const ENDPOINTS_ENV = "NETWORK_SMOKE_ENDPOINTS";

export const endpointsSchema = z.object({
  runId: z.string(),
  logDir: z.string(),
  anvilUrl: z.string().url(),
  aztecNodeUrl: z.string().url(),
  explorerApiUrl: z.string().url(),
  wsUrl: z.string().startsWith("ws://"),
  /** Log files (without `.log`) of the services that consume Kafka. */
  consumerLogs: z.array(z.string()),
});

export type Endpoints = z.infer<typeof endpointsSchema>;

export const readEndpoints = (): Endpoints =>
  endpointsSchema.parse(JSON.parse(process.env[ENDPOINTS_ENV] ?? "null"));
