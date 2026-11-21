#!/usr/bin/env bash
# First-time (and re-runnable) setup of hotel-offer-orchestrator on Ubuntu 24.04.
#
#   curl -fsSL https://raw.githubusercontent.com/Vanisha-vc5/hotel-offer-orchestrator/main/deploy/setup-vm.sh -o setup-vm.sh
#   REPO_URL=https://github.com/Vanisha-vc5/hotel-offer-orchestrator.git PUBLIC_DOMAIN=hotels.example.com bash setup-vm.sh
#
# Idempotent: every step checks before it acts, so running it again is safe.
# PUBLIC_DOMAIN is optional; without it the script uses <public-ip>.sslip.io.
set -euo pipefail

REPO_URL="${REPO_URL:?set REPO_URL to the git URL of the repository}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/hotel-offer-orchestrator}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

if [[ $EUID -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi

log "Installing base packages"
$SUDO apt-get update -y
$SUDO apt-get install -y ca-certificates curl git ufw openssl

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine + Compose plugin"
  curl -fsSL https://get.docker.com | $SUDO sh
else
  log "Docker already installed: $(docker --version)"
fi
$SUDO systemctl enable --now docker
if [[ -n "${SUDO}" ]] && ! id -nG "$USER" | grep -qw docker; then
  $SUDO usermod -aG docker "$USER"
  echo "Added $USER to the docker group (takes effect on next login; using sudo for now)."
fi
if ! docker info >/dev/null 2>&1; then COMPOSE=(sudo "${COMPOSE[@]}"); fi

log "Configuring the firewall (ufw: 22, 80, 443)"
$SUDO ufw allow 22/tcp >/dev/null
$SUDO ufw allow 80/tcp >/dev/null
$SUDO ufw allow 443/tcp >/dev/null
$SUDO ufw allow 443/udp >/dev/null
$SUDO ufw --force enable >/dev/null
$SUDO ufw status | sed -n '1,12p'

log "Fetching the code into ${APP_DIR}"
if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" fetch --quiet origin "${BRANCH}"
  git -C "${APP_DIR}" checkout --quiet "${BRANCH}"
  git -C "${APP_DIR}" pull --ff-only --quiet origin "${BRANCH}"
else
  $SUDO mkdir -p "${APP_DIR}"
  $SUDO chown "$(id -u):$(id -g)" "${APP_DIR}"
  git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
fi
cd "${APP_DIR}"

set_env() { # set_env KEY VALUE — replace or append in .env
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
get_env() { grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }

if [[ ! -f .env ]]; then
  log "Creating .env from .env.example"
  cp .env.example .env
  set_env NODE_ENV production
  # A public endpoint must not run up LLM costs: rules parser only unless you opt in later.
  set_env LLM_PROVIDER none
  set_env ADMIN_TOKEN "$(openssl rand -hex 24)"
  set_env POSTGRES_PASSWORD "$(openssl rand -hex 16)"
else
  log ".env exists; keeping secrets"
  [[ -n "$(get_env ADMIN_TOKEN)" ]] || set_env ADMIN_TOKEN "$(openssl rand -hex 24)"
fi

if [[ -z "${PUBLIC_DOMAIN:-}" ]]; then
  PUBLIC_DOMAIN="$(get_env PUBLIC_DOMAIN)"
fi
if [[ -z "${PUBLIC_DOMAIN}" ]]; then
  IP="$(curl -fsS4 https://api.ipify.org || curl -fsS4 https://ifconfig.me)"
  PUBLIC_DOMAIN="${IP//./-}.sslip.io"
  echo "No PUBLIC_DOMAIN given; using ${PUBLIC_DOMAIN}"
fi
set_env PUBLIC_DOMAIN "${PUBLIC_DOMAIN}"
chmod 600 .env

log "Building and starting the stack (first run takes a few minutes)"
"${COMPOSE[@]}" up -d --build --wait --wait-timeout 600
"${COMPOSE[@]}" ps

log "Done"
cat <<EOF
  Public URL:    https://${PUBLIC_DOMAIN}
  Try:           curl https://${PUBLIC_DOMAIN}/health
  API docs:      https://${PUBLIC_DOMAIN}/docs
  Admin token:   grep ADMIN_TOKEN ${APP_DIR}/.env   (send as x-admin-token)
  Temporal UI:   ssh -L 8080:127.0.0.1:8080 $(whoami)@<this-vm>  then open http://localhost:8080
  Update later:  bash ${APP_DIR}/deploy/update.sh
EOF
