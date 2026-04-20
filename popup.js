const extensionApi = createExtensionApi();
const isExtensionPreview = !hasChromeExtensionApi();

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
const previewBannerEls = document.querySelectorAll("[data-preview-banner]");
const historySearchEl = document.getElementById("history-search");
const historyStatusFilterEl = document.getElementById("history-status-filter");
const historyDateFilterEl = document.getElementById("history-date-filter");
const exportHistoryButton = document.getElementById("export-history");
const directoryListEl = document.getElementById("directory-list");
const directoryEmptyEl = document.getElementById("directory-empty");
const directoryCountEl = document.getElementById("directory-count");
const directoryStatusEl = document.getElementById("directory-status");
const directoryRefreshButton = document.getElementById("directory-refresh");
const directorySearchEl = document.getElementById("directory-search");
const directoryCreateFormEl = document.getElementById("directory-create-form");
const directoryCreateNameEl = document.getElementById("directory-create-name");
const directoryCreateFaxEl = document.getElementById("directory-create-fax");
const toInputEl = document.getElementById("to-number");
const toSuggestionsEl = document.getElementById("to-suggestions");

const AUTO_REFRESH_INTERVAL_MS = 10000;
const AUTO_REFRESH_MAX_DURATION_MS = 20 * 60 * 1000;
const AUTO_REFRESH_IDLE_STOP_POLLS = 2;
const HARDCODED_FROM_NUMBER = "+14252074289";
const LOCAL_EMAIL_HISTORY_KEY = "easyFaxEmailHistory";
const LOCAL_RETRY_CACHE_KEY = "easyFaxRetryCache";
const LOCAL_RECENT_SENDS_KEY = "easyFaxRecentSends";
const LOCAL_DIRECTORY_CONTACTS_KEY = "easyFaxDirectoryContacts";
const LOCAL_HIDDEN_CLOUD_CLIENT_IDS_KEY = "easyFaxHiddenCloudClientIds";
const SETTINGS_STORAGE_KEY = "settings";
const STORAGE_PROBE_KEY = "easyfaxStorageProbe";
const MAX_LOCAL_EMAIL_HISTORY = 30;
const MAX_RETRY_CACHE_ITEMS = 50;
const MAX_RECENT_SENDS = 50;
const DUPLICATE_SEND_WINDOW_MS = 2 * 60 * 1000;

let autoRefreshIntervalId = null;
let autoRefreshInFlight = false;
let autoRefreshStartedAt = 0;
let autoRefreshIdlePolls = 0;
let appUiBound = false;
let launchPdfUrl = "";
let launchPdfFileName = "";
let launchPdfDataUrl = "";
let launchPdfMimeType = "application/pdf";
let historyFilter = "all";
let historyStatusFilter = "all";
let historyDateFilter = "all";
let historySearchTerm = "";
let latestHistoryItems = [];
let historyHasAnimated = false;
let statusClearTimeoutId = null;
let statusMessageSerial = 0;
let latestClients = [];
let latestDirectoryContacts = [];
let hiddenCloudClientIds = new Set();
let directorySearchTerm = "";
let clientsLoadPromise = null;
let toSuggestionsDismissed = false;
let directoryEditingNameKey = "";
let directoryEditingNumberKey = "";

if (form) {
  form.addEventListener("submit", onSubmitFax);
}
if (refreshButton) {
  refreshButton.addEventListener("click", () => renderFaxes());
}
if (optionsButton) {
  optionsButton.addEventListener("click", () => extensionApi.runtime.openOptionsPage());
}
if (setupFormEl) {
  setupFormEl.addEventListener("submit", onSetupSubmit);
}

init().catch((error) => {
  console.error("[EasyFax] Popup init failed", error);
  // Fallback: ensure at least one screen is visible instead of a blank popup.
  if (setupScreenEl && appShellEl) {
    setupScreenEl.hidden = false;
    appShellEl.hidden = true;
  }
  if (setupStatusEl) {
    setupStatusEl.textContent = "Unable to initialize popup. Reload extension and try again.";
    setupStatusEl.style.color = "var(--failure)";
  }
});

async function init() {
  setHardcodedFromNumber();
  syncPreviewBanners();

  const settings = await getStoredSettings();
  if (!String(settings.apiKey || "").trim()) {
    showSetupScreen();
    const diagnostics = await getSettingsStorageDiagnostics();
    const prefix = isExtensionPreview
      ? "Preview mode. No saved API key found."
      : "No saved API key found.";
    setSetupStatus(formatStorageDiagnostics(prefix, diagnostics), false);
    return;
  }

  showAppShell();
  bindAppUi();
  await applyLaunchContext();
  await renderFaxes();
  if (isExtensionPreview) {
    setStatus("Preview mode: running without extension APIs.");
  }
}

function showSetupScreen() {
  syncPreviewBanners();
  appShellEl.hidden = true;
  setupScreenEl.hidden = false;
  setupStatusEl.textContent = "";
}

function showAppShell() {
  syncPreviewBanners();
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

  try {
    const settings = await getStoredSettings();
    const apiBase = String(settings.apiBase || "https://api.medsender.com/api/v2").trim().replace(/\/$/, "");

    const nextSettings = {
      ...settings,
      apiKey,
      apiBase
    };

    await saveStoredSettings(nextSettings);

    const savedSettings = await getStoredSettings();
    if (!String(savedSettings.apiKey || "").trim()) {
      const diagnostics = await getSettingsStorageDiagnostics();
      setSetupStatus(formatStorageDiagnostics("API key save did not persist.", diagnostics), true);
      return;
    }

    showAppShell();
    bindAppUi();
    await applyLaunchContext();
    await renderFaxes();
  } catch (error) {
    const diagnostics = await getSettingsStorageDiagnostics();
    const prefix = `Could not save API key: ${extractErrorMessage(error)}`;
    setSetupStatus(formatStorageDiagnostics(prefix, diagnostics), true);
  }
}

