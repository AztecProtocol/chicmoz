# Chicmoz (AztecScan) — project guide

Open-source block explorer for the Aztec network. This is the Aztec
Foundation's fork; production (aztecscan.xyz) is built and deployed from
[AztecProtocol/foundation-iac](https://github.com/AztecProtocol/foundation-iac)
(`aztecscan.xyz/`), which pins a commit of this repo and builds every service
image from it. Nothing in this repo deploys anything by itself.

Skills in `.claude/skills/`: `kafka-message-design` (new topics/messages),
`aztec-types-guide` (Aztec SDK types, `@chicmoz-pkg/types`),
`react-best-practices` (UI hooks/data fetching), `frontend-design` (UI look
and feel). `services/explorer-ui-v2/CLAUDE.md` has frontend specifics.

## Stack

| Concern       | Technology                                                                    |
| ------------- | ----------------------------------------------------------------------------- |
| Monorepo      | Yarn 4 (Berry), `node-modules` linker, workspaces `services/*` + `packages/*` |
| Language      | TypeScript 5.8 ESM throughout — imports require `.js` extensions              |
| Backend       | Node.js, Express 4, Drizzle ORM (Postgres), Redis                             |
| Validation    | Zod — schema first, types via `z.infer<>`                                     |
| Messaging     | Kafka (KafkaJS via `@chicmoz-pkg/message-bus`), BSON serialization            |
| Chain clients | `@aztec/aztec.js` (L2), `viem` (L1) — both pinned at root via `resolutions`   |
| Frontend      | React 18, Vite, TailwindCSS, TanStack Router/Query/Table, shadcn/ui           |
| Logging       | Winston via `@chicmoz-pkg/logger-server` — no `console.*` in service code     |
| Local dev     | Kubernetes (minikube) + Skaffold, `k8s/local/`                                |

## Commands

```sh
yarn install                 # yarn 4 via corepack; git-lfs is required for checkout
yarn build:packages          # shared packages — required before building any service
yarn build                   # everything (parallel)
yarn build-all-slow          # everything, strict dependency order
yarn lint                    # all workspaces (lint-staged + prettier run on commit)
yarn test                    # vitest across workspaces
# per service: cd services/<name> && yarn build|lint|test|test:watch
```

## Services

| Service                     | Role                                                                                | Own DB                        | Kafka                                             |
| --------------------------- | ----------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------- |
| `aztec-listener`            | Polls Aztec L2 nodes for blocks, pending/dropped txs, sequencer info                | `aztec_listener_{network}`    | publishes 8 L2 events                             |
| `ethereum-listener`         | Watches L1 rollup contracts (block proposed, proof verified, validator changes)     | `ethereum_listener_{network}` | publishes 6 L1 events                             |
| `explorer-api`              | REST API; consumes all events into Postgres; serves UI and external consumers       | `explorer_api_{network}`      | subscribes to all; publishes finalization updates |
| `websocket-event-publisher` | Kafka → WebSocket bridge for live block/tx updates                                  | —                             | subscribes to 3 events                            |
| `compiler-orchestrator`     | Runs contract source-verification compiles via a pluggable backend (k8s, AWS Batch) | —                             | —                                                 |
| `explorer-ui-v2`            | Public React SPA                                                                    | —                             | —                                                 |
| `auth`                      | API-key gateway (rate limiting, key lifecycle). Mainnet only                        | `auth`, `apikey`              | —                                                 |
| `event-cannon`              | Dev/test synthetic transaction firer. Never deployed                                | —                             | —                                                 |

Shared packages (`packages/`, published as `@chicmoz-pkg/*`): `types` (all
domain Zod schemas — single source of truth), `message-registry` (topic names,
payload type maps, `getConsumerGroupId()`), `message-bus`, `microservice-base`
(`startMicroservice()`, `MicroserviceBaseSvc` with `init/shutdown/health`),
`postgres-helper`, `redis-helper`, `backend-utils` (`parseBlock()`),
`logger-server`, `error-middleware`, `auth0-middleware`,
`contract-verification`.

## Data flow

```
Aztec L2 nodes ──aztec.js──► aztec-listener ──► Kafka ──► explorer-api ──► Postgres
Ethereum L1  ──viem──────► ethereum-listener ──► Kafka ─┘        │
                                                  └──► websocket-event-publisher ──► browser
explorer-ui-v2 ──REST──► auth (mainnet) / explorer-api
```

Topics: `{L2NetworkId}__{EventType}` (L2), `{L2NetworkId}_{L1NetworkId}__{EventType}`
(L1). Networks are isolated on one Kafka cluster by prefix. Consumer groups
come from `getConsumerGroupId()`. Payloads are BSON; block bytes travel as hex
and are decoded with `parseBlock()`.

## Rules (already decided — do not deviate)

- ESM everywhere: `import { x } from "./utils.js"` even for `.ts` sources.
- Backend and packages: named exports only (`import/no-default-export`),
  named imports only. `explorer-ui-v2` is the exception — extension-less
  relative imports and default exports are allowed there; do not churn files
  to change that.
- `type` over `interface`; `import { type X }` for type-only imports; strict
  TS — no `any`, no unchecked nulls; camelCase / PascalCase; curly braces
  always; no parameter reassignment.
- Zod schema first, then `z.infer<>`. Shared types live in `@chicmoz-pkg/types`,
  never redefined per service. API responses in the UI pass through
  `validateResponse()` before React Query.
- Kafka: BSON only (never `JSON.stringify` a payload); call the heartbeat
  before long DB work inside a handler; new topics go in
  `@chicmoz-pkg/message-registry`; producers/consumers use `message-bus`.
  Handler errors propagate (they are rethrown, so the consumer restarts
  rather than silently committing); undeserializable messages are skipped.
- Database: Drizzle only, no raw SQL outside a Drizzle `sql` template;
  schema in `svcs/database/schema/`; every schema change ships a migration
  (`yarn migrate` runs before the service starts). `TOTAL_DB_RESET` is
  destructive — warn before suggesting it.
- Logging through `@chicmoz-pkg/logger-server` only.
- Errors through `@chicmoz-pkg/error-middleware`; never swallow silently.
- Sanitize IP addresses in RPC-node error events before publishing.
- Never commit `.chicmoz.env`; `.chicmoz-example.env` is the template.
- Source verification runs untrusted compiles in isolated jobs
  (`compiler-orchestrator`); payloads can be several MB — keep size guards.

## Review checklist

Correctness (async/await, unhandled rejections, races) → security
(unsanitized input to DB/shell, secrets, permissive CORS/auth bypass, payload
size) → the rules above → performance (N+1 queries, missing pagination,
unbounded work over blocks/txs) → maintainability → tests for new logic
paths. Cite file and line; explain why.

## Where things live

| What                                         | Where                                                             |
| -------------------------------------------- | ----------------------------------------------------------------- |
| Domain schemas / types                       | `packages/types/src/`                                             |
| Kafka topics + payload types                 | `packages/message-registry/src/{aztec,ethereum}.ts`               |
| API routes + validators                      | `services/explorer-api/src/svcs/http-server/routes/`              |
| OpenAPI spec                                 | `services/explorer-api/src/svcs/http-server/open-api-spec.ts`     |
| Explorer API DB schema                       | `services/explorer-api/src/svcs/database/schema/`                 |
| L2 polling / publishers                      | `services/aztec-listener/src/svcs/poller/`, `src/events/emitted/` |
| L1 watchers                                  | `services/ethereum-listener/src/svcs/events-watcher/`             |
| Compile job backends                         | `services/compiler-orchestrator/src/svcs/job-manager/backends/`   |
| Frontend API layer / hooks / routes / pages  | `services/explorer-ui-v2/src/{api,hooks,routes,pages}/`           |
| Local k8s + Skaffold entry points            | `k8s/local/skaffold.*.yaml`                                       |
| Legacy production manifests (reference only) | `k8s/production/`, `scripts/production/`                          |
| Env template                                 | `.chicmoz-example.env`                                            |
