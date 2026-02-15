import './uiHandlers.js';
import './version.js';
import './runTest.js';
import state from "./state.js";
import { initGauge } from './gauge.js';
import { startStatsPolling } from "./stats_quality.js";

window.addEventListener('DOMContentLoaded', () => {
     const units = state.units || "Mbps";
  const initialMax = units === "Gbps" ? 1 : units === "Kbps" ? 1000000 : 1000;

  initGauge({
    initialMax,
    // startSweep bleibt false (Default) -> Nadel steht ruhig auf 0
    sweepMaxFraction: 0.12,
    sweepAutoStopMs: 2500,
    sweepIntervalMs: 700,
  });
  startStatsPolling(() => state.iface || document.getElementById("iface")?.value || "");
});