async function applyLaunchContext() {
  const { easyFaxLaunchContext = null } = await extensionApi.storage.local.get(["easyFaxLaunchContext"]);
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

  await extensionApi.storage.local.remove("easyFaxLaunchContext");
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

      if (panelId === "panel-directory") {
        await renderDirectory();
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

  if (historySearchEl) {
    historySearchEl.addEventListener("input", () => {
      historySearchTerm = String(historySearchEl.value || "").trim().toLowerCase();
      renderHistoryItems(latestHistoryItems);
    });
  }

  if (historyStatusFilterEl) {
    historyStatusFilterEl.addEventListener("change", () => {
      historyStatusFilter = String(historyStatusFilterEl.value || "all");
      renderHistoryItems(latestHistoryItems);
    });
  }

  if (historyDateFilterEl) {
    historyDateFilterEl.addEventListener("change", () => {
      historyDateFilter = String(historyDateFilterEl.value || "all");
      renderHistoryItems(latestHistoryItems);
    });
  }

  if (exportHistoryButton) {
    exportHistoryButton.addEventListener("click", () => {
      exportHistoryCsv();
    });
  }

  if (directoryRefreshButton) {
    directoryRefreshButton.addEventListener("click", () => {
      renderDirectory();
    });
  }

  if (directorySearchEl) {
    directorySearchEl.addEventListener("input", () => {
      directorySearchTerm = String(directorySearchEl.value || "").trim().toLowerCase();
      renderDirectoryList(latestClients);
    });
  }

  if (directoryCreateFormEl) {
    directoryCreateFormEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      await createClientFromDirectoryForm();
    });
  }

  if (directoryListEl) {
    directoryListEl.addEventListener("click", async (event) => {
      const useBtn = event.target.closest("[data-action='use-number']");
      if (useBtn) {
        const number = String(useBtn.getAttribute("data-number") || "");
        if (number) applyDirectoryNumberToSend(number);
        return;
      }

      const startEditNameBtn = event.target.closest("[data-action='start-edit-contact-name']");
      if (startEditNameBtn) {
        const source = String(startEditNameBtn.getAttribute("data-source") || "");
        if (source === "cloud") {
          const clientId = String(startEditNameBtn.getAttribute("data-client-id") || "");
          if (clientId) {
            directoryEditingNameKey = buildDirectoryEditNameKey("cloud", clientId);
            renderDirectoryList(latestClients);
          }
          return;
        }
        if (source === "local") {
          const contactId = String(startEditNameBtn.getAttribute("data-contact-id") || "");
          if (contactId) {
            directoryEditingNameKey = buildDirectoryEditNameKey("local", contactId);
            renderDirectoryList(latestClients);
          }
          return;
        }
      }

      const cancelEditNameBtn = event.target.closest("[data-action='cancel-edit-contact-name']");
      if (cancelEditNameBtn) {
        directoryEditingNameKey = "";
        renderDirectoryList(latestClients);
        return;
      }

      const saveEditNameBtn = event.target.closest("[data-action='save-edit-contact-name']");
      if (saveEditNameBtn) {
        const source = String(saveEditNameBtn.getAttribute("data-source") || "");
        const row = saveEditNameBtn.closest(".directory-row");
        const input = row?.querySelector(".directory-inline-name-input");
        const nextName = String(input?.value || "").trim();
        if (!nextName) {
          setDirectoryStatus("Name is required.", true);
          return;
        }

        if (source === "cloud") {
          const clientId = String(saveEditNameBtn.getAttribute("data-client-id") || "");
          if (clientId) {
            await updateClientName(clientId, nextName);
          }
          return;
        }

        if (source === "local") {
          const contactId = String(saveEditNameBtn.getAttribute("data-contact-id") || "");
          if (contactId) {
            await updateLocalContactName(contactId, nextName);
          }
        }
        return;
      }

      const startEditNumberBtn = event.target.closest("[data-action='start-edit-contact-number']");
      if (startEditNumberBtn) {
        const source = String(startEditNumberBtn.getAttribute("data-source") || "");
        if (source === "cloud") {
          const clientId = String(startEditNumberBtn.getAttribute("data-client-id") || "");
          const faxNumberId = String(startEditNumberBtn.getAttribute("data-fax-id") || "");
          if (clientId && faxNumberId) {
            directoryEditingNumberKey = buildDirectoryEditNumberKey("cloud", clientId, faxNumberId);
            renderDirectoryList(latestClients);
          }
          return;
        }

        if (source === "local") {
          const contactId = String(startEditNumberBtn.getAttribute("data-contact-id") || "");
          if (contactId) {
            directoryEditingNumberKey = buildDirectoryEditNumberKey("local", contactId, "");
            renderDirectoryList(latestClients);
          }
        }
        return;
      }

      const cancelEditNumberBtn = event.target.closest("[data-action='cancel-edit-contact-number']");
      if (cancelEditNumberBtn) {
        directoryEditingNumberKey = "";
        renderDirectoryList(latestClients);
        return;
      }

      const saveEditNumberBtn = event.target.closest("[data-action='save-edit-contact-number']");
      if (saveEditNumberBtn) {
        const source = String(saveEditNumberBtn.getAttribute("data-source") || "");
        const row = saveEditNumberBtn.closest(".directory-row");
        const input = row?.querySelector(".directory-inline-number-input");
        const nextNumber = String(input?.value || "").trim();
        if (!nextNumber) {
          setDirectoryStatus("Fax number is required.", true);
          return;
        }

        if (source === "cloud") {
          const clientId = String(saveEditNumberBtn.getAttribute("data-client-id") || "");
          const faxNumberId = String(saveEditNumberBtn.getAttribute("data-fax-id") || "");
          if (clientId && faxNumberId) {
            await updateClientFaxNumber(clientId, faxNumberId, nextNumber);
          }
          return;
        }

        if (source === "local") {
          const contactId = String(saveEditNumberBtn.getAttribute("data-contact-id") || "");
          if (contactId) {
            await updateLocalContactNumber(contactId, nextNumber);
          }
        }
        return;
      }

      const deleteBtn = event.target.closest("[data-action='delete-contact']");
      if (deleteBtn) {
        const source = String(deleteBtn.getAttribute("data-source") || "");
        if (source === "cloud") {
          const clientId = String(deleteBtn.getAttribute("data-client-id") || "");
          if (clientId) {
            await deleteCloudClient(clientId);
          }
          return;
        }
        if (source === "local") {
          const contactId = String(deleteBtn.getAttribute("data-contact-id") || "");
          if (contactId) {
            await deleteLocalContact(contactId);
          }
        }
      }
    });
  }

  if (toInputEl && toSuggestionsEl) {
    toInputEl.addEventListener("focus", async () => {
      toSuggestionsDismissed = false;
      await updateToSuggestions();
    });

    toInputEl.addEventListener("input", async () => {
      if (!String(toInputEl.value || "").trim()) {
        toSuggestionsDismissed = false;
      }
      await updateToSuggestions();
    });

    toInputEl.addEventListener("blur", () => {
      // Allow click selection to run before hiding.
      setTimeout(() => {
        hideToSuggestions();
        toSuggestionsDismissed = false;
      }, 120);
    });

    toInputEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        toSuggestionsDismissed = true;
        hideToSuggestions();
      }
    });

    toSuggestionsEl.addEventListener("mousedown", (event) => {
      // Keep focus in input while selecting an option.
      event.preventDefault();
    });

    toSuggestionsEl.addEventListener("click", (event) => {
      const closeBtn = event.target.closest("[data-action='dismiss-suggestions']");
      if (closeBtn) {
        toSuggestionsDismissed = true;
        hideToSuggestions();
        return;
      }

      const row = event.target.closest("[data-action='select-recipient']");
      if (!row) {
        return;
      }
      const number = String(row.getAttribute("data-number") || "");
      const name = String(row.getAttribute("data-name") || "");
      applySuggestedRecipient(number, name);
    });
  }

  faxListEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='retry-fax']");
    if (!button) {
      return;
    }
    const historyKey = String(button.getAttribute("data-history-key") || "");
    if (!historyKey) {
      return;
    }
    retryFailedFax(historyKey);
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
  const normalizedTo = isEmailTarget ? { ok: true, value: "" } : normalizeFaxNumber(toRaw);
  if (!isEmailTarget && !normalizedTo.ok) {
    setStatus(normalizedTo.error || "Please enter a valid fax number in E.164 format.", true);
    return;
  }
  const toNumber = isEmailTarget ? "" : normalizedTo.value;
  if (!isEmailTarget) {
    const toInput = document.getElementById("to-number");
    if (toInput) toInput.value = toNumber;
  }
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

  const sendFingerprint = buildSendFingerprint({
    kind: isEmailTarget ? "email" : "fax",
    to: isEmailTarget ? recipientEmail : toNumber,
    file
  });

  const duplicate = await findRecentDuplicateSend(sendFingerprint);
  if (duplicate) {
    const ageText = formatDuration(Date.now() - duplicate.sentAt);
    const ok = window.confirm(`A similar fax was sent ${ageText} ago. Send again?`);
    if (!ok) {
      setStatus("Send cancelled.");
      return;
    }
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
      await rememberRecentSend(sendFingerprint);
      setStatus("");
    } else {
      const token = result.faxId || result.fax_id || result.sendToken || result.send_token || result.token || "created";
      await rememberRecentSend(sendFingerprint);
      await saveRetryPayload(token, {
        fromNumber,
        toNumber,
        message: coverMessage,
        fileName: file.name || "fax-document.pdf",
        fileType: file.type || "application/pdf",
        fileDataUrl: await fileToDataUrl(file)
      });
      console.log("[EasyFax] Fax queued", { token });
      setStatus("");
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

    const checkedAt = new Date().toISOString();

    const previousByKey = new Map(latestHistoryItems.map((item) => [historyItemKey(item), item]));
    const retryCacheByToken = await getRetryPayloadMap();

    const faxItems = faxes.map((fax) => ({
      ...fax,
      kind: "fax",
      retryPayloadAvailable: Boolean(retryCacheByToken[String(fax.token || "")]),
      lastCheckedAt: checkedAt,
      sortTs: Date.parse(fax.createdAt || "") || 0
    }));
    const emailItems = emails.map((email) => ({
      ...email,
      kind: "email",
      lastCheckedAt: checkedAt,
      sortTs: Date.parse(email.createdAt || "") || 0
    }));
    const items = [...faxItems, ...emailItems]
      .map((item) => {
        const key = historyItemKey(item);
        const previous = previousByKey.get(key);
        const transitionedToTerminal = Boolean(previous) && !isTerminalStatus(previous.status) && isTerminalStatus(item.status);

        if (!isTerminalStatus(item.status)) {
          return { ...item, elapsedFrozenMs: undefined };
        }

        if (typeof previous?.elapsedFrozenMs === "number" && Number.isFinite(previous.elapsedFrozenMs)) {
          return { ...item, elapsedFrozenMs: previous.elapsedFrozenMs };
        }

        const completionElapsedMs = computeElapsedMsBetween(
          item.createdAt,
          item.completedAt || item.updatedAt
        );
        const observedElapsedMs = transitionedToTerminal
          ? computeElapsedMsBetween(item.createdAt, item.lastCheckedAt)
          : null;
        const frozenMs = maxFiniteNumber(completionElapsedMs, observedElapsedMs);

        return {
          ...item,
          elapsedFrozenMs: typeof frozenMs === "number" ? frozenMs : undefined
        };
      })
      .sort((a, b) => b.sortTs - a.sortTs)
      .slice(0, 12);

    latestHistoryItems = items;
    renderHistoryItems(items);

  notifyStatusTransitions(items, previousByKey);

    const pendingCount = items.filter((item) => isPendingStatus(item.status)).length;
    return { pendingCount, hadError: false };
  } catch (error) {
    emptyStateEl.hidden = false;
    emptyStateEl.textContent = `Unable to load faxes: ${extractErrorMessage(error)}`;
    return { pendingCount: 0, hadError: true };
  } finally {
    // Remove spinning animation when done
    refreshButton.classList.remove("spinning");
  }
}

