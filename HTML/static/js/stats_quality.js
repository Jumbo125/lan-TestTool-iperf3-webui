// stats_quality.js
// Small helper to render /api/stats into the UI cards:
// - linkInfo, pktErrDelta, dropDelta, crcDelta, qualityBadge
//
// Usage in main.js (example):
//   import state from "./state.js";
//   import { startStatsPolling } from "./stats_quality.js";
//   startStatsPolling(() => state.iface || document.getElementById("iface")?.value || "");
//
// If you already poll /api/stats elsewhere, just call:
//   updateStatsCards(statsJson);

function sumKeys(obj, keys) {
  let s = 0;
  if (!obj) return 0;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) s += v;
    else if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) s += Number(v);
  }
  return s;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setClass(id, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("ok", "warn", "bad");
  if (cls) el.classList.add(cls);
}

function renderLinkInfo(link) {
  // link can be {ok, speed, link, duplex, auto} (your backend)
  if (!link || link.ok === false) return "--";
  const parts = [];
  const l = String(link.link || "").trim();
  const sp = String(link.speed || "").trim();

  if (l) parts.push(l);
  if (sp) parts.push(sp);

  return parts.length ? parts.join(" • ") : "--";
}

function computeQuality(pktErrDelta, dropDelta, crcDelta, linkText) {
  // Simple heuristic (tweak as you like):
  // - any CRC/FCS => BAD
  // - any packet errors => WARN/BAD depending on magnitude
  // - many drops/discards => WARN/BAD
  const crc = Number.isFinite(crcDelta) ? crcDelta : 0;
  const pe = pktErrDelta || 0;
  const dr = dropDelta || 0;

  const linkDown = /down|disconnected|no/i.test(String(linkText || ""));
  if (linkDown) return { label: "BAD (link)", cls: "bad" };

  if (crc > 0) return { label: `BAD (CRC +${crc})`, cls: "bad" };

  const score = pe + dr;
  if (score === 0) return { label: "OK", cls: "ok" };
  if (score <= 5) return { label: `WARN (+${score})`, cls: "warn" };
  return { label: `BAD (+${score})`, cls: "bad" };
}

/**
 * Call this with the JSON returned by /api/stats
 */
export function updateStatsCards(stats) {
  const linkText = renderLinkInfo(stats?.link);
  setText("linkInfo", linkText);

  const delta = stats?.delta || {};

  // Windows keys (your backend):
  const winPktErr = sumKeys(delta, ["ReceivedErrors", "OutboundErrors"]);
  const winDrop = sumKeys(delta, ["ReceivedDiscarded", "OutboundDiscarded"]);

  // Linux-ish keys (only if present):
  const nixPktErr = sumKeys(delta, ["rx_errors", "tx_errors"]);
  const nixDrop = sumKeys(delta, ["rx_dropped", "tx_dropped", "rx_missed_errors"]);

  // CRC/FCS: only available if your driver exposes it (mostly Linux)
  const crc = sumKeys(delta, [
    "rx_crc_errors", "rx_fcs_errors",
    // common aliases (in case you later expand your backend):
    "rx_crc_err", "rx_fcs_err", "crc_errors", "fcs_errors"
  ]);

  const pktErrDelta = winPktErr || nixPktErr;
  const dropDelta = winDrop || nixDrop;

  setText("pktErrDelta", String(pktErrDelta || 0));
  setText("dropDelta", String(dropDelta || 0));

  // Show "n/a" if truly not present
  setText("crcDelta", crc > 0 ? String(crc) : (Object.prototype.hasOwnProperty.call(delta, "rx_crc_errors") ||
                                              Object.prototype.hasOwnProperty.call(delta, "rx_fcs_errors"))
                                ? "0"
                                : "n/a");

  // Colorize deltas a bit
  setClass("pktErrDelta", pktErrDelta === 0 ? "ok" : (pktErrDelta <= 5 ? "warn" : "bad"));
  setClass("dropDelta", dropDelta === 0 ? "ok" : (dropDelta <= 20 ? "warn" : "bad"));
  // crcDelta handled via quality mostly

  const q = computeQuality(pktErrDelta, dropDelta, crc, linkText);
  setText("qualityBadge", q.label);
  setClass("qualityBadge", q.cls);
}

/**
 * Starts a polling loop for /api/stats and updates the cards.
 * Pass a function that returns the iface string.
 */
export function startStatsPolling(getIface, { intervalMs = 1000 } = {}) {
  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const iface = (typeof getIface === "function" ? getIface() : "") || "";
      const url = `/api/stats?iface=${encodeURIComponent(iface)}`;

      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`stats http ${res.status}`);
      const data = await res.json();
      updateStatsCards(data);
    } catch (e) {
      // Keep UI, but don't spam errors
      // If you want, show a subtle indicator here.
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }

  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
