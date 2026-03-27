export const mockStatusById = {
  jellyfin: { state: "online", detail: "Streaming healthy" },
  sonarr: { state: "online", detail: "Queue clear" },
  radarr: { state: "degraded", detail: "Indexer rate-limited" },
  proxmox: { state: "online", detail: "Cluster nominal" },
  portainer: { state: "online", detail: "All containers running" },
  pihole: { state: "online", detail: "DNS filtering active" },
  vaultwarden: { state: "online", detail: "No alerts" },
  authelia: { state: "degraded", detail: "One failed auth source" },
  crowdsec: { state: "online", detail: "Protection enabled" },
  uptimekuma: { state: "online", detail: "Monitoring all endpoints" },
  homepage: { state: "offline", detail: "Service unreachable" },
  whoami: { state: "unknown", detail: "No status check configured" },
};
