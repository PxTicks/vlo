#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${VLO_HOST:-127.0.0.1}"
PORT="${VLO_PORT:-6332}"
NO_BROWSER=false
PYTHON_BIN="$SCRIPT_DIR/backend/.venv/bin/python"

for arg in "$@"; do
    case "$arg" in
        --no-browser) NO_BROWSER=true ;;
        --host=*) HOST="${arg#*=}" ;;
        --port=*) PORT="${arg#*=}" ;;
    esac
done

# Verify installation
if [ ! -x "$PYTHON_BIN" ]; then
    echo "Error: Backend not installed. Run ./install.sh first."
    exit 1
fi
if [ ! -f "$SCRIPT_DIR/frontend/dist/index.html" ]; then
    echo "Warning: Frontend not built. Run ./install.sh or npm run build."
fi

# Open browser after short delay
if [ "$NO_BROWSER" = false ]; then
    (sleep 2 && "$PYTHON_BIN" -m webbrowser "http://${HOST}:${PORT}" 2>/dev/null) &
fi

echo "Starting VLO at http://${HOST}:${PORT}"
echo "Press Ctrl+C to stop."
echo ""

cd "$SCRIPT_DIR/backend"
"$PYTHON_BIN" -m uvicorn main:app --host "$HOST" --port "$PORT"
