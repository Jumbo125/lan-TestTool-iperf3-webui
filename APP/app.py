import os
import re
import sys
import json
import time
import yaml
import queue
import threading
import subprocess
import locale
import shlex
import datetime
import traceback
import platform
import sys
import stat
from pathlib import Path
from typing import Optional


from flask import Flask, Response, jsonify, render_template, request, stream_with_context

# ============================================================
# PATCH NOTES (2026-02-13)
# - /run_iperf no longer blocks on expensive interface counter reads.
#   Baseline counters are captured inside the worker thread instead.
# - run_cmd now supports a timeout to prevent PowerShell/ethtool hangs
#   from blocking HTTP requests.
# ============================================================

# -----------------------------
# Paths (PyInstaller safe)
# -----------------------------
def base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent

BASE_DIR = base_dir()

# -----------------------------
# Per-run logfile (portable)
# -----------------------------
LOG_DIR = BASE_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

_log_lock = threading.Lock()
_current_log_path: Optional[Path] = None

def _new_log_path() -> Path:
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    return LOG_DIR / f"iperf_{ts}.log"

def _log_write(fp, msg: str):
    try:
        fp.write(msg + "\n")
        fp.flush()
    except Exception:
        pass
    
TEMPLATE_DIR = (BASE_DIR / ".." / "HTML" / "templates").resolve()
STATIC_DIR   = (BASE_DIR / ".." / "HTML" / "static").resolve()

app = Flask(
    __name__,
    template_folder=str(TEMPLATE_DIR),
    static_folder=str(STATIC_DIR),
)

# -----------------------------
# Regex
# -----------------------------
BW_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(K|M|G)bits/sec", re.IGNORECASE)

# Linux ethtool counter names vary by driver. Keep a "useful" superset.
LINUX_COUNTER_KEYS = [
    "rx_crc_errors", "rx_fcs_errors", "rx_errors", "tx_errors",
    "rx_dropped", "tx_dropped", "rx_missed_errors", "rx_length_errors",
    "rx_over_errors", "rx_frame_errors", "rx_fifo_errors",
]

# -----------------------------
# Settings & Config
# -----------------------------
DEFAULT_SETTINGS = {
    "web_host": "0.0.0.0",
    "web_port": 5000,
    "iperf_port": 5201,
    "default_target": "",
    "default_iface": ""
}

def ensure_executable(p: Path) -> None:
    try:
        st = p.stat()
        p.chmod(st.st_mode | stat.S_IXUSR)
    except Exception:
        pass


def load_settings() -> dict:
    p = BASE_DIR / "settings.json"
    if not p.exists():
        return dict(DEFAULT_SETTINGS)
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f) or {}
        merged = dict(DEFAULT_SETTINGS)
        merged.update({k: data[k] for k in data.keys()})
        return merged
    except Exception:
        return dict(DEFAULT_SETTINGS)

