/* ============================================================
   OCPP Log Analyzer – Frontend Logic
   ============================================================ */

// --- State ---
let parsedData             = null;
let isAnalyzing            = false;
let allPairs               = [];
let analyzeAbortController = null;
let emailAbortController   = null;
let emailDraftText         = '';
let analysisDone           = false;
let explanationDone        = false;

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
const draftEmailBtn   = document.getElementById('draftEmailBtn');

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
  logInput.addEventListener('input', updateCharCount);

  parseBtn.addEventListener('click', parseLogs);
  analyzeBtn.addEventListener('click', analyzeLogs);
  draftEmailBtn.addEventListener('click', draftEmail);
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

    updateStats(parsedData.stats);
    displayMessages(parsedData.messages);
    displayIssues(parsedData.errors, parsedData.warnings);
    switchTab('messages');

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
    <div class="msg-filter-bar">
      <select id="filterAction" class="filter-input">
        <option value="">Alle Event-Typen</option>
        ${actionOptions}
      </select>
      <button id="filterErrors" class="filter-toggle" data-active="false">🔴 Nur Fehler</button>
      <span id="filterCount" class="filter-count"></span>
      <button id="filterClear" class="filter-clear" title="Filter zurücksetzen">✕</button>
    </div>
    <div id="msg-list"></div>
  `;

  document.getElementById('filterAction').addEventListener('change', renderFilteredPairs);
  document.getElementById('filterErrors').addEventListener('click', () => {
    const btn = document.getElementById('filterErrors');
    const active = btn.dataset.active === 'true';
    btn.dataset.active = String(!active);
    btn.classList.toggle('active', !active);
    renderFilteredPairs();
  });
  document.getElementById('filterClear').addEventListener('click', () => {
    document.getElementById('filterAction').value = '';
    const btn = document.getElementById('filterErrors');
    btn.dataset.active = 'false';
    btn.classList.remove('active');
    renderFilteredPairs();
  });

  renderFilteredPairs();
}

function renderFilteredPairs() {
  const list = document.getElementById('msg-list');
  if (!list) return;

  const fromVal    = document.getElementById('filterFrom')?.value ?? '';
  const toVal      = document.getElementById('filterTo')?.value   ?? '';
  const actionVal  = document.getElementById('filterAction')?.value ?? '';
  const errorsOnly = document.getElementById('filterErrors')?.dataset.active === 'true';

  const filtered = allPairs.filter(({ call, response, isError }) => {
    const unanswered = call && !response;

    if (errorsOnly && !isError && !unanswered) return false;
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
      <div class="pair-row-meta">
        <span class="msg-line">L${call.line}</span>
        <span class="pair-row-arrow">↑</span>
        <span class="pair-row-type">CALL</span>
        ${dirBadge}
        <span class="pair-ts" title="${escapeHtml(call.timestamp || '')}">${formatTime(call.timestamp)}</span>
        <span class="pair-action-name" title="${escapeHtml(call.action || '')}">${escapeHtml(call.action || call.uniqueId)}</span>
      </div>
      ${payloadHtml}
    </div>`;
  }

  // ── CALLRESULT / CALLERROR row ────────────────────────────
  if (response) {
    const dirBadge = dirBadgeHtml(call?.action ?? response.action, true, response.direction);
    const rowClass  = response.type === 'CALLERROR' ? 'pair-error' : 'pair-response';
    const typeLabel = response.type === 'CALLERROR' ? 'ERROR' : 'RES';

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
        <span class="pair-row-arrow">↓</span>
        <span class="pair-row-type">${typeLabel}</span>
        ${dirBadge}
        <span class="pair-ts" title="${escapeHtml(response.timestamp || '')}">${formatTime(response.timestamp)}</span>
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
// Email Draft (Streaming)
// ============================================================
async function draftEmail() {
  // Switch tab immediately so the user sees something happen
  switchTab('email');
  const emailTab = document.getElementById('tab-email');

  if (emailAbortController) {
    emailAbortController.abort();
  }
  emailAbortController = new AbortController();

  const content = logInput.value.trim();
  if (!content) {
    emailTab.innerHTML = `<div class="email-hint-state"><div class="empty-icon">📄</div><div>Bitte zuerst einen OCPP-Log einfügen und parsen.</div></div>`;
    return;
  }

  const url   = ollamaUrl.value.trim();
  const model = modelSelect.value;
  if (!url || !model) {
    emailTab.innerHTML = `<div class="email-hint-state"><div class="empty-icon">⚙️</div><div>Bitte Ollama URL und Modell in den <strong>Einstellungen</strong> konfigurieren.</div></div>`;
    return;
  }

  if (!parsedData) {
    await parseLogs();
    if (!parsedData) return;
  }

  draftEmailBtn.disabled = true;
  draftEmailBtn.textContent = '⏳ Erkläre...';
  const signal = emailAbortController.signal;
  emailTab.innerHTML = `<div class="analyzing-spinner"><div class="spinner"></div> Einfache Erklärung wird erstellt...</div>`;
  emailDraftText = '';
  let success = false;

  try {
    const response = await fetch('/api/draft-email', {
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
      emailDraftText += chunk;

      if (!started) {
        started = true;
        emailTab.innerHTML = '';
      }

      renderEmailDraft(emailTab, emailDraftText, true);
    }

    renderEmailDraft(emailTab, emailDraftText, false);
    showToast('✅ Erklärung erstellt', 'success');
    success = true;
    explanationDone = true;
  } catch (err) {
    if (err.name !== 'AbortError') {
      emailTab.innerHTML = `<div class="issue-card type-error"><div class="issue-icon">🔴</div><div class="issue-body"><div class="issue-message">Erklärung fehlgeschlagen</div><div class="issue-detail">${escapeHtml(err.message)}</div></div></div>`;
      showToast('Fehler: ' + err.message, 'error');
    }
  } finally {
    emailAbortController = null;
    if (!success) {
      draftEmailBtn.disabled = false;
      draftEmailBtn.textContent = '💡 Einfache Erklärung';
    } else {
      draftEmailBtn.textContent = '✅ Erklärt';
      draftEmailBtn.title = 'Bereits erklärt – Log leeren für neue Erklärung';
    }
  }
}

function renderEmailDraft(container, text, streaming) {
  const cursor  = streaming ? '<span class="streaming-indicator"></span>' : '';
  const toolbar = streaming
    ? `<div class="email-toolbar"><span class="email-status-hint">Generiere Erklärung…</span></div>`
    : `<div class="email-toolbar">
         <button class="btn btn-secondary" onclick="copyEmailDraft()">📋 Kopieren</button>
         <span class="email-status-hint" id="emailCopyHint"></span>
       </div>`;

  container.innerHTML = `<div class="email-draft-wrapper">
    ${toolbar}
    <div class="email-draft-content">${escapeHtml(text)}${cursor}</div>
  </div>`;

  if (streaming) container.scrollTop = container.scrollHeight;
}

function copyEmailDraft() {
  if (!emailDraftText) return;
  navigator.clipboard.writeText(emailDraftText).then(() => {
    const hint = document.getElementById('emailCopyHint');
    if (hint) {
      hint.textContent = '✓ In Zwischenablage kopiert';
      setTimeout(() => { hint.textContent = ''; }, 2500);
    }
    showToast('✅ E-Mail kopiert', 'success');
  }).catch(() => showToast('Kopieren fehlgeschlagen', 'error'));
}

// ============================================================
// Empty-state HTML constants
// ============================================================
const EMPTY_STATES = {
  messages: '<div class="empty-state"><div class="empty-icon">📭</div><div>Log parsen um Nachrichten anzuzeigen</div></div>',
  analysis: '<div class="empty-state"><div class="empty-icon">🔬</div><div>„🤖 KI-Analyse" klicken um eine detaillierte Analyse zu erhalten</div></div>',
  issues:   '<div class="empty-state"><div class="empty-icon">✅</div><div>Keine Issues erkannt</div></div>',
  email:    '<div class="empty-state"><div class="empty-icon">💡</div><div>„💡 Einfache Erklärung" klicken um eine verständliche Zusammenfassung zu erhalten</div></div>',
};

// ============================================================
// Clear Log
// ============================================================
function clearLog() {
  logInput.value = '';
  if (customerContext) customerContext.value = '';
  updateCharCount();
  parsedData = null;
  allPairs   = [];

  issuesBadge.classList.add('hidden');

  document.getElementById('tab-messages').innerHTML = EMPTY_STATES.messages;
  document.getElementById('tab-analysis').innerHTML = EMPTY_STATES.analysis;
  document.getElementById('tab-issues').innerHTML   = EMPTY_STATES.issues;
  document.getElementById('tab-email').innerHTML    = EMPTY_STATES.email;
  emailDraftText = '';

  analysisDone    = false;
  explanationDone = false;
  analyzeBtn.disabled    = false;
  analyzeBtn.textContent = '🤖 KI-Analyse';
  analyzeBtn.title       = '';
  draftEmailBtn.disabled    = false;
  draftEmailBtn.textContent = '💡 Einfache Erklärung';
  draftEmailBtn.title       = '';

  showToast('Log geleert', 'info');
}

// ============================================================
// Reset Results (rechtes Panel leeren, Eingabe bleibt)
// ============================================================
function resetResults() {
  parsedData = null;

  issuesBadge.classList.add('hidden');

  document.getElementById('tab-messages').innerHTML = EMPTY_STATES.messages;
  document.getElementById('tab-analysis').innerHTML = EMPTY_STATES.analysis;
  document.getElementById('tab-issues').innerHTML   = EMPTY_STATES.issues;
  document.getElementById('tab-email').innerHTML    = EMPTY_STATES.email;
  emailDraftText = '';

  analysisDone    = false;
  explanationDone = false;
  analyzeBtn.disabled    = false;
  analyzeBtn.textContent = '🤖 KI-Analyse';
  analyzeBtn.title       = '';
  draftEmailBtn.disabled    = false;
  draftEmailBtn.textContent = '💡 Einfache Erklärung';
  draftEmailBtn.title       = '';

  switchTab('messages');
  showToast('Ergebnisse zurückgesetzt', 'info');
}

// ============================================================
// Load Example Log
// ============================================================
function loadExample() {
  logInput.value = EXAMPLE_LOG;
  updateCharCount();
  showToast('📋 Beispiel-Log geladen', 'info');
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

// ============================================================
// Example OCPP 1.6 Log
// ============================================================
const EXAMPLE_LOG = `2024-01-15T10:00:00.000Z SEND [2,"msg-001","BootNotification",{"chargePointVendor":"EVBox","chargePointModel":"BusinessLine","chargePointSerialNumber":"EVB-P1234567","firmwareVersion":"3.0.1","iccid":"","imsi":"","meterType":"Inepro Metering","meterSerialNumber":"PRE12345678"}]
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
