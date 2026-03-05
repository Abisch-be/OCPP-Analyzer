/* ============================================================
   OCPP Log Analyzer – Frontend Logic
   ============================================================ */

// --- State ---
let parsedData             = null;
let isAnalyzing            = false;
let allPairs               = [];
let analyzeAbortController = null;
let explanationAbortController   = null;
let explanationText         = '';
let analysisDone           = false;
let explanationDone        = false;
let timelineChartInstance  = null;
let lastParsedContent      = '';

// --- DOM References ---
const logInput        = document.getElementById('logInput');
const fileInput       = document.getElementById('fileInput');
const charCount       = document.getElementById('charCount');
const lineCount       = document.getElementById('lineCount');
const parseBtn        = document.getElementById('parseBtn');
const analyzeBtn      = document.getElementById('analyzeBtn');
const exampleBtn      = document.getElementById('exampleBtn');
const clearBtn        = document.getElementById('clearBtn');
const settingsToggle  = document.getElementById('settingsToggle');
const settingsPanel   = document.getElementById('settingsPanel');
const ollamaUrl       = document.getElementById('ollamaUrl');
const modelSelect     = document.getElementById('modelSelect');
const loadModelsBtn   = document.getElementById('loadModelsBtn');
const modelsStatus    = document.getElementById('modelsStatus');
const issuesBadge     = document.getElementById('issuesBadge');
const toastContainer  = document.getElementById('toastContainer');
const customerContext = document.getElementById('customerContext');
const explanationBtn   = document.getElementById('explanationBtn');

// --- Initialization ---
window.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  setupDragDrop();
  setupEventListeners();
});

// ============================================================
// Settings – LocalStorage
// ============================================================
function loadSettings() {
  const savedUrl   = localStorage.getItem('ollama_url');
  const savedModel = localStorage.getItem('ollama_model');
  if (savedUrl)   ollamaUrl.value = savedUrl;
  if (savedModel) {
    // Add saved model as option so it's visible before loading
    const opt = document.createElement('option');
    opt.value = savedModel;
    opt.textContent = savedModel;
    opt.selected = true;
    modelSelect.appendChild(opt);
  }
}

function saveSettings() {
  localStorage.setItem('ollama_url', ollamaUrl.value.trim());
  if (modelSelect.value) localStorage.setItem('ollama_model', modelSelect.value);
}

// ============================================================
// Event Listeners
// ============================================================
function setupEventListeners() {
  logInput.addEventListener('input', () => {
    updateCharCount();
    if (parsedData !== null) markResultsDirty();
  });

  parseBtn.addEventListener('click', async () => {
    if (parsedData !== null && logInput.value.trim() === lastParsedContent) {
      switchTab('messages');
      return;
    }
    await parseLogs();
    switchTab('messages');
  });
  analyzeBtn.addEventListener('click', analyzeLogs);
  explanationBtn.addEventListener('click', draftExplanation);
  exampleBtn.addEventListener('click', loadExample);
  clearBtn.addEventListener('click', clearLog);

  settingsToggle.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
  });

  loadModelsBtn.addEventListener('click', loadModels);

  ollamaUrl.addEventListener('change', saveSettings);
  modelSelect.addEventListener('change', saveSettings);

  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFileUpload(e.target.files[0]);
  });

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

// ============================================================
// Drag & Drop
// ============================================================
function setupDragDrop() {
  logInput.addEventListener('dragover', (e) => {
    e.preventDefault();
    logInput.classList.add('drag-over');
  });
  logInput.addEventListener('dragleave', () => {
    logInput.classList.remove('drag-over');
  });
  logInput.addEventListener('drop', (e) => {
    e.preventDefault();
    logInput.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  });
}

// ============================================================
// File Upload
// ============================================================
function handleFileUpload(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    logInput.value = e.target.result;
    updateCharCount();
    if (parsedData !== null) markResultsDirty();
    showToast(`📂 Datei geladen: ${file.name}`, 'success');
  };
  reader.onerror = () => showToast('Fehler beim Lesen der Datei', 'error');
  reader.readAsText(file, 'UTF-8');
}

// ============================================================
// Char / Line Counter
// ============================================================
function updateCharCount() {
  const text = logInput.value;
  charCount.textContent = text.length.toLocaleString('de');
  lineCount.textContent = text ? text.split('\n').length.toLocaleString('de') : '0';
}

// ============================================================
// Load Ollama Models
// ============================================================
async function loadModels() {
  const url = ollamaUrl.value.trim();
  if (!url) { showToast('Ollama URL eingeben', 'error'); return; }

  loadModelsBtn.disabled = true;
  modelsStatus.textContent = 'Lade...';

  try {
    const response = await fetch(`/api/models?ollama_url=${encodeURIComponent(url)}`);
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || 'Fehler');
    }
    const data = await response.json();

    const models = data.models || [];
    const savedModel = localStorage.getItem('ollama_model');

    modelSelect.innerHTML = '<option value="">-- Modell wählen --</option>';
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === savedModel) opt.selected = true;
      modelSelect.appendChild(opt);
    });

    modelsStatus.textContent = `${models.length} Modell(e) gefunden`;
    showToast(`✅ ${models.length} Modelle geladen`, 'success');
    saveSettings();
  } catch (err) {
    modelsStatus.textContent = 'Fehler: ' + err.message;
    showToast('Modelle konnten nicht geladen werden: ' + err.message, 'error');
  } finally {
    loadModelsBtn.disabled = false;
  }
}

// ============================================================
// Tab Switching
// ============================================================
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('active', c.id === `tab-${name}`);
    c.classList.toggle('hidden', c.id !== `tab-${name}`);
  });
}

// ============================================================
// Parse Logs
// ============================================================
async function parseLogs() {
  const content = logInput.value.trim();
  if (!content) { showToast('Kein Log-Inhalt vorhanden', 'error'); return; }

  parseBtn.disabled = true;
  parseBtn.textContent = '⏳ Parsen...';

  try {
    const response = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ log_content: content }),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.detail || 'Server-Fehler');
    }

    parsedData = await response.json();
    lastParsedContent = content;

    updateStats(parsedData.stats);
    displayMessages(parsedData.messages);
    displayIssues(parsedData.errors, parsedData.warnings);

    const total = parsedData.stats.total;
    const issues = parsedData.stats.errors + parsedData.stats.warnings;
    showToast(`✅ ${total} Nachrichten geparst – ${issues} Issue(s)`, 'success');
  } catch (err) {
    showToast('Parse-Fehler: ' + err.message, 'error');
  } finally {
    parseBtn.disabled = false;
    parseBtn.textContent = '🔍 Parsen';
  }
}

