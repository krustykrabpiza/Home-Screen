import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const servicesPath = path.join(projectRoot, "public", "services.json");
const runtimeStatusPath = path.join(projectRoot, "public", "runtime-status.json");
const configPath = path.join(projectRoot, "config", "runtime-metrics.local.json");

const metricTracker = new Map();
const healthFailureTracker = new Map();

const SOURCE_CONFIDENCE = {
  http: 0.62,
  glances: 0.85,
  proxmox: 0.95,
};

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toPercent(value) {
  const numeric = toNumber(value);
  if (numeric === null) return null;
  return numeric <= 1 ? numeric * 100 : numeric;
}

function round(value, places = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function debugLog(config, message) {
  if (config?.debug) {
    console.log(`[poller][debug] ${message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeState(state) {
  const value = String(state || "").toLowerCase();
  if (["online", "offline", "degraded", "unknown"].includes(value)) {
    return value;
  }
  return "unknown";
}

function computeMbps(key, rxBytes, txBytes, nowMs) {
  const rx = toNumber(rxBytes);
  const tx = toNumber(txBytes);
  if (rx === null || tx === null) {
    return { netInMbps: null, netOutMbps: null };
  }

  const prev = metricTracker.get(key);
  metricTracker.set(key, { timestampMs: nowMs, rxBytes: rx, txBytes: tx });
  if (!prev) {
    return { netInMbps: null, netOutMbps: null };
  }

  const elapsedSeconds = (nowMs - prev.timestampMs) / 1000;
  if (elapsedSeconds <= 0) {
    return { netInMbps: null, netOutMbps: null };
  }

  const netInMbps = ((rx - prev.rxBytes) * 8) / elapsedSeconds / 1_000_000;
  const netOutMbps = ((tx - prev.txBytes) * 8) / elapsedSeconds / 1_000_000;

  return {
    netInMbps: round(Math.max(0, netInMbps)),
    netOutMbps: round(Math.max(0, netOutMbps)),
  };
}

async function readJson(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function writeRuntimeStatus(statuses, meta = {}) {
  const payload = {
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
    ...meta,
    statuses,
  };
  await fs.writeFile(runtimeStatusPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3500;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      signal: controller.signal,
      headers: options.headers ?? {},
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFirstJson(baseUrl, endpointCandidates, options = {}) {
  const normalizedBase = String(baseUrl || "").replace(/\/+$/, "");
  for (const endpoint of endpointCandidates) {
    const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    try {
      const data = await fetchJson(`${normalizedBase}${cleanEndpoint}`, options);
      return { endpoint: cleanEndpoint, data };
    } catch {
      // Continue trying endpoint variants.
    }
  }
  return null;
}

function getObjectArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function readFirstNumber(entry, keys) {
  for (const key of keys) {
    const value = key
      .split(".")
      .reduce((acc, part) => (acc && part in acc ? acc[part] : undefined), entry);
    const numeric = toNumber(value);
    if (numeric !== null) return numeric;
  }
  return null;
}

function detectUpdateFromContainer(container) {
  const candidates = [
    container.status,
    container.state,
    container.description,
    container.update,
    container.update_status,
    container.image_status,
    container.health,
    container.version,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(" ");

  if (!candidates) return false;
  return /(update available|apply update|new image|upgrade available|outdated)/.test(candidates);
}

function parseGlancesContainer(container) {
  const name =
    container.name ||
    container.container_name ||
    container.Name ||
    container.id ||
    container.Id ||
    null;

  const cpuPct = toPercent(
    readFirstNumber(container, ["cpu_percent", "cpu", "cpu_usage", "cpu_stats.cpu_usage.total_usage"])
  );
  const memPct = toPercent(readFirstNumber(container, ["memory_percent", "mem_percent", "mem"]));
  const rxBytes = readFirstNumber(container, [
    "rx",
    "rx_bytes",
    "network_rx",
    "network.rx",
    "net_rx",
    "bytes_recv",
  ]);
  const txBytes = readFirstNumber(container, [
    "tx",
    "tx_bytes",
    "network_tx",
    "network.tx",
    "net_tx",
    "bytes_sent",
  ]);

  const statusText = String(container.status || container.state || "").toLowerCase();
  const hasStatus = Boolean(statusText.trim());
  const isRunning = hasStatus
    ? statusText.includes("up") ||
      statusText.includes("running") ||
      statusText.includes("started") ||
      statusText.includes("healthy")
    : null;

  return {
    name: String(name || ""),
    isRunning,
    updateAvailable: detectUpdateFromContainer(container),
    cpuPct: round(cpuPct),
    memPct: round(memPct),
    rxBytes,
    txBytes,
  };
}

async function collectGlancesStatuses(config, nowMs) {
  if (!config?.baseUrl || !config?.containers) return {};

  const containerResponse = await fetchFirstJson(
    config.baseUrl,
    ["/api/4/containers", "/api/3/containers", "/api/4/docker", "/api/3/docker"],
    { timeoutMs: config.requestTimeoutMs ?? 3500 }
  );
  if (!containerResponse) return {};

  const containers = getObjectArray(containerResponse.data).map(parseGlancesContainer);
  const statuses = {};

  for (const [serviceId, expectedContainerName] of Object.entries(config.containers)) {
    const match = containers.find(
      (entry) => entry.name.toLowerCase() === String(expectedContainerName).toLowerCase()
    );
    if (!match) continue;

    const throughput = computeMbps(
      `glances-container:${match.name}`,
      match.rxBytes,
      match.txBytes,
      nowMs
    );

    const state =
      match.isRunning === true ? "online" : match.isRunning === false ? "offline" : "unknown";

    statuses[serviceId] = {
      source: "glances",
      sourceConfidence: SOURCE_CONFIDENCE.glances,
      state,
      detail: `Glances: ${match.name}`,
      updateAvailable: match.updateAvailable || undefined,
      metrics: {
        ...throughput,
        cpuPct: match.cpuPct,
        memPct: match.memPct,
      },
    };
  }

  if (config.hostServiceId) {
    const cpuResponse = await fetchFirstJson(config.baseUrl, ["/api/4/cpu", "/api/3/cpu"], {
      timeoutMs: config.requestTimeoutMs ?? 3500,
    });
    const memResponse = await fetchFirstJson(config.baseUrl, ["/api/4/mem", "/api/3/mem"], {
      timeoutMs: config.requestTimeoutMs ?? 3500,
    });
    const netResponse = await fetchFirstJson(config.baseUrl, ["/api/4/network", "/api/3/network"], {
      timeoutMs: config.requestTimeoutMs ?? 3500,
    });

    const cpuData = cpuResponse?.data ?? {};
    const memData = memResponse?.data ?? {};
    const netCandidates = getObjectArray(netResponse?.data ?? []);
    const interfaceStats = netCandidates.find((iface) => {
      const name = String(iface.interface_name || iface.interface || iface.name || "").toLowerCase();
      return name && name !== "lo";
    });

    const cpuPct = toPercent(readFirstNumber(cpuData, ["total", "total_pct", "cpu_percent"]));
    const memPct = toPercent(readFirstNumber(memData, ["percent", "used_percent", "used"]));
    const rxBytes = readFirstNumber(interfaceStats || {}, ["rx", "bytes_recv", "rx_bytes"]);
    const txBytes = readFirstNumber(interfaceStats || {}, ["tx", "bytes_sent", "tx_bytes"]);
    const throughput = computeMbps("glances-host", rxBytes, txBytes, nowMs);

    statuses[config.hostServiceId] = {
      source: "glances",
      sourceConfidence: SOURCE_CONFIDENCE.glances,
      state: "online",
      detail: "Glances host metrics",
      metrics: {
        ...throughput,
        cpuPct: round(cpuPct),
        memPct: round(memPct),
      },
    };
  }

  return statuses;
}

function proxmoxAuthHeader(config) {
  if (!config?.tokenId || !config?.tokenSecret) return null;
  return `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`;
}

async function fetchProxmoxJson(config, endpoint) {
  const normalizedBase = String(config.baseUrl || "").replace(/\/+$/, "");
  const auth = proxmoxAuthHeader(config);
  if (!auth) throw new Error("Missing Proxmox token credentials.");

  const data = await fetchJson(`${normalizedBase}${endpoint}`, {
    timeoutMs: config.requestTimeoutMs ?? 4000,
    headers: {
      Authorization: auth,
    },
  });
  return data?.data ?? data;
}

async function collectProxmoxStatuses(config, nowMs) {
  if (!config?.baseUrl || !config?.node || !config?.services) return {};

  if (config.ignoreTlsErrors) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const statuses = {};
  for (const [serviceId, serviceConfig] of Object.entries(config.services)) {
    const type = String(serviceConfig.type || "").toLowerCase();
    const vmid = serviceConfig.vmid;
    if (!type || !vmid) continue;

    const apiType = type === "vm" || type === "qemu" ? "qemu" : "lxc";
    const endpoint = `/api2/json/nodes/${config.node}/${apiType}/${vmid}/status/current`;

    try {
      const data = await fetchProxmoxJson(config, endpoint);
      const running = String(data.status || "").toLowerCase() === "running";
      const cpuPct = toPercent(data.cpu);
      const memPct =
        toNumber(data.mem) !== null && toNumber(data.maxmem)
          ? (Number(data.mem) / Number(data.maxmem)) * 100
          : null;
      const throughput = computeMbps(
        `proxmox:${config.node}:${apiType}:${vmid}`,
        data.netin,
        data.netout,
        nowMs
      );

      statuses[serviceId] = {
        source: "proxmox",
        sourceConfidence: SOURCE_CONFIDENCE.proxmox,
        state: running ? "online" : "offline",
        detail: `Proxmox ${apiType.toUpperCase()} ${vmid} on ${config.node}`,
        metrics: {
          ...throughput,
          cpuPct: round(cpuPct),
          memPct: round(memPct),
        },
      };
    } catch (error) {
      statuses[serviceId] = {
        source: "proxmox",
        sourceConfidence: SOURCE_CONFIDENCE.proxmox,
        state: "unknown",
        detail: `Proxmox check failed: ${error.message}`,
      };
    }
  }

  if (config.nodeServiceId) {
    try {
      const nodeData = await fetchProxmoxJson(config, `/api2/json/nodes/${config.node}/status`);
      const cpuPct = toPercent(readFirstNumber(nodeData, ["cpu", "cpuinfo.cpu"]));
      const memUsed = readFirstNumber(nodeData, ["memory.used", "memory.memused"]);
      const memTotal = readFirstNumber(nodeData, ["memory.total", "memory.memtotal"]);
      const memPct = memUsed && memTotal ? (memUsed / memTotal) * 100 : null;

      statuses[config.nodeServiceId] = {
        source: "proxmox",
        sourceConfidence: SOURCE_CONFIDENCE.proxmox,
        state: "online",
        detail: `Proxmox node ${config.node}`,
        metrics: {
          cpuPct: round(cpuPct),
          memPct: round(memPct),
        },
      };
    } catch (error) {
      statuses[config.nodeServiceId] = {
        source: "proxmox",
        sourceConfidence: SOURCE_CONFIDENCE.proxmox,
        state: "unknown",
        detail: `Proxmox node check failed: ${error.message}`,
      };
    }
  }

  return statuses;
}

function buildHealthCheckProfile(service, config, defaultTimeoutMs) {
  const defaults = config?.healthChecks?.defaults ?? {};
  const serviceOverride = config?.healthChecks?.services?.[service.id] ?? {};

  const headers = {
    ...(defaults.headers ?? {}),
    ...(serviceOverride.headers ?? {}),
  };
  const method = String(serviceOverride.method ?? defaults.method ?? "GET").toUpperCase();

  return {
    enabled: serviceOverride.enabled ?? defaults.enabled ?? true,
    url: String(serviceOverride.url ?? service.link),
    method,
    timeoutMs: serviceOverride.timeoutMs ?? defaults.timeoutMs ?? defaultTimeoutMs,
    expectedStatusCodes: serviceOverride.expectedStatusCodes ?? defaults.expectedStatusCodes ?? null,
    treat3xxAsOnline: serviceOverride.treat3xxAsOnline ?? defaults.treat3xxAsOnline ?? true,
    allowInsecureTls: serviceOverride.allowInsecureTls ?? defaults.allowInsecureTls ?? false,
    headers,
  };
}

function stateFromHttpResponse(response, profile) {
  if (Array.isArray(profile.expectedStatusCodes) && profile.expectedStatusCodes.length > 0) {
    return profile.expectedStatusCodes.includes(response.status) ? "online" : "degraded";
  }
  if (response.ok) return "online";
  if (profile.treat3xxAsOnline && response.status >= 300 && response.status < 400) return "online";
  return "degraded";
}

function withConsecutiveFailureHandling(serviceId, previousStatuses, failedStatus) {
  const failures = (healthFailureTracker.get(serviceId) ?? 0) + 1;
  healthFailureTracker.set(serviceId, failures);

  const previous = previousStatuses?.[serviceId];
  if (previous && failures < 3) {
    return {
      ...previous,
      detail: `Last check failed (${failures}/3): ${failedStatus.detail}`,
      stale: true,
      source: "http",
      sourceConfidence: SOURCE_CONFIDENCE.http,
    };
  }

  return failedStatus;
}

async function collectHttpHealthStatuses(services, config, previousStatuses) {
  const statuses = {};
  const defaultTimeoutMs = config.requestTimeoutMs ?? 3500;

  await Promise.all(
    services.map(async (service) => {
      const profile = buildHealthCheckProfile(service, config, defaultTimeoutMs);
      debugLog(
        config,
        `HTTP profile ${service.id}: enabled=${profile.enabled} method=${profile.method} url=${profile.url}`
      );
      if (!profile.enabled) {
        statuses[service.id] = {
          source: "http",
          sourceConfidence: SOURCE_CONFIDENCE.http,
          state: "unknown",
          detail: "HTTP check disabled",
        };
        return;
      }

      if (!/^https?:\/\//i.test(profile.url)) {
        statuses[service.id] = {
          source: "http",
          sourceConfidence: SOURCE_CONFIDENCE.http,
          state: "unknown",
          detail: "Skipped non-HTTP URL",
        };
        return;
      }

      if (profile.allowInsecureTls) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      }

      const start = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), profile.timeoutMs);

      try {
        const response = await fetch(profile.url, {
          method: profile.method,
          signal: controller.signal,
          headers: profile.headers,
        });
        const latencyMs = Date.now() - start;
        healthFailureTracker.set(service.id, 0);
        const derivedState = stateFromHttpResponse(response, profile);
        debugLog(
          config,
          `HTTP result ${service.id}: status=${response.status} state=${derivedState} expected=${JSON.stringify(profile.expectedStatusCodes)}`
        );
        statuses[service.id] = {
          source: "http",
          sourceConfidence: SOURCE_CONFIDENCE.http,
          state: derivedState,
          detail: `HTTP ${response.status} in ${latencyMs}ms`,
          stale: false,
        };
      } catch (error) {
        const failedStatus = {
          source: "http",
          sourceConfidence: SOURCE_CONFIDENCE.http,
          state: "offline",
          detail: `Health check failed: ${error.message}`,
        };
        statuses[service.id] = withConsecutiveFailureHandling(
          service.id,
          previousStatuses,
          failedStatus
        );
      } finally {
        clearTimeout(timeout);
      }
    })
  );

  return statuses;
}

function flattenServices(config) {
  const sections = config?.sections ?? [];
  return sections.flatMap((section) => section.services ?? []);
}

function mergeMetrics(entries) {
  const merged = {};
  for (const entry of entries) {
    if (entry?.metrics && typeof entry.metrics === "object") {
      Object.assign(merged, entry.metrics);
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function selectFinalState(entries, proxmoxEntry) {
  if (proxmoxEntry && normalizeState(proxmoxEntry.state) !== "unknown") {
    return normalizeState(proxmoxEntry.state);
  }

  const states = entries.map((entry) => normalizeState(entry.state));
  const hasOnline = states.includes("online");
  const hasOffline = states.includes("offline");
  const hasDegraded = states.includes("degraded");

  if (hasOnline && hasOffline) return "degraded";
  if (hasOffline) return "offline";
  if (hasDegraded) return "degraded";
  if (hasOnline) return "online";
  return "unknown";
}

function calculateConfidence(entries, finalState) {
  if (entries.length === 0) return null;

  let confidence = Math.max(
    ...entries.map((entry) => Number(entry.sourceConfidence ?? SOURCE_CONFIDENCE[entry.source] ?? 0.5))
  );

  const normalizedStates = entries.map((entry) => normalizeState(entry.state));
  const hasConflict = normalizedStates.includes("online") && normalizedStates.includes("offline");
  const hasStale = entries.some((entry) => entry.stale);

  if (entries.length > 1 && !hasConflict && finalState !== "unknown") {
    confidence += 0.08;
  }
  if (hasConflict) {
    confidence -= 0.25;
  }
  if (hasStale) {
    confidence -= 0.1;
  }

  return Math.round(clamp(confidence * 100, 20, 99));
}

function chooseDetailEntry(entries, finalState) {
  const priority = { proxmox: 3, glances: 2, http: 1 };
  const candidates = entries
    .filter((entry) => normalizeState(entry.state) === finalState || finalState === "unknown")
    .sort((a, b) => (priority[b.source] ?? 0) - (priority[a.source] ?? 0));
  return candidates[0] ?? entries[0];
}

function combineStatuses(services, sourceMaps, previousStatuses, config) {
  const statuses = {};
  const serviceIds = services.map((service) => service.id);

  for (const serviceId of serviceIds) {
    const entries = Object.values(sourceMaps)
      .map((sourceMap) => sourceMap?.[serviceId])
      .filter(Boolean);

    if (entries.length === 0) {
      if (previousStatuses?.[serviceId]) {
        statuses[serviceId] = {
          ...previousStatuses[serviceId],
          stale: true,
          detail: `No fresh telemetry; keeping previous status: ${previousStatuses[serviceId].detail}`,
        };
      }
      continue;
    }

    const proxmoxEntry = sourceMaps.proxmox?.[serviceId];
    const finalState = selectFinalState(entries, proxmoxEntry);
    const detailEntry = chooseDetailEntry(entries, finalState);
    const sourceSummary = [...new Set(entries.map((entry) => entry.source).filter(Boolean))].join("+");
    const confidencePct = calculateConfidence(entries, finalState);
    const metrics = mergeMetrics(entries);
    const updateAvailable =
      entries.some((entry) => entry.updateAvailable === true) ||
      config?.updateOverrides?.[serviceId] === true;

    statuses[serviceId] = {
      state: finalState,
      detail: detailEntry?.detail ?? "No detail available",
      sourceSummary,
      confidencePct,
      stale: entries.some((entry) => entry.stale),
      updateAvailable: updateAvailable || undefined,
      ...(metrics ? { metrics } : {}),
    };
  }

  return statuses;
}

async function runPoll(config) {
  const nowMs = Date.now();
  const serviceConfig = await readJson(servicesPath, { sections: [] });
  const services = flattenServices(serviceConfig);
  const previousRuntime = await readJson(runtimeStatusPath, { statuses: {} });

  const healthStatuses = await collectHttpHealthStatuses(
    services,
    config,
    previousRuntime.statuses ?? {}
  );
  const glancesStatuses = await collectGlancesStatuses(config.glances, nowMs);
  const proxmoxStatuses = await collectProxmoxStatuses(config.proxmox, nowMs);

  const statuses = combineStatuses(
    services,
    {
      http: healthStatuses,
      glances: glancesStatuses,
      proxmox: proxmoxStatuses,
    },
    previousRuntime.statuses ?? {},
    config
  );

  await writeRuntimeStatus(statuses, {
    source: "runtime-status-poller",
  });
}

async function main() {
  const once = process.argv.includes("--once");
  const config = await readJson(configPath, {});
  const intervalMs = config.pollIntervalMs ?? 15000;

  console.log(`[poller] cwd ${process.cwd()}`);
  console.log(`[poller] script ${__filename}`);
  console.log(`[poller] writing runtime status to ${runtimeStatusPath}`);
  if (once) {
    await runPoll(config);
    console.log("[poller] completed single poll");
    return;
  }

  // Keep this as a serial loop to avoid overlapping polls.
  while (true) {
    try {
      await runPoll(config);
      console.log(`[poller] updated at ${new Date().toISOString()}`);
    } catch (error) {
      console.error(`[poller] poll failed: ${error.message}`);
    }
    await sleep(intervalMs);
  }
}

main().catch((error) => {
  console.error(`[poller] fatal error: ${error.message}`);
  process.exitCode = 1;
});
