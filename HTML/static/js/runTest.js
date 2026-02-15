import state from "./state.js";
import { initGauge, updateGauge, resetGauge } from "./gauge.js";

const runBtn = document.getElementById("runBtn");
const resultEl = document.getElementById("result");

// Overlay Elements (müssen in index.html existieren)
const overlay = document.getElementById("speedtestOverlay");
const overlayText = document.getElementById("speedtestOverlayText");
const overlayClose = document.getElementById("speedtestOverlayClose");

function showOverlay(text, showClose = false) {
  if (!overlay) return;
  overlay.style.display = "flex";
  if (overlayText) overlayText.textContent = text || "";
  if (overlayClose) overlayClose.style.display = showClose ? "inline-block" : "none";
}

function hideOverlay() {
  if (!overlay) return;
  overlay.style.display = "none";
  if (overlayClose) overlayClose.style.display = "none";
}

overlayClose?.addEventListener("click", () => hideOverlay());

// --- Robust parsing: numeric OR iperf text lines ("... 941 Mbits/sec") ---
function toSelectedUnits(val, prefix, units) {
  // Convert iperf (K/M/G bits/sec) -> Mbps, then to selected units (Kbps/Mbps/Gbps)
  let mbps = val;
  const p = (prefix || "M").toUpperCase();

  if (p === "K") mbps = val / 1000;
  else if (p === "G") mbps = val * 1000;

  if (units === "Kbps") return mbps * 1000;
  if (units === "Gbps") return mbps / 1000;
  return mbps; // "Mbps"
}

function extractBandwidth(line, units) {
  const s = (line ?? "").trim();

  // Backend might already send pure numbers (incl -1 marker)
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);

  // Parse iperf lines: take last "... X [K|M|G]bits/sec"
  const matches = [
    ...s.matchAll(
      /([0-9]+(?:\.[0-9]+)?)\s*([KMG])?\s*(?:bits\/sec|bit\/s|bits\/s|bit\/sec)/gi
    ),
  ];

  if (!matches.length) return NaN;

  const last = matches[matches.length - 1];
  const val = Number(last[1]);
  const prefix = last[2] || "M";
  return toSelectedUnits(val, prefix, units);
}