// ============================================================
// Update Stats Bar
// ============================================================
function updateStats(stats) {
  const totalIssues = stats.errors + stats.warnings;
  if (totalIssues > 0) {
    issuesBadge.textContent = totalIssues;
    issuesBadge.classList.remove('hidden');
  } else {
    issuesBadge.classList.add('hidden');
  }
}

// ============================================================
// Timeline Chart
// ============================================================
function buildTimelineChartData(messages, errors, warnings) {
  const errorLines   = new Set((errors   || []).map(e => e.line));
  const warningLines = new Set((warnings || []).map(w => w.line));

  const timed = messages
    .map(m => ({ ts: m.timestamp ? new Date(m.timestamp).getTime() : NaN, line: m.line }))
    .filter(x => !isNaN(x.ts));

  if (timed.length === 0) return null;

  const minTs = Math.min(...timed.map(x => x.ts));
  const maxTs = Math.max(...timed.map(x => x.ts));
  const range = maxTs - minTs;

  if (range <= 0) return null;

  let bucketMs;
  if      (range < 60 * 60 * 1000)       bucketMs = 60 * 1000;       // < 1 h  → 1-min buckets
  else if (range < 24 * 60 * 60 * 1000)  bucketMs = 5  * 60 * 1000;  // < 1 d  → 5-min buckets
  else                                    bucketMs = 60 * 60 * 1000;  // >= 1 d → 1-h  buckets

  const buckets = new Map();
  for (const msg of messages) {
    if (!msg.timestamp) continue;
    const t = new Date(msg.timestamp).getTime();
    if (isNaN(t)) continue;
    const idx = Math.floor((t - minTs) / bucketMs);
    if (!buckets.has(idx)) buckets.set(idx, { ok: 0, warning: 0, error: 0, startTs: minTs + idx * bucketMs });
    const b = buckets.get(idx);
    if      (errorLines.has(msg.line))   b.error++;
    else if (warningLines.has(msg.line)) b.warning++;
    else                                 b.ok++;
  }

  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);

  const fmt = (ts) => {
    const d = new Date(ts);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    if (bucketMs >= 60 * 60 * 1000) {
      const dd = d.getDate().toString().padStart(2, '0');
      const mo = (d.getMonth() + 1).toString().padStart(2, '0');
      return `${dd}.${mo} ${hh}:00`;
    }
    return `${hh}:${mm}`;
  };

  return {
    labels:  sorted.map(([, b]) => fmt(b.startTs)),
    ok:      sorted.map(([, b]) => b.ok),
    warning: sorted.map(([, b]) => b.warning),
    error:   sorted.map(([, b]) => b.error),
  };
}

function renderTimelineChart(messages) {
  const canvas = document.getElementById('timelineChart');
  if (!canvas || typeof Chart === 'undefined') return;

  if (timelineChartInstance) { timelineChartInstance.destroy(); timelineChartInstance = null; }

  const data = buildTimelineChartData(messages, parsedData?.errors, parsedData?.warnings);
  if (!data) return;

  timelineChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: [
        { label: 'OK',            data: data.ok,      backgroundColor: 'rgba(34,197,94,0.85)',  borderRadius: 4, borderSkipped: false, stack: 'logs' },
        { label: 'Unvollständig', data: data.warning, backgroundColor: 'rgba(249,115,22,0.85)', borderRadius: 4, borderSkipped: false, stack: 'logs' },
        { label: 'Fehler',        data: data.error,   backgroundColor: 'rgba(239,68,68,0.85)',  borderRadius: 4, borderSkipped: false, stack: 'logs' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { font: { size: 11, weight: '500' }, color: '#94a3b8', boxWidth: 10, boxHeight: 10, borderRadius: 3, padding: 16, usePointStyle: true, pointStyle: 'circle' },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: 'rgba(15,23,42,0.9)',
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(148,163,184,0.1)',
          borderWidth: 1,
          cornerRadius: 8,
          padding: 10,
        },
      },
      scales: {
        x: { stacked: true, ticks: { color: '#64748b', font: { size: 10 }, maxRotation: 45 }, grid: { display: false }, border: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { color: '#64748b', font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(148,163,184,0.08)' }, border: { display: false } },
      },
      animation: { duration: 400 },
      barPercentage: 0.75,
      categoryPercentage: 0.85,
    },
  });
}

// ============================================================
// Display Messages
// ============================================================
function displayMessages(messages) {
  const container = document.getElementById('tab-messages');

  if (!messages || messages.length === 0) {
    allPairs = [];
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div>Keine OCPP-Nachrichten gefunden</div></div>';
    return;
  }

  const errorLines = new Set((parsedData?.errors ?? []).map(e => e.line));

  allPairs = groupMessages(messages).map(pair => {
    const line = pair.call?.line ?? pair.response?.line;
    return {
      ...pair,
      isError: errorLines.has(line) || pair.response?.type === 'CALLERROR',
    };
  });

  const actions = [...new Set(allPairs.map(p => p.call?.action).filter(Boolean))].sort();
  const actionOptions = actions.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');

  container.innerHTML = `
    <div class="timeline-chart-section">
      <canvas id="timelineChart"></canvas>
    </div>
    <div class="msg-filter-bar">
      <select id="filterAction" class="filter-input">
        <option value="">Alle Event-Typen</option>
        ${actionOptions}
      </select>
      <button id="filterOk"      class="filter-toggle" data-active="false">✅ OK</button>
      <button id="filterWarning" class="filter-toggle" data-active="false">🟠 Unvollständig</button>
      <button id="filterErrors"  class="filter-toggle" data-active="false">🔴 Fehler</button>
      <span id="filterCount" class="filter-count"></span>
      <button id="filterClear" class="filter-clear" title="Filter zurücksetzen">✕</button>
    </div>
    <div id="msg-list"></div>
  `;

  renderTimelineChart(messages);

  document.getElementById('filterAction').addEventListener('change', renderFilteredPairs);
  ['filterOk', 'filterWarning', 'filterErrors'].forEach(id => {
    document.getElementById(id).addEventListener('click', () => {
      const btn = document.getElementById(id);
      const active = btn.dataset.active === 'true';
      btn.dataset.active = String(!active);
      btn.classList.toggle('active', !active);
      renderFilteredPairs();
    });
  });
  document.getElementById('filterClear').addEventListener('click', () => {
    document.getElementById('filterAction').value = '';
    ['filterOk', 'filterWarning', 'filterErrors'].forEach(id => {
      const btn = document.getElementById(id);
      btn.dataset.active = 'false';
      btn.classList.remove('active');
    });
    renderFilteredPairs();
  });

  renderFilteredPairs();
}