def load_env_yaml() -> dict:
    p = BASE_DIR / "env.yaml"
    if not p.exists():
        return {"logos": [], "theme": {}}
    with open(p, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {"logos": [], "theme": {}}

# -----------------------------
# iperf3 executable
# -----------------------------
def iperf3_cmd() -> str:
    # 1) Windows
    if sys.platform.startswith("win"):
        cand = (BASE_DIR / ".." / "IPERF" / "iperf3.exe").resolve()
        print (cand)
        if cand.exists():
            return str(cand)
        return "iperf3"  # fallback: iperf3 im PATH

    # 2) Linux/Unix: Architektur bestimmen
    arch = platform.machine().lower()

    if arch in ("x86_64", "amd64"):
        cand = (BASE_DIR / ".." / "IPERF" / "iperf3-amd64").resolve()
    elif arch in ("aarch64", "arm64"):
        cand = (BASE_DIR / ".." / "IPERF" / "iperf3-arm64v8").resolve()
    else:
        return "iperf3"
        
    if cand.exists():
        ensure_executable(cand)
        return str(cand)

    return "iperf3"

# -----------------------------
# Helpers: safe subprocess
# -----------------------------
def _decode_output(b: bytes) -> str:
    """Decode subprocess output robustly across Windows/Linux locales."""
    if not b:
        return ""

    # PowerShell sometimes emits UTF-16LE when output is redirected/piped.
    if b.count(b"\x00") > len(b) // 10:
        for enc in ("utf-16", "utf-16-le"):
            try:
                return b.decode(enc)
            except UnicodeDecodeError:
                pass

    candidates = [
        "utf-8",
        "cp65001",
        "cp850",
        locale.getpreferredencoding(False),
        "cp1252",
    ]
    for enc in candidates:
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            continue

    return b.decode("utf-8", errors="replace")

def run_cmd(args, shell=False, timeout: Optional[float] = 6.0) -> tuple[int, str]:
    """
    Run a command with a timeout to avoid blocking HTTP handlers
    (PowerShell/ethtool can occasionally hang).
    """
    try:
        p = subprocess.run(
            args,
            shell=shell,
            capture_output=True,
            text=False,
            timeout=timeout if timeout and timeout > 0 else None,
        )
        out_b = (p.stdout or b"") + (p.stderr or b"")
        out = _decode_output(out_b)
        return p.returncode, out.strip()
    except subprocess.TimeoutExpired:
        return 124, f"timeout after {timeout}s: {args}"
    except Exception as e:
        return 1, str(e)

def format_cmd_for_console(cmd: list[str]) -> str:
    if os.name == "nt":
        return subprocess.list2cmdline(cmd)
    return " ".join(shlex.quote(x) for x in cmd)

# -----------------------------
# Bandwidth conversion
# -----------------------------
def convert_bandwidth(value_str: str, target_unit: str) -> float:
    m = BW_RE.search(value_str.strip())
    if not m:
        return 0.0
    number = float(m.group(1))
    src = m.group(2).upper()

    src_factor = {"K": 1_000, "M": 1_000_000, "G": 1_000_000_000}.get(src, 1)
    bits_per_sec = number * src_factor

    target_unit = (target_unit or "Mbits").strip()
    if target_unit not in ("Kbits", "Mbits", "Gbits"):
        mapping = {"Kbps": "Kbits", "Mbps": "Mbits", "Gbps": "Gbits"}
        target_unit = mapping.get(target_unit, "Mbits")

    tgt_factor = {"Kbits": 1_000, "Mbits": 1_000_000, "Gbits": 1_000_000_000}[target_unit]
    return bits_per_sec / tgt_factor

# -----------------------------
# JSON-stream helpers (iperf3 --json-stream)
# -----------------------------
def bps_to_selected_unit(bits_per_sec: float, target_unit: str) -> float:
    target_unit = (target_unit or "Mbits").strip()
    if target_unit not in ("Kbits", "Mbits", "Gbits"):
        mapping = {"Kbps": "Kbits", "Mbps": "Mbits", "Gbps": "Gbits"}
        target_unit = mapping.get(target_unit, "Mbits")

    factor = {"Kbits": 1_000.0, "Mbits": 1_000_000.0, "Gbits": 1_000_000_000.0}[target_unit]
    return float(bits_per_sec) / factor

def extract_interval_bps(data: dict) -> Optional[float]:
    if not isinstance(data, dict):
        return None

    def _bps(obj):
        if isinstance(obj, dict):
            v = obj.get("bits_per_second")
            if isinstance(v, (int, float)):
                return float(v)
        return None

    for key in ("sum_received", "sum"):
        v = _bps(data.get(key))
        if v is not None:
            if key == "sum":
                sender_flag = data.get("sum", {}).get("sender", None)
                if sender_flag is False:
                    return v
                return v
            return v

    v = _bps(data.get("sum_sent"))
    if v is not None:
        return v

    streams = data.get("streams")
    if isinstance(streams, list) and streams:
        vals = []
        for s in streams:
            vv = _bps(s)
            if vv is not None:
                vals.append(vv)
        if vals:
            return sum(vals) if len(vals) > 1 else vals[0]

    return None

# -----------------------------
# Interface listing + stats (Linux/Windows)
# -----------------------------
def list_interfaces() -> list[str]:
    if os.name == "nt":
        # NOTE: PowerShell can be slow to cold-start; use a longer timeout.
        # Also add a CIM fallback for systems where Get-NetAdapter isn't available.
        ps1 = 'Get-NetAdapter | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress'
        code, out = run_cmd(
            ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps1],
            timeout=15.0
        )

        if code == 0 and out:
            try:
                data = json.loads(out)
                if isinstance(data, list):
                    return [x for x in data if isinstance(x, str) and x.strip()]
                if isinstance(data, str) and data.strip():
                    return [data.strip()]
            except Exception:
                pass

        # Fallback (CIM): works even if NetAdapter module is missing
        ps2 = (
            'Get-CimInstance Win32_NetworkAdapter | '
            'Where-Object { $_.NetEnabled -eq $true -and $_.NetConnectionID } | '
            'Select-Object -ExpandProperty NetConnectionID | ConvertTo-Json -Compress'
        )
        code2, out2 = run_cmd(
            ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps2],
            timeout=15.0
        )
        if code2 != 0 or not out2:
            # Log a hint so you can see the root cause in console logs
            try:
                app.logger.warning("list_interfaces failed: ps1 rc=%s out=%r | ps2 rc=%s out=%r",
                                   code, (out or "")[:400], code2, (out2 or "")[:400])
            except Exception:
                pass
            return []

        try:
            data = json.loads(out2)
            if isinstance(data, list):
                return [x for x in data if isinstance(x, str) and x.strip()]
            if isinstance(data, str) and data.strip():
                return [data.strip()]
        except Exception:
            return []
        return []
    else:
        code, out = run_cmd(["bash", "-lc", "ip -o link show | awk -F': ' '{print $2}'"], timeout=3.0)
        if code != 0:
            return []
        names = [x.strip() for x in out.splitlines() if x.strip() and x.strip() != "lo"]
        return names

