#!/usr/bin/env bash
set -euo pipefail

# Start_App_Linux.sh
# Linux-Äquivalent zu deinem Windows-BAT:
# - nimmt portable Python je nach Architektur
# - startet ../APP/app.py und reicht alle Argumente durch
# - hält das Terminal offen, wenn direkt gestartet

BASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Optional: executable-bit setzen (wie bei dir gewünscht)
chmod +x "$BASE_DIR/../PORTABLE_linux_amd/python/bin/python3" 2>/dev/null || true
chmod +x "$BASE_DIR/../PORTABLE_linux_aarch64/python/bin/python3" 2>/dev/null || true
chmod +x "$BASE_DIR/../PORTABLE_linux_amd/python/bin/python" 2>/dev/null || true
chmod +x "$BASE_DIR/../PORTABLE_linux_aarch64/python/bin/python" 2>/dev/null || true

resolve_python() {
  local arch
  arch="$(uname -m)"

  if [[ "$arch" == "x86_64" || "$arch" == "amd64" ]]; then
    if [[ -x "$BASE_DIR/../PORTABLE_linux_amd/python/bin/python3" ]]; then
      echo "$BASE_DIR/../PORTABLE_linux_amd/python/bin/python3"; return 0
    fi
    if [[ -x "$BASE_DIR/../PORTABLE_linux_amd/python/bin/python" ]]; then
      echo "$BASE_DIR/../PORTABLE_linux_amd/python/bin/python"; return 0
    fi
  elif [[ "$arch" == "aarch64" || "$arch" == "arm64" ]]; then
    if [[ -x "$BASE_DIR/../PORTABLE_linux_aarch64/python/bin/python3" ]]; then
      echo "$BASE_DIR/../PORTABLE_linux_aarch64/python/bin/python3"; return 0
    fi
    if [[ -x "$BASE_DIR/../PORTABLE_linux_aarch64/python/bin/python" ]]; then
      echo "$BASE_DIR/../PORTABLE_linux_aarch64/python/bin/python"; return 0
    fi
  else
    # unbekannt -> probiere beide
    if [[ -x "$BASE_DIR/../PORTABLE_linux_amd/python/bin/python3" ]]; then
      echo "$BASE_DIR/../PORTABLE_linux_amd/python/bin/python3"; return 0
    fi
    if [[ -x "$BASE_DIR/../PORTABLE_linux_aarch64/python/bin/python3" ]]; then
      echo "$BASE_DIR/../PORTABLE_linux_aarch64/python/bin/python3"; return 0
    fi
  fi

  # Fallback: system python3
  if command -v python3 >/dev/null 2>&1; then
    command -v python3; return 0
  fi

  echo ""
  return 1
}

PYTHON_BIN="$(resolve_python || true)"
SCRIPT="$BASE_DIR/../APP/app.py"

if [[ -z "$PYTHON_BIN" ]]; then
  echo "[FEHLER] Python nicht gefunden (portable oder systemweit)."
  echo "Erwartet z.B.: ../PORTABLE_linux_amd/python/bin/python3"
  echo "         oder: ../PORTABLE_linux_aarch64/python/bin/python3"
  exit 1
fi

if [[ ! -f "$SCRIPT" ]]; then
  echo "[FEHLER] Script nicht gefunden: $SCRIPT"
  exit 1
fi

# App starten (Argumente wie bei %* durchreichen)
"$PYTHON_BIN" "$SCRIPT" "$@"
rc=$?

# "pause" wie im BAT: nur wenn interaktives Terminal
if [[ -t 0 && -t 1 ]]; then
  echo
  read -r -p "Enter zum Schließen..." _
fi

exit $rc