function renderFilteredPairs() {
  const list = document.getElementById('msg-list');
  if (!list) return;

  const fromVal      = document.getElementById('filterFrom')?.value ?? '';
  const toVal        = document.getElementById('filterTo')?.value   ?? '';
  const actionVal    = document.getElementById('filterAction')?.value ?? '';
  const showOk       = document.getElementById('filterOk')?.dataset.active === 'true';
  const showWarning  = document.getElementById('filterWarning')?.dataset.active === 'true';
  const showErrors   = document.getElementById('filterErrors')?.dataset.active === 'true';
  const anyActive    = showOk || showWarning || showErrors;

  const filtered = allPairs.filter(({ call, response, isError }) => {
    const unanswered = call && !response;
    const isOk = !isError && !unanswered;

    if (anyActive) {
      if (showErrors && isError) { /* include */ }
      else if (showWarning && unanswered) { /* include */ }
      else if (showOk && isOk) { /* include */ }
      else return false;
    }
    if (actionVal && call?.action !== actionVal) return false;
    if (fromVal || toVal) {
      const ts = (call?.timestamp ?? response?.timestamp ?? '').substring(0, 16);
      if (fromVal && ts < fromVal) return false;
      if (toVal   && ts > toVal)   return false;
    }
    return true;
  });

  const countEl = document.getElementById('filterCount');
  if (countEl) countEl.textContent = `${filtered.length} von ${allPairs.length}`;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div>Keine Nachrichten für diesen Filter</div></div>';
    return;
  }

  list.innerHTML = filtered.map(pair => buildPairCard(pair)).join('');
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/);
  if (m) return `${m[3]}.${m[2]}.${m[1]} ${m[4]}`;
  return ts;
}

function formatTime(ts) {
  if (!ts) return '';
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/);
  if (m) return `${m[3]}.${m[2]}. ${m[4]}`;
  const tm = ts.match(/T(\d{2}:\d{2}:\d{2})/);
  return tm ? tm[1] : ts;
}

function tsHtml(ts) {
  if (!ts) return '';
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/);
  const date = m ? `${m[3]}.${m[2]}.${m[1]}` : '';
  const time = m ? m[4] : (ts.match(/T(\d{2}:\d{2}:\d{2})/) || [])[1] || ts;
  const dateSpan = date ? `<span class="pair-ts-date">${escapeHtml(date)}</span>` : '';
  return `<span class="pair-ts" title="${escapeHtml(ts)}">${dateSpan}<span class="pair-ts-time">${escapeHtml(time)}</span></span>`;
}

// OCPP 1.6: actions always initiated by the Charging Station → Backend
const CS_INITIATED = new Set([
  'Authorize', 'BootNotification', 'DiagnosticsStatusNotification',
  'FirmwareStatusNotification', 'Heartbeat', 'LogStatusNotification',
  'MeterValues', 'SecurityEventNotification', 'SignCertificate',
  'SignedFirmwareStatusNotification', 'StartTransaction',
  'StatusNotification', 'StopTransaction',
]);

// Returns a direction badge using the OCPP action (reliable) with
// raw direction as fallback for unknown/bidirectional actions (e.g. DataTransfer).
// forResponse=true flips the direction (response goes the other way).
function dirBadgeHtml(action, forResponse, rawDirection) {
  let csToBackend;
  if (action && CS_INITIATED.has(action)) {
    csToBackend = !forResponse;
  } else if (action && !CS_INITIATED.has(action)) {
    csToBackend = forResponse;   // BE-initiated CALL; response comes from CS
  } else {
    csToBackend = rawDirection === 'SEND'; // unknown action – fall back to log tag
  }
  const cls   = csToBackend ? 'dir-SEND' : 'dir-RECV';
  const label = csToBackend ? 'Ladestation → Backend' : 'Backend → Ladestation';
  return `<span class="direction-badge ${cls}">${label}</span>`;
}

function buildPayloadHtml(str) {
  if (!str || str === '{}' || str === 'null') return '';
  return `<pre>${escapeHtml(str)}</pre>`;
}

function groupMessages(messages) {
  const pairs  = [];
  const callMap = {};

  for (const msg of messages) {
    if (msg.type === 'CALL') {
      const pair = { call: msg, response: null };
      callMap[msg.uniqueId] = pair;
      pairs.push(pair);
    } else if (msg.type === 'CALLRESULT' || msg.type === 'CALLERROR') {
      if (callMap[msg.uniqueId]) {
        callMap[msg.uniqueId].response = msg;
      } else {
        pairs.push({ call: null, response: msg });
      }
    }
  }

  return pairs;
}

function buildPairCard(pair) {
  const { call, response } = pair;

  const hasError   = pair.isError ?? (response?.type === 'CALLERROR');
  const unanswered = call && !response;

  let pairClass = '';
  if (hasError)        pairClass = 'has-error';
  else if (unanswered) pairClass = 'unanswered';
  else if (response)   pairClass = 'ok';

  const lineNum = call?.line ?? response?.line ?? '';
  let html = `<div class="msg-pair ${pairClass}" data-line="${lineNum}">`;

  // ── CALL row ──────────────────────────────────────────────
  if (call) {
    const dirBadge = dirBadgeHtml(call.action, false, call.direction);
    const payloadHtml = buildPayloadHtml(formatPayload(call.payload));
    html += `<div class="pair-row pair-request">
      <div class="pair-action-header">
        <div class="pair-action-name${OCPP_DESCRIPTIONS[call.action] ? ' has-ocpp-desc' : ''}" data-ocpp-action="${escapeHtml(call.action || '')}">${escapeHtml(call.action || call.uniqueId)}</div>
        ${tsHtml(call.timestamp)}
      </div>
      <div class="pair-row-meta">
        <span class="msg-line">L${call.line}</span>
        <span class="pair-row-arrow">↑</span>
        <span class="pair-row-type">CALL</span>
        ${dirBadge}
      </div>
      ${payloadHtml}
    </div>`;
  }

  // ── CALLRESULT / CALLERROR row ────────────────────────────
  if (response) {
    const dirBadge = dirBadgeHtml(call?.action ?? response.action, true, response.direction);
    const rowClass  = response.type === 'CALLERROR' ? 'pair-error' : 'pair-response';
    const typeLabel = response.type === 'CALLERROR' ? 'ERROR' : 'RESPONSE';

    let payloadStr;
    if (response.type === 'CALLERROR') {
      payloadStr = response.errorCode || 'UnknownError';
      if (response.errorDescription) payloadStr += ': ' + response.errorDescription;
      if (response.errorDetails && Object.keys(response.errorDetails).length > 0) {
        payloadStr += '\n' + formatPayload(response.errorDetails);
      }
    } else {
      payloadStr = formatPayload(response.payload);
    }
    const payloadHtml = buildPayloadHtml(payloadStr);

    html += `<div class="pair-row ${rowClass}">
      <div class="pair-row-meta">
        <span class="msg-line">L${response.line}</span>
        ${tsHtml(response.timestamp)}
        <span class="pair-row-arrow">↓</span>
        <span class="pair-row-type">${typeLabel}</span>
        ${dirBadge}
      </div>
      ${payloadHtml}
    </div>`;
  } else if (call) {
    html += `<div class="pair-no-response">⚠ Keine Antwort empfangen</div>`;
  }

  html += '</div>';
  return html;
}