def linux_link_info(iface: str) -> dict:
    code, out = run_cmd(["ethtool", iface], timeout=4.0)
    if code != 0:
        return {"ok": False, "error": out}

    def grab(key):
        m = re.search(rf"^{re.escape(key)}:\s*(.*)$", out, re.MULTILINE)
        return m.group(1).strip() if m else ""

    return {
        "ok": True,
        "speed": grab("Speed"),
        "duplex": grab("Duplex"),
        "link": grab("Link detected"),
        "auto": grab("Auto-negotiation"),
    }

def linux_counters(iface: str) -> dict:
    code, out = run_cmd(["ethtool", "-S", iface], timeout=5.0)
    if code != 0:
        return {"ok": False, "error": out, "counters": {}}
    counters = {}
    for line in out.splitlines():
        if ":" not in line:
            continue
        k, v = [x.strip() for x in line.split(":", 1)]
        if k in LINUX_COUNTER_KEYS:
            try:
                counters[k] = int(v)
            except Exception:
                pass
    return {"ok": True, "counters": counters}

def windows_link_info(iface: str) -> dict:
    ps = (
        f'Get-NetAdapter -Name "{iface}" | '
        'Select-Object Name, Status, LinkSpeed | ConvertTo-Json'
    )
    code, out = run_cmd(["powershell", "-NoProfile", "-Command", ps], timeout=6.0)
    if code != 0 or not out:
        return {"ok": False, "error": out}
    try:
        data = json.loads(out)
        return {
            "ok": True,
            "speed": data.get("LinkSpeed", ""),
            "duplex": "",
            "link": data.get("Status", ""),
            "auto": "",
        }
    except Exception:
        return {"ok": False, "error": out}

def windows_counters(iface: str) -> dict:
    ps = (
        f'Get-NetAdapterStatistics -Name "{iface}" | '
        "Select-Object ReceivedErrors, OutboundErrors, ReceivedDiscarded, OutboundDiscarded | "
        "ConvertTo-Json"
    )
    code, out = run_cmd(["powershell", "-NoProfile", "-Command", ps], timeout=6.0)
    if code != 0 or not out:
        return {"ok": False, "error": out, "counters": {}}
    try:
        data = json.loads(out)
        counters = {}
        for k in ["ReceivedErrors", "OutboundErrors", "ReceivedDiscarded", "OutboundDiscarded"]:
            v = data.get(k, 0)
            try:
                counters[k] = int(v)
            except Exception:
                pass
        return {"ok": True, "counters": counters}
    except Exception:
        return {"ok": False, "error": out, "counters": {}}

