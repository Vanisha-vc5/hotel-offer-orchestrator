# Deploying hotel-offer-orchestrator to a Linux VM

This guide puts the whole stack on **one Ubuntu 24.04 VM** with Docker Compose, behind **Caddy** with automatic
HTTPS:

```
Internet ──443/80──▶ Caddy ──▶ api ──▶ Temporal ◀── worker
                                 │                   │
                                 └──────▶ Redis ◀────┘      (Postgres, Temporal UI: internal only)
```

- **What's public:** only Caddy publishes ports (80 and 443). Redis, Postgres, Temporal and the api are reachable
  only on the internal Docker network.
- **The Temporal UI** is bound to `127.0.0.1:8080` on the VM and opened over an SSH tunnel. I chose this over basic
  auth at `/temporal`: the UI is a single-page app with absolute asset paths, so serving it under a sub-path needs
  extra UI configuration, while a tunnel adds no attack surface and always works.
- **`ADMIN_TOKEN` is required.** Compose refuses to start without it, and the app refuses tokens shorter than
  16 characters (`REQUIRE_ADMIN_TOKEN=true`).
- **Every service** has `restart: unless-stopped`, log rotation (`10m × 3` files) and a memory limit.

Files: `docker-compose.prod.yml` (the override), `deploy/Caddyfile`, `deploy/setup-vm.sh` (first deploy, safe to
re-run) and `deploy/update.sh` (updates).

---

## 1. Create the VM

| Requirement                       | Value                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------ |
| OS                                | Ubuntu 24.04 LTS (x86_64)                                                      |
| Size                              | **2 vCPU / 4 GB RAM** minimum (Temporal + Postgres + the app use about 2.5 GB) |
| Disk                              | 20 GB or more                                                                  |
| Inbound firewall / security group | TCP **22**, **80**, **443** (and UDP 443 for HTTP/3)                           |

Any provider works: AWS EC2 (`t3.medium`), DigitalOcean (4 GB droplet), Hetzner, Azure, GCP, Oracle Cloud and
others. If you're a student, several providers and the GitHub Student Developer Pack have offered credit
programs. Availability, amounts and eligibility change often, so check each program's current terms. Nothing in
this guide depends on a particular one.

Create the VM with your SSH key, note its **public IP**, and connect:

```bash
ssh ubuntu@<public-ip>
```

## 2. A domain, or sslip.io

Caddy needs a hostname that resolves to the VM so it can get a certificate from Let's Encrypt or ZeroSSL.

- **Your own domain:** add a DNS `A` record such as `hotels.example.com → <public-ip>`, wait until
  `dig +short hotels.example.com` returns the IP, then use `PUBLIC_DOMAIN=hotels.example.com`.
- **No domain:** use **sslip.io**, a free wildcard DNS service. For IP `203.0.113.10`, the hostname
  `203-0-113-10.sslip.io` resolves to it. `setup-vm.sh` does this automatically when `PUBLIC_DOMAIN` isn't set.

## 3. First deploy

On the VM:

```bash
curl -fsSL https://raw.githubusercontent.com/Vanisha-vc5/hotel-offer-orchestrator/main/deploy/setup-vm.sh -o setup-vm.sh
REPO_URL=https://github.com/Vanisha-vc5/hotel-offer-orchestrator.git \
PUBLIC_DOMAIN=hotels.example.com \
bash setup-vm.sh
```

The script is idempotent, so running it again is safe. It does the following:

1. Installs Docker Engine and the Compose plugin, and enables Docker.
2. Configures **ufw** to allow only 22, 80 and 443.
3. Clones the repository into `/opt/hotel-offer-orchestrator`, or fast-forwards it if it's already there.
4. Creates `.env` from `.env.example`, with a random `ADMIN_TOKEN`, a random `POSTGRES_PASSWORD`,
   `NODE_ENV=production` and `PUBLIC_DOMAIN`. An existing `.env` keeps its secrets.
5. Runs
   `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --wait` and prints the URL.

Check it:

```bash
curl https://hotels.example.com/health
curl -i "https://hotels.example.com/api/hotels?city=delhi"
grep ADMIN_TOKEN /opt/hotel-offer-orchestrator/.env    # send as the x-admin-token header
```

