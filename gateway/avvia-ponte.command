#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Installa Node.js LTS da https://nodejs.org"; read; exit 1; }
[ -d node_modules ] || npm ci --omit=dev
open http://localhost:3100 2>/dev/null
while true; do node --env-file=.env src/server.js; echo "Riavvio tra 10 secondi..."; sleep 10; done
