import baseConfig from "../../.lintstagedrc.mjs";

const config = {
  ...baseConfig,
  // As `lint`: only .ts/.tsx, since the .js config files are in no tsconfig.
  "*.{ts,tsx}": ["yarn run lint-base"],
};

export default config;