function renderHistoryItems(items) {
  const filtered = getFilteredHistoryItems(items);

  const countEl = document.getElementById("history-count");
  if (countEl) {
    const suffix = historyFilter === "all" ? "" : ` (${historyFilter})`;
    countEl.textContent = filtered.length ? `${filtered.length} recent${suffix}` : `0 recent${suffix}`;
  }

  if (filtered.length === 0) {
    faxListEl.replaceChildren();
    emptyStateEl.hidden = false;
    emptyStateEl.textContent = "No history entries match current filters.";
    return;
  }

  emptyStateEl.hidden = true;
  const shouldAnimate = !historyHasAnimated;
  const fragment = document.createDocumentFragment();
  for (const item of filtered) {
    fragment.appendChild(buildFaxRow(item, { animate: shouldAnimate }));
  }
  faxListEl.replaceChildren(fragment);
  historyHasAnimated = true;
}

async function renderDirectory() {
  if (!directoryRefreshButton || !directoryListEl || !directoryEmptyEl) {
    return;
  }

  directoryRefreshButton.classList.add("spinning");
  setDirectoryStatus("");
  hiddenCloudClientIds = await getHiddenCloudClientIds();
  latestDirectoryContacts = await getLocalDirectoryContacts();

  let settings;
  try {
    settings = await getApiSettings();
  } catch (error) {
    latestClients = [];
    renderDirectoryList(latestClients);
    setDirectoryStatus(`Cloud clients unavailable: ${extractErrorMessage(error)}. Showing saved contacts only.`, true);
    directoryRefreshButton.classList.remove("spinning");
    return;
  }

  try {
    latestClients = filterVisibleCloudClients(await fetchClients(settings));
    renderDirectoryList(latestClients);
  } catch (error) {
    directoryListEl.replaceChildren();
    directoryEmptyEl.hidden = false;
    directoryEmptyEl.textContent = "Unable to load clients.";
    setDirectoryStatus(extractErrorMessage(error), true);
  } finally {
    directoryRefreshButton.classList.remove("spinning");
  }
}

async function fetchClients(settings) {
  const response = await fetch(`${settings.apiBase}/clients`, {
    headers: {
      Authorization: `Bearer ${settings.apiKey}`
    }
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result.error || result.message || `Request failed with ${response.status}`;
    throw new Error(message);
  }

  return normalizeClients(result);
}

function normalizeClients(result) {
  const array = Array.isArray(result?.clients)
    ? result.clients
    : Array.isArray(result)
    ? result
    : [];

  return array.map((client) => ({
    clientId: String(client.client_id || client.clientId || client.id || ""),
    name: String(client.name || "Unnamed client"),
    faxNumbers: Array.isArray(client.fax_numbers)
      ? client.fax_numbers.map((entry) => ({
          id: String(entry.id || ""),
          number: String(entry.number || "")
        }))
      : []
  }));
}

function renderDirectoryList(clients) {
  if (!directoryListEl || !directoryEmptyEl) {
    return;
  }

  const filteredContacts = latestDirectoryContacts.filter((contact) => {
    if (!directorySearchTerm) return true;
    const haystack = `${contact.name} ${contact.number}`.toLowerCase();
    return haystack.includes(directorySearchTerm);
  });

  const filtered = clients.filter((client) => {
    if (!directorySearchTerm) return true;
    const haystack = [
      client.name,
      ...client.faxNumbers.map((entry) => entry.number)
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(directorySearchTerm);
  });

  if (directoryCountEl) {
    const total = filtered.length + filteredContacts.length;
    directoryCountEl.textContent = total
      ? `${total} entr${total === 1 ? "y" : "ies"}`
      : "0 entries";
  }

  if (!filtered.length && !filteredContacts.length) {
    directoryListEl.replaceChildren();
    directoryEmptyEl.hidden = false;
    directoryEmptyEl.textContent = "No directory entries match your search.";
    return;
  }

  directoryEmptyEl.hidden = true;
  const fragment = document.createDocumentFragment();
  for (const contact of filteredContacts) {
    fragment.appendChild(buildDirectoryContactRow(contact));
  }
  for (const client of filtered) {
    fragment.appendChild(buildDirectoryRow(client));
  }
  directoryListEl.replaceChildren(fragment);
}

function buildDirectoryContactRow(contact) {
  const li = document.createElement("li");
  li.className = "fax-row directory-row";

  const isEditingName = directoryEditingNameKey === buildDirectoryEditNameKey("local", contact.id);
  const isEditingNumber = directoryEditingNumberKey === buildDirectoryEditNumberKey("local", contact.id, "");
  const nameBlock = isEditingName
    ? `
      <div class="directory-inline-edit">
        <input type="text" class="directory-inline-input directory-inline-name-input" value="${escapeHtmlAttribute(contact.name)}" maxlength="120" />
        <div class="directory-inline-actions">
          <button type="button" class="directory-btn" data-action="save-edit-contact-name" data-source="local" data-contact-id="${escapeHtml(contact.id)}">Save</button>
          <button type="button" class="directory-btn" data-action="cancel-edit-contact-name">Cancel</button>
        </div>
      </div>
    `
    : `<div class="directory-name">${escapeHtml(contact.name)}<span class="directory-source-tag">saved</span></div>`;

  const numberBlock = isEditingNumber
    ? `
      <div class="directory-inline-edit directory-inline-edit-number">
        <input type="text" class="directory-inline-input directory-inline-number-input" value="${escapeHtmlAttribute(contact.number)}" />
        <div class="directory-inline-actions">
          <button type="button" class="directory-btn" data-action="save-edit-contact-number" data-source="local" data-contact-id="${escapeHtml(contact.id)}">Save</button>
          <button type="button" class="directory-btn" data-action="cancel-edit-contact-number">Cancel</button>
        </div>
      </div>
    `
    : `
      <div class="directory-number-row">
        <span class="directory-number-chip">${escapeHtml(contact.number)}</span>
        <div class="directory-number-actions">
          <button type="button" class="directory-btn" data-action="use-number" data-number="${escapeHtml(contact.number)}">Use</button>
          <button type="button" class="directory-btn" data-action="start-edit-contact-number" data-source="local" data-contact-id="${escapeHtml(contact.id)}">Edit</button>
        </div>
      </div>
    `;

  li.innerHTML = `
    <div class="fax-info">
      ${nameBlock}
      <div class="fax-meta">1 number</div>
      <div class="directory-numbers">${numberBlock}</div>
      <div class="directory-actions">
        <button type="button" class="directory-btn" data-action="start-edit-contact-name" data-source="local" data-contact-id="${escapeHtml(contact.id)}">Edit Name</button>
        <button type="button" class="directory-btn" data-action="delete-contact" data-source="local" data-contact-id="${escapeHtml(contact.id)}">Delete</button>
      </div>
    </div>
  `;

  return li;
}

function buildDirectoryRow(client) {
  const li = document.createElement("li");
  li.className = "fax-row directory-row";

  const isEditingName = directoryEditingNameKey === buildDirectoryEditNameKey("cloud", client.clientId);
  const nameBlock = isEditingName
    ? `
      <div class="directory-inline-edit">
        <input type="text" class="directory-inline-input directory-inline-name-input" value="${escapeHtmlAttribute(client.name)}" maxlength="120" />
        <div class="directory-inline-actions">
          <button type="button" class="directory-btn" data-action="save-edit-contact-name" data-source="cloud" data-client-id="${escapeHtml(client.clientId)}">Save</button>
          <button type="button" class="directory-btn" data-action="cancel-edit-contact-name">Cancel</button>
        </div>
      </div>
    `
    : `<div class="directory-name">${escapeHtml(client.name)}</div>`;

  const numberHtml = client.faxNumbers.length
    ? client.faxNumbers
        .map((entry) => {
          const isEditingNumber = directoryEditingNumberKey === buildDirectoryEditNumberKey("cloud", client.clientId, entry.id);
          if (isEditingNumber) {
            return `
              <div class="directory-inline-edit directory-inline-edit-number">
                <input type="text" class="directory-inline-input directory-inline-number-input" value="${escapeHtmlAttribute(entry.number)}" />
                <div class="directory-inline-actions">
                  <button type="button" class="directory-btn" data-action="save-edit-contact-number" data-source="cloud" data-client-id="${escapeHtml(client.clientId)}" data-fax-id="${escapeHtml(entry.id)}">Save</button>
                  <button type="button" class="directory-btn" data-action="cancel-edit-contact-number">Cancel</button>
                </div>
              </div>
            `;
          }

          return `
            <div class="directory-number-row">
              <span class="directory-number-chip">${escapeHtml(entry.number)}</span>
              <div class="directory-number-actions">
                <button type="button" class="directory-btn" data-action="use-number" data-number="${escapeHtml(entry.number)}">Use</button>
                <button type="button" class="directory-btn" data-action="start-edit-contact-number" data-source="cloud" data-client-id="${escapeHtml(client.clientId)}" data-fax-id="${escapeHtml(entry.id)}">Edit</button>
              </div>
            </div>
          `;
        })
        .join("")
    : `<div class="directory-number-row"><span class="directory-number-chip">No fax numbers</span></div>`;

  li.innerHTML = `
    <div class="fax-info">
      ${nameBlock}
      <div class="fax-meta">${client.faxNumbers.length} number${client.faxNumbers.length === 1 ? "" : "s"}</div>
      <div class="directory-numbers">${numberHtml}</div>
      <div class="directory-actions">
        <button type="button" class="directory-btn" data-action="start-edit-contact-name" data-source="cloud" data-client-id="${escapeHtml(client.clientId)}">Edit Name</button>
        <button type="button" class="directory-btn" data-action="delete-contact" data-source="cloud" data-client-id="${escapeHtml(client.clientId)}">Delete</button>
      </div>
    </div>
  `;

  return li;
}

async function createClientFromDirectoryForm() {
  const name = String(directoryCreateNameEl?.value || "").trim();
  const faxRaw = String(directoryCreateFaxEl?.value || "").trim();
  if (!name) {
    setDirectoryStatus("Client name is required.", true);
    return;
  }

  if (faxRaw) {
    const normalized = normalizeFaxNumber(faxRaw);
    if (!normalized.ok) {
      setDirectoryStatus(normalized.error || "Invalid fax number.", true);
      return;
    }

    await saveLocalDirectoryContact({
      name,
      number: normalized.value
    });

    if (directoryCreateNameEl) {
      directoryCreateNameEl.value = "";
    }
    if (directoryCreateFaxEl) {
      directoryCreateFaxEl.value = "";
    }

    latestDirectoryContacts = await getLocalDirectoryContacts();
    renderDirectoryList(latestClients);
    setDirectoryStatus("Contact saved.");
    return;
  }

  let settings;
  try {
    settings = await getApiSettings();
  } catch (error) {
    setDirectoryStatus(extractErrorMessage(error), true);
    return;
  }

  try {
    setDirectoryStatus("Creating client...");
    const response = await fetch(`${settings.apiBase}/clients`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client: {
          name,
          fax_number_id: null
        }
      })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = result.error || result.message || `Request failed with ${response.status}`;
      throw new Error(message);
    }

    if (directoryCreateNameEl) {
      directoryCreateNameEl.value = "";
    }
    if (directoryCreateFaxEl) {
      directoryCreateFaxEl.value = "";
    }
    setDirectoryStatus("Client created.");
    await renderDirectory();
  } catch (error) {
    setDirectoryStatus(extractErrorMessage(error), true);
  }
}

