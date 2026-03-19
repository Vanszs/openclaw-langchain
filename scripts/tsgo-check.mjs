#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const configs = ["tsconfig.check.src.json", "tsconfig.check.extensions.json"];

const forwardedArgs = process.argv.slice(2);
const needsPrettyArg = !forwardedArgs.some(
  (arg) => arg === "--pretty" || arg.startsWith("--pretty="),
);
const sharedArgs = needsPrettyArg ? ["--pretty", "false", ...forwardedArgs] : forwardedArgs;

for (const configPath of configs) {
  const result = spawnSync("./node_modules/.bin/tsgo", ["-p", configPath, ...sharedArgs], {
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
}
