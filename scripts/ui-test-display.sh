#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# A private X11 lane for UI automation. This script deliberately removes the
# caller's display before doing any work; only Xvfb and the app receive DISPLAY.
unset DISPLAY XAUTHORITY

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "dialog-push" ]]; then
  shift
  exec env -u DISPLAY -u XAUTHORITY node "${repo_root}/scripts/dialog-push.mjs" "$@"
fi

state_root="${repo_root}/.build/ui-test-display"
app="builder"
screenshot=""
ready_file=""
dialog_queue=""
exit_after_probe=0
timeout_seconds="${UI_TEST_TIMEOUT:-3600}"

usage() {
  cat <<'EOF'
Usage: scripts/ui-test-display.sh [builder|photolab] [options]

Options:
  --screenshot <png>   Capture the selected app through CDP Page.captureScreenshot.
  --ready-file <path>  Write DISPLAY, CDP_URL, profile and probe paths when ready.
  --dialog-queue <file> Supply queued dev-only native open/save dialog responses.
  --exit-after-probe   Stop immediately after backend proof/screenshot (self-test mode).
  --timeout <seconds>  Stop and clean up after this time (default: UI_TEST_TIMEOUT or 3600).
  --help               Show this help.

The first hardware result is kept: ANGLE/Vulkan, then NVIDIA EGL PRIME. If
neither is hardware-backed, the script starts a clearly labelled SwiftShader
software session. DISPLAY=:0 is never inherited or contacted.

Queue a response before or during a run with:
  scripts/ui-test-display.sh dialog-push queue.json \
    '{"kind":"open","filePaths":["/data/scan.las"],"canceled":false}'
EOF
}