async function updateClientName(clientId, nextNameRaw) {
  const client = latestClients.find((entry) => entry.clientId === clientId);
  const currentName = client?.name || "";
  const nextName = String(nextNameRaw || "").trim();
  if (!nextName || nextName === currentName) {
    return;
  }

  let settings;
  try {
    settings = await getApiSettings();
  } catch (error) {
    setDirectoryStatus(extractErrorMessage(error), true);
    return;
  }

  try {
    setDirectoryStatus("Updating client...");
    const response = await fetch(`${settings.apiBase}/clients/${encodeURIComponent(clientId)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client: {
          name: nextName
        }
      })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = result.error || result.message || `Request failed with ${response.status}`;
      throw new Error(message);
    }

    setDirectoryStatus("Client updated.");
    directoryEditingNameKey = "";
    await renderDirectory();
  } catch (error) {
    setDirectoryStatus(extractErrorMessage(error), true);
  }
}

async function updateClientFaxNumber(clientId, faxNumberId, nextRawValue) {
  const client = latestClients.find((entry) => entry.clientId === clientId);
  if (!client) {
    setDirectoryStatus("Client not found.", true);
    return;
  }

  const target = client.faxNumbers.find((entry) => entry.id === faxNumberId);
  if (!target) {
    setDirectoryStatus("Fax number not found.", true);
    return;
  }

  const nextRaw = String(nextRawValue || "").trim();
  if (!nextRaw || nextRaw === target.number) {
    return;
  }

  const normalized = normalizeFaxNumber(nextRaw);
  if (!normalized.ok) {
    setDirectoryStatus(normalized.error || "Invalid fax number.", true);
    return;
  }

  let settings;
  try {
    settings = await getApiSettings();
  } catch (error) {
    setDirectoryStatus(extractErrorMessage(error), true);
    return;
  }

  const nextFaxNumbers = client.faxNumbers.map((entry) => ({
    id: entry.id,
    number: entry.id === faxNumberId ? normalized.value : entry.number
  }));

  try {
    setDirectoryStatus("Updating fax number...");
    const response = await fetch(`${settings.apiBase}/clients/${encodeURIComponent(clientId)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client: {
          name: client.name,
          fax_numbers: nextFaxNumbers
        }
      })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = result.error || result.message || `Request failed with ${response.status}`;
      throw new Error(message);
    }

    setDirectoryStatus("Fax number updated.");
    directoryEditingNumberKey = "";
    await renderDirectory();
  } catch (error) {
    setDirectoryStatus(`Could not update number in MedSender: ${extractErrorMessage(error)}`, true);
  }
}

async function deleteCloudClient(clientId) {
  const client = latestClients.find((entry) => entry.clientId === clientId);
  const label = client?.name || "this contact";
  const ok = window.confirm(`Delete ${label}?`);
  if (!ok) {
    return;
  }

  let settings;
  try {
    settings = await getApiSettings();
  } catch (error) {
    setDirectoryStatus(extractErrorMessage(error), true);
    return;
  }

  try {
    setDirectoryStatus("Deleting contact...");
    const response = await fetch(`${settings.apiBase}/clients/${encodeURIComponent(clientId)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`
      }
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 404) {
        await hideCloudClientId(clientId);
        hiddenCloudClientIds.add(clientId);
        latestClients = latestClients.filter((entry) => entry.clientId !== clientId);
        directoryEditingNameKey = "";
        directoryEditingNumberKey = "";
        renderDirectoryList(latestClients);
        setDirectoryStatus("Contact already missing in MedSender. Removed from EasyFax list.");
        return;
      }
      const message = result.error || result.message || `Request failed with ${response.status}`;
      throw new Error(message);
    }

    setDirectoryStatus("Contact deleted.");
    directoryEditingNameKey = "";
    directoryEditingNumberKey = "";
    await renderDirectory();
  } catch (error) {
    setDirectoryStatus(`Could not delete contact in MedSender: ${extractErrorMessage(error)}`, true);
  }
}

async function updateLocalContactName(contactId, nextNameRaw) {
  const contact = latestDirectoryContacts.find((entry) => entry.id === contactId);
  if (!contact) {
    setDirectoryStatus("Saved contact not found.", true);
    return;
  }

  const nextName = String(nextNameRaw || "").trim();
  if (!nextName || nextName === contact.name) {
    return;
  }

  await updateLocalDirectoryContact(contactId, { name: nextName });
  latestDirectoryContacts = await getLocalDirectoryContacts();
  directoryEditingNameKey = "";
  renderDirectoryList(latestClients);
  setDirectoryStatus("Saved contact updated.");
}