function formatPayload(payload) {
  if (!payload) return '{}';
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

// ============================================================
// Display Issues
// ============================================================
function displayIssues(errors, warnings) {
  const container = document.getElementById('tab-issues');

  if ((!errors || errors.length === 0) && (!warnings || warnings.length === 0)) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div><div>Keine Issues erkannt</div></div>';
    return;
  }

  let html = '';

  if (errors && errors.length > 0) {
    html += `<div class="issues-section-header errors-header">🔴 Fehler (${errors.length})</div>`;
    groupIssuesByMessage(errors).forEach(group => {
      html += buildIssueGroup(group, 'error');
    });
  }

  if (warnings && warnings.length > 0) {
    html += `<div class="issues-section-header warnings-header">🟡 Warnungen (${warnings.length})</div>`;
    groupIssuesByMessage(warnings).forEach(group => {
      html += buildIssueGroup(group, 'warning');
    });
  }

  container.innerHTML = html;
}

function groupIssuesByMessage(issues) {
  const map = new Map();
  for (const issue of issues) {
    if (!map.has(issue.message)) map.set(issue.message, []);
    map.get(issue.message).push(issue);
  }
  return Array.from(map.values());
}

function buildIssueGroup(items, type) {
  const icon    = type === 'error' ? '🔴' : '🟡';
  const message = items[0].message;
  const count   = items.length;
  const countBadge = count > 1 ? `<span class="issue-count">${count}×</span>` : '';

  const occurrences = items.map(issue => {
    const lineLabel  = issue.line > 0 ? `Zeile ${issue.line}` : '';
    const detailText = issue.detail ? escapeHtml(issue.detail) : '';
    const onclick    = issue.line > 0 ? `onclick="jumpToLine(${issue.line})"` : '';
    return `<div class="issue-occurrence" ${onclick} title="In Nachrichten anzeigen">
      <span class="occurrence-line">${lineLabel}</span>
      <span class="occurrence-detail">${detailText}</span>
      <span class="occurrence-arrow">→</span>
    </div>`;
  }).join('');

  return `<details class="issue-group type-${type}">
    <summary class="issue-summary">
      <span class="issue-chevron"></span>
      <span class="issue-icon">${icon}</span>
      <span class="issue-message">${escapeHtml(message)}</span>
      ${countBadge}
    </summary>
    <div class="issue-occurrences">${occurrences}</div>
  </details>`;
}

function jumpToLine(line) {
  if (!line || line <= 0) return;
  switchTab('messages');
  setTimeout(() => {
    const container = document.getElementById('tab-messages');
    const pairs = container.querySelectorAll('.msg-pair[data-line]');
    let best = null;
    let bestDiff = Infinity;
    pairs.forEach(el => {
      const diff = Math.abs(parseInt(el.dataset.line, 10) - line);
      if (diff < bestDiff) { bestDiff = diff; best = el; }
    });
    if (best) {
      best.scrollIntoView({ behavior: 'smooth', block: 'center' });
      best.classList.add('highlight-jump');
      setTimeout(() => best.classList.remove('highlight-jump'), 1500);
    }
  }, 50);
}

// ============================================================
// AI Analysis (Streaming)
// ============================================================
async function analyzeLogs() {
  if (analysisDone) { switchTab('analysis'); return; }

  if (analyzeAbortController) {
    analyzeAbortController.abort();
  }
  analyzeAbortController = new AbortController();

  const content = logInput.value.trim();
  if (!content) { showToast('Kein Log-Inhalt vorhanden', 'error'); return; }

  const url   = ollamaUrl.value.trim();
  const model = modelSelect.value;
  if (!url)   { showToast('Ollama URL eingeben', 'error'); return; }
  if (!model) { showToast('Modell auswählen', 'error'); return; }

  // Auto-parse if not done yet
  if (!parsedData) {
    await parseLogs();
    if (!parsedData) return;
  }

  isAnalyzing = true;
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = '⏳ Analysiere...';
  const signal = analyzeAbortController.signal;
  switchTab('analysis');

  const analysisTab = document.getElementById('tab-analysis');
  analysisTab.innerHTML = `<div class="analyzing-spinner"><div class="spinner"></div> KI analysiert Log...</div>`;

  let fullText = '';
  let success  = false;

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        log_content: content,
        parsed_data: parsedData,
        ollama_url: url,
        model: model,
        customer_context: customerContext ? customerContext.value.trim() : '',
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || 'Server-Fehler');
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let started   = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;

      if (!started) {
        started = true;
        analysisTab.innerHTML = '';
      }

      renderAnalysis(analysisTab, fullText, true);
    }

    renderAnalysis(analysisTab, fullText, false);
    showToast('✅ KI-Analyse abgeschlossen', 'success');
    success = true;
    analysisDone = true;
  } catch (err) {
    analysisTab.innerHTML = `<div class="issue-card type-error"><div class="issue-icon">🔴</div><div class="issue-body"><div class="issue-message">Analyse fehlgeschlagen</div><div class="issue-detail">${escapeHtml(err.message)}</div></div></div>`;
    showToast('Analyse-Fehler: ' + err.message, 'error');
  } finally {
    isAnalyzing = false;
    analyzeAbortController = null;
    if (!success) {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = '🤖 KI-Analyse';
    } else {
      analyzeBtn.textContent = '✅ KI-Analyse';
      analyzeBtn.title = 'Bereits analysiert – Log leeren für neue Analyse';
    }
  }
}

function renderAnalysis(container, text, streaming) {
  try {
    const html = (typeof marked !== 'undefined')
      ? marked.parse(text)
      : `<pre>${escapeHtml(text)}</pre>`;

    const cursor = streaming ? '<span class="streaming-indicator"></span>' : '';
    container.innerHTML = `<div class="analysis-content">${html}${cursor}</div>`;
  } catch {
    container.innerHTML = `<div class="analysis-content"><pre>${escapeHtml(text)}</pre></div>`;
  }

  // Auto-scroll to bottom during streaming
  if (streaming) container.scrollTop = container.scrollHeight;
}

