#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const args = [
  "exec",
  "oxlint",
  "--ignore-pattern",
  "**/*.test.ts",
  "--ignore-pattern",
  "**/*.test.tsx",
  "--ignore-pattern",
  "**/*.spec.ts",
  "--ignore-pattern",
  "**/*.spec.tsx",
  "--ignore-pattern",
  "**/*.e2e.test.ts",
  "--ignore-pattern",
  "**/*.live.test.ts",
  "src",
  "extensions",
  "scripts",
];

const result = spawnSync("pnpm", args, {
  stdio: "inherit",
  shell: false,
});

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
