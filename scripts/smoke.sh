#!/usr/bin/env bash
# End-to-end smoke test of an installed Homeport, used by CI for the Docker image and the Linux installer.
#
#   scripts/smoke.sh setup   <url> <flavor> <command that prints the setup code>
#   scripts/smoke.sh resumed <url>          # after a restart: still protected, Caddy brought back
set -euo pipefail
MODE=$1 URL=$2
PW='ci-harbour-lantern-9'
JAR=$(mktemp)
H=(-H 'X-Homeport: 1' -H 'Content-Type: application/json')
ok() { printf '  ✓ %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

for _ in $(seq 1 60); do curl -sf "$URL/api/auth/status" >/dev/null && break; sleep 2; done
status=$(curl -sf "$URL/api/auth/status") || fail "Homeport did not answer at $URL"
echo "status: $status"

if [[ $MODE == setup ]]; then
  FLAVOR=$3 CODE_CMD=$4
  [[ $(jq -r .flavor <<<"$status") == "$FLAVOR" ]] || fail "flavor is not $FLAVOR"
  [[ $(jq -r .passwordSet <<<"$status") == false ]] || fail "a password is already set"
  [[ $(jq -r .local <<<"$status") == false ]] || fail "the test must come from another address"
  ok "fresh install, flavor $FLAVOR, seen as remote"

  code=$(eval "$CODE_CMD")
  [[ $code =~ ^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$ ]] || fail "no setup code (got '$code')"
  ok "setup code available"

  [[ $(curl -s -o /dev/null -w '%{http_code}' "$URL/api/state") == 403 ]] || fail "API open before a password exists"
  wrong=$(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" -X POST "$URL/api/auth/setup" \
    -d "{\"password\":\"$PW\",\"setupCode\":\"AAAA-AAAA-AAAA-AAAA\"}")
  [[ $wrong == 403 ]] || fail "wrong setup code was accepted ($wrong)"
  ok "API closed and wrong code refused"

  curl -sf -c "$JAR" "${H[@]}" -X POST "$URL/api/auth/setup" -d "{\"password\":\"$PW\",\"setupCode\":\"$code\"}" >/dev/null ||
    fail "setup with the right code failed"
  ok "password set with the setup code"
else
  [[ $(jq -r .passwordSet <<<"$status") == true ]] || fail "password lost after restart"
  [[ $(curl -s -o /dev/null -w '%{http_code}' "$URL/api/state") == 401 ]] || fail "API open without a session"
  curl -sf -c "$JAR" "${H[@]}" -X POST "$URL/api/auth/login" -d "{\"password\":\"$PW\"}" >/dev/null || fail "sign-in failed"
  ok "still protected after restart; signed in"
fi

st=$(curl -sf -b "$JAR" "$URL/api/status")
echo "tools: $(jq -c '{caddy: .caddy.version, cloudflared: .cloudflared.version, pm2: .pm2.version}' <<<"$st")"
for k in .caddy.version .cloudflared.version .pm2.version; do
  [[ $(jq -r "$k" <<<"$st") != null ]] || fail "$k missing"
done
ok "caddy, cloudflared and pm2 found"

if [[ $MODE == setup ]]; then
  curl -sf -b "$JAR" "${H[@]}" -X POST "$URL/api/caddy/start" >/dev/null || fail "could not start Caddy"
  curl -sf -b "$JAR" "${H[@]}" -X POST "$URL/api/monitoring/start" >/dev/null || fail "could not start monitoring"
  sleep 5 # let Homeport save pm2's process list
fi

for _ in $(seq 1 20); do
  st=$(curl -sf -b "$JAR" "$URL/api/status")
  [[ $(jq -r .caddy.adminUp <<<"$st") == true ]] && break
  sleep 2
done
[[ $(jq -r .caddy.adminUp <<<"$st") == true ]] || fail "Caddy is not running"
ok "Caddy running under pm2"

mon=$(curl -sf -b "$JAR" "$URL/api/monitoring")
echo "monitoring: $(jq -c '[.components[] | {key, version, running}]' <<<"$mon")"
[[ $(jq -r '[.components[] | select(.key == "prometheus")][0].version' <<<"$mon") != null ]] || fail "Prometheus missing"
ok "Prometheus found"
echo "smoke test passed"
