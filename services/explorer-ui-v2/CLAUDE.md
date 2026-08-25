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

| Variable                                            | Purpose                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------- | ------------- |
| `VITE_L2_NETWORK_ID`                                | `MAINNET`, `TESTNET`, `SANDBOX`, … — branch behaviour on this, never fork components per network |
| `VITE_API_URL`                                      | REST base, with trailing `/v1`                                                                   |
| `VITE_API_KEY`                                      | Public path token appended to the API URL                                                        |
| `VITE_WS_URL`                                       | WebSocket server                                                                                 |
| `VITE_CHICMOZ_ALL_UI_URLS`                          | Network switcher: `Name                                                                          | https://url,Name2 | https://url2` |
| `VITE_VERSION_STRING`                               | Shown in the footer/health views                                                                 |
| `VITE_DISCORD_URL`, `VITE_GITHUB_URL`, `VITE_X_URL` | Social links                                                                                     |

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
yarn dev | yarn build | yarn lint | yarn tsc --noEmit
```
