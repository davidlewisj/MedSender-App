const form = document.getElementById("fax-form");
const faxListEl = document.getElementById("fax-list");
const emptyStateEl = document.getElementById("empty-state");
const refreshButton = document.getElementById("refresh-faxes");
const optionsButton = document.getElementById("open-options");
const sendStatusEl = document.getElementById("send-status");
const setupScreenEl = document.getElementById("setup-screen");
const appShellEl = document.getElementById("app-shell");
const setupFormEl = document.getElementById("setup-form");
const setupApiKeyEl = document.getElementById("setup-api-key");
const setupStatusEl = document.getElementById("setup-status");

const AUTO_REFRESH_INTERVAL_MS = 10000;
const AUTO_REFRESH_DURATION_MS = 120000;
const HARDCODED_FROM_NUMBER = "+14252074289";
const LOCAL_EMAIL_HISTORY_KEY = "easyFaxEmailHistory";
const MAX_LOCAL_EMAIL_HISTORY = 30;

let autoRefreshIntervalId = null;
let autoRefreshStopTimeoutId = null;
let autoRefreshInFlight = false;
let appUiBound = false;
let launchPdfUrl = "";
let launchPdfFileName = "";
let launchPdfDataUrl = "";
let launchPdfMimeType = "application/pdf";
let historyFilter = "all";
let latestHistoryItems = [];

form.addEventListener("submit", onSubmitFax);
refreshButton.addEventListener("click", () => renderFaxes());
optionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
setupFormEl.addEventListener("submit", onSetupSubmit);

init();

async function init() {
  setHardcodedFromNumber();

  const { settings = {} } = await chrome.storage.sync.get(["settings"]);
  if (!String(settings.apiKey || "").trim()) {
    showSetupScreen();
    return;
  }

  showAppShell();
  bindAppUi();
  await applyLaunchContext();
  await renderFaxes();
}

function showSetupScreen() {
  appShellEl.hidden = true;
  setupScreenEl.hidden = false;
  setupStatusEl.textContent = "";
}

function showAppShell() {
  setupScreenEl.hidden = true;
  appShellEl.hidden = false;
}

async function onSetupSubmit(event) {
  event.preventDefault();

  const apiKey = String(setupApiKeyEl.value || "").trim();
  if (!apiKey) {
    setupStatusEl.textContent = "API key is required.";
    setupStatusEl.style.color = "var(--failure)";
    return;
  }

  const { settings = {} } = await chrome.storage.sync.get(["settings"]);
  const apiBase = String(settings.apiBase || "https://api.medsender.com/api/v2").trim().replace(/\/$/, "");

  await chrome.storage.sync.set({
    settings: {
      ...settings,
      apiKey,
      apiBase
    }
  });

  showAppShell();
  bindAppUi();
  await applyLaunchContext();
  await renderFaxes();
}

async function applyLaunchContext() {
  const { easyFaxLaunchContext = null } = await chrome.storage.local.get(["easyFaxLaunchContext"]);
  if (!easyFaxLaunchContext) {
    return;
  }

  launchPdfUrl = String(easyFaxLaunchContext.pdfUrl || "").trim();
  launchPdfFileName = buildLaunchPdfFileName(easyFaxLaunchContext);
  launchPdfDataUrl = String(easyFaxLaunchContext.pdfDataUrl || "").trim();
  launchPdfMimeType = String(easyFaxLaunchContext.pdfMimeType || "application/pdf").trim() || "application/pdf";

  const fileLabel = document.getElementById("file-label");
  if (fileLabel && launchPdfDataUrl) {
    fileLabel.textContent = `Using AdvancedMD document (${launchPdfFileName})`;
  }

  const patientHint = easyFaxLaunchContext.patProfId
    ? `Patient ${easyFaxLaunchContext.patProfId}`
    : "chart";
  if (launchPdfDataUrl) {
    setStatus(`Loaded AdvancedMD context for ${patientHint}. Document is ready to send.`);
  } else if (launchPdfUrl) {
    setStatus(`Loaded AdvancedMD context for ${patientHint}. Document link detected; will fetch on send.`);
  } else {
    setStatus(`Loaded AdvancedMD context for ${patientHint}.`);
  }

  await chrome.storage.local.remove("easyFaxLaunchContext");
}

