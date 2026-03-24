import type {
  MemoryDomain,
  MemoryProviderStatus,
  MemorySearchManager,
  MemoryVectorProbeStatus,
} from "./types.js";

export const DEFAULT_MEMORY_PROBE_DOMAINS: MemoryDomain[] = ["user_memory", "docs_kb", "history"];

export async function getLiveVectorProbeStatus(params: {
  manager: Pick<MemorySearchManager, "probeVectorAvailability" | "probeVectorStatus">;
  domains?: MemoryDomain[];
}): Promise<MemoryVectorProbeStatus> {
  const domains = params.domains ?? DEFAULT_MEMORY_PROBE_DOMAINS;
  if (typeof params.manager.probeVectorStatus === "function") {
    return await params.manager.probeVectorStatus({ domains });
  }
  const available = await params.manager.probeVectorAvailability();
  const domainStatus = Object.fromEntries(
    domains.map((domain) => [domain, { domain, available }]),
  ) as MemoryVectorProbeStatus["domains"];
  return {
    available,
    ...(domainStatus ? { domains: domainStatus } : {}),
  };
}

export function mergeLiveVectorProbeIntoStatus(params: {
  status: MemoryProviderStatus;
  probe: MemoryVectorProbeStatus;
}): MemoryProviderStatus {
  const { status, probe } = params;
  const custom = status.custom ?? {};
  const { backendError: _ignoredBackendError, ...customRest } = custom;
  const vector = {
    enabled: status.vector?.enabled ?? true,
    ...status.vector,
    available: probe.available,
    ...(probe.available ? {} : probe.error ? { loadError: probe.error } : {}),
  };
  if (probe.available) {
    delete vector.loadError;
  }
  return {
    ...status,
    vector,
    custom: {
      ...customRest,
      ...(probe.available ? {} : probe.error ? { backendError: probe.error } : {}),
      liveVectorProbe: probe,
    },
  };
}