// ============================================================
// Erklärung (Streaming)
// ============================================================
async function draftExplanation() {
  // If already done, just navigate to the tab
  if (explanationDone) {
    switchTab('explanation');
    return;
  }
  // Switch tab immediately so the user sees something happen
  switchTab('explanation');
  const explanationTab = document.getElementById('tab-explanation');

  const content = logInput.value.trim();
  if (!content) {
    explanationTab.innerHTML = `<div class="explanation-hint-state"><div class="empty-icon">📄</div><div>Bitte zuerst einen OCPP-Log einfügen und parsen.</div></div>`;
    return;
  }

  const url   = ollamaUrl.value.trim();
  const model = modelSelect.value;
  if (!url || !model) {
    explanationTab.innerHTML = `<div class="explanation-hint-state"><div class="empty-icon">⚙️</div><div>Bitte Ollama URL und Modell in den <strong>Einstellungen</strong> konfigurieren.</div></div>`;
    return;
  }

  if (!parsedData) {
    await parseLogs();
    if (!parsedData) return;
  }

  // Abort any still-running previous request, then create fresh controller
  if (explanationAbortController) {
    explanationAbortController.abort();
  }
  explanationAbortController = new AbortController();

  explanationBtn.disabled = true;
  explanationBtn.textContent = '⏳ Erkläre...';
  const signal = explanationAbortController.signal;
  explanationTab.innerHTML = `<div class="analyzing-spinner"><div class="spinner"></div> Einfache Erklärung wird erstellt...</div>`;
  explanationText = '';
  let success = false;

  try {
    const response = await fetch('/api/explain', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        log_content: content,
        parsed_data: parsedData,
        ollama_url: url,
        model: model,
        customer_context: customerContext ? customerContext.value.trim() : '',
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || 'Server-Fehler');
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let started   = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      explanationText += chunk;

      if (!started) {
        started = true;
        explanationTab.innerHTML = '';
      }

      renderExplanation(explanationTab, explanationText, true);
    }

    renderExplanation(explanationTab, explanationText, false);
    showToast('✅ Erklärung erstellt', 'success');
    success = true;
    explanationDone = true;
  } catch (err) {
    explanationTab.innerHTML = `<div class="issue-card type-error"><div class="issue-icon">🔴</div><div class="issue-body"><div class="issue-message">Erklärung fehlgeschlagen</div><div class="issue-detail">${escapeHtml(err.message)}</div></div></div>`;
    if (err.name !== 'AbortError') {
      showToast('Fehler: ' + err.message, 'error');
    }
  } finally {
    explanationAbortController = null;
    explanationBtn.disabled = false;
    if (!success) {
      explanationBtn.textContent = '💡 Einfache Erklärung';
    } else {
      explanationBtn.textContent = '✅ Erklärt';
      explanationBtn.title = 'Bereits erklärt – Log leeren für neue Erklärung';
    }
  }
}

function renderExplanation(container, text, streaming) {
  try {
    const html = (typeof marked !== 'undefined')
      ? marked.parse(text)
      : `<pre>${escapeHtml(text)}</pre>`;

    const cursor = streaming ? '<span class="streaming-indicator"></span>' : '';
    container.innerHTML = `<div class="explanation-content analysis-content">${html}${cursor}</div>`;
  } catch {
    container.innerHTML = `<div class="explanation-content analysis-content"><pre>${escapeHtml(text)}</pre></div>`;
  }

  if (streaming) container.scrollTop = container.scrollHeight;
}

// ============================================================
// Empty-state HTML constants
// ============================================================
const OCPP_DESCRIPTIONS = {
  Authorize:                        'Die Ladestation fragt das Backend, ob eine RFID-Karte oder ein Nutzer zum Laden berechtigt ist.',
  BootNotification:                 'Die Ladestation meldet sich beim Backend an und übermittelt Hersteller, Modell und Seriennummer. Das Backend antwortet mit Uhrzeit und Heartbeat-Intervall.',
  ChangeAvailability:               'Das Backend ändert die Verfügbarkeit eines Anschlusses oder der gesamten Ladestation (Verfügbar / Nicht verfügbar).',
  ChangeConfiguration:              'Das Backend ändert einen Konfigurationsparameter der Ladestation.',
  ClearCache:                       'Das Backend weist die Ladestation an, ihren lokalen Autorisierungscache zu löschen.',
  ClearChargingProfile:             'Das Backend löscht ein oder mehrere Ladeprofile von der Ladestation.',
  DataTransfer:                     'Ermöglicht den Austausch herstellerspezifischer Daten, die nicht im OCPP-Standard definiert sind.',
  DiagnosticsStatusNotification:    'Die Ladestation meldet den Fortschritt einer laufenden Diagnosedaten-Übertragung.',
  FirmwareStatusNotification:       'Die Ladestation meldet den Stand einer Firmware-Aktualisierung (z.B. Herunterladen, Installieren, Abgeschlossen).',
  GetCompositeSchedule:             'Das Backend fragt den zusammengesetzten Ladezeitplan eines Anschlusses ab.',
  GetConfiguration:                 'Das Backend fragt die aktuelle Konfiguration der Ladestation ab.',
  GetDiagnostics:                   'Das Backend fordert die Ladestation auf, Diagnosedateien hochzuladen.',
  GetLocalListVersion:              'Das Backend fragt die Versionsnummer der lokalen Autorisierungsliste ab.',
  Heartbeat:                        'Regelmäßiges Lebenszeichen der Ladestation. Bestätigt, dass die Verbindung aktiv ist, und synchronisiert die Uhrzeit.',
  LogStatusNotification:            'Die Ladestation meldet den Status einer laufenden Log-Datei-Übertragung (Security-Logging).',
  MeterValues:                      'Die Ladestation sendet aktuelle Messwerte (Strom, Spannung, Energie) – in regelmäßigen Abständen oder auf Anforderung.',
  RemoteStartTransaction:           'Das Backend fordert die Ladestation auf, einen Ladevorgang zu starten – z.B. per App-Befehl.',
  RemoteStopTransaction:            'Das Backend fordert die Ladestation auf, einen laufenden Ladevorgang zu beenden.',
  ReserveNow:                       'Das Backend reserviert einen Ladepunkt für einen bestimmten Nutzer.',
  CancelReservation:                'Das Backend storniert eine bestehende Reservierung.',
  Reset:                            'Das Backend fordert einen Neustart der Ladestation (Soft = Neustart nach laufendem Ladevorgang, Hard = sofortiger Neustart).',
  SecurityEventNotification:        'Die Ladestation meldet ein sicherheitsrelevantes Ereignis an das Backend.',
  SendLocalList:                    'Das Backend sendet eine aktualisierte lokale Autorisierungsliste an die Ladestation.',
  SetChargingProfile:               'Das Backend sendet ein Ladeprofil zur Steuerung von Ladeleistung oder -zeitplan.',
  SignCertificate:                  'Die Ladestation sendet eine Zertifikatsanfrage (CSR) an das Backend zur Signierung.',
  SignedFirmwareStatusNotification: 'Die Ladestation meldet den Status einer signierten Firmware-Aktualisierung.',
  StartTransaction:                 'Die Ladestation informiert das Backend, dass ein Ladevorgang begonnen hat. Enthält Karten-ID, Zählerstand und Startzeitpunkt.',
  StatusNotification:               'Die Ladestation teilt dem Backend ihren aktuellen Zustand mit (z.B. Verfügbar, Laden, Gestört). Wird bei jeder Statusänderung gesendet.',
  StopTransaction:                  'Die Ladestation meldet das Ende eines Ladevorgangs. Enthält Endzählerstand, geladene Energiemenge und Stoppgrund.',
  TriggerMessage:                   'Das Backend fordert die Ladestation auf, eine bestimmte Nachricht sofort zu senden (z.B. StatusNotification oder Heartbeat).',
  UnlockConnector:                  'Das Backend fordert die Ladestation auf, einen Stecker mechanisch freizugeben.',
  UpdateFirmware:                   'Das Backend weist die Ladestation an, eine neue Firmware-Version herunterzuladen und zu installieren.',
};

