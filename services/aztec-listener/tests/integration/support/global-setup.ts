import {
  type StackInfo,
  createDatabase,
  harnessGlobalSetup,
  migrateDir,
  migrationsDir,
} from "@chicmoz/test-harness";
import { type TestProject } from "vitest/node";
import { TEMPLATE_DB } from "./constants.js";

declare module "vitest" {
  export interface ProvidedContext {
    harnessStack: StackInfo;
  }
}

const harness = harnessGlobalSetup(async (stack) => {
  await createDatabase(stack, TEMPLATE_DB);
  await migrateDir(
    stack,
    TEMPLATE_DB,
    migrationsDir("aztec-listener"),
    "aztec-listener",
  );
});

export const setup = async (project: TestProject) => {
  project.provide("harnessStack", await harness.start());
};

export const teardown = harness.stop;