function buildLaunchPdfFileName(context) {
  const pat = String(context.patProfId || "").trim();
  const item = String(context.itemId || "").trim();
  const suffix = [pat && `pat-${pat}`, item && `item-${item}`].filter(Boolean).join("-");
  return suffix ? `advancedmd-${suffix}.pdf` : "advancedmd-document.pdf";
}

function bindAppUi() {
  if (appUiBound) {
    return;
  }

  // Tab switching
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", async () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tabs.forEach((t) => t.setAttribute("aria-selected", "false"));
      panels.forEach((p) => { p.hidden = true; });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      const panelId = tab.getAttribute("aria-controls");
      const panel = document.getElementById(panelId);
      if (panel) panel.hidden = false;

      if (panelId === "panel-history") {
        await renderFaxes({ preserveStatus: true });
      }
    });
  });

  // File drop zone label
  const fileInput = document.getElementById("fax-file");
  const fileLabel = document.getElementById("file-label");
  const fileDrop = document.querySelector(".file-drop");
  if (fileInput && fileLabel) {
    fileInput.addEventListener("change", () => {
      fileLabel.textContent = fileInput.files[0] ? fileInput.files[0].name : "Attach PDF or image…";
    });
  }
  if (fileDrop) {
    fileDrop.addEventListener("dragover", (e) => { e.preventDefault(); fileDrop.classList.add("dragover"); });
    fileDrop.addEventListener("dragleave", () => fileDrop.classList.remove("dragover"));
    fileDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      fileDrop.classList.remove("dragover");
      if (e.dataTransfer.files[0] && fileInput) {
        const dt = new DataTransfer();
        dt.items.add(e.dataTransfer.files[0]);
        fileInput.files = dt.files;
        if (fileLabel) fileLabel.textContent = e.dataTransfer.files[0].name;
      }
    });
  }

  const filterButtons = document.querySelectorAll(".history-filter-btn");
  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      historyFilter = button.dataset.filter || "all";
      filterButtons.forEach((b) => {
        const active = b === button;
        b.classList.toggle("active", active);
        b.setAttribute("aria-pressed", active ? "true" : "false");
      });
      renderHistoryItems(latestHistoryItems);
    });
  });

  appUiBound = true;
}