const EMPTY_STATES = {
  messages: '<div class="empty-state"><div class="empty-icon">📭</div><div>Log parsen um Nachrichten anzuzeigen</div></div>',
  analysis: '<div class="empty-state"><div class="empty-icon">🔬</div><div>„🤖 KI-Analyse" klicken um eine detaillierte Analyse zu erhalten</div></div>',
  issues:   '<div class="empty-state"><div class="empty-icon">✅</div><div>Keine Issues erkannt</div></div>',
  explanation: '<div class="empty-state"><div class="empty-icon">💡</div><div>„💡 Einfache Erklärung" klicken um eine verständliche Zusammenfassung zu erhalten</div></div>',
};

// ============================================================
// Clear Log
// ============================================================
function clearLog() {
  logInput.value = '';
  if (customerContext) customerContext.value = '';
  updateCharCount();
  markResultsDirty();
  showToast('Log geleert', 'info');
}

// ============================================================
// Reset Results (rechtes Panel leeren, Eingabe bleibt)
// ============================================================
function markResultsDirty() {
  parsedData      = null;
  analysisDone    = false;
  explanationDone = false;
  lastParsedContent = '';
  allPairs = [];

  issuesBadge.classList.add('hidden');

  document.getElementById('tab-messages').innerHTML = EMPTY_STATES.messages;
  document.getElementById('tab-analysis').innerHTML = EMPTY_STATES.analysis;
  document.getElementById('tab-issues').innerHTML   = EMPTY_STATES.issues;
  document.getElementById('tab-explanation').innerHTML    = EMPTY_STATES.explanation;
  explanationText = '';

  if (timelineChartInstance) { timelineChartInstance.destroy(); timelineChartInstance = null; }

  analyzeBtn.disabled    = false;
  analyzeBtn.textContent = '🤖 KI-Analyse';
  analyzeBtn.title       = '';
  explanationBtn.disabled    = false;
  explanationBtn.textContent = '💡 Einfache Erklärung';
  explanationBtn.title       = '';
}

function resetResults() {
  markResultsDirty();
  switchTab('messages');
  showToast('Ergebnisse zurückgesetzt', 'info');
}

// ============================================================
// Load Example Log (cycles through multiple examples)
// ============================================================
let exampleIndex = 0;

function loadExample() {
  logInput.value = EXAMPLE_LOGS[exampleIndex % EXAMPLE_LOGS.length];
  exampleIndex++;
  updateCharCount();
  showToast(`📄 Beispiel ${exampleIndex} von ${EXAMPLE_LOGS.length} geladen`, 'info');
}

// ============================================================
// Toast Notifications
// ============================================================
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ============================================================
// Helpers
// ============================================================
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// --- OCPP Tooltip ---
(function initOcppTooltip() {
  const tooltip = document.getElementById('ocppTooltip');
  if (!tooltip) return;
  const titleEl = tooltip.querySelector('.ocpp-tooltip-title');
  const bodyEl  = tooltip.querySelector('.ocpp-tooltip-body');
  let hideTimer;

  function show(action, anchorEl) {
    const desc = OCPP_DESCRIPTIONS[action];
    if (!desc) return;
    clearTimeout(hideTimer);
    titleEl.textContent = action;
    bodyEl.textContent  = desc;
    tooltip.classList.remove('hidden');

    const rect = anchorEl.getBoundingClientRect();
    const scrollY = window.scrollY;
    let top  = rect.bottom + scrollY + 6;
    let left = rect.left + window.scrollX;

    tooltip.style.left = '0';
    tooltip.style.top  = '0';
    tooltip.style.visibility = 'hidden';
    tooltip.classList.remove('hidden');
    const tw = tooltip.offsetWidth;
    if (left + tw > window.innerWidth - 12) left = window.innerWidth - tw - 12;
    tooltip.style.left = left + 'px';
    tooltip.style.top  = top + 'px';
    tooltip.style.visibility = '';
  }

  function hide() {
    hideTimer = setTimeout(() => tooltip.classList.add('hidden'), 120);
  }

  // tab-messages exists in the static HTML; msg-list is created dynamically
  const msgContainer = document.getElementById('tab-messages');
  if (!msgContainer) return;

  msgContainer.addEventListener('mouseover', e => {
    const el = e.target.closest('.pair-action-name[data-ocpp-action]');
    if (el) show(el.dataset.ocppAction, el);
  });
  msgContainer.addEventListener('mouseout', e => {
    if (e.target.closest('.pair-action-name[data-ocpp-action]')) hide();
  });
  tooltip.addEventListener('mouseover', () => clearTimeout(hideTimer));
  tooltip.addEventListener('mouseout', hide);
})();

// ============================================================
// Example OCPP 1.6 Logs
// ============================================================

