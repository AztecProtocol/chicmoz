# explorer-ui-v2

React 18 + Vite + TailwindCSS SPA; TanStack Router (file-based routes in
`src/routes/`, `src/routeTree.gen.ts` is generated — never hand-edit) and
TanStack Query for all server state (no Redux/Zustand/Context for server
data). Read the root `CLAUDE.md` first; `react-best-practices` and
`frontend-design` skills apply here.

## Build-time configuration

Every `VITE_*` value is a compile-time constant; there is no runtime env
injection (no `window._env_`). Changing a URL means rebuilding. Production
builds one bundle per network with these baked in:

| Variable                                            | Purpose                                                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `VITE_L2_NETWORK_ID`                                | `MAINNET`, `TESTNET`, `SANDBOX`, … — branch behaviour on this, never fork components per network                             |
| `VITE_API_URL`                                      | REST base, with trailing `/v1`                                                                                               |
| `VITE_API_KEY`                                      | Public path token appended to the API URL                                                                                    |
| `VITE_WS_URL`                                       | WebSocket server (unused on an archived version)                                                                             |
| `VITE_NETWORK_VERSION`                              | This build's major Aztec version, e.g. `v6`; unset for an unversioned network                                                |
| `VITE_CHICMOZ_ALL_UI_URLS`                          | Every deployment, comma-separated `Network\|URL[\|version[\|status]]`; status is `canonical` (default), `live` or `archived` |
| `VITE_VERSION_STRING`                               | Shown in the footer/health views                                                                                             |
| `VITE_DISCORD_URL`, `VITE_GITHUB_URL`, `VITE_X_URL` | Social links                                                                                                                 |

Each major Aztec version of a network is its own deployment (own backend
stack and UI build). The network picker links each network to its
`canonical` deployment; the version picker lists the current network's
versions and opens a version's landing page. A non-canonical build shows a
banner pointing at the canonical one, and an `archived` build drops live
features (WebSocket, next-block countdown). Its API runs with
`ARCHIVE_MODE=true`. Example:
`Mainnet|https://aztecscan.xyz,Testnet|https://testnet.aztecscan.xyz|v6|canonical,Testnet|https://v5.testnet.aztecscan.xyz|v5|archived`.

Production values are set by `foundation-iac/aztecscan.xyz/scripts/deploy-ui.sh`,
which builds `dist/` and publishes it to S3 behind CloudFront (extensionless
routes are rewritten to `index.html` at the edge). The `Dockerfile`/nginx setup
here is for local Skaffold only.

## Conventions

- Named exports preferred in new code, but default exports and extension-less
  relative imports exist and are allowed — don't churn files to change them.
- `type Props = {…}`, PascalCase components, `useXxx` hooks, Tailwind utility
  classes over inline styles, no `console.*` left in committed code.
- Consuming a new endpoint: confirm it exists in `explorer-api`, add the Zod
  schema to `@chicmoz-pkg/types` if shared, parse with `validateResponse()`.
- Live data comes through the existing WebSocket hook; don't open sockets in
  components.
- Static assets go in `public/` (copied verbatim by Vite).
- Static/legal pages live in `src/pages/static/`; the site is operated by the
  Aztec Foundation — no operator-specific content (staking pitches, third-party
  analytics loaders) belongs in the UI.

```sh
yarn build:packages   # from repo root, once
yarn dev | yarn build | yarn lint | yarn test | yarn tsc --noEmit
```