async function onSubmitFax(event) {
  event.preventDefault();
  setStatus("");

  const fileInput = document.getElementById("fax-file");
  const formData = new FormData(form);
  const fromNumber = HARDCODED_FROM_NUMBER;
  const toRaw = String(formData.get("toNumber") || "").trim();
  const isEmailTarget = isLikelyEmail(toRaw);
  const toNumber = isEmailTarget ? "" : toRaw;
  const recipientEmail = isEmailTarget ? toRaw.toLowerCase() : "";
  const recipientName = String(formData.get("recipientName") || "").trim();
  const coverMessage = String(formData.get("coverMessage") || "").trim();
  let file = fileInput.files[0];

  if (!file && launchPdfDataUrl) {
    try {
      file = dataUrlToFile(launchPdfDataUrl, launchPdfFileName, launchPdfMimeType);
      if (file) {
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
      }
    } catch (error) {
      setStatus(`Could not prepare AdvancedMD PDF bytes: ${extractErrorMessage(error)}`, true);
      return;
    }
  }

  if (!file && launchPdfUrl) {
    try {
      file = await fetchLaunchPdfFile();
      if (file) {
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
      }
    } catch (error) {
      setStatus(`Could not load AdvancedMD PDF: ${extractErrorMessage(error)}`, true);
      return;
    }
  }

  if (!toRaw || !file) {
    setStatus("To (fax number or email) and PDF file are required. Click EasyFax in AdvancedMD to attach current chart document.", true);
    return;
  }

  let settings;
  try {
    settings = await getApiSettings();
  } catch (error) {
    setStatus(extractErrorMessage(error), true);
    return;
  }

  const payload = new FormData();
  payload.append("file", file);

  if (isEmailTarget) {
    payload.append("recipient_email", recipientEmail);
    // Always include recipient_name; use email if name is empty
    const finalRecipientName = recipientName || recipientEmail;
    payload.append("recipient_name", finalRecipientName);
    if (coverMessage) {
      payload.append("note", coverMessage);
    }
    payload.append("sender_name", "TMJ & Sleep Solutions NW");
    // Link expires in 30 days (required by MedSender API, range 1-180)
    payload.append("expire_after", "30");
    setStatus("Sending secure email link…");
  } else {
    payload.append("from_number", fromNumber);
    payload.append("to_number", toNumber);
    if (coverMessage) {
      payload.append("message", coverMessage);
    }
    setStatus("Sending fax…");
  }

  try {
    const endpoint = isEmailTarget ? "emails" : "sent_faxes";
    
    // Debug: Log payload contents
    if (isEmailTarget) {
      console.log("[EasyFax] Email API Request:", {
        endpoint: `${settings.apiBase}/${endpoint}`,
        fields: {
          recipient_email: recipientEmail,
          recipient_name: recipientName || recipientEmail,
          sender_name: "TMJ & Sleep Solutions NW",
          note: coverMessage || "(empty)",
          expire_after: "30",
          file: file ? `${file.name} (${file.size} bytes, ${file.type})` : null
        }
      });
    }
    
    const response = await fetch(`${settings.apiBase}/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: payload
    });

    let result;
    let responseText = "";
    try {
      responseText = await response.clone().text();
      result = responseText ? JSON.parse(responseText) : {};
    } catch (e) {
      result = {};
    }
    
    if (!response.ok) {
      // Log full error response for debugging
      console.error("[EasyFax] API Error Response:", { 
        status: response.status, 
        statusText: response.statusText,
        raw: responseText,
        parsed: result 
      });
      const message = result.error || result.message || result.errors || responseText || `Request failed with ${response.status}`;
      throw new Error(message);
    }

    if (isEmailTarget) {
      const emailId = result.emailId || result.email_id || result.id || "created";
      await addLocalEmailHistoryEntry({
        id: String(emailId),
        to: recipientEmail,
        recipient: recipientName,
        status: "queued",
        createdAt: new Date().toISOString()
      });
      setStatus(`Secure email queued — id: ${emailId}`);
    } else {
      const token = result.faxId || result.fax_id || result.sendToken || result.send_token || result.token || "created";
      setStatus(`Fax queued — token: ${token}`);
    }

    form.reset();
    setHardcodedFromNumber();
    document.getElementById("file-label").textContent = "Attach PDF or image…";
    launchPdfUrl = "";
    launchPdfFileName = "";
    launchPdfDataUrl = "";
    launchPdfMimeType = "application/pdf";
    await renderFaxes({ preserveStatus: true });
    startAutoRefreshLoop();
  } catch (error) {
    clearAutoRefreshLoop();
    setStatus(`Failed to send: ${extractErrorMessage(error)}`, true);
  }
}

function isLikelyEmail(value) {
  const email = String(value || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function fetchLaunchPdfFile() {
  if (!launchPdfUrl) {
    return null;
  }

  const response = await fetch(launchPdfUrl, {
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error(`document fetch failed (${response.status})`);
  }

  const blob = await response.blob();
  if (!blob || blob.size === 0) {
    throw new Error("document is empty");
  }

  const type = blob.type || "application/pdf";
  return new File([blob], launchPdfFileName || "advancedmd-document.pdf", { type });
}

function dataUrlToFile(dataUrl, fileName, mimeType) {
  const marker = "base64,";
  const base64Index = dataUrl.indexOf(marker);
  if (base64Index === -1) {
    throw new Error("invalid data URL payload");
  }

  const base64 = dataUrl.slice(base64Index + marker.length);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new File([bytes], fileName || "advancedmd-document.pdf", {
    type: mimeType || "application/pdf"
  });
}

function setHardcodedFromNumber() {
  const fromInput = document.getElementById("from-number");
  if (!fromInput) {
    return;
  }

  fromInput.value = HARDCODED_FROM_NUMBER;
  fromInput.readOnly = true;
  fromInput.setAttribute("aria-readonly", "true");
  fromInput.title = "From fax number is managed by EasyFax";
}

async function renderFaxes(options = {}) {
  const preserveStatus = Boolean(options.preserveStatus);
  faxListEl.innerHTML = "";
  if (!preserveStatus) {
    setStatus("");
  }

  // Add spinning animation to refresh button
  refreshButton.classList.add("spinning");

  let settings;
  try {
    settings = await getApiSettings();
  } catch (error) {
    refreshButton.classList.remove("spinning");
    emptyStateEl.hidden = false;
    emptyStateEl.textContent = "Add API settings first.";
    return;
  }

  try {
    const response = await fetch(`${settings.apiBase}/sent_faxes`, {
      headers: {
        Authorization: `Bearer ${settings.apiKey}`
      }
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = result.error || result.message || `Request failed with ${response.status}`;
      throw new Error(message);
    }

    const baseFaxes = normalizeFaxes(result).slice(0, 12);
    const faxes = await hydrateQueuedStatuses(baseFaxes, settings);
    const emails = await hydrateEmailStatuses(await getLocalEmailHistory(), settings);

    const faxItems = faxes.map((fax) => ({
      ...fax,
      kind: "fax",
      sortTs: Date.parse(fax.createdAt || "") || 0
    }));
    const emailItems = emails.map((email) => ({
      ...email,
      kind: "email",
      sortTs: Date.parse(email.createdAt || "") || 0
    }));
    const items = [...faxItems, ...emailItems]
      .sort((a, b) => b.sortTs - a.sortTs)
      .slice(0, 12);

    latestHistoryItems = items;
    renderHistoryItems(items);
  } catch (error) {
    emptyStateEl.hidden = false;
    emptyStateEl.textContent = `Unable to load faxes: ${extractErrorMessage(error)}`;
  } finally {
    // Remove spinning animation when done
    refreshButton.classList.remove("spinning");
  }
}

function renderHistoryItems(items) {
  faxListEl.innerHTML = "";

  const filtered = items.filter((item) => {
    if (historyFilter === "all") return true;
    return item.kind === historyFilter;
  });

  const countEl = document.getElementById("history-count");
  if (countEl) {
    const suffix = historyFilter === "all" ? "" : ` (${historyFilter})`;
    countEl.textContent = filtered.length ? `${filtered.length} recent${suffix}` : `0 recent${suffix}`;
  }

  if (filtered.length === 0) {
    emptyStateEl.hidden = false;
    emptyStateEl.textContent = historyFilter === "all"
      ? "No faxes or emails to display yet."
      : `No ${historyFilter} entries yet.`;
    return;
  }

  emptyStateEl.hidden = true;
  for (const item of filtered) {
    faxListEl.appendChild(buildFaxRow(item));
  }
}

function buildFaxRow(fax) {
  const li = document.createElement("li");
  li.className = "fax-row";

  const cls = fax.status === "success" ? "success" : fax.status === "failure" ? "failure" : "pending";

  const iconSvg = fax.status === "success"
    ? `<svg viewBox="0 0 16 16" fill="none" stroke="#16a34a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,8 6.5,11.5 13,5"/></svg>`
    : fax.status === "failure"
    ? `<svg viewBox="0 0 16 16" fill="none" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`
    : `<svg viewBox="0 0 16 16" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8,5 8,8 10,10"/></svg>`;

  const sentDate = fax.createdAt ? new Date(fax.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const mode = fax.kind === "email" ? "Email" : "Fax";
  const pagesText = fax.kind === "email" ? "secure link" : (fax.pages ? `${escapeHtml(fax.pages)}pp` : "");
  const meta = [mode, sentDate, pagesText].filter(Boolean).join(" · ");
  const numbersLine = fax.kind === "email"
    ? `${escapeHtml(fax.from || "EasyFax")} → ${escapeHtml(fax.to)}`
    : `${escapeHtml(fax.from)} → ${escapeHtml(fax.to)}`;

  li.innerHTML = `
    <div class="fax-status-icon ${cls}">${iconSvg}</div>
    <div class="fax-info">
      <div class="fax-numbers">${numbersLine}</div>
      ${meta ? `<div class="fax-meta">${meta}</div>` : ""}
    </div>
    <span class="fax-badge ${cls}">${escapeHtml(fax.status)}</span>
  `;
  return li;
}

function startAutoRefreshLoop() {
  clearAutoRefreshLoop();

  autoRefreshIntervalId = setInterval(async () => {
    if (autoRefreshInFlight) return;
    autoRefreshInFlight = true;
    try {
      await renderFaxes({ preserveStatus: true });
    } finally {
      autoRefreshInFlight = false;
    }
  }, AUTO_REFRESH_INTERVAL_MS);

  autoRefreshStopTimeoutId = setTimeout(() => {
    clearAutoRefreshLoop();
    setStatus("Auto-refresh ended.");
  }, AUTO_REFRESH_DURATION_MS);
}

function clearAutoRefreshLoop() {
  if (autoRefreshIntervalId) { clearInterval(autoRefreshIntervalId); autoRefreshIntervalId = null; }
  if (autoRefreshStopTimeoutId) { clearTimeout(autoRefreshStopTimeoutId); autoRefreshStopTimeoutId = null; }
  autoRefreshInFlight = false;
}

async function hydrateQueuedStatuses(faxes, settings) {
  return Promise.all(
    faxes.map(async (fax) => {
      const shouldHydrate = !fax.status || fax.status === "unknown" || isPendingStatus(fax.status);
      if (!fax.token || !shouldHydrate) return fax;
      try {
        const response = await fetch(`${settings.apiBase}/sent_faxes/${encodeURIComponent(fax.token)}`, {
          headers: { Authorization: `Bearer ${settings.apiKey}` }
        });
        if (!response.ok) return fax;
        const result = await response.json().catch(() => ({}));
        return { ...fax, ...toFaxListItem(result), token: fax.token };
      } catch {
        return fax;
      }
    })
  );
}

async function hydrateEmailStatuses(emails, settings) {
  if (!emails.length) {
    return emails;
  }

  let changed = false;
  const hydrated = await Promise.all(
    emails.map(async (email) => {
      const shouldHydrate = !email.status || email.status === "unknown" || isPendingStatus(email.status);
      if (!email.id || !shouldHydrate) {
        return email;
      }

      try {
        const response = await fetch(`${settings.apiBase}/emails/${encodeURIComponent(email.id)}`, {
          headers: { Authorization: `Bearer ${settings.apiKey}` }
        });
        if (!response.ok) {
          return email;
        }

        const result = await response.json().catch(() => ({}));
        const merged = {
          ...email,
          ...toEmailListItem(result),
          id: email.id
        };

        if (merged.status !== email.status) {
          changed = true;
        }

        return merged;
      } catch {
        return email;
      }
    })
  );

  if (changed) {
    await setLocalEmailHistory(hydrated);
  }

  return hydrated;
}

async function getLocalEmailHistory() {
  const { [LOCAL_EMAIL_HISTORY_KEY]: emailHistory = [] } = await chrome.storage.local.get([LOCAL_EMAIL_HISTORY_KEY]);
  if (!Array.isArray(emailHistory)) {
    return [];
  }
  return emailHistory.map(toEmailListItem);
}

async function addLocalEmailHistoryEntry(entry) {
  const existing = await getLocalEmailHistory();
  const deduped = existing.filter((item) => item.id !== entry.id);
  const next = [toEmailListItem(entry), ...deduped].slice(0, MAX_LOCAL_EMAIL_HISTORY);
  await setLocalEmailHistory(next);
}

async function setLocalEmailHistory(items) {
  await chrome.storage.local.set({
    [LOCAL_EMAIL_HISTORY_KEY]: items.slice(0, MAX_LOCAL_EMAIL_HISTORY)
  });
}

function isPendingStatus(status) {
  const v = String(status || "").toLowerCase();
  return v === "queued" || v === "inprogress" || v === "pending" || v === "processing" || v === "sending";
}

function extractErrorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error.message && typeof error.message === "string") return error.message;
  if (error.error && typeof error.error === "string") return error.error;
  if (error.msg && typeof error.msg === "string") return error.msg;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function getApiSettings() {
  const { settings = {} } = await chrome.storage.sync.get(["settings"]);
  const apiKey = (settings.apiKey || "").trim();
  const apiBase = (settings.apiBase || "https://api.medsender.com/api/v2").trim().replace(/\/$/, "");
  if (!apiKey) throw new Error("Missing API key. Open API Settings.");
  return { apiKey, apiBase };
}

function normalizeFaxes(result) {
  if (Array.isArray(result)) return result.map(toFaxListItem);
  if (Array.isArray(result.sentFaxes)) return result.sentFaxes.map(toFaxListItem);
  if (Array.isArray(result.sent_faxes)) return result.sent_faxes.map(toFaxListItem);
  const firstArray = Object.values(result).find((v) => Array.isArray(v));
  if (firstArray) return firstArray.map(toFaxListItem);
  return [];
}

function toFaxListItem(fax) {
  const rawStatus = fax.sentStatus || fax.sent_status || inferStatusFromFields(fax) || extractStatus(fax);
  const status = normalizeStatus(rawStatus);
  return {
    token: String(fax.sendToken || fax.send_token || fax.faxId || fax.fax_id || fax.id || ""),
    from: String(fax.fromNumber || fax.from_number || fax.from || "unknown"),
    to: String(fax.toNumber || fax.to_number || fax.to || "unknown"),
    recipient: String(fax.recipientName || fax.recipient_name || ""),
    pages: String(fax.numPages || fax.num_pages || ""),
    errorDetails: String(fax.errorDetails || fax.error_details || ""),
    status,
    createdAt: String(fax.sentAt || fax.sent_at || fax.created_at || fax.inserted_at || "")
  };
}

function toEmailListItem(email) {
  const status = normalizeStatus(email.emailStatus || email.email_status || email.status || "queued");
  return {
    kind: "email",
    id: String(email.emailId || email.email_id || email.id || ""),
    from: String(email.senderName || email.sender_name || "EasyFax"),
    to: String(email.recipientEmail || email.recipient_email || email.to || "unknown"),
    recipient: String(email.recipientName || email.recipient_name || ""),
    pages: "",
    errorDetails: String(email.errorDetails || email.error_details || ""),
    status,
    createdAt: String(email.sentAt || email.sent_at || email.created_at || "")
  };
}

function inferStatusFromFields(fax) {
  const errorDetails = fax.errorDetails || fax.error_details;
  const completedAt = fax.completedAt || fax.completed_at;
  const sentAt = fax.sentAt || fax.sent_at;
  if (errorDetails != null && errorDetails !== "") return "failure";
  if (completedAt != null && completedAt !== "") return "success";
  if (sentAt != null && sentAt !== "") return "inprogress";
  return "";
}

function extractStatus(fax) {
  const candidates = [
    fax.sentStatus, fax.sent_status,
    fax.deliveryStatus, fax.delivery_status,
    fax.sendStatus, fax.send_status,
    fax.faxStatus, fax.fax_status,
    fax.status, fax.state
  ];
  const direct = candidates.find((v) => typeof v === "string" && v.trim());
  if (direct) return direct;
  if (typeof fax.success === "boolean") return fax.success ? "success" : "failure";
  return "unknown";
}

function normalizeStatus(rawStatus) {
  const value = String(rawStatus).trim().toLowerCase();
  if (!value || value === "undefined" || value === "null") return "unknown";
  if (["ok", "sent", "delivered", "complete", "completed", "success", "succeeded"].includes(value)) return "success";
  if (["error", "failed", "failure", "rejected", "undelivered", "canceled", "cancelled"].includes(value)) return "failure";
  return value;
}

function setStatus(message, isError = false) {
  sendStatusEl.textContent = message;
  sendStatusEl.style.color = isError ? "var(--failure)" : "var(--accent)";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
