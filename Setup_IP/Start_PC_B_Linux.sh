#!/usr/bin/env bash
set -euo pipefail

# Startet NUR den iperf3 Server:
#   -s -p 5201 -i 1 --forceflush

DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IPERF_BASE="$DIR/../IPERF"

# Arch bestimmen und exakt die Dateien aus ../IPERF benutzen
case "$(uname -m)" in
  x86_64|amd64)  IPERF_BIN="$IPERF_BASE/iperf3-amd64" ;;
  aarch64|arm64) IPERF_BIN="$IPERF_BASE/iperf3-arm64v8" ;;
  *)             IPERF_BIN="" ;;
esac

# Executable-Bit setzen (falls nötig)
if [[ -n "${IPERF_BIN}" ]]; then
  chmod +x "$IPERF_BIN" 2>/dev/null || true
fi

# Wenn Arch unbekannt oder Datei fehlt: optional Windows-Exe als Fallback
if [[ -z "${IPERF_BIN}" || ! -f "${IPERF_BIN}" ]]; then
  if [[ -f "$IPERF_BASE/iperf3.exe" ]]; then
    IPERF_BIN="$IPERF_BASE/iperf3.exe"
  else
    echo "[FEHLER] Kein passendes iperf3 Binary gefunden in: $IPERF_BASE"
    echo "Erwartet:"
    echo "  $IPERF_BASE/iperf3-amd64"
    echo "  $IPERF_BASE/iperf3-arm64v8"
    echo "  (optional: $IPERF_BASE/iperf3.exe)"
    exit 1
  fi
fi

# Wenn es kein .exe ist, muss es ausführbar sein
if [[ "$IPERF_BIN" != *.exe && ! -x "$IPERF_BIN" ]]; then
  echo "[FEHLER] Binary ist nicht ausführbar: $IPERF_BIN"
  echo "Tipp (WSL /mnt/c): ggf. in Linux-Dateisystem kopieren oder chmod +x / Mount-Option 'metadata' nutzen."
  exit 1
fi

echo "iperf3 Server läuft. Beenden mit STRG+C"
echo "Binary: $IPERF_BIN"
echo

exec "$IPERF_BIN" -s -p 5201 -i 1 --forceflush
