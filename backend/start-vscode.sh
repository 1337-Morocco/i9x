#!/usr/bin/env bash
# Launch code-server (VS Code in the browser) for i9x's "VS Code" app.
# The VSCODE_IPC_* vars are unset so code-server runs as its own server
# instead of acting as a CLI client of the surrounding VS Code remote.
exec env -u VSCODE_IPC_HOOK_CLI -u VSCODE_IPC_HOOK -u VSCODE_GIT_IPC_HANDLE \
  "$HOME/.local/bin/code-server" \
  --auth none \
  --bind-addr 127.0.0.1:8890 \
  --disable-telemetry \
  "${1:-$HOME}"
