import { describe, expect, it, vi } from "vitest";
import tsdownConfig from "../../tsdown.config.ts";

type TsdownConfigEntry = {
  entry?: Record<string, string> | string[];
  inputOptions?: (options: {
    onLog?: (
      level: string,
      log: { code?: string; message?: string; id?: string; importer?: string },
      defaultHandler: (level: string, log: { code?: string; message?: string }) => void,
    ) => void;
  }) =>
    | {
        onLog?: (
          level: string,
          log: { code?: string; message?: string; id?: string; importer?: string },
          defaultHandler: (level: string, log: { code?: string; message?: string }) => void,
        ) => void;
      }
    | undefined;
  outDir?: string;
};

function asConfigArray(config: unknown): TsdownConfigEntry[] {
  return Array.isArray(config) ? (config as TsdownConfigEntry[]) : [config as TsdownConfigEntry];
}

function entryKeys(config: TsdownConfigEntry): string[] {
  if (!config.entry || Array.isArray(config.entry)) {
    return [];
  }
  return Object.keys(config.entry);
}

describe("tsdown config", () => {
  it("keeps core, plugin runtime, plugin-sdk, bundled plugins, and bundled hooks in one dist graph", () => {
    const configs = asConfigArray(tsdownConfig);
    const distGraphs = configs.filter((config) => {
      const keys = entryKeys(config);
      return (
        keys.includes("index") ||
        keys.includes("plugins/runtime/index") ||
        keys.includes("plugin-sdk/index") ||
        keys.includes("extensions/openai/index") ||
        keys.includes("bundled/boot-md/handler")
      );
    });

    expect(distGraphs).toHaveLength(1);
    expect(entryKeys(distGraphs[0])).toEqual(
      expect.arrayContaining([
        "index",
        "plugins/runtime/index",
        "plugin-sdk/index",
        "extensions/openai/index",
        "bundled/boot-md/handler",
      ]),
    );
  });

  it("does not emit plugin-sdk or hooks from a separate dist graph", () => {
    const configs = asConfigArray(tsdownConfig);

    expect(configs.some((config) => config.outDir === "dist/plugin-sdk")).toBe(false);
    expect(
      configs.some((config) =>
        Array.isArray(config.entry)
          ? config.entry.some((entry) => entry.includes("src/hooks/"))
          : false,
      ),
    ).toBe(false);
  });

  it("suppresses known third-party eval warnings while keeping other eval warnings", () => {
    const configs = asConfigArray(tsdownConfig);
    const configWithInputOptions = configs.find(
      (config) => typeof config.inputOptions === "function",
    );
    expect(configWithInputOptions).toBeDefined();

    const defaultHandler = vi.fn();
    const previousOnLog = vi.fn();
    const inputOptions = configWithInputOptions?.inputOptions?.({ onLog: previousOnLog });
    expect(inputOptions?.onLog).toBeDefined();

    inputOptions?.onLog?.(
      "warn",
      { code: "EVAL", id: "node_modules/bottleneck/lib/RedisConnection.js" },
      defaultHandler,
    );
    inputOptions?.onLog?.(
      "warn",
      { code: "EVAL", id: "@protobufjs/inquire/index.js" },
      defaultHandler,
    );
    inputOptions?.onLog?.(
      "warn",
      { code: "EVAL", id: "node_modules/some-other-package/index.js" },
      defaultHandler,
    );

    expect(previousOnLog).toHaveBeenCalledTimes(1);
    expect(previousOnLog).toHaveBeenCalledWith(
      "warn",
      { code: "EVAL", id: "node_modules/some-other-package/index.js" },
      defaultHandler,
    );
    expect(defaultHandler).not.toHaveBeenCalled();
  });
});
