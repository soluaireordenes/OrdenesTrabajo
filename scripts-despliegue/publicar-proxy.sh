#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# Publica el proxy (proxy-seguridad/cloudflare-proxy.js) en Cloudflare y
# comprueba que /ping responda la versión del archivo (auditoría O-01).
#
# Conserva lo que ya tiene el Worker sin nombrarlo aquí: sus secretos
# (SESSION_SECRET, PIN_PEPPER, la cuenta de servicio…) y el espacio KV
# BLOQUEOS ("keep_bindings"). Así no hay ningún identificador en el código.
#
# Necesita dos variables (en GitHub, como secretos del repositorio):
#   CF_TOKEN   token de la API de Cloudflare con permiso "Workers Scripts: Edit"
#   CF_CUENTA  el Account ID de Cloudflare
# Sin ellas no publica nada y lo dice.
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${CF_TOKEN:-}" ] || [ -z "${CF_CUENTA:-}" ]; then
  echo "::warning::Faltan los secretos CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID: el proxy NO se publicó."
  exit 0
fi

ARCHIVO=proxy-seguridad/cloudflare-proxy.js
VERSION=$(grep -oE "const VERSION_PROXY = '[^']+'" "$ARCHIVO" | grep -oE "[0-9]{4}-[0-9]{2}-[0-9]{2}")
URL_PROXY=${URL_PROXY:-https://solucionaire-proxy.soluaire-ordenes.workers.dev}
META=$(mktemp)
cat > "$META" <<'JSON'
{"main_module": "worker.js", "compatibility_date": "2026-10-05", "compatibility_flags": [],
 "keep_bindings": ["secret_text", "kv_namespace"], "logpush": false,
 "observability": {"enabled": true, "head_sampling_rate": 1,
   "logs": {"enabled": true, "head_sampling_rate": 1, "persist": true, "invocation_logs": true}}}
JSON

echo "Publicando el proxy, versión $VERSION…"
RESP=$(curl -sS -X PUT "https://api.cloudflare.com/client/v4/accounts/$CF_CUENTA/workers/scripts/solucionaire-proxy" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -F "metadata=@$META;type=application/json" \
  -F "worker.js=@$ARCHIVO;filename=worker.js;type=application/javascript+module")
echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('Cloudflare:', 'publicado' if d.get('success') else d.get('errors')); sys.exit(0 if d.get('success') else 1)"

# Cloudflare tarda unos segundos en servir la versión nueva en todas partes.
for i in $(seq 1 12); do
  PUBLICADA=$(curl -sS -H "Origin: https://soluaireordenes.github.io" "$URL_PROXY/ping" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',''))" || true)
  if [ "$PUBLICADA" = "$VERSION" ]; then echo "El proxy responde la versión $PUBLICADA."; exit 0; fi
  sleep 5
done
echo "::error::El proxy se publicó, pero /ping responde '$PUBLICADA' y el archivo dice '$VERSION'."
exit 1