def get_link_info(iface: str) -> dict:
    if not iface:
        return {"ok": False, "error": "no iface"}
    return windows_link_info(iface) if os.name == "nt" else linux_link_info(iface)

def get_counters(iface: str) -> dict:
    if not iface:
        return {"ok": False, "error": "no iface", "counters": {}}
    return windows_counters(iface) if os.name == "nt" else linux_counters(iface)

# -----------------------------
# iperf run state (thread-safe)
# -----------------------------
_state_lock = threading.Lock()
_output_q: "queue.Queue[Optional[str]]" = queue.Queue()
_running = False
_selected_unit = "Mbits"
_streams = 1
_iface = ""
_baseline_counters = {}
_test_started_at = 0.0
_proc: Optional[subprocess.Popen] = None

def stop_proc():
    global _proc
    if _proc and _proc.poll() is None:
        try:
            _proc.terminate()
            time.sleep(0.5)
            if _proc.poll() is None:
                _proc.kill()
        except Exception:
            pass
    _proc = None

# -----------------------------
# Routes
# -----------------------------
@app.route("/")
def index():
    config = load_env_yaml()
    settings = load_settings()
    return render_template(
        "index.html",
        default_target=settings.get("default_target", ""),
        default_port=settings.get("iperf_port", 5201),
        default_iface=settings.get("default_iface", ""),
        logos=config.get("logos", []),
        theme=config.get("theme", {}),
    )

@app.route("/test")
def test():
    return index()

@app.route("/api/interfaces")
def api_interfaces():
    return jsonify({"interfaces": list_interfaces()})

@app.route("/api/stats")
def api_stats():
    global _baseline_counters, _test_started_at
    iface = request.args.get("iface", "") or _iface
    link = get_link_info(iface)
    counters_now = get_counters(iface)

    delta = {}
    if counters_now.get("ok") and isinstance(counters_now.get("counters"), dict):
        now = counters_now["counters"]
        for k, v in now.items():
            base = _baseline_counters.get(k, v)
            try:
                delta[k] = int(v) - int(base)
            except Exception:
                pass

    with _state_lock:
        running = _running
        unit = _selected_unit
        streams = _streams
        started_at = _test_started_at

    return jsonify({
        "iface": iface,
        "running": running,
        "unit": unit,
        "streams": streams,
        "started_at": started_at,
        "link": link,
        "counters": counters_now,
        "delta": delta
    })

def _cmd_str(cmd: list[str]) -> str:
    if os.name == "nt":
        return subprocess.list2cmdline(cmd)
    return " ".join(shlex.quote(x) for x in cmd)

