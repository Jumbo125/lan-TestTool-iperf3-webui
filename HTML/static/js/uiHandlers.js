import state from './state.js';

function $(id) { return document.getElementById(id); }

// Init state from server-rendered defaults in the DOM
(function initStateFromDom() {
  const targetEl = $('target');
  const portEl = $('port');
  const streamsEl = $('streams');
  const bandwidthEl = $('bandwidth');

  if (targetEl?.value) state.ip = targetEl.value;
  if (portEl?.value) state.port = portEl.value;
  if (streamsEl?.value) state.streams = streamsEl.value;
  if (bandwidthEl?.value) state.bandwidth = bandwidthEl.value;

  if ($('uploadBtn')?.classList.contains('active')) state.mode = 'upload';
  else if ($('downloadBtn')?.classList.contains('active')) state.mode = 'download';

  if ($('tcpBtn')?.classList.contains('active')) {
    state.protocol = 'tcp';
    $('bandwidth-field') && ($('bandwidth-field').style.display = 'none');
  } else if ($('udpBtn')?.classList.contains('active')) {
    state.protocol = 'udp';
    $('bandwidth-field') && ($('bandwidth-field').style.display = '');
  }

  ['Kbits', 'Mbits', 'Gbits'].forEach(unit => {
    if ($(unit)?.classList.contains('active')) {
      state.units = unit.replace('bits', 'bps'); // Kbps/Mbps/Gbps
      const u = document.querySelector('.units');
      if (u) u.textContent = state.units;
    }
  });
})();

// Input listeners
$('target')?.addEventListener('input', () => { state.ip = $('target').value; });
$('port')?.addEventListener('input', () => { state.port = $('port').value; });
$('streams')?.addEventListener('input', () => { state.streams = $('streams').value; });
$('bandwidth')?.addEventListener('input', () => { state.bandwidth = $('bandwidth').value; });

// Mode toggles
$('uploadBtn')?.addEventListener('click', () => {
  $('uploadBtn').classList.add('active');
  $('downloadBtn').classList.remove('active');
  state.mode = 'upload';
});

$('downloadBtn')?.addEventListener('click', () => {
  $('downloadBtn').classList.add('active');
  $('uploadBtn').classList.remove('active');
  state.mode = 'download';
});

// Protocol toggles
$('tcpBtn')?.addEventListener('click', () => {
  $('tcpBtn').classList.add('active');
  $('udpBtn').classList.remove('active');
  state.protocol = 'tcp';
  $('bandwidth-field') && ($('bandwidth-field').style.display = 'none');
});

$('udpBtn')?.addEventListener('click', () => {
  $('udpBtn').classList.add('active');
  $('tcpBtn').classList.remove('active');
  state.protocol = 'udp';
  $('bandwidth-field') && ($('bandwidth-field').style.display = '');
});

// Units toggles
['Kbits', 'Mbits', 'Gbits'].forEach(unit => {
  $(unit)?.addEventListener('click', () => {
    ['Kbits', 'Mbits', 'Gbits'].forEach(u => $(u)?.classList.remove('active'));
    $(unit).classList.add('active');

    state.units = unit.replace('bits', 'bps'); // -> Kbps/Mbps/Gbps
    const u = document.querySelector(".units");
    if (u) u.textContent = state.units;
  });
});

// NEW: Interface dropdown loading
async function loadInterfaces() {
  const sel = $('iface');
  if (!sel) return;

  try {
    const r = await fetch('/api/interfaces');
    const j = await r.json();
    const ifaces = j.interfaces || [];

    sel.innerHTML = '';
    for (const name of ifaces) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }

    const def = sel.dataset.default || '';
    if (def && ifaces.includes(def)) sel.value = def;
    else if (ifaces.length) sel.value = ifaces[0];

    state.iface = sel.value || '';

    sel.addEventListener('change', () => {
      state.iface = sel.value || '';
    });
  } catch (e) {
    console.warn('Failed to load interfaces', e);
  }
}

// NEW: Link + counter delta polling
async function refreshStats() {
  if (!state.iface) return;

  try {
    const r = await fetch('/api/stats?iface=' + encodeURIComponent(state.iface));
    const j = await r.json();

    // Link info
    const link = j.link || {};
    const speed = link.speed || '';
    const duplex = link.duplex || '';
    const up = link.link || link.status || '';
    const linkTxt = [speed, duplex, up].filter(Boolean).join(' | ') || '--';
    $('linkInfo') && ($('linkInfo').textContent = linkTxt);

    // ---- NEW: split deltas into groups ----
    const delta = j.delta || {};
    const n = (v) => Number(v) || 0;

    // Linux "true PHY error" keys
    const linuxPhyKeys = ['rx_crc_errors', 'rx_fcs_errors', 'rx_frame_errors', 'rx_length_errors', 'rx_over_errors'];

    // Windows has only high-level counters, treat Errors as "phy-ish"
    const winErrKeys = ['ReceivedErrors', 'OutboundErrors'];

    // Drops/Discards keys
    const dropKeys = ['rx_dropped', 'tx_dropped', 'rx_missed_errors', 'ReceivedDiscarded', 'OutboundDiscarded'];

    // Compute sums (works on both OS; missing keys count as 0)
    const crcDelta = linuxPhyKeys.reduce((a, k) => a + n(delta[k]), 0);

    const winErrDelta = winErrKeys.reduce((a, k) => a + n(delta[k]), 0);

    const dropsDelta = dropKeys.reduce((a, k) => a + n(delta[k]), 0);

    // Total delta sum (everything we got)
    const totalDelta = Object.values(delta).reduce((a, v) => a + n(v), 0);

    // Show:
    // - On Linux: CRC/FCS Δ is real crcDelta
    // - On Windows: show winErrDelta in the same field (no CRC detail available)
    const shownCrc = (crcDelta > 0) ? crcDelta : winErrDelta;

    if ($('crcDelta')) $('crcDelta').textContent = String(shownCrc);
    if ($('dropDelta')) $('dropDelta').textContent = String(dropsDelta);
    if ($('errDelta')) $('errDelta').textContent = String(totalDelta);

    // ---- Optional: Ampel classes ----
    // rule: CRC/FCS (or win errors) > 0 => red
    // else drops > 0 => yellow
    // else green
    const setClass = (el, cls) => {
      if (!el) return;
      el.classList.remove('ok', 'warn', 'bad');
      el.classList.add(cls);
    };

    setClass($('crcDelta'), shownCrc > 0 ? 'bad' : (dropsDelta > 0 ? 'warn' : 'ok'));
    setClass($('dropDelta'), dropsDelta > 0 ? 'warn' : 'ok');
    setClass($('errDelta'), totalDelta > 0 ? (shownCrc > 0 ? 'bad' : 'warn') : 'ok');

  } catch (e) {
    // ignore
  }
}


loadInterfaces();
setInterval(refreshStats, 1000);