// Example 1: Ground fault + invalid RFID + emergency stop
const EXAMPLE_1 = `2024-01-15T10:00:00.000Z SEND [2,"msg-001","BootNotification",{"chargePointVendor":"EVBox","chargePointModel":"BusinessLine","chargePointSerialNumber":"EVB-P1234567","firmwareVersion":"3.0.1","iccid":"","imsi":"","meterType":"Inepro Metering","meterSerialNumber":"PRE12345678"}]
2024-01-15T10:00:00.521Z RECV [3,"msg-001",{"currentTime":"2024-01-15T10:00:00Z","interval":300,"status":"Accepted"}]
2024-01-15T10:00:01.100Z SEND [2,"msg-002","StatusNotification",{"connectorId":0,"errorCode":"NoError","status":"Available"}]
2024-01-15T10:00:01.234Z RECV [3,"msg-002",{}]
2024-01-15T10:00:01.350Z SEND [2,"msg-003","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Available"}]
2024-01-15T10:00:01.490Z RECV [3,"msg-003",{}]
2024-01-15T10:05:00.000Z SEND [2,"msg-004","Heartbeat",{}]
2024-01-15T10:05:00.123Z RECV [3,"msg-004",{"currentTime":"2024-01-15T10:05:00Z"}]
2024-01-15T10:10:00.000Z SEND [2,"msg-005","Authorize",{"idTag":"ABC-12345"}]
2024-01-15T10:10:00.215Z RECV [3,"msg-005",{"idTagInfo":{"status":"Accepted","expiryDate":"2024-12-31T23:59:59Z"}}]
2024-01-15T10:10:00.300Z SEND [2,"msg-006","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Preparing"}]
2024-01-15T10:10:00.420Z RECV [3,"msg-006",{}]
2024-01-15T10:10:01.000Z SEND [2,"msg-007","StartTransaction",{"connectorId":1,"idTag":"ABC-12345","meterStart":0,"timestamp":"2024-01-15T10:10:01Z"}]
2024-01-15T10:10:01.320Z RECV [3,"msg-007",{"transactionId":9876,"idTagInfo":{"status":"Accepted"}}]
2024-01-15T10:10:01.450Z SEND [2,"msg-008","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Charging"}]
2024-01-15T10:10:01.570Z RECV [3,"msg-008",{}]
2024-01-15T10:15:00.000Z SEND [2,"msg-009","MeterValues",{"connectorId":1,"transactionId":9876,"meterValue":[{"timestamp":"2024-01-15T10:15:00Z","sampledValue":[{"value":"2500","measurand":"Power.Active.Import","unit":"W"},{"value":"1.500","measurand":"Energy.Active.Import.Register","unit":"kWh"}]}]}]
2024-01-15T10:15:00.180Z RECV [3,"msg-009",{}]
2024-01-15T10:20:00.000Z SEND [2,"msg-010","MeterValues",{"connectorId":1,"transactionId":9876,"meterValue":[{"timestamp":"2024-01-15T10:20:00Z","sampledValue":[{"value":"2480","measurand":"Power.Active.Import","unit":"W"},{"value":"3.583","measurand":"Energy.Active.Import.Register","unit":"kWh"}]}]}]
2024-01-15T10:20:00.195Z RECV [3,"msg-010",{}]
2024-01-15T10:22:00.000Z SEND [2,"msg-011","StatusNotification",{"connectorId":1,"errorCode":"GroundFailure","status":"Faulted","info":"Ground fault detected on connector 1"}]
2024-01-15T10:22:00.140Z RECV [3,"msg-011",{}]
2024-01-15T10:22:05.000Z SEND [2,"msg-012","Authorize",{"idTag":"UNKNOWN-TAG-999"}]
2024-01-15T10:22:05.320Z RECV [3,"msg-012",{"idTagInfo":{"status":"Invalid"}}]
2024-01-15T10:22:10.000Z SEND [2,"msg-013","StopTransaction",{"transactionId":9876,"meterStop":3750,"timestamp":"2024-01-15T10:22:10Z","reason":"EmergencyStop","idTag":"ABC-12345"}]
2024-01-15T10:22:10.410Z RECV [3,"msg-013",{"idTagInfo":{"status":"Accepted"}}]
2024-01-15T10:22:11.000Z SEND [2,"msg-014","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Available"}]
2024-01-15T10:22:11.150Z RECV [3,"msg-014",{}]
2024-01-15T10:23:00.000Z SEND [2,"msg-015","ChangeAvailability",{"connectorId":0,"type":"Inoperative"}]
2024-01-15T10:23:00.320Z RECV [3,"msg-015",{"status":"Rejected"}]
2024-01-15T10:25:00.000Z SEND [2,"msg-016","DataTransfer",{"vendorId":"com.example","messageId":"GetDiagnostics","data":"{}"}]
2024-01-15T10:25:00.450Z RECV [4,"msg-016","NotImplemented","The requested action is not known by the receiver",{}]
2024-01-15T10:30:00.000Z SEND [2,"msg-017","Heartbeat",{}]
2024-01-15T10:30:00.112Z RECV [3,"msg-017",{"currentTime":"2024-01-15T10:30:00Z"}]
2024-01-15T10:35:00.000Z SEND [2,"msg-018","RemoteStartTransaction",{"connectorId":1,"idTag":"RFID-XYZ"}]`;

// Example 2: Normal successful charge session (clean flow, no errors)
const EXAMPLE_2 = `2024-03-10T08:00:00.000Z SEND [2,"s-001","BootNotification",{"chargePointVendor":"Alpitronic","chargePointModel":"Hypercharger100","chargePointSerialNumber":"ALP-HC-00423","firmwareVersion":"1.9.4","meterType":"MID","meterSerialNumber":"MID-8823441"}]
2024-03-10T08:00:00.312Z RECV [3,"s-001",{"currentTime":"2024-03-10T08:00:00Z","interval":60,"status":"Accepted"}]
2024-03-10T08:00:01.000Z SEND [2,"s-002","StatusNotification",{"connectorId":0,"errorCode":"NoError","status":"Available"}]
2024-03-10T08:00:01.120Z RECV [3,"s-002",{}]
2024-03-10T08:00:01.200Z SEND [2,"s-003","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Available"}]
2024-03-10T08:00:01.310Z RECV [3,"s-003",{}]
2024-03-10T08:01:00.000Z SEND [2,"s-004","Heartbeat",{}]
2024-03-10T08:01:00.090Z RECV [3,"s-004",{"currentTime":"2024-03-10T08:01:00Z"}]
2024-03-10T08:05:22.000Z SEND [2,"s-005","Authorize",{"idTag":"RFID-4A2F9C"}]
2024-03-10T08:05:22.188Z RECV [3,"s-005",{"idTagInfo":{"status":"Accepted","expiryDate":"2025-12-31T23:59:59Z","parentIdTag":"GROUP-FLEET-01"}}]
2024-03-10T08:05:22.300Z SEND [2,"s-006","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Preparing"}]
2024-03-10T08:05:22.420Z RECV [3,"s-006",{}]
2024-03-10T08:05:23.000Z SEND [2,"s-007","StartTransaction",{"connectorId":1,"idTag":"RFID-4A2F9C","meterStart":12450,"timestamp":"2024-03-10T08:05:23Z","reservationId":0}]
2024-03-10T08:05:23.245Z RECV [3,"s-007",{"transactionId":10042,"idTagInfo":{"status":"Accepted"}}]
2024-03-10T08:05:23.400Z SEND [2,"s-008","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Charging"}]
2024-03-10T08:05:23.510Z RECV [3,"s-008",{}]
2024-03-10T08:10:23.000Z SEND [2,"s-009","MeterValues",{"connectorId":1,"transactionId":10042,"meterValue":[{"timestamp":"2024-03-10T08:10:23Z","sampledValue":[{"value":"22000","measurand":"Power.Active.Import","unit":"W"},{"value":"12452.833","measurand":"Energy.Active.Import.Register","unit":"kWh"}]}]}]
2024-03-10T08:10:23.155Z RECV [3,"s-009",{}]
2024-03-10T08:15:23.000Z SEND [2,"s-010","MeterValues",{"connectorId":1,"transactionId":10042,"meterValue":[{"timestamp":"2024-03-10T08:15:23Z","sampledValue":[{"value":"21800","measurand":"Power.Active.Import","unit":"W"},{"value":"14284.500","measurand":"Energy.Active.Import.Register","unit":"kWh"}]}]}]
2024-03-10T08:15:23.140Z RECV [3,"s-010",{}]
2024-03-10T08:20:23.000Z SEND [2,"s-011","MeterValues",{"connectorId":1,"transactionId":10042,"meterValue":[{"timestamp":"2024-03-10T08:20:23Z","sampledValue":[{"value":"18500","measurand":"Power.Active.Import","unit":"W"},{"value":"16100.750","measurand":"Energy.Active.Import.Register","unit":"kWh"}]}]}]
2024-03-10T08:20:23.162Z RECV [3,"s-011",{}]
2024-03-10T08:25:10.000Z SEND [2,"s-012","StopTransaction",{"transactionId":10042,"meterStop":17650,"timestamp":"2024-03-10T08:25:10Z","reason":"Local","idTag":"RFID-4A2F9C"}]
2024-03-10T08:25:10.290Z RECV [3,"s-012",{"idTagInfo":{"status":"Accepted"}}]
2024-03-10T08:25:11.000Z SEND [2,"s-013","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Finishing"}]
2024-03-10T08:25:11.120Z RECV [3,"s-013",{}]
2024-03-10T08:25:15.000Z SEND [2,"s-014","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Available"}]
2024-03-10T08:25:15.110Z RECV [3,"s-014",{}]
2024-03-10T08:26:00.000Z SEND [2,"s-015","Heartbeat",{}]
2024-03-10T08:26:00.085Z RECV [3,"s-015",{"currentTime":"2024-03-10T08:26:00Z"}]`;

