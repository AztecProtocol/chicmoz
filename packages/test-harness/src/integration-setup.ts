import { type TestProject } from "vitest/node";
import { harnessGlobalSetup } from "./global-setup.js";
import { type StackInfo } from "./stack.js";

declare module "vitest" {
  export interface ProvidedContext {
    harnessStack: StackInfo;
  }
}

const harness = harnessGlobalSetup();

export const setup = async (project: TestProject) => {
  project.provide("harnessStack", await harness.start());
};

export const teardown = harness.stop;
