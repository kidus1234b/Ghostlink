#!/bin/bash
# Serve the app over HTTPS and bring up the Ghost Mesh bridge alongside it.
#
# The browser build cannot start a process on its own, so opening index.html
# without a bridge left the app with nothing to connect to — which is how a
# missing bridge came to be reported as an unreachable peer. Starting both here
# means the normal way of running the app has a mesh node behind it.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_PORT="${GMP_BRIDGE_PORT:-3002}"
HTTPS_PORT="${GHOSTLINK_HTTPS_PORT:-8443}"
BRIDGE_PID=""

cleanup() {
  if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "Stopping Ghost Mesh bridge (pid $BRIDGE_PID)"
    kill "$BRIDGE_PID" 2>/dev/null
    wait "$BRIDGE_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

# Reuse a bridge that is already listening rather than failing on EADDRINUSE.
if (exec 3<>/dev/tcp/127.0.0.1/"$BRIDGE_PORT") 2>/dev/null; then
  exec 3<&- 2>/dev/null
  echo "Ghost Mesh bridge already listening on 127.0.0.1:$BRIDGE_PORT — reusing it"
else
  if [ ! -f "$ROOT/gmp-core/dist/gmp-bridge.js" ]; then
    echo "gmp-core is not built. Run: cd gmp-core && npm run build" >&2
    exit 1
  fi
  echo "Starting Ghost Mesh bridge on 127.0.0.1:$BRIDGE_PORT"
  node "$ROOT/gmp-core/dist/gmp-bridge.js" &
  BRIDGE_PID=$!

  # Give it a moment, then confirm it actually bound the port. Reporting
  # success for a bridge that died on startup is the failure this whole change
  # is about.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.3
    if (exec 3<>/dev/tcp/127.0.0.1/"$BRIDGE_PORT") 2>/dev/null; then
      exec 3<&- 2>/dev/null
      echo "Ghost Mesh bridge is up (pid $BRIDGE_PID)"
      break
    fi
    if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
      echo "Ghost Mesh bridge exited during startup — the app will report the bridge as not running" >&2
      BRIDGE_PID=""
      break
    fi
  done
fi

cd "$ROOT" || exit 1
python3 -c "
import ssl, http.server
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('cert.pem', 'key.pem')
httpd = http.server.HTTPServer(('0.0.0.0', $HTTPS_PORT), http.server.SimpleHTTPRequestHandler)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
print('Serving HTTPS on https://0.0.0.0:$HTTPS_PORT')
httpd.serve_forever()
"