while (($# > 0)); do
  case "$1" in
    builder | photolab)
      app="$1"
      shift
      ;;
    --screenshot)
      [[ $# -ge 2 ]] || { echo "--screenshot needs a path" >&2; exit 2; }
      screenshot="$2"
      shift 2
      ;;
    --ready-file)
      [[ $# -ge 2 ]] || { echo "--ready-file needs a path" >&2; exit 2; }
      ready_file="$2"
      shift 2
      ;;
    --dialog-queue)
      [[ $# -ge 2 ]] || { echo "--dialog-queue needs a path" >&2; exit 2; }
      dialog_queue="$2"
      shift 2
      ;;
    --exit-after-probe)
      exit_after_probe=1
      shift
      ;;
    --timeout)
      [[ $# -ge 2 ]] || { echo "--timeout needs a value" >&2; exit 2; }
      timeout_seconds="$2"
      shift 2
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || {
  echo "Timeout must be a positive integer" >&2
  exit 2
}
overall_deadline=$((SECONDS + timeout_seconds))

if [[ -n "$dialog_queue" ]]; then
  dialog_queue="$(realpath -m "$dialog_queue")"
  [[ -f "$dialog_queue" ]] || { echo "Dialog queue does not exist: $dialog_queue" >&2; exit 2; }
  node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!Array.isArray(value)) throw new Error("dialog queue must be a JSON array")' "$dialog_queue"
fi

for command_name in Xvfb xauth mcookie systemd-run systemctl curl node pnpm realpath rg ss timeout; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

mkdir -p "$state_root"
chmod 700 "$state_root"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
run_dir="${state_root}/${run_id}"
profile_dir="${run_dir}/profile"
auth_file="${run_dir}/Xauthority"
probe_script="${run_dir}/probe.mjs"
probe_json="${run_dir}/gpu-proof.json"
mkdir -p "$run_dir"
chmod 700 "$run_dir"

xvfb_pid=""
scope_pid=""
scope_unit=""
probe_pid=""
selected_attempt=""

stop_scope() {
  if [[ -n "$scope_unit" ]]; then
    systemctl --user stop "${scope_unit}.scope" >/dev/null 2>&1 || true
  fi
  if [[ -n "$scope_pid" ]]; then
    kill -TERM "$scope_pid" >/dev/null 2>&1 || true
    for _ in {1..50}; do
      kill -0 "$scope_pid" >/dev/null 2>&1 || break
      sleep 0.1
    done
    kill -KILL "$scope_pid" >/dev/null 2>&1 || true
    wait "$scope_pid" >/dev/null 2>&1 || true
  fi
  scope_pid=""
  scope_unit=""
}

cleanup() {
  trap - EXIT INT TERM HUP
  if [[ -n "$probe_pid" ]]; then
    kill -TERM "$probe_pid" >/dev/null 2>&1 || true
    wait "$probe_pid" >/dev/null 2>&1 || true
  fi
  stop_scope
  if [[ -n "$xvfb_pid" ]]; then
    kill -TERM "$xvfb_pid" >/dev/null 2>&1 || true
    wait "$xvfb_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM HUP

display_number=""
for candidate in $(seq 90 199); do
  if [[ ! -e "/tmp/.X${candidate}-lock" && ! -S "/tmp/.X11-unix/X${candidate}" ]]; then
    display_number="$candidate"
    break
  fi
done
[[ -n "$display_number" ]] || {
  echo "No free private X display in :90..:199" >&2
  exit 1
}
child_display=":${display_number}"
display_suffix="${child_display##*:}"
if [[ "${display_suffix%%.*}" == "0" ]]; then
  echo "Refusing to run a child on DISPLAY=${child_display}" >&2
  exit 1
fi

touch "$auth_file"
chmod 600 "$auth_file"
xauth -f "$auth_file" add "$child_display" . "$(mcookie)"
Xvfb "$child_display" -screen 0 1920x1080x24 -nolisten tcp -noreset -auth "$auth_file" \
  >"${run_dir}/xvfb.log" 2>&1 &
xvfb_pid=$!
for _ in {1..100}; do
  [[ -S "/tmp/.X11-unix/X${display_number}" ]] && break
  kill -0 "$xvfb_pid" >/dev/null 2>&1 || {
    echo "Xvfb exited during startup; see ${run_dir}/xvfb.log" >&2
    exit 1
  }
  sleep 0.1
done
[[ -S "/tmp/.X11-unix/X${display_number}" ]] || {
  echo "Xvfb did not create ${child_display}" >&2
  exit 1
}

port="${UI_TEST_CDP_PORT:-9223}"
[[ "$port" =~ ^[0-9]+$ ]] || { echo "UI_TEST_CDP_PORT must be numeric" >&2; exit 2; }
while ss -H -ltn "sport = :${port}" | rg -q .; do
  port=$((port + 1))
done
cdp_url="http://127.0.0.1:${port}"

cat >"$probe_script" <<'EOF'
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { chromium } from 'playwright-core';

const [cdpUrl, app, expected, outputPath, screenshotPath] = process.argv.slice(2);
let browser;
try {
  browser = await chromium.connectOverCDP(cdpUrl);
  const deadline = Date.now() + 150_000;
  let page;
  let runtime;
  while (Date.now() < deadline) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) =>
      app === 'builder' ? /(?:localhost|127\.0\.0\.1):5173/.test(candidate.url()) :
        /(?:localhost|127\.0\.0\.1):5174/.test(candidate.url()),
    );
    if (page) {
      runtime = await page.evaluate((product) => {
        const handle = product === 'builder'
          ? globalThis.__hcadBuilderKernel
          : globalThis.__hcadPhotolabKernel;
        if (!handle?.session?.diagnostics) return null;
        if (product === 'builder' && !document.querySelector('[data-hud-backend]')) {
          if (!globalThis.__hcadUiTestHudRequested) {
            globalThis.__hcadUiTestHudRequested = true;
            [...document.querySelectorAll('button')]
              .find((element) => element.textContent?.trim() === 'HUD')
              ?.click();
          }
          return null;
        }
        const diagnostics = handle.session.diagnostics();
        const hudBackend = document.querySelector('[data-hud-backend]')?.textContent?.trim() ?? null;
        const chipLabel = [...document.querySelectorAll('span')]
          .map((element) => element.textContent?.trim())
          .find((text) => text === 'Hardware rendering' || text === 'Software rendering') ?? null;
        return {
          url: location.href,
          title: document.title,
          rendererBackend: diagnostics.backend,
          capabilities: diagnostics.capabilities,
          hardwarePolicy: diagnostics.hardwarePolicy,
          hudBackend,
          chipLabel,
        };
      }, app).catch(() => null);
      if (runtime) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!page || !runtime) throw new Error(`${app} kernel did not become ready within 150 seconds`);

  const browserSession = await browser.newBrowserCDPSession();
  const systemInfo = await browserSession.send('SystemInfo.getInfo');
  const text = JSON.stringify({ systemInfo, runtime }).toLowerCase();
  const software = /swiftshader|llvmpipe|software rasterizer/.test(text) ||
    runtime.capabilities?.deviceKind === 'cpu' || runtime.rendererBackend === 'software';
  const nvidia = systemInfo.gpu?.devices?.some((device) =>
    Number(device.vendorId) === 0x10de || /nvidia|quadro/.test(JSON.stringify(device).toLowerCase()),
  ) || /nvidia|quadro/.test(JSON.stringify(runtime.capabilities).toLowerCase());
  const hardware = Boolean(nvidia && !software);
  const expectsSoftware = expected === 'software';
  const expectedKernelBackend = expected.startsWith('hardware-webgl2') ? 'webgl2' : null;
  const builderUiMatches = app !== 'builder' || (expectsSoftware
    ? runtime.chipLabel === 'Software rendering' && runtime.hudBackend === 'software'
    : runtime.chipLabel === 'Hardware rendering' &&
      ['webgpu', 'webgl2'].includes(runtime.hudBackend));
  const accepted = expectsSoftware
    ? software && builderUiMatches
    : hardware && builderUiMatches &&
      (expectedKernelBackend === null || runtime.rendererBackend === expectedKernelBackend);
  const proof = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    cdpUrl,
    app,
    expected,
    accepted,
    classification: software ? 'SOFTWARE' : hardware ? 'HARDWARE' : 'UNKNOWN',
    systemInfo,
    runtime,
  };
  await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`);
  if (accepted && screenshotPath) {
    const pageSession = await page.context().newCDPSession(page);
    const capture = await pageSession.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });
    await writeFile(screenshotPath, Buffer.from(capture.data, 'base64'));
  }
  process.exit(accepted ? 0 : 20);
} catch (error) {
  await writeFile(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    cdpUrl,
    app,
    expected,
    accepted: false,
    classification: 'ERROR',
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  }, null, 2)}\n`).catch(() => {});
  process.exit(10);
}
EOF

