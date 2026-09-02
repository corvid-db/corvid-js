#!/usr/bin/env bash
# size-gate.sh — the wasm bundle-size budget gate.
#
# The engine's CI contract is < 2 MB gzipped for the wasm-linked
# engine (its corvid-wasm size harness, gzip -9). This binding ships
# that engine plus wasm-bindgen glue, so its own budget is set WITH
# MARGIN below the engine reference: 1 MiB (1,048,576 bytes) gzipped
# — ~2.9x headroom over the bootstrap measurement (363 KB), while
# still catching any regression that eats the margin toward the
# engine's hard 2 MB. CI fails if the built artifact exceeds it.
#
# Local development: SIZE_GATE_WASM=<path> overrides the artifact
# location (CI builds first, then gates). shellcheck-clean.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WASM="${SIZE_GATE_WASM:-$ROOT/pkg/corvid_js_bg.wasm}"
BUDGET=1048576 # 1 MiB gzipped (the engine reference is 2 MiB)

[ -f "$WASM" ] || { echo "size-gate: $WASM not found — run 'npm run build' (wasm-pack) first" >&2; exit 1; }

RAW=$(wc -c < "$WASM" | tr -d ' ')
GZ=$(gzip -9 -c "$WASM" | wc -c | tr -d ' ')

echo "size-gate: $(basename "$WASM") raw=$RAW bytes gzipped=$GZ bytes (budget $BUDGET gzipped; engine reference 2 MiB)"

if [ "$GZ" -gt "$BUDGET" ]; then
    echo "::error::gzipped wasm bundle $GZ bytes exceeds the $BUDGET-byte (1 MiB) budget" >&2
    echo "  The budget is a binding contract (docs/PLAN.md §6), set with margin under" >&2
    echo "  the engine's own < 2 MB gzipped CI gate. Shrink the surface or raise the" >&2
    echo "  budget deliberately, in the same commit, with the measurement in the plan." >&2
    exit 1
fi

echo "size-gate: ok — $((GZ * 100 / BUDGET))% of budget used"