To change settings later (for example, enabling an LLM for `/api/hotels/ask`), edit
`/opt/hotel-offer-orchestrator/.env` and re-run `bash deploy/update.sh`.

## 4. Updating

```bash
bash /opt/hotel-offer-orchestrator/deploy/update.sh
```

It runs `git pull --ff-only`, rebuilds the app image, recreates only what changed (data volumes are kept), waits
until everything is healthy, prunes old images and checks `https://<domain>/health/live`.

### From Windows (PowerShell)

The VM commands run inside the SSH session, so they are the same on every OS. On your Windows machine:

```powershell
# Connect (OpenSSH ships with Windows 10/11)
ssh ubuntu@<public-ip>

# Smoke-test the live site from the repo folder (Node 24 on PATH)
npm run smoke -- --url https://<your-domain>

# Postman against production (the token is in /opt/hotel-offer-orchestrator/.env on the VM)
$env:ADMIN_TOKEN = "<token>"
npx newman run postman/HotelOfferOrchestrator.postman_collection.json `
  -e postman/production.postman_environment.json `
  --env-var baseUrl=https://<your-domain> --env-var adminToken=$env:ADMIN_TOKEN

# Reset chaos afterwards
Invoke-RestMethod -Method Delete -Uri https://<your-domain>/admin/chaos -Headers @{ "x-admin-token" = $env:ADMIN_TOKEN }

# Temporal UI through an SSH tunnel, then open http://localhost:8080
ssh -L 8080:127.0.0.1:8080 ubuntu@<public-ip>
```

**LLM in production:** `setup-vm.sh` writes `LLM_PROVIDER=none`, and the prod override defaults to `none`, so a
public endpoint can't run up model costs. Natural-language search still works through the rules parser. To opt
in, set `LLM_PROVIDER`, `LLM_API_KEY` and (optionally) a low `LLM_DAILY_CALL_LIMIT` in `.env`, then run
`deploy/update.sh`.

## 5. Operating the deployment

```bash
cd /opt/hotel-offer-orchestrator
alias dc='docker compose -f docker-compose.yml -f docker-compose.prod.yml'

dc ps                                  # health of every service
dc logs -f api worker                  # structured JSON logs (rotated 10m × 3)
dc logs -f caddy                       # TLS issuance and access logs
dc logs worker | grep '"requestId":"<X-Request-Id>"'    # trace one request end to end
dc restart worker
```

**Temporal UI** (not public):

```bash
# on your laptop
ssh -L 8080:127.0.0.1:8080 ubuntu@<public-ip>
# then open http://localhost:8080
```

**Postman against production.** Import `postman/production.postman_environment.json`, then set `baseUrl` to
`https://<your-domain>` and `adminToken` to the value from `.env`. The read-only folders need no token. The chaos
folders and the per-request setup steps use the token.

```bash
npx newman run postman/HotelOfferOrchestrator.postman_collection.json \
  -e postman/production.postman_environment.json \
  --env-var baseUrl=https://hotels.example.com --env-var adminToken=<token>
```

> Chaos endpoints are enabled in production behind the admin token, so the resilience demo also works live. To
> turn them off, set `ENABLE_CHAOS=false` in `.env` and run `update.sh`.

## 6. Backups

Temporal's workflow history lives in the **Postgres** volume. Redis holds only a cache (it can be rebuilt, and has
no persistence).

```bash
cd /opt/hotel-offer-orchestrator
# Logical backup of all Temporal databases (consistent, online)
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgresql \
  pg_dumpall -U temporal | gzip > ~/backup-temporal-$(date +%F).sql.gz

# Restore onto a fresh stack (stop app containers first)
gunzip -c ~/backup-temporal-2026-11-20.sql.gz | \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgresql psql -U temporal postgres
```

Copy backups off the VM (`scp`, object storage, or provider snapshots). A nightly cron entry:

```cron
0 3 * * * cd /opt/hotel-offer-orchestrator && docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgresql pg_dumpall -U temporal | gzip > /var/backups/temporal-$(date +\%F).sql.gz
```

## 7. Troubleshooting