limit_core_property=1
if ! systemd-run --user --scope -p LimitCORE=0 true \
  >"${run_dir}/systemd-limit-core-check.log" 2>&1; then
  limit_core_property=0
  echo "Note: this systemd rejects LimitCORE= on scope units; enforcing ulimit -c 0 inside the scope." >&2
fi

start_attempt() {
  local attempt="$1"
  local extra_args_json="$2"
  local egl_vendor="$3"
  local prime_offload="$4"
  local viewer_backend="$5"
  local app_log="${run_dir}/${attempt}.log"
  local unit_safe="${run_id}-${attempt//[^a-zA-Z0-9_-]/-}"
  scope_unit="hcad-ui-${unit_safe}"

  rm -rf -- "$profile_dir"
  mkdir -p "$profile_dir"
  if [[ "$attempt" == "software" && "$app" == "builder" ]]; then
    cat >"${profile_dir}/builder-settings.v1.json" <<EOF
{
  "schemaVersion": 1,
  "rendererFallback": {
    "mode": "software",
    "from": "webgl2",
    "reason": "Private UI test display hardware attempts were unavailable",
    "gpu": "SwiftShader",
    "driver": "Electron ANGLE",
    "decidedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  }
}
EOF
  fi

  local -a properties=(
    -p "MemoryMax=${UI_TEST_MEM:-12G}"
    -p MemorySwapMax=0
    -p CPUQuota=400%
  )
  if ((limit_core_property)); then properties+=(-p LimitCORE=0); fi
  local -a dialog_environment=()
  if [[ -n "$dialog_queue" ]]; then
    dialog_environment+=("HIMMELCAD_TEST_DIALOG_QUEUE=${dialog_queue}")
  fi

  systemd-run --user --scope --quiet --unit="$scope_unit" \
    "${properties[@]}" --nice=10 \
    bash -c 'ulimit -c 0; exec env "$@"' bash \
      "DISPLAY=${child_display}" \
      "XAUTHORITY=${auth_file}" \
      "CARGO_TARGET_DIR=${repo_root}/target/${app}" \
      "HIMMELCAD_VITE_HMR=0" \
      "HIMMELCAD_REMOTE_DEBUGGING_PORT=${port}" \
      "HIMMELCAD_ELECTRON_USER_DATA_DIR=${profile_dir}" \
      "${dialog_environment[@]}" \
      "HIMMELCAD_ELECTRON_EXTRA_ARGS_JSON=${extra_args_json}" \
      "HIMMELCAD_GPU=" \
      "VITE_HIMMELCAD_VIEWER_BACKEND=${viewer_backend}" \
      "__EGL_VENDOR_LIBRARY_FILENAMES=${egl_vendor}" \
      "__NV_PRIME_RENDER_OFFLOAD=${prime_offload}" \
      pnpm --dir "$repo_root" --filter "@himmelcad/${app}" dev \
      >"$app_log" 2>&1 &
  scope_pid=$!
}

stop_and_wait_for_port() {
  stop_scope
  for _ in {1..100}; do
    curl --silent --fail --max-time 0.2 "${cdp_url}/json/version" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  echo "CDP port ${port} remained open after stopping ${scope_unit}" >&2
  return 1
}

attempts=(vulkan vulkan-webgl2 egl software)
for attempt in "${attempts[@]}"; do
  case "$attempt" in
    vulkan)
      extra_args='["--use-angle=vulkan","--enable-features=Vulkan,DefaultANGLEVulkan","--enable-unsafe-webgpu","--ozone-platform=x11"]'
      egl_vendor=""
      prime_offload=""
      # V-01c proved that this driver/Electron pair can enumerate WebGPU but
      # cannot sustain surface presentation. Do not call that backend usable;
      # accept this first Vulkan trial only if the viewer lands on WebGL2.
      expected="hardware-webgl2-no-override"
      viewer_backend="automatic"
      ;;
    vulkan-webgl2)
      # Same NVIDIA ANGLE/Vulkan renderer without Chromium's Vulkan compositor.
      # This is the proven hardware-WebGL2 variant of attempt (a).
      extra_args='["--use-angle=vulkan","--enable-features=DefaultANGLEVulkan","--disable-features=Vulkan","--disable-webgpu","--ozone-platform=x11"]'
      egl_vendor=""
      prime_offload=""
      expected="hardware-webgl2"
      viewer_backend="webgl2"
      ;;
    egl)
      extra_args='["--use-gl=egl","--enable-unsafe-webgpu","--ozone-platform=x11"]'
      egl_vendor="/usr/share/glvnd/egl_vendor.d/10_nvidia.json"
      prime_offload="1"
      expected="hardware"
      viewer_backend="webgl2"
      ;;
    software)
      extra_args='["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ozone-platform=x11"]'
      egl_vendor=""
      prime_offload=""
      expected="software"
      viewer_backend="webgl2"
      ;;
  esac

  echo "Starting ${app} attempt ${attempt} on ${child_display} (${cdp_url})"
  start_attempt "$attempt" "$extra_args" "$egl_vendor" "$prime_offload" "$viewer_backend"

  deadline=$((SECONDS + 900))
  ((overall_deadline < deadline)) && deadline="$overall_deadline"
  while ((SECONDS < deadline)); do
    if curl --silent --fail --max-time 0.5 "${cdp_url}/json/version" >/dev/null 2>&1; then break; fi
    kill -0 "$scope_pid" >/dev/null 2>&1 || break
    sleep 0.5
  done

  attempt_probe="${run_dir}/gpu-proof-${attempt}.json"
  attempt_screenshot=""
  [[ -n "$screenshot" ]] && attempt_screenshot="$(realpath -m "$screenshot")"
  [[ -z "$attempt_screenshot" ]] || mkdir -p "$(dirname "$attempt_screenshot")"
  remaining_seconds=$((overall_deadline - SECONDS))
  if ((remaining_seconds <= 0)); then
    echo "UI test timeout reached before ${attempt} probing; cleaning up." >&2
    exit 124
  fi
  ((remaining_seconds > 180)) && remaining_seconds=180
  set +e
  env -u DISPLAY -u XAUTHORITY timeout "${remaining_seconds}s" node "$probe_script" \
    "$cdp_url" "$app" "$expected" "$attempt_probe" "$attempt_screenshot" &
  probe_pid=$!
  wait "$probe_pid"
  probe_status=$?
  probe_pid=""
  set -e
  if ((probe_status == 130 || probe_status == 143)); then
    exit "$probe_status"
  fi
  if ((probe_status == 0)); then
    cp "$attempt_probe" "$probe_json"
    selected_attempt="$attempt"
    break
  fi

  echo "Attempt ${attempt} did not yield ${expected}; proof: ${attempt_probe}" >&2
  stop_and_wait_for_port