async function updateLocalContactNumber(contactId, nextRawValue) {
  const contact = latestDirectoryContacts.find((entry) => entry.id === contactId);
  if (!contact) {
    setDirectoryStatus("Saved contact not found.", true);
    return;
  }

  const nextRaw = String(nextRawValue || "").trim();
  if (!nextRaw || nextRaw === contact.number) {
    return;
  }

  const normalized = normalizeFaxNumber(nextRaw);
  if (!normalized.ok) {
    setDirectoryStatus(normalized.error || "Invalid fax number.", true);
    return;
  }

  await updateLocalDirectoryContact(contactId, { number: normalized.value });
  latestDirectoryContacts = await getLocalDirectoryContacts();
  directoryEditingNumberKey = "";
  renderDirectoryList(latestClients);
  setDirectoryStatus("Saved contact updated.");
}

async function deleteLocalContact(contactId) {
  const contact = latestDirectoryContacts.find((entry) => entry.id === contactId);
  const label = contact?.name || "this contact";
  const ok = window.confirm(`Delete ${label}?`);
  if (!ok) {
    return;
  }

  await removeLocalDirectoryContact(contactId);
  latestDirectoryContacts = await getLocalDirectoryContacts();
  directoryEditingNameKey = "";
  directoryEditingNumberKey = "";
  renderDirectoryList(latestClients);
  setDirectoryStatus("Saved contact deleted.");
}

function applyDirectoryNumberToSend(number) {
  const toInput = document.getElementById("to-number");
  if (toInput) {
    toInput.value = number;
  }

  const sendTab = document.getElementById("tab-send");
  if (sendTab) {
    sendTab.click();
  }
  setStatus(`Selected ${number} from Directory.`);
}

async function ensureClientsLoadedForSuggestions() {
  hiddenCloudClientIds = await getHiddenCloudClientIds();
  latestDirectoryContacts = await getLocalDirectoryContacts();

  if (latestClients.length > 0 || latestDirectoryContacts.length > 0) {
    return true;
  }

  if (clientsLoadPromise) {
    await clientsLoadPromise;
    return latestClients.length > 0 || latestDirectoryContacts.length > 0;
  }

  clientsLoadPromise = (async () => {
    try {
      const settings = await getApiSettings();
      latestClients = filterVisibleCloudClients(await fetchClients(settings));
    } catch {
      // Ignore suggestion fetch failures; user can still type manually.
    } finally {
      clientsLoadPromise = null;
    }
  })();

  await clientsLoadPromise;
  return latestClients.length > 0 || latestDirectoryContacts.length > 0;
}

async function updateToSuggestions() {
  if (!toInputEl || !toSuggestionsEl) {
    return;
  }

  const query = String(toInputEl.value || "").trim().toLowerCase();
  if (query.includes("@")) {
    hideToSuggestions();
    return;
  }

  // Do not show suggestions until user has typed at least one letter.
  if (!/[a-z]/i.test(query)) {
    hideToSuggestions();
    return;
  }

  if (toSuggestionsDismissed) {
    hideToSuggestions();
    return;
  }

  await ensureClientsLoadedForSuggestions();
  const flattenedFromClients = latestClients.flatMap((client) =>
    client.faxNumbers.map((entry) => ({
      clientName: client.name,
      number: entry.number
    }))
  );

  const flattenedFromContacts = latestDirectoryContacts.map((contact) => ({
    clientName: contact.name,
    number: contact.number
  }));

  const dedupe = new Map();
  for (const item of [...flattenedFromContacts, ...flattenedFromClients]) {
    const key = `${String(item.clientName).toLowerCase()}|${String(item.number).toLowerCase()}`;
    if (!dedupe.has(key)) {
      dedupe.set(key, item);
    }
  }
  const flattened = Array.from(dedupe.values());

  const filtered = flattened
    .filter((item) => {
      const haystack = `${item.clientName} ${item.number}`.toLowerCase();
      return haystack.includes(query);
    })
    .slice(0, 8);

  if (!filtered.length) {
    hideToSuggestions();
    return;
  }

  const rows = filtered
    .map((item) => `
      <button type="button" class="to-suggestion-row" data-action="select-recipient" data-number="${escapeHtml(item.number)}" data-name="${escapeHtml(item.clientName)}">
        <div class="to-suggestion-name">${escapeHtml(item.clientName)}</div>
        <div class="to-suggestion-number">${escapeHtml(item.number)}</div>
      </button>
    `)
    .join("");

  toSuggestionsEl.innerHTML = `
    <div class="to-suggestion-head">
      <span class="to-suggestion-title">Suggestions</span>
      <button type="button" class="to-suggestion-close" data-action="dismiss-suggestions" aria-label="Close suggestions">Close</button>
    </div>
    ${rows}
  `;
  toSuggestionsEl.hidden = false;
}

function hideToSuggestions() {
  if (!toSuggestionsEl) {
    return;
  }
  toSuggestionsEl.hidden = true;
  toSuggestionsEl.innerHTML = "";
}

function applySuggestedRecipient(number, name) {
  if (!toInputEl) {
    return;
  }

  toInputEl.value = number;
  toSuggestionsDismissed = false;
  hideToSuggestions();

  const recipientNameInput = document.getElementById("recipient-name");
  if (recipientNameInput && !String(recipientNameInput.value || "").trim()) {
    recipientNameInput.value = name;
  }
}

function setDirectoryStatus(message, isError = false) {
  if (!directoryStatusEl) {
    return;
  }
  directoryStatusEl.textContent = message;
  directoryStatusEl.style.color = isError ? "var(--failure)" : "var(--accent)";
}

function buildDirectoryEditNameKey(source, id) {
  return `${source}:${id}`;
}

function buildDirectoryEditNumberKey(source, id, faxId) {
  return `${source}:${id}:${faxId || ""}`;
}

async function getLocalDirectoryContacts() {
  const { [LOCAL_DIRECTORY_CONTACTS_KEY]: contacts = [] } = await extensionApi.storage.local.get([LOCAL_DIRECTORY_CONTACTS_KEY]);
  if (!Array.isArray(contacts)) {
    return [];
  }

  return contacts
    .map((entry, index) => ({
      id: String(entry.id || `legacy-${buildLegacyContactKey(entry, index)}`),
      name: String(entry.name || "").trim(),
      number: String(entry.number || "").trim()
    }))
    .filter((entry) => entry.name && entry.number);
}

async function getHiddenCloudClientIds() {
  const { [LOCAL_HIDDEN_CLOUD_CLIENT_IDS_KEY]: ids = [] } = await extensionApi.storage.local.get([LOCAL_HIDDEN_CLOUD_CLIENT_IDS_KEY]);
  if (!Array.isArray(ids)) {
    return new Set();
  }

  return new Set(
    ids
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );
}

function filterVisibleCloudClients(clients) {
  return clients.filter((client) => !hiddenCloudClientIds.has(client.clientId));
}

async function hideCloudClientId(clientId) {
  const existing = await getHiddenCloudClientIds();
  existing.add(String(clientId || "").trim());
  await extensionApi.storage.local.set({
    [LOCAL_HIDDEN_CLOUD_CLIENT_IDS_KEY]: Array.from(existing).filter(Boolean)
  });
}

async function saveLocalDirectoryContact(contact) {
  const existing = await getLocalDirectoryContacts();
  const key = `${String(contact.name).toLowerCase()}|${String(contact.number)}`;
  const previous = existing.find((entry) => `${entry.name.toLowerCase()}|${entry.number}` === key);
  const deduped = existing.filter((entry) => `${entry.name.toLowerCase()}|${entry.number}` !== key);
  const next = [{ id: previous?.id || createLocalContactId(), name: contact.name, number: contact.number }, ...deduped].slice(0, 200);
  await extensionApi.storage.local.set({ [LOCAL_DIRECTORY_CONTACTS_KEY]: next });
}

async function updateLocalDirectoryContact(contactId, updates) {
  const existing = await getLocalDirectoryContacts();
  const next = existing.map((entry) => (
    entry.id === contactId
      ? {
          ...entry,
          ...(updates.name ? { name: String(updates.name).trim() } : {}),
          ...(updates.number ? { number: String(updates.number).trim() } : {})
        }
      : entry
  ));
  await extensionApi.storage.local.set({ [LOCAL_DIRECTORY_CONTACTS_KEY]: next });
}

