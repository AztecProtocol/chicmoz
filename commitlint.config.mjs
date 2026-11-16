/* eslint-disable import/no-default-export */

const config = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Wrapping is not part of the convention, and bodies carry URLs and long bullet lines.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
    // "Sentence case" means any capital first letter, which flags acronym-led subjects
    // ("fix: L1 deposit ..."); keep it as a hint, not a failure.
    "subject-case": [
      1,
      "never",
      ["sentence-case", "start-case", "pascal-case", "upper-case"],
    ],
  },
};

export default config;