@app.route("/run_iperf", methods=["POST"])
def run_iperf():
    global _output_q, _running, _selected_unit, _streams, _iface, _baseline_counters, _test_started_at, _proc
    global _current_log_path

    app.logger.info("RUN pid=%s tid=%s qid(before)=%s", os.getpid(), threading.get_ident(), id(_output_q))
    data = request.get_json(silent=True) or {}
    protocol = (data.get("protocol") or "tcp").lower()
    mode = (data.get("mode") or "upload").lower()

    settings = load_settings()

    target = data.get("target") or ""
    port = str(data.get("port") or settings.get("iperf_port", 5201))
    _streams = int(data.get("streams") or 1)
    bandwidth = str(data.get("bandwidth") or "0")
    _selected_unit = data.get("units") or "Mbits"
    _iface = data.get("iface") or settings.get("default_iface", "")

    duration = str(data.get("duration") or "10")
    interval = str(data.get("interval") or "1")

    # Avoid long "silent hangs" if the server is unreachable.
    # iperf3 in --json-stream mode may output nothing until the control connection is established.
    connect_timeout_ms = str(data.get("connect_timeout_ms") or "3000")

    if not target:
        return jsonify({"error": "Target is required."}), 400
    if protocol not in ("tcp", "udp"):
        return jsonify({"error": 'Invalid protocol. Must be "tcp" or "udp".'}), 400
    if _streams <= 0:
        return jsonify({"error": "Streams must be a positive integer."}), 400

    cmd = [iperf3_cmd(), "-c", target, "-p", str(port), "-P", str(_streams)]
    cmd += ["-i", interval, "-t", duration]
    cmd.append("--json-stream")
    cmd.append("--forceflush")
    cmd += ["--connect-timeout", connect_timeout_ms]

    if protocol == "udp":
        cmd += ["-u", "-b", bandwidth]
    if mode == "download":
        cmd.append("-R")

    cmd_str = _cmd_str(cmd)
    app.logger.info("iperf3 cmd: %s", cmd_str)

    # neues Logfile pro Run
    with _log_lock:
        _current_log_path = _new_log_path()
        lp = _current_log_path
    app.logger.info("iperf logfile: %s", str(lp))

    # NOTE: The expensive baseline counter read was previously done here
    # and could block for a long time (PowerShell/ethtool hangs).
    # We now reset quickly and capture baseline in the worker thread.
    with _state_lock:
        stop_proc()
        _output_q = queue.Queue()
        _running = True
        _test_started_at = time.time()
        _baseline_counters = {}

    # capture immutable values for this run (avoid races if user starts another run quickly)
    run_iface = _iface
    run_unit = _selected_unit
    run_cmd_str = cmd_str

    _output_q.put(f"CMD: {run_cmd_str}")
    _output_q.put(f"LOGFILE: {lp}")

    app.logger.info("RUN pid=%s qid(after)=%s qsize=%s", os.getpid(), id(_output_q), _output_q.qsize())

    def worker(out_q: "queue.Queue[str|None]", cmd_to_run: list[str], iface_for_run: str, unit_for_run: str):
        global _running, _proc, _baseline_counters
        global _current_log_path

        out_q.put("WORKER: started")

        # Baseline counters (moved here so /run_iperf returns immediately)
        try:
            base = get_counters(iface_for_run)
            with _state_lock:
                _baseline_counters = base.get("counters", {}) if base.get("ok") else {}
        except Exception:
            with _state_lock:
                _baseline_counters = {}

        with _log_lock:
            log_path = _current_log_path or _new_log_path()

        try:
            with open(log_path, "a", encoding="utf-8", errors="replace") as fp:
                _log_write(fp, "=== NEW RUN ===")
                _log_write(fp, f"time: {datetime.datetime.now().isoformat()}")
                _log_write(fp, f"cwd: {os.getcwd()}")
                _log_write(fp, f"cmd: {_cmd_str(cmd_to_run)}")
                _log_write(fp, f"connect_timeout_ms: {connect_timeout_ms}")
                _log_write(fp, f"iface: {iface_for_run}")
                _log_write(fp, f"unit: {unit_for_run}")

                creationflags = 0
                if os.name == "nt":
                    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)

                proc = subprocess.Popen(
                    cmd_to_run,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=False,
                    bufsize=0,
                    creationflags=creationflags,
                )
                _proc = proc
                out_q.put(f"WORKER: iperf pid={proc.pid}")
                _log_write(fp, f"pid: {proc.pid}")

                if proc.stdout is not None:
                    for raw in iter(proc.stdout.readline, b""):
                        line = _decode_output(raw).strip()
                        if not line:
                            continue

                        # alles in Datei loggen
                        _log_write(fp, f"OUT: {line}")

                        try:
                            obj = json.loads(line)
                        except Exception:
                            # nicht-JSON Text direkt an UI/Stream
                            out_q.put(line)
                            continue

                        event = obj.get("event")
                        data = obj.get("data")

                        if event == "interval":
                            if isinstance(data, dict):
                                bps = extract_interval_bps(data)
                                if bps is not None:
                                    v = bps_to_selected_unit(bps, unit_for_run)
                                    out_q.put(f"{v}")
                            continue

                        if event == "end":
                            if isinstance(data, dict):
                                bps = extract_interval_bps(data)
                                if bps is not None:
                                    v = bps_to_selected_unit(bps, unit_for_run)
                                    out_q.put(f"{v}")
                            continue

                        if event == "error":
                            out_q.put(f"ERROR: {data}")
                            continue

                        if event == "server_output_text":
                            out_q.put((data or "").strip() if isinstance(data, str) else str(data))
                            continue

                proc.wait()
                _log_write(fp, f"returncode: {proc.returncode}")

                if proc.returncode not in (0, None):
                    out_q.put(f"iperf3 exited with code {proc.returncode}")

        except Exception as e:
            out_q.put(f"ERROR: {e}")
            try:
                with open(log_path, "a", encoding="utf-8", errors="replace") as fp:
                    _log_write(fp, "EXCEPTION:")
                    _log_write(fp, traceback.format_exc())
            except Exception:
                pass
        finally:
            out_q.put(None)
            with _state_lock:
                _running = False

    threading.Thread(target=worker, args=(_output_q, cmd, run_iface, run_unit), daemon=True).start()

    with _log_lock:
        lp_str = str(_current_log_path) if _current_log_path else ""
    return jsonify({"status": "iperf3 started", "cmd": cmd_str, "logfile": lp_str}), 200