async function removeLocalDirectoryContact(contactId) {
  const existing = await getLocalDirectoryContacts();
  const next = existing.filter((entry) => entry.id !== contactId);
  await extensionApi.storage.local.set({ [LOCAL_DIRECTORY_CONTACTS_KEY]: next });
}

function createLocalContactId() {
  return `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function buildLegacyContactKey(entry, index) {
  const name = String(entry?.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const number = String(entry?.number || "").replace(/\D/g, "");
  return `${name || "contact"}-${number || "num"}-${index}`;
}

function buildFaxRow(fax, options = {}) {
  const li = document.createElement("li");
  li.className = "fax-row";
  if (options.animate) {
    li.classList.add("animate-in");
  }

  const cls = fax.status === "success" ? "success" : isFailureLikeStatus(fax.status) ? "failure" : "pending";

  const iconSvg = fax.status === "success"
    ? `<svg viewBox="0 0 16 16" fill="none" stroke="#16a34a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,8 6.5,11.5 13,5"/></svg>`
    : fax.status === "failure"
    ? `<svg viewBox="0 0 16 16" fill="none" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`
    : `<svg viewBox="0 0 16 16" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8,5 8,8 10,10"/></svg>`;

  const sentDate = fax.createdAt ? new Date(fax.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const mode = fax.kind === "email" ? "Email" : "Fax";
  const pagesText = fax.kind === "email" ? "secure link" : (fax.pages ? `${escapeHtml(fax.pages)}pp` : "");
  const meta = [mode, sentDate, pagesText].filter(Boolean).join(" · ");
  const progressDetail = formatProgressDetail(fax);
  const numbersLine = fax.kind === "email"
    ? `${escapeHtml(fax.from || "EasyFax")} → ${escapeHtml(fax.to)}`
    : `${escapeHtml(fax.from)} → ${escapeHtml(fax.to)}`;
  const canRetry = fax.kind === "fax" && isFailureLikeStatus(fax.status) && Boolean(fax.token);
  const retryDisabled = canRetry && !fax.retryPayloadAvailable;
  const retryLabel = retryDisabled ? "Retry unavailable" : "Retry";
  const badgeLabel = statusBadgeLabel(fax.status);

  li.innerHTML = `
    <div class="fax-status-icon ${cls}">${iconSvg}</div>
    <div class="fax-info">
      <div class="fax-numbers">${numbersLine}</div>
      ${meta ? `<div class="fax-meta">${meta}</div>` : ""}
      ${progressDetail ? `<div class="fax-progress">${escapeHtml(progressDetail)}</div>` : ""}
    </div>
    ${canRetry ? `<div class="fax-actions"><button type="button" class="retry-btn" data-action="retry-fax" data-history-key="${escapeHtml(historyItemKey(fax))}" ${retryDisabled ? "disabled" : ""}>${retryLabel}</button></div>` : ""}
    <span class="fax-badge ${cls}">${escapeHtml(badgeLabel)}</span>
  `;
  return li;
}

function startAutoRefreshLoop() {
  clearAutoRefreshLoop();

  autoRefreshStartedAt = Date.now();
  autoRefreshIdlePolls = 0;

  autoRefreshIntervalId = setInterval(async () => {
    if (autoRefreshInFlight) return;

    const elapsed = Date.now() - autoRefreshStartedAt;
    if (elapsed >= AUTO_REFRESH_MAX_DURATION_MS) {
      clearAutoRefreshLoop();
      return;
    }

    autoRefreshInFlight = true;
    try {
      const result = await renderFaxes({ preserveStatus: true });
      if (result.hadError) {
        return;
      }

      if (result.pendingCount > 0) {
        autoRefreshIdlePolls = 0;
        return;
      }

      autoRefreshIdlePolls += 1;
      if (autoRefreshIdlePolls >= AUTO_REFRESH_IDLE_STOP_POLLS) {
        clearAutoRefreshLoop();
      }
    } finally {
      autoRefreshInFlight = false;
    }
  }, AUTO_REFRESH_INTERVAL_MS);
}

function clearAutoRefreshLoop() {
  if (autoRefreshIntervalId) { clearInterval(autoRefreshIntervalId); autoRefreshIntervalId = null; }
  autoRefreshInFlight = false;
  autoRefreshStartedAt = 0;
  autoRefreshIdlePolls = 0;
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
  const { [LOCAL_EMAIL_HISTORY_KEY]: emailHistory = [] } = await extensionApi.storage.local.get([LOCAL_EMAIL_HISTORY_KEY]);
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
  await extensionApi.storage.local.set({
    [LOCAL_EMAIL_HISTORY_KEY]: items.slice(0, MAX_LOCAL_EMAIL_HISTORY)
  });
}

function isPendingStatus(status) {
  const v = String(status || "").toLowerCase();
  return v === "queued" || v === "inprogress" || v === "pending" || v === "processing" || v === "sending" || v === "dialing" || v === "retrying";
}

function isTerminalStatus(status) {
  const v = String(status || "").toLowerCase();
  return v === "success" || isFailureLikeStatus(v);
}

function isFailureLikeStatus(status) {
  const v = String(status || "").toLowerCase();
  return ["failure", "busy", "noanswer", "rejected", "undelivered", "invalidnumber", "failed"].includes(v);
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
  const settings = await getStoredSettings();
  const apiKey = (settings.apiKey || "").trim();
  const apiBase = (settings.apiBase || "https://api.medsender.com/api/v2").trim().replace(/\/$/, "");
  if (!apiKey) throw new Error("Missing API key. Open API Settings.");
  return { apiKey, apiBase };
}

async function getStoredSettings() {
  // Prefer sync storage, fallback to local storage if sync is unavailable.
  try {
    const { [SETTINGS_STORAGE_KEY]: settings = {} } = await extensionApi.storage.sync.get([SETTINGS_STORAGE_KEY]);
    if (settings && typeof settings === "object" && String(settings.apiKey || "").trim()) {
      return settings;
    }
  } catch {
    // ignore and fallback to local
  }

  const { [SETTINGS_STORAGE_KEY]: localSettings = {} } = await extensionApi.storage.local.get([SETTINGS_STORAGE_KEY]);
  if (localSettings && typeof localSettings === "object") {
    return localSettings;
  }
  return {};
}

async function saveStoredSettings(settings) {
  // Save to local first so popup always has a recoverable copy.
  await extensionApi.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });

  try {
    await extensionApi.storage.sync.set({ [SETTINGS_STORAGE_KEY]: settings });
  } catch {
    // Keep local copy only if sync write fails.
  }
}

async function getSettingsStorageDiagnostics() {
  const [syncProbe, localProbe] = await Promise.all([
    probeStorageArea(extensionApi.storage.sync, "sync"),
    probeStorageArea(extensionApi.storage.local, "local")
  ]);

  const syncSettings = await readSettingsFromArea(extensionApi.storage.sync);
  const localSettings = await readSettingsFromArea(extensionApi.storage.local);

  return {
    syncProbe,
    localProbe,
    syncHasApiKey: Boolean(String(syncSettings?.apiKey || "").trim()),
    localHasApiKey: Boolean(String(localSettings?.apiKey || "").trim())
  };
}

async function readSettingsFromArea(storageArea) {
  try {
    const { [SETTINGS_STORAGE_KEY]: settings = {} } = await storageArea.get([SETTINGS_STORAGE_KEY]);
    return settings && typeof settings === "object" ? settings : {};
  } catch {
    return {};
  }
}

async function probeStorageArea(storageArea, label) {
  const probeValue = `${label}-${Date.now()}`;
  const report = {
    label,
    ok: true,
    canWrite: false,
    canReadBack: false,
    error: ""
  };

  try {
    await storageArea.set({ [STORAGE_PROBE_KEY]: probeValue });
    report.canWrite = true;
    const { [STORAGE_PROBE_KEY]: readBack = "" } = await storageArea.get([STORAGE_PROBE_KEY]);
    report.canReadBack = readBack === probeValue;
    await storageArea.remove([STORAGE_PROBE_KEY]);
    if (!report.canReadBack) {
      report.ok = false;
      report.error = "read-back mismatch";
    }
  } catch (error) {
    report.ok = false;
    report.error = extractErrorMessage(error);
  }

  return report;
}

