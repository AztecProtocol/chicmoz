# @chicmoz/test-harness

Test infrastructure for the backend: Docker-free checks that run in `yarn test`, and a compose stack (Postgres 15, Kafka 4 with SASL, Redis 7) for integration tests. Private and dev-only. The `@chicmoz/` name keeps it out of `build:packages`, so no image build compiles or installs it; its source is still copied into images with the rest of `packages/`, inert.

## Commands

| Command                   | Needs                | What it runs                                                                                                                |
| ------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `yarn test`               | nothing              | migration journal order, applied-migration immutability, aggregate status jobs (with every other unit test)                 |
| `yarn test:integration`   | Docker, `yarn build` | migrations against real Postgres (this package), then explorer-api handler and route tests, then aztec-listener store tests |
| `yarn harness ls`         | Docker               | harness compose projects on this host: run id, container states, created, worktree                                          |
| `yarn harness down <run>` | Docker               | removes one harness project and its volumes; refuses anything without the harness label                                     |

Each integration run is its own compose project (`ih<random>`). Every port is assigned by Docker on `127.0.0.1`, so parallel runs on one host do not collide, and a run removes only its own project. Set `HARNESS_KEEP=1` to keep the stack after the run; it prints the `yarn harness down` command.

## In CI

`.github/workflows/integration-tests.yml` runs each suite as its own job and reports `integration-tests-status`. On pull requests a path filter skips them when nothing they build, install, migrate or run has changed; the status check still reports, expecting `skipped`. The migrations job checks out full history and sets `MIGRATIONS_BASE_REF` (the PR base, the previous `main` commit on push, else the merge base with `origin/main`, or `HEAD^1` when that is `HEAD` itself), so the applied-migration and upgrade-path tests always run there. A failing job uploads `.harness/` as an artifact for 7 days.

## Reading a failure

- Start-up: `harness run <id> did not start: ...; logs in .harness/<id>/compose.log`.
- Migrations: the service, the SQL file and the Postgres error, for example `explorer-api: 0038_x.sql failed: column "y" does not exist`. The deploy entrypoint's output is in `.harness/<id>/migrate-<service>-<db>.log`.
- Journal order: `explorer-api: 0038_x has when ..., not above ... (0037_y); Drizzle skips it on any database that already ran 0037_y`. Drizzle applies an entry only when its `when` exceeds the newest applied one.
- Applied migrations: `... changed since <base>; an applied migration must stay byte-identical`. The base is `MIGRATIONS_BASE_REF`, else the merge base with `origin/main`; a shallow clone has neither and reports the check as skipped. The upgrade-path test uses the same base.
- Route tests: Vitest names the file and test. Compose logs for every run are in `.harness/<id>/compose.log` (`.harness/` is gitignored; delete it at will).

## Writing an explorer-api integration test

Files go in `services/explorer-api/tests/integration/` and end in `.integration.test.ts`. Each file gets its own database (cloned from a template migrated once per run), its own `KAFKA_NAMESPACE` (topics, consumer groups and Redis keys) and its own process. Import explorer-api modules dynamically, after `startExplorerApiForTest()`: they read their environment at import.

Worked example (`contract-class.integration.test.ts`): register a contract class built from a real `@aztec-labs/noir-contracts.js` artifact, then read it through a cached route.

```ts
import { TokenContractArtifact } from "@aztec-labs/noir-contracts.js/Token";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import { startExplorerApiForTest } from "./support/explorer-api.js";

const api = await startExplorerApiForTest(); // in beforeAll; api.close() in afterAll
const contractClass = await getContractClassFromArtifact(TokenContractArtifact);

// Seed through the service's own controllers (a class row references a block row).
const { controllers } = await import("../../src/svcs/database/index.js");
await controllers.l2Contract.storeContractClass({ blockHash, contractClassId, ... });

const res = await api.request.get(`/l2/contract-classes/${contractClassId}/versions/1`);
expect(res.status).toBe(200);

// Cached routes write `<namespace>-<network>-<keys>` to this run's Redis.
await api.stack.exec("redis", ["redis-cli", "EXISTS", `${api.namespace}-SANDBOX-l2-contract-classes-...`]);
```

To test an event handler, deliver its payload the way the message bus does (BSON round trip, `{ data }` envelope) and read the result back through a route, as `chain-info.integration.test.ts` does:

```ts
import { deliver } from "@chicmoz/test-harness";

const { chainInfoHandler } = await import(
  "../../src/events/received/on-chain-info.js"
);
await deliver(chainInfoHandler, event); // event: ChicmozChainInfoEvent
```

## Limits

- The integration layer needs Docker with the compose plugin; it is exercised on Linux only.
- Schema checks compare tables, columns, primary keys and unique keys (by column set). Column types, defaults and nullability are not compared.
- The upgrade-path test proves that base-then-head migrations reach the same schema as head from empty. It does not exercise data-dependent migrations.
- A crashed run leaves its labelled project until `yarn harness down <run>`.