done

[[ -n "$selected_attempt" ]] || {
  echo "No usable hardware or labelled software renderer started; see ${run_dir}" >&2
  exit 1
}

# Prove display isolation without connecting to the owner's X server. Every
# process in the owned scope must either inherit the private display or need no
# X display at all; DISPLAY=:0 is a hard failure.
process_display_proof="${run_dir}/process-displays.txt"
control_group="$(systemctl --user show "${scope_unit}.scope" --property=ControlGroup --value)"
if [[ "$control_group" != /user.slice/* || ! -d "/sys/fs/cgroup${control_group}" ]]; then
  echo "Could not resolve the owned scope cgroup: ${control_group}" >&2
  exit 1
fi
{
  echo "scope=${scope_unit}.scope"
  echo "control_group=${control_group}"
  echo "required_display=${child_display}"
  while IFS= read -r pid; do
    [[ -r "/proc/${pid}/environ" ]] || continue
    process_display="$(tr '\0' '\n' <"/proc/${pid}/environ" | sed -n 's/^DISPLAY=//p' | head -1)"
    process_command="$(tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null || true)"
    printf 'pid=%s display=%s command=%s\n' "$pid" "${process_display:-<unset>}" "$process_command"
    display_slot="${process_display##*:}"
    if [[ -n "$process_display" && "${display_slot%%.*}" == "0" ]]; then
      echo "Refusing owned process ${pid}: DISPLAY=${process_display}" >&2
      exit 1
    fi
  done < <(find "/sys/fs/cgroup${control_group}" -name cgroup.procs -type f -exec cat {} + | sort -nu)
} >"$process_display_proof"

if [[ -n "$ready_file" ]]; then
  ready_file="$(realpath -m "$ready_file")"
  mkdir -p "$(dirname "$ready_file")"
  cat >"$ready_file" <<EOF
DISPLAY=${child_display}
XAUTHORITY=${auth_file}
CDP_URL=${cdp_url}
RUN_DIRECTORY=${run_dir}
PROFILE_DIRECTORY=${profile_dir}
HIMMELCAD_TEST_DIALOG_QUEUE=${dialog_queue}
GPU_PROOF=${probe_json}
PROCESS_DISPLAY_PROOF=${process_display_proof}
BACKEND_ATTEMPT=${selected_attempt}
EOF
fi

echo "UI test display: ${child_display}"
echo "CDP URL: ${cdp_url}"
echo "Backend proof: ${probe_json}"
echo "Process display proof: ${process_display_proof}"
echo "Selected backend attempt: ${selected_attempt}"

if ((exit_after_probe)); then exit 0; fi

end_time="$overall_deadline"
while kill -0 "$scope_pid" >/dev/null 2>&1; do
  if ((SECONDS >= end_time)); then
    echo "UI test timeout reached after ${timeout_seconds}s; cleaning up." >&2
    exit 124
  fi
  sleep 1
done
wait "$scope_pid"