function formatStorageDiagnostics(prefix, diagnostics) {
  const syncInfo = `${diagnostics.syncProbe.label}: write=${diagnostics.syncProbe.canWrite ? "ok" : "no"}, read=${diagnostics.syncProbe.canReadBack ? "ok" : "no"}${diagnostics.syncProbe.error ? ` (${diagnostics.syncProbe.error})` : ""}`;
  const localInfo = `${diagnostics.localProbe.label}: write=${diagnostics.localProbe.canWrite ? "ok" : "no"}, read=${diagnostics.localProbe.canReadBack ? "ok" : "no"}${diagnostics.localProbe.error ? ` (${diagnostics.localProbe.error})` : ""}`;
  const keyInfo = `saved key: sync=${diagnostics.syncHasApiKey ? "yes" : "no"}, local=${diagnostics.localHasApiKey ? "yes" : "no"}`;
  return `${prefix} ${syncInfo}; ${localInfo}; ${keyInfo}.`;
}

function setSetupStatus(message, isError = false) {
  if (!setupStatusEl) {
    return;
  }
  setupStatusEl.textContent = message;
  setupStatusEl.style.color = isError ? "var(--failure)" : "var(--accent)";
}

function hasChromeExtensionApi() {
  return typeof chrome !== "undefined"
    && typeof chrome.storage !== "undefined"
    && typeof chrome.storage.sync !== "undefined"
    && typeof chrome.storage.local !== "undefined"
    && typeof chrome.runtime !== "undefined";
}

function createExtensionApi() {
  if (hasChromeExtensionApi()) {
    return chrome;
  }

  return {
    storage: {
      sync: createStorageArea("easyfax.preview.sync"),
      local: createStorageArea("easyfax.preview.local")
    },
    runtime: {
      openOptionsPage() {
        window.location.href = "options.html";
      }
    }
  };
}

function createStorageArea(namespace) {
  return {
    async get(keys) {
      const store = readPreviewStore(namespace);
      if (Array.isArray(keys)) {
        return keys.reduce((accumulator, key) => {
          accumulator[key] = store[key];
          return accumulator;
        }, {});
      }

      if (typeof keys === "string") {
        return {
          [keys]: store[keys]
        };
      }

      if (keys && typeof keys === "object") {
        return Object.entries(keys).reduce((accumulator, [key, defaultValue]) => {
          accumulator[key] = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : defaultValue;
          return accumulator;
        }, {});
      }

      return { ...store };
    },
    async set(items) {
      const store = readPreviewStore(namespace);
      writePreviewStore(namespace, {
        ...store,
        ...items
      });
    },
    async remove(keys) {
      const store = readPreviewStore(namespace);
      const nextStore = { ...store };
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        delete nextStore[key];
      }
      writePreviewStore(namespace, nextStore);
    }
  };
}

function readPreviewStore(namespace) {
  try {
    const raw = window.localStorage.getItem(namespace);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writePreviewStore(namespace, value) {
  window.localStorage.setItem(namespace, JSON.stringify(value));
}

function syncPreviewBanners() {
  for (const bannerEl of previewBannerEls) {
    bannerEl.hidden = !isExtensionPreview;
  }
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
    createdAt: String(fax.sentAt || fax.sent_at || fax.created_at || fax.inserted_at || ""),
    completedAt: String(
      fax.completedAt
      || fax.completed_at
      || fax.deliveredAt
      || fax.delivered_at
      || fax.completedOn
      || fax.completed_on
      || ""
    ),
    updatedAt: String(
      fax.updatedAt
      || fax.updated_at
      || fax.statusUpdatedAt
      || fax.status_updated_at
      || ""
    )
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
    createdAt: String(email.sentAt || email.sent_at || email.created_at || ""),
    completedAt: String(
      email.completedAt
      || email.completed_at
      || email.deliveredAt
      || email.delivered_at
      || email.completedOn
      || email.completed_on
      || ""
    ),
    updatedAt: String(
      email.updatedAt
      || email.updated_at
      || email.statusUpdatedAt
      || email.status_updated_at
      || ""
    )
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
  if (["error", "failed", "failure", "canceled", "cancelled"].includes(value)) return "failure";
  if (["busy", "linebusy", "busy_signal"].includes(value)) return "busy";
  if (["no_answer", "no-answer", "noanswer"].includes(value)) return "noanswer";
  if (["invalid_number", "invalid-number", "invalidnumber"].includes(value)) return "invalidnumber";
  if (["undelivered", "delivery_failed"].includes(value)) return "undelivered";
  if (["rejected", "blocked"].includes(value)) return "rejected";
  return value;
}

function formatProgressDetail(item) {
  const statusText = statusToProgressText(item.status);
  const elapsedText = typeof item.elapsedFrozenMs === "number"
    ? formatDuration(item.elapsedFrozenMs)
    : isTerminalStatus(item.status)
    ? ""
    : formatElapsedSince(item.createdAt);
  const checkedText = formatRelativeTime(item.lastCheckedAt);

  const parts = [statusText];
  if (elapsedText) parts.push(`elapsed ${elapsedText}`);
  if (checkedText) parts.push(`updated ${checkedText}`);
  return parts.filter(Boolean).join(" · ");
}

function statusToProgressText(status) {
  const value = String(status || "").toLowerCase();
  if (value === "success") return "Delivered";
  if (value === "failure") return "Failed";
  if (value === "busy") return "Failed (busy)";
  if (value === "noanswer") return "Failed (no answer)";
  if (value === "invalidnumber") return "Failed (invalid number)";
  if (value === "undelivered") return "Failed (undelivered)";
  if (value === "rejected") return "Failed (rejected)";
  if (value === "queued") return "Queued";
  if (value === "inprogress" || value === "pending" || value === "processing" || value === "sending" || value === "dialing" || value === "retrying") return "Sending";
  if (value === "unknown") return "Status pending";
  return value ? `Status: ${value}` : "Status pending";
}

function statusBadgeLabel(status) {
  const value = String(status || "").toLowerCase();
  if (value === "success") return "delivered";
  if (value === "failure") return "failed";
  if (value === "busy") return "busy";
  if (value === "noanswer") return "no answer";
  if (value === "invalidnumber") return "invalid number";
  if (value === "undelivered") return "undelivered";
  if (value === "rejected") return "rejected";
  return value || "unknown";
}

function normalizeFaxNumber(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return { ok: false, error: "Fax number is required." };
  }

  if (raw.startsWith("+")) {
    if (/^\+[1-9]\d{9,14}$/.test(raw)) {
      return { ok: true, value: raw };
    }
    return { ok: false, error: "Fax number must be E.164 format, like +14252074289." };
  }

  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return { ok: true, value: `+1${digits}` };
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return { ok: true, value: `+${digits}` };
  }

  return { ok: false, error: "Fax number must include 10 digits (US) or a full E.164 number." };
}

function buildSendFingerprint({ kind, to, file }) {
  return [
    String(kind || ""),
    String(to || "").toLowerCase(),
    String(file?.name || ""),
    String(file?.size || ""),
    String(file?.lastModified || ""),
    String(file?.type || "")
  ].join("|");
}

async function findRecentDuplicateSend(fingerprint) {
  const { [LOCAL_RECENT_SENDS_KEY]: entries = [] } = await extensionApi.storage.local.get([LOCAL_RECENT_SENDS_KEY]);
  if (!Array.isArray(entries)) {
    return null;
  }

  const now = Date.now();
  const hit = entries.find((entry) => {
    if (!entry || entry.fingerprint !== fingerprint) return false;
    const sentAt = Number(entry.sentAt || 0);
    return Number.isFinite(sentAt) && now - sentAt <= DUPLICATE_SEND_WINDOW_MS;
  });

  return hit || null;
}

