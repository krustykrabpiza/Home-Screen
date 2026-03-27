# Home-Screen

A clean, modern homelab dashboard built with React + Vite.

## Features

- Service cards with name, description, icon, link
- Per-service status indicator with optional live runtime polling
- Sections for media, infra, security, and utilities
- Responsive dark theme for desktop and mobile
- Easy static configuration via `public/services.json`
- Optional live metrics (network in/out Mbps, CPU, memory) from Glances and Proxmox

## Run

```bash
npm install
npm run dev
```

## Live Runtime Metrics

This project can poll health/metrics and write runtime data into `public/runtime-status.json`.

1) Create local runtime config:

```powershell
Copy-Item config/runtime-metrics.example.json config/runtime-metrics.local.json
```

2) Edit `config/runtime-metrics.local.json`:
- Set your `glances.baseUrl`
- Set Proxmox `baseUrl`, `node`, `tokenId`, `tokenSecret`
- Adjust service ID mappings to match your dashboard IDs
- Optional: tune `healthChecks.services` per service (`enabled`, `url`, `method`, `timeoutMs`, `expectedStatusCodes`)
- Optional: set `updateOverrides` for services where update state is known externally

3) Run poller in one terminal:

```bash
npm run status:poll
```

4) Run frontend in another terminal:

```bash
npm run dev
```

The UI auto-refreshes runtime status every 15 seconds.

### Source-aware status

Runtime status is combined from multiple sources when available:
- HTTP checks
- Glances container/host metrics
- Proxmox API for VM/LXC/node services

Each card shows source summary and confidence to help explain why a service is marked online/degraded/offline.

### One-off poll

```bash
npm run status:once
```

## Build

```bash
npm run build
```

## Config

Edit `public/services.json` to add or change sections/services.