// Optional: verhindert doppeltes Binden (hilft bei versehentlichem Doppelladen)
if (!window.__iperfBound) {
  window.__iperfBound = true;

  runBtn.addEventListener("click", async () => {
    const target = state.ip;
    const port = state.port;
    const streams = state.streams;
    let bandwidth = state.bandwidth.trim();
    const protocol = state.protocol;
    const mode = state.mode;         // "upload" | "download"
    const units = state.units;

    // send iface to backend for link/counter deltas
    const iface = state.iface || document.getElementById("iface")?.value || "";

    const regex = /^\d+(\.\d+)?[KMG]$/i;
    if (!regex.test(bandwidth)) bandwidth = "0";

    // UI reset
    resultEl.textContent = "Running iPerf3...\n";
    state.bandwidthSum = 0;
    state.bandwidthCount = 0;
    state.maxBandwidth = 0;

    const statusEl = document.querySelector(".status");
    const avgEl = document.querySelector(".avg_speed");
    const maxEl = document.querySelector(".max_speed");
    if (statusEl) statusEl.textContent = "Starting";
    if (avgEl) avgEl.textContent = `- ${units}`;
    if (maxEl) maxEl.textContent = `- ${units}`;

    // Gauge: Sweep als "pending" Animation
    const initialMax = units === "Gbps" ? 1 : units === "Kbps" ? 1000000 : 1000;
    initGauge({
      startSweep: true,
      initialMax,
      sweepMaxFraction: 0.12,
      sweepAutoStopMs: 2500,
      sweepIntervalMs: 700,
    });

    runBtn.disabled = true;
    showOverlay("Starte iPerf…");

    let eventSource = null;

    // ======= NO-DATA / INACTIVITY TIMEOUT =======
    // Reverse (-R / Download) kann manchmal später "erste Daten" liefern (Handshake/Server-Output),
    // daher etwas großzügiger.
    const NO_DATA_MS = mode === "download" ? 45000 : 15000;
    let noDataTimer = null;

    const stopNoDataTimer = () => {
      if (noDataTimer) {
        clearTimeout(noDataTimer);
        noDataTimer = null;
      }
    };

    const armNoDataTimer = () => {
      stopNoDataTimer();
      noDataTimer = setTimeout(() => {
        if (statusEl) statusEl.textContent = "Error";
        resultEl.textContent += "Timeout: Keine Daten vom Stream erhalten.\n";
        if (lastCmd) resultEl.textContent += `Letzter CMD: ${lastCmd}\n`;

        cleanup({ reset: true, closeStream: true });
      }, NO_DATA_MS);
    };

    // ======= ZENTRALES CLEANUP =======
    const cleanup = ({ reset = true, closeStream = true } = {}) => {
      hideOverlay();
      stopNoDataTimer();

      runBtn.disabled = false;

      if (reset) resetGauge();

      if (closeStream) {
        try { eventSource?.close(); } catch (_) {}
        eventSource = null;

        try { window.__iperfES?.close(); } catch (_) {}
        window.__iperfES = null;
      }
    };

    let lastCmd = "";

    // Alte SSE-Verbindung vor neuem Run schließen
    try { window.__iperfES?.close(); } catch (_) {}
    window.__iperfES = null;

    // ===========================================================
    // ✅ Fix für "Download"-Timeout:
    // SSE zuerst öffnen, dann /run_iperf starten (parallel).
    // Dadurch bekommst du sofort stream_connected/ping und kein "tot" Gefühl.
    // ===========================================================
    const cid = crypto.randomUUID();

    console.time("sse_open");
    eventSource = new EventSource(`/stream_iperf?cid=${encodeURIComponent(cid)}&ts=${Date.now()}`);
    window.__iperfES = eventSource;

    console.log("[SSE] creating", { cid, url: eventSource.url });

    // Timer direkt scharf (falls open/message nie kommt)
    armNoDataTimer();

    eventSource.addEventListener("open", () => {
      console.timeEnd("sse_open");
      console.log("[SSE] open", { cid, readyState: eventSource.readyState });
      armNoDataTimer();
    });

    eventSource.addEventListener("message", (e) => {
      const s = (e.data ?? "").trim();
      console.log("[SSE] msg", { cid, data: s });

      // ✅ bei JEDEM Event resetten (auch ping)
      armNoDataTimer();

      if (!s || s === "ping") return;

      // Ende-Marker
      if (s === "-1") {
        const avg =
          state.bandwidthCount > 0
            ? (state.bandwidthSum / state.bandwidthCount).toFixed(2)
            : "0.00";

        if (statusEl) statusEl.textContent = "Complete";
        if (avgEl) avgEl.textContent = `${avg} ${units}`;
        if (maxEl) maxEl.textContent = `${state.maxBandwidth} ${units}`;

        console.log("[SSE] end", { cid });
        cleanup({ reset: false, closeStream: true });
        return;
      }

      if (s === "server is busy") {
        if (statusEl) statusEl.textContent = "Server is Busy";
        resultEl.textContent += "server is busy\n";
        cleanup({ reset: true, closeStream: true });
        return;
      }

      if (s.startsWith("CMD:") || s.startsWith("WORKER:") || s.startsWith("LOGFILE:")) {
        resultEl.textContent += s + "\n";
        return;
      }

      const bandwidthValue = extractBandwidth(s, units);
      if (Number.isNaN(bandwidthValue)) {
        resultEl.textContent += s + "\n";
        return;
      }

      updateGauge(bandwidthValue);

      state.bandwidthSum += bandwidthValue;
      state.bandwidthCount += 1;
      if (bandwidthValue > state.maxBandwidth) state.maxBandwidth = bandwidthValue;

      if (statusEl) statusEl.textContent = "Running";
      resultEl.textContent += s + "\n";

      showOverlay(
        `Running: ${bandwidthValue.toFixed(2)} ${units}\n(${protocol.toUpperCase()} • ${mode} • ${streams} Streams)`,
        false
      );
    });

    eventSource.addEventListener("error", (e) => {
      // EventSource reconnectet automatisch.
      console.warn("[SSE] error", { cid, readyState: eventSource.readyState, e });

      // ✅ Verhindert "false timeout" während Reconnect-Schleifen
      armNoDataTimer();

      if (eventSource.readyState === EventSource.CLOSED) {
        if (statusEl) statusEl.textContent = "Error";
        resultEl.textContent += "SSE connection closed.\n";
        cleanup({ reset: true, closeStream: true });
      }
    });

    // ==========================
    // Jetzt iperf starten (nicht blockierend)
    // ==========================
    try {
      const controller = new AbortController();
      // Start darf etwas länger dauern; Reverse kann minimal später reagieren
      const RUN_START_TIMEOUT_MS = mode === "download" ? 15000 : 8000;
      const startTimeout = setTimeout(() => controller.abort(), RUN_START_TIMEOUT_MS);

      console.time("run_iperf");
      const response = await fetch("/run_iperf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          protocol,
          mode,
          streams,
          target,
          bandwidth,
          port,
          units,
          iface,
          cid, // server kann cid ignorieren, falls nicht implementiert
        }),
      });
      console.timeEnd("run_iperf");
      clearTimeout(startTimeout);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const msg = errorData.error || response.statusText || "Error starting iPerf3.";

        cleanup({ reset: true, closeStream: true });
        showOverlay(`Fehler beim Start:\n${msg}`, true);
        throw new Error(msg);
      }

      console.time("run_iperf_json");
      const startData = await response.json().catch(() => ({}));
      console.timeEnd("run_iperf_json");

      lastCmd = (startData.cmd || "").trim();
      if (lastCmd) resultEl.textContent += `CMD: ${lastCmd}\n`;

      showOverlay(
        `Verbunden – Test läuft…\n(${protocol.toUpperCase()} • ${mode} • ${streams} Streams)`,
        false
      );
    } catch (error) {
      console.error("Run error:", error);
      resultEl.textContent += (error?.message || String(error)) + "\n";
      if (statusEl) statusEl.textContent = "Error";

      cleanup({ reset: true, closeStream: true });
      showOverlay(`Fehler:\n${error?.message || String(error)}`, true);
    }
  });
}