async function rememberRecentSend(fingerprint) {
  const { [LOCAL_RECENT_SENDS_KEY]: entries = [] } = await extensionApi.storage.local.get([LOCAL_RECENT_SENDS_KEY]);
  const now = Date.now();
  const safe = Array.isArray(entries) ? entries : [];
  const next = [
    { fingerprint, sentAt: now },
    ...safe.filter((entry) => entry && entry.fingerprint !== fingerprint && now - Number(entry.sentAt || 0) <= 24 * 60 * 60 * 1000)
  ].slice(0, MAX_RECENT_SENDS);

  await extensionApi.storage.local.set({ [LOCAL_RECENT_SENDS_KEY]: next });
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read file for retry cache."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

async function getRetryPayloadMap() {
  const { [LOCAL_RETRY_CACHE_KEY]: cache = {} } = await extensionApi.storage.local.get([LOCAL_RETRY_CACHE_KEY]);
  if (!cache || typeof cache !== "object") {
    return {};
  }
  return cache;
}

async function saveRetryPayload(token, payload) {
  const tokenKey = String(token || "");
  if (!tokenKey) {
    return;
  }

  const cache = await getRetryPayloadMap();
  const next = {
    ...cache,
    [tokenKey]: {
      ...payload,
      savedAt: new Date().toISOString()
    }
  };

  const sortedTokens = Object.keys(next)
    .sort((a, b) => Date.parse(String(next[b]?.savedAt || "")) - Date.parse(String(next[a]?.savedAt || "")));
  const trimmed = sortedTokens.slice(0, MAX_RETRY_CACHE_ITEMS)
    .reduce((acc, key) => {
      acc[key] = next[key];
      return acc;
    }, {});

  await extensionApi.storage.local.set({ [LOCAL_RETRY_CACHE_KEY]: trimmed });
}

async function retryFailedFax(historyKey) {
  const item = latestHistoryItems.find((entry) => historyItemKey(entry) === historyKey);
  if (!item || item.kind !== "fax" || !item.token) {
    setStatus("Retry data not found.", true);
    return;
  }

  const cache = await getRetryPayloadMap();
  const retryPayload = cache[item.token];
  if (!retryPayload || !retryPayload.fileDataUrl) {
    setStatus("Retry unavailable for this fax. Send again manually.", true);
    return;
  }

  const confirmation = window.confirm(`Retry fax to ${item.to}?`);
  if (!confirmation) {
    return;
  }

  let settings;
  try {
    settings = await getApiSettings();
  } catch (error) {
    setStatus(extractErrorMessage(error), true);
    return;
  }

  try {
    setStatus("Retrying fax...");
    const payload = new FormData();
    const file = dataUrlToFile(retryPayload.fileDataUrl, retryPayload.fileName || "fax-document.pdf", retryPayload.fileType || "application/pdf");
    payload.append("file", file);
    payload.append("from_number", retryPayload.fromNumber || HARDCODED_FROM_NUMBER);
    payload.append("to_number", retryPayload.toNumber || item.to);
    if (retryPayload.message) {
      payload.append("message", retryPayload.message);
    }

    const response = await fetch(`${settings.apiBase}/sent_faxes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      body: payload
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = result.error || result.message || `Retry failed with ${response.status}`;
      throw new Error(message);
    }

    const newToken = result.faxId || result.fax_id || result.sendToken || result.send_token || result.token || "";
    if (newToken) {
      await saveRetryPayload(newToken, retryPayload);
    }

    const resendFingerprint = buildSendFingerprint({
      kind: "fax",
      to: retryPayload.toNumber || item.to,
      file
    });
    await rememberRecentSend(resendFingerprint);

    setTransientStatus("Retry queued.");
    await renderFaxes({ preserveStatus: true });
    startAutoRefreshLoop();
  } catch (error) {
    setStatus(`Retry failed: ${extractErrorMessage(error)}`, true);
  }
}

function notifyStatusTransitions(items, previousByKey) {
  for (const item of items) {
    const key = historyItemKey(item);
    const previous = previousByKey.get(key);
    if (!previous) {
      continue;
    }
    if (isTerminalStatus(previous.status)) {
      continue;
    }
    if (!isTerminalStatus(item.status)) {
      continue;
    }

    const title = item.status === "success" ? "Fax delivered" : "Fax failed";
    const message = item.kind === "email"
      ? `${title}: ${item.to}`
      : `${title}: ${item.from} -> ${item.to}`;
    showSystemNotification(title, message);
  }
}

function showSystemNotification(title, message) {
  if (!extensionApi.notifications || typeof extensionApi.notifications.create !== "function") {
    return;
  }

  const id = `easyfax-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  extensionApi.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message
  }, () => {
    if (chrome.runtime && chrome.runtime.lastError) {
      console.debug("[EasyFax] notification error", chrome.runtime.lastError.message);
    }
  });
}

function exportHistoryCsv() {
  const items = getFilteredHistoryItems(latestHistoryItems);
  if (!items.length) {
    setStatus("Nothing to export.", true);
    return;
  }

  const headers = ["Type", "From", "To", "Recipient", "Status", "Created At", "Completed At", "Elapsed", "Details"];
  const rows = items.map((item) => [
    item.kind === "email" ? "Email" : "Fax",
    item.from || "",
    item.to || "",
    item.recipient || "",
    statusBadgeLabel(item.status),
    item.createdAt || "",
    item.completedAt || item.updatedAt || "",
    typeof item.elapsedFrozenMs === "number" ? formatDuration(item.elapsedFrozenMs) : "",
    item.errorDetails || ""
  ]);

  const csv = [headers, ...rows]
    .map((row) => row.map((value) => `"${String(value || "").replaceAll('"', '""')}"`).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `easyfax-history-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setTransientStatus("History exported.");
}

function getFilteredHistoryItems(items) {
  return items.filter((item) => {
    if (historyFilter !== "all" && item.kind !== historyFilter) {
      return false;
    }

    if (historyStatusFilter !== "all") {
      if (historyStatusFilter === "inprogress" && !isPendingStatus(item.status)) {
        return false;
      }
      if (historyStatusFilter === "delivered" && item.status !== "success") {
        return false;
      }
      if (historyStatusFilter === "failed" && !isFailureLikeStatus(item.status)) {
        return false;
      }
    }

    if (historyDateFilter !== "all") {
      const createdAt = Date.parse(String(item.createdAt || ""));
      if (Number.isFinite(createdAt)) {
        const ageMs = Date.now() - createdAt;
        const maxAgeMs = historyDateFilter === "7d"
          ? 7 * 24 * 60 * 60 * 1000
          : historyDateFilter === "30d"
          ? 30 * 24 * 60 * 60 * 1000
          : 90 * 24 * 60 * 60 * 1000;
        if (ageMs > maxAgeMs) {
          return false;
        }
      }
    }

    if (historySearchTerm) {
      const haystack = [
        item.to,
        item.from,
        item.recipient,
        item.token,
        item.id,
        item.errorDetails
      ]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");
      if (!haystack.includes(historySearchTerm)) {
        return false;
      }
    }

    return true;
  });
}

function formatElapsedSince(timestampValue) {
  const timestamp = Date.parse(String(timestampValue || ""));
  if (!Number.isFinite(timestamp)) return "";

  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return "";

  return formatDuration(diffMs);
}

function formatRelativeTime(timestampValue) {
  const timestamp = Date.parse(String(timestampValue || ""));
  if (!Number.isFinite(timestamp)) return "";

  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return "just now";
  if (diffMs < 5000) return "just now";
  return `${formatDuration(diffMs)} ago`;
}

function formatDuration(durationMs) {
  const totalSeconds = Math.floor(durationMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function historyItemKey(item) {
  const kind = String(item.kind || "");
  const id = kind === "email" ? String(item.id || "") : String(item.token || "");
  return `${kind}:${id}`;
}

function computeElapsedMsBetween(startValue, endValue) {
  const start = Date.parse(String(startValue || ""));
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = Date.parse(String(endValue || ""));
  if (!Number.isFinite(end)) {
    return null;
  }

  const delta = end - start;
  if (delta < 0) {
    return 0;
  }

  return delta;
}

function maxFiniteNumber(...values) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!finite.length) {
    return null;
  }
  return Math.max(...finite);
}

function setStatus(message, isError = false) {
  if (statusClearTimeoutId) {
    clearTimeout(statusClearTimeoutId);
    statusClearTimeoutId = null;
  }

  const normalizedMessage = normalizeLegacyStatusMessage(message);

  statusMessageSerial += 1;
  sendStatusEl.textContent = normalizedMessage;
  sendStatusEl.style.color = isError ? "var(--failure)" : "var(--accent)";
  return statusMessageSerial;
}

function normalizeLegacyStatusMessage(message) {
  const text = String(message || "");
  if (/^Fax queued\s*[—-]\s*token:/i.test(text)) {
    return "Fax queued. Tracking progress in History.";
  }
  return text;
}

function setTransientStatus(message, options = {}) {
  const durationMs = Number(options.durationMs || 2500);
  const isError = Boolean(options.isError);
  const serial = setStatus(message, isError);
  if (isError || !message) {
    return serial;
  }

  statusClearTimeoutId = setTimeout(() => {
    if (statusMessageSerial === serial) {
      setStatus("");
    }
  }, durationMs);

  return serial;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