@app.route("/stream_iperf", methods=["GET"])
def stream_iperf():
    try:
        print(
            f"STREAM connect pid={os.getpid()} tid={threading.get_ident()} qid={id(_output_q)} qsize={_output_q.qsize()}",
            flush=True,
        )
    except Exception:
        pass

    def generate():
        # Comment + retry as complete SSE frames (end with blank line)
        yield ": stream\n\n"
        yield "retry: 1000\n\n"
        yield "data: stream_connected\n\n"

        last_val = 0.0
        q = _output_q

        try:
            while True:
                try:
                    item = q.get(timeout=1.0)
                except queue.Empty:
                    # keepalive ping
                    yield "data: ping\n\n"
                    continue

                if item is None:
                    yield "data: -1\n\n"
                    break

                s = (item or "").strip()
                if not s:
                    continue
                low = s.lower()

                # CMD/LOGFILE/etc direkt weitergeben
                if s.startswith("CMD:") or s.startswith("LOGFILE:") or s.startswith("WORKER:"):
                    yield f"data: {s}\n\n"
                    continue

                # Worker-Fehler
                if low.startswith("error:"):
                    yield f"data: {s}\n\n"
                    yield "data: -1\n\n"
                    break

                # typische iperf Fehlertexte
                if (
                    low.startswith("iperf3:") or
                    "unable to connect" in low or
                    "connection refused" in low or
                    "timed out" in low or
                    "failed" in low or
                    "no route" in low
                ):
                    yield f"data: ERROR: {s}\n\n"
                    yield "data: -1\n\n"
                    break

                # "server busy"
                if "server is busy" in low or "unable to send control message" in low:
                    yield "data: server is busy\n\n"
                    continue

                # nackte Zahl (vom JSON-stream Parser)
                if re.fullmatch(r"-?\d+(?:\.\d+)?", s):
                    try:
                        v = float(s)
                    except Exception:
                        v = last_val
                    last_val = v
                    yield f"data: {v}\n\n"
                    continue

                # iperf Textzeile mit "... Mbits/sec" (Fallback)
                m = BW_RE.search(s)
                if m:
                    v = convert_bandwidth(m.group(0), _selected_unit)
                    if ("[SUM]" in s) and ("sender" not in low):
                        last_val = v
                        yield f"data: {v}\n\n"
                    else:
                        if _streams == 1:
                            last_val = v
                            yield f"data: {v}\n\n"
                        else:
                            yield f"data: {last_val}\n\n"
                    continue

                # sonstige Textausgabe (debug/info)
                yield f"data: {s}\n\n"

        except GeneratorExit:
            return
        except Exception as e:
            # If something goes wrong mid-stream, send one final error frame
            try:
                yield f"data: ERROR: stream exception: {e}\n\n"
                yield "data: -1\n\n"
            except Exception:
                pass

    return Response(
        stream_with_context(generate()),
        status=200,
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/iperf_version", methods=["GET"])
def iperf_version():
    code, out = run_cmd([iperf3_cmd(), "-v"], timeout=5.0)
    first = out.splitlines()[0] if out else "unknown"
    code2, host = run_cmd(["hostname"], shell=False, timeout=3.0)
    return jsonify({"version": f"{first} client running on: {host}"}), 200


if __name__ == "__main__":
    settings = load_settings()
    app.run(
        host=settings["web_host"],
        port=int(settings["web_port"]),
        debug=False,
        use_reloader=False,
        threaded=True,
    )