// Example 3: Connection timeout / heartbeat failure – station goes offline mid-session
const EXAMPLE_3 = `2024-06-20T14:00:00.000Z SEND [2,"t-001","BootNotification",{"chargePointVendor":"Wallbox","chargePointModel":"Commander2","chargePointSerialNumber":"WB-CMD2-88512","firmwareVersion":"5.7.12","meterType":"MID","meterSerialNumber":"WB-MID-55312"}]
2024-06-20T14:00:00.290Z RECV [3,"t-001",{"currentTime":"2024-06-20T14:00:00Z","interval":30,"status":"Accepted"}]
2024-06-20T14:00:01.000Z SEND [2,"t-002","StatusNotification",{"connectorId":0,"errorCode":"NoError","status":"Available"}]
2024-06-20T14:00:01.110Z RECV [3,"t-002",{}]
2024-06-20T14:00:01.200Z SEND [2,"t-003","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Available"}]
2024-06-20T14:00:01.320Z RECV [3,"t-003",{}]
2024-06-20T14:00:30.000Z SEND [2,"t-004","Heartbeat",{}]
2024-06-20T14:00:30.095Z RECV [3,"t-004",{"currentTime":"2024-06-20T14:00:30Z"}]
2024-06-20T14:02:15.000Z SEND [2,"t-005","Authorize",{"idTag":"RFID-9B3D1E"}]
2024-06-20T14:02:15.210Z RECV [3,"t-005",{"idTagInfo":{"status":"Accepted"}}]
2024-06-20T14:02:15.400Z SEND [2,"t-006","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Preparing"}]
2024-06-20T14:02:15.520Z RECV [3,"t-006",{}]
2024-06-20T14:02:16.000Z SEND [2,"t-007","StartTransaction",{"connectorId":1,"idTag":"RFID-9B3D1E","meterStart":5800,"timestamp":"2024-06-20T14:02:16Z"}]
2024-06-20T14:02:16.315Z RECV [3,"t-007",{"transactionId":20317,"idTagInfo":{"status":"Accepted"}}]
2024-06-20T14:02:16.500Z SEND [2,"t-008","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Charging"}]
2024-06-20T14:02:16.615Z RECV [3,"t-008",{}]
2024-06-20T14:03:00.000Z SEND [2,"t-009","Heartbeat",{}]
2024-06-20T14:03:00.088Z RECV [3,"t-009",{"currentTime":"2024-06-20T14:03:00Z"}]
2024-06-20T14:07:16.000Z SEND [2,"t-010","MeterValues",{"connectorId":1,"transactionId":20317,"meterValue":[{"timestamp":"2024-06-20T14:07:16Z","sampledValue":[{"value":"11000","measurand":"Power.Active.Import","unit":"W"},{"value":"5800.917","measurand":"Energy.Active.Import.Register","unit":"kWh"}]}]}]
2024-06-20T14:07:16.145Z RECV [3,"t-010",{}]
2024-06-20T14:03:30.000Z SEND [2,"t-011","Heartbeat",{}]
2024-06-20T14:04:00.000Z SEND [2,"t-012","Heartbeat",{}]
2024-06-20T14:04:30.000Z SEND [2,"t-013","Heartbeat",{}]
2024-06-20T14:05:00.000Z SEND [2,"t-014","Heartbeat",{}]
2024-06-20T14:12:16.000Z SEND [2,"t-015","StopTransaction",{"transactionId":20317,"meterStop":6230,"timestamp":"2024-06-20T14:12:16Z","reason":"PowerLoss","idTag":"RFID-9B3D1E"}]
2024-06-20T14:25:44.000Z SEND [2,"t-016","BootNotification",{"chargePointVendor":"Wallbox","chargePointModel":"Commander2","chargePointSerialNumber":"WB-CMD2-88512","firmwareVersion":"5.7.12","meterType":"MID","meterSerialNumber":"WB-MID-55312"}]
2024-06-20T14:25:44.380Z RECV [3,"t-016",{"currentTime":"2024-06-20T14:25:44Z","interval":30,"status":"Accepted"}]
2024-06-20T14:25:45.000Z SEND [2,"t-017","StatusNotification",{"connectorId":0,"errorCode":"NoError","status":"Available"}]
2024-06-20T14:25:45.130Z RECV [3,"t-017",{}]
2024-06-20T14:25:45.250Z SEND [2,"t-018","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Available"}]
2024-06-20T14:25:45.360Z RECV [3,"t-018",{}]`;

const EXAMPLE_LOGS = [EXAMPLE_1, EXAMPLE_2, EXAMPLE_3];