| Symptom                                                                                  | Cause and fix                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `required variable ADMIN_TOKEN is missing a value`                                       | `.env` has no `ADMIN_TOKEN`. Re-run `setup-vm.sh` (it generates one) or set it by hand.                                                                                             |
| api restarts with `ADMIN_TOKEN is required (at least 16 characters)`                     | The token is too short. Use `openssl rand -hex 24`.                                                                                                                                 |
| Browser shows a certificate error, or `dc logs caddy` mentions an ACME challenge failure | DNS doesn't point at the VM yet, or port 80 or 443 is blocked by the cloud firewall or security group. Check `dig +short <domain>` and the inbound rules. Caddy retries on its own. |
| `too many certificates` from Let's Encrypt                                               | A rate limit after many re-deploys with fresh volumes. Keep the `caddy-data` volume, or wait. sslip.io hostnames share limits per IP-derived name.                                  |
| `temporal` unhealthy for a few minutes on the first boot                                 | Schema creation on Postgres. `--wait` blocks until it's ready. Check `dc logs temporal`.                                                                                            |
| Containers killed with `OOMKilled`                                                       | The VM is too small. Use 4 GB or more, or raise `mem_limit` in `docker-compose.prod.yml`.                                                                                           |
| `/api/hotels` returns 503 `TEMPORAL_UNAVAILABLE`                                         | `dc ps temporal`, then `dc restart temporal`. The api reconnects on its own.                                                                                                        |
| Can't open the Temporal UI                                                               | It's loopback-only by design. Use the SSH tunnel in §5.                                                                                                                             |

## 8. Alternatives to the one-command setup

### Plain Docker Compose on any Linux VM Any Linux VM (EC2, DigitalOcean, …) with Docker Compose

```bash
# 1. Install Docker Engine + Compose plugin (Ubuntu)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# 2. Get the code and configure
git clone https://github.com/Vanisha-vc5/hotel-offer-orchestrator.git && cd hotel-offer-orchestrator
cp .env.example .env
#   Recommended production edits in .env:
#   ADMIN_TOKEN=<long random string>        # protect /admin/*
#   ENABLE_CHAOS=false                       # turn off failure injection
#   POSTGRES_PASSWORD=<strong password>
#   REDIS_HOST_PORT=127.0.0.1:6379           # do NOT expose Redis/Temporal publicly
#   TEMPORAL_HOST_PORT=127.0.0.1:7233
#   TEMPORAL_UI_HOST_PORT=127.0.0.1:8080     # reach it through an SSH tunnel

# 3. Start
docker compose up --build -d
docker compose ps                            # wait until everything is healthy

# 4. Open port 3000: allow inbound TCP 3000 in the cloud security group / firewall,
#    and on the host if ufw is active:
sudo ufw allow 3000/tcp
curl http://<vm-ip>:3000/health
```

**Optional nginx reverse proxy** (TLS termination on 80/443). Set `API_HOST_PORT=127.0.0.1:3000` and
`TRUST_PROXY=true` in `.env`, then `docker compose up -d`:

```nginx
server {
  listen 80;
  server_name hotels.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 40s;            # > WORKFLOW_EXECUTION_TIMEOUT (30s)
  }
}
```

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp hotels.conf /etc/nginx/sites-available/ && sudo ln -s ../sites-available/hotels.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d hotels.example.com   # optional HTTPS
```

To reach the Temporal UI securely, use `ssh -L 8080:127.0.0.1:8080 user@vm`, then open <http://localhost:8080>.

### Temporal Cloud instead of the bundled server Temporal Cloud

`config.ts` already supports both Temporal Cloud auth methods, so this needs no code changes:

```dotenv
TEMPORAL_NAMESPACE=<namespace>.<account-id>

# Option 1 — API key (TLS is implied)
TEMPORAL_ADDRESS=<region>.<cloud>.api.temporal.io:7233
TEMPORAL_API_KEY=<api key>

# Option 2 — mTLS (mount the files into the api and worker containers)
TEMPORAL_ADDRESS=<namespace>.<account-id>.tmprl.cloud:7233
TEMPORAL_TLS_CERT_PATH=/certs/client.pem
TEMPORAL_TLS_KEY_PATH=/certs/client.key
```

Then run only Redis and the app; the local `temporal`, `postgresql` and `temporal-ui` services aren't needed:

```bash
docker compose up -d redis
docker compose up -d --no-deps --build api worker
```

For mTLS, add `volumes: ['./certs:/certs:ro']` to `api` and `worker`. Use the Temporal Cloud UI instead of the
local one.
