import { getCSSVariable } from "./utils.js";

let gauge;

// Sweep + smooth readout
let sweepTimer = null;
let sweepDir = 1;
let sweepAutoStopTimer = null;

let readoutRaf = null;
let hasRealValue = false;

// Default Sweep-Verhalten (kannst du in initGauge überschreiben)
let SWEEP_MAX_FRACTION = 0.12;     // 12% der Skala statt 100% -> kein "Vollgas"
let SWEEP_AUTO_STOP_MS = 2500;     // nach 2.5s Sweep aus, wenn keine Daten
let SWEEP_INTERVAL_MS = 700;

const NORMAL_ANIM_SPEED = 32;
const SWEEP_ANIM_SPEED = 10;

function startReadoutSync() {
  if (readoutRaf) return;

  const el = document.getElementById("current-value");

  const tick = () => {
    if (!gauge || !el) {
      readoutRaf = null;
      return;
    }

    // displayedValue kommt aus gauge.js (bernii)
    const dv = gauge.gp?.[0]?.displayedValue ?? gauge.displayedValue ?? 0;

    // WICHTIG: Während Sweep (und noch kein Realwert) keine "Fake"-Zahlen anzeigen
    const showValue = (!hasRealValue && sweepTimer) ? 0 : dv;

    el.innerText = Number(showValue).toFixed(2);
    readoutRaf = requestAnimationFrame(tick);
  };

  readoutRaf = requestAnimationFrame(tick);
}

function stopSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (sweepAutoStopTimer) {
    clearTimeout(sweepAutoStopTimer);
    sweepAutoStopTimer = null;
  }
  if (gauge) gauge.animationSpeed = NORMAL_ANIM_SPEED;
}

function startSweep({
  maxFraction = SWEEP_MAX_FRACTION,
  intervalMs = SWEEP_INTERVAL_MS,
  autoStopMs = SWEEP_AUTO_STOP_MS,
  resetToZeroOnStop = true,
} = {}) {
  stopSweep();
  if (!gauge) return;

  gauge.animationSpeed = SWEEP_ANIM_SPEED;
  sweepDir = 1;
  gauge.set(0);

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const frac = clamp01(maxFraction);
  const sweepTop = gauge.maxValue * frac;

  sweepTimer = setInterval(() => {
    if (!gauge) return;
    const t = sweepDir > 0 ? sweepTop : 0;
    gauge.set(t);
    sweepDir *= -1;
  }, intervalMs);

  // Auto-Stop: wenn keine echten Daten kommen -> Sweep aus + Zeiger auf 0
  if (autoStopMs > 0) {
    sweepAutoStopTimer = setTimeout(() => {
      stopSweep();
      if (gauge && resetToZeroOnStop) gauge.set(0);
    }, autoStopMs);
  }
}

/**
 * initGauge({
 *   startSweep?: boolean,
 *   initialMax?: number,
 *   sweepMaxFraction?: number,
 *   sweepAutoStopMs?: number,
 *   sweepIntervalMs?: number
 * })
 */
function initGauge({
  startSweep: doSweep = false,
  initialMax = 10,
  sweepMaxFraction = SWEEP_MAX_FRACTION,
  sweepAutoStopMs = SWEEP_AUTO_STOP_MS,
  sweepIntervalMs = SWEEP_INTERVAL_MS,
} = {}) {
  // Defaults aktualisieren (für spätere Sweeps)
  SWEEP_MAX_FRACTION = sweepMaxFraction;
  SWEEP_AUTO_STOP_MS = sweepAutoStopMs;
  SWEEP_INTERVAL_MS = sweepIntervalMs;

  stopSweep();
  hasRealValue = false;

  const opts = {
    angle: 0,
    lineWidth: 0.15,
    radiusScale: 0.9,
    pointer: {
      length: 0.5,
      strokeWidth: 0.025,
      color: getCSSVariable("--speedometer_gradient_2"),
    },
    staticLabels: {
      font: "11px sans-serif",
      labels: [],
      color: "#ffffff",
      fractionDigits: 0,
    },
    percentColors: [
      [0.0, getCSSVariable("--speedometer_gradient_1")],
      [0.5, getCSSVariable("--speedometer_gradient_2")],
      [1.0, getCSSVariable("--speedometer_gradient_3")],
    ],
    limitMax: false,
    limitMin: false,
    highDpiSupport: true,
  };

  const target = document.getElementById("speedometer");
  if (!target) return;

  gauge = new Gauge(target).setOptions(opts);

  gauge.setMinValue(0);
  gauge.maxValue = initialMax;
  gauge.animationSpeed = NORMAL_ANIM_SPEED;
  gauge.set(0);

  // Zahl folgt dem animierten Zeiger (aber während Sweep zeigen wir 0.00)
  startReadoutSync();

  if (doSweep) {
    startSweep({
      maxFraction: SWEEP_MAX_FRACTION,
      intervalMs: SWEEP_INTERVAL_MS,
      autoStopMs: SWEEP_AUTO_STOP_MS,
    });
  }
}

function updateGauge(value) {
  if (!gauge) return;

  // echte Messwerte -> Sweep aus, Readout darf "echt" werden
  hasRealValue = Number.isFinite(value);
  stopSweep();

  // Stabil: Skala nur nach oben erweitern
  if (value > gauge.maxValue * 0.8) {
    let newMax = value > 0 ? value * 1.2 : 1;

    const niceSteps = [1, 2, 5];
    const magnitude = Math.pow(10, Math.floor(Math.log10(newMax / 5)));

    let step = niceSteps[niceSteps.length - 1] * magnitude;
    for (let i = 0; i < niceSteps.length; i++) {
      const s = niceSteps[i] * magnitude;
      if (newMax / s < 6) {
        step = s;
        break;
      }
    }

    gauge.maxValue = Math.ceil(newMax / step) * step;

    const labels = [];
    const numLabels = Math.round(gauge.maxValue / step);
    for (let i = 0; i <= numLabels; i++) {
      labels.push(parseFloat((i * step).toPrecision(15)));
    }

    gauge.setOptions({
      staticLabels: {
        font: "11px sans-serif",
        labels,
        color: "#ffffff",
        fractionDigits: step < 1 ? 2 : 0,
      },
    });
  }

  gauge.set(value);
}

// Optional: falls du aus runTest.js bei Fehlern den Gauge “resetten” willst
function resetGauge() {
  hasRealValue = false;
  stopSweep();
  if (gauge) gauge.set(0);
}

// Optional: falls du beim Klick “Run” nur animieren willst, ohne neu zu initten
function beginPending() {
  hasRealValue = false;
  startSweep({
    maxFraction: SWEEP_MAX_FRACTION,
    intervalMs: SWEEP_INTERVAL_MS,
    autoStopMs: SWEEP_AUTO_STOP_MS,
  });
}

export { initGauge, updateGauge, resetGauge, beginPending };
