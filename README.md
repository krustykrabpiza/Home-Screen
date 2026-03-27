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

## Deploy on Unraid (recommended)

This repo includes a 2-container stack:
- `home-screen-web`: serves the static dashboard with Nginx
- `home-screen-poller`: updates `runtime-status.json` continuously

### Unraid prerequisites

- Unraid Docker service enabled
- `git` available on Unraid (NerdTools or your preferred method)
- Docker Compose plugin/app installed (recommended), or use CLI

### 1) Clone repo into Appdata

```bash
mkdir -p /mnt/user/appdata/home-screen
cd /mnt/user/appdata/home-screen
git clone https://github.com/krustykrabpiza/Home-Screen.git
cd Home-Screen
```

### 2) Create runtime config

```bash
cp config/runtime-metrics.example.json config/runtime-metrics.local.json
```

Edit `config/runtime-metrics.local.json`:
- `glances.baseUrl` (example: `http://192.168.1.22:61208`)
- `proxmox.baseUrl`, `proxmox.node`, `proxmox.tokenId`, `proxmox.tokenSecret`
- service mappings under `glances.containers` and `proxmox.services`

### 3) Deploy stack

```bash
cd /mnt/user/appdata/home-screen/Home-Screen/deploy
docker compose up -d --build
```

Dashboard URL:
- `http://<UNRAID-IP>:8088`

### 4) Verify and monitor

```bash
docker compose ps
docker compose logs -f home-screen-poller
```

### 5) Update on Unraid

```bash
cd /mnt/user/appdata/home-screen/Home-Screen
git pull
cd deploy
docker compose up -d --build
```

### Using Unraid Compose Manager UI

If you prefer UI instead of CLI:
- Stack Name: `home-screen`
- Compose file path: `/mnt/user/appdata/home-screen/Home-Screen/deploy/docker-compose.yml`
- Deploy the stack from the UI

### Optional: publish through Nginx Proxy Manager

- Add Proxy Host:
  - Forward Host/IP: `UNRAID-IP`
  - Forward Port: `8088`
- Enable SSL + Force SSL if you want HTTPS externally

## Config

Edit `public/services.json` to add or change sections/services.