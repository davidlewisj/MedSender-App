(() => {
  const EASYFAX_BUTTON_ID = "easyfax-btn-edit-left";
  const TOAST_ID = "easyfax-amd-toast";
  const MAX_STORED_PDF_BYTES = 4.5 * 1024 * 1024;
  let retries = 0;
  let retryTimerId = null;

  function visitRoot(root, visitor) {
    if (!root) {
      return;
    }

    visitor(root);

    const nodes = root.querySelectorAll("*");
    for (const node of nodes) {
      if (node.shadowRoot) {
        visitRoot(node.shadowRoot, visitor);
      }
    }
  }

  function deepQuerySelector(selector) {
    let found = null;
    visitRoot(document, (root) => {
      if (found) {
        return;
      }
      const hit = root.querySelector(selector);
      if (hit) {
        found = hit;
      }
    });
    return found;
  }

  function findEditButton() {
    return deepQuerySelector("#btnEdit")
      || deepQuerySelector("button[onclick*='openNarrativeGeneratedDocumentEditor']")
      || deepQuerySelector(".narrative-header-btn#btnEdit")
      || null;
  }

  function extractChartContext() {
    const params = new URLSearchParams(window.location.search);
    const pdfUrl = findPdfViewerUrl();
    return {
      source: "advancedmd",
      capturedAt: new Date().toISOString(),
      pageTitle: document.title,
      pageUrl: window.location.href,
      patProfId: params.get("PatProfID") || "",
      itemType: params.get("ItemType") || "",
      itemId: params.get("ItemID") || params.get("id") || "",
      pdfUrl
    };
  }

  function normalizeUrl(rawUrl) {
    if (!rawUrl) {
      return "";
    }

    try {
      const normalized = new URL(rawUrl, window.location.href).href;
      if (normalized === "about:blank") {
        return "";
      }
      return normalized;
    } catch {
      return "";
    }
  }

  function findPdfViewerUrl() {
    const candidates = [];

    const selectorSources = [
      ["embed[type='application/pdf']", "src"],
      ["object[type='application/pdf']", "data"],
      ["iframe[src*='.pdf']", "src"],
      ["iframe[src*='ChartViewerDetail.aspx']", "src"],
      ["iframe[src*='chartviewerdetail.aspx']", "src"],
      ["iframe[src*='Pdf']", "src"],
      ["iframe[src*='Viewer']", "src"],
      ["iframe[src*='Document']", "src"]
    ];

    for (const [selector, attr] of selectorSources) {
      const node = document.querySelector(selector);
      if (!node) {
        continue;
      }
      const value = node.getAttribute(attr) || "";
      if (value) {
        candidates.push(value);
      }
    }

    // Generic pass: include iframe/object/embed URLs that look related to chart docs.
    for (const node of document.querySelectorAll("iframe[src], object[data], embed[src]")) {
      const raw = node.getAttribute("src") || node.getAttribute("data") || "";
      if (!raw) {
        continue;
      }
      candidates.push(raw);
    }

    for (const candidate of candidates) {
      const url = normalizeUrl(candidate);
      if (!url) {
        continue;
      }

      if (url.startsWith("blob:")) {
        return url;
      }

      const lower = url.toLowerCase();
      if (
        lower.includes(".pdf")
        || lower.includes("pdf")
        || lower.includes("documentviewer")
        || lower.includes("chartviewerdetail.aspx")
      ) {
        return url;
      }
    }

    return "";
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Failed to read PDF bytes"));
      reader.readAsDataURL(blob);
    });
  }

  async function capturePdfData(context) {
    if (!context.pdfUrl) {
      return null;
    }

    const response = await fetch(context.pdfUrl, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`PDF fetch failed (${response.status})`);
    }

    const blob = await response.blob();
    if (!blob || !blob.size) {
      throw new Error("PDF is empty");
    }

    if (blob.size > MAX_STORED_PDF_BYTES) {
      throw new Error("PDF is too large for quick handoff");
    }

    const dataUrl = await blobToDataUrl(blob);
    return {
      pdfDataUrl: dataUrl,
      pdfMimeType: blob.type || "application/pdf",
      pdfSize: blob.size
    };
  }

  function toast(message) {
    const oldToast = document.getElementById(TOAST_ID);
    if (oldToast) {
      oldToast.remove();
    }

    const node = document.createElement("div");
    node.id = TOAST_ID;
    node.textContent = message;
    node.style.position = "fixed";
    node.style.right = "16px";
    node.style.bottom = "16px";
    node.style.zIndex = "2147483647";
    node.style.padding = "10px 12px";
    node.style.borderRadius = "8px";
    node.style.background = "#0e8f6f";
    node.style.color = "#fff";
    node.style.font = "600 12px Segoe UI, sans-serif";
    node.style.boxShadow = "0 4px 16px rgba(0,0,0,0.2)";
    document.body.appendChild(node);

    window.setTimeout(() => {
      node.remove();
    }, 2600);
  }

  async function onEasyFaxClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const context = extractChartContext();

    let pdfPayload = null;
    if (context.pdfUrl) {
      try {
        pdfPayload = await capturePdfData(context);
      } catch {
        // Keep going with URL-only context if byte capture fails.
      }
    }

    await chrome.storage.local.set({
      easyFaxLaunchContext: {
        ...context,
        ...pdfPayload
      }
    });

    try {
      const response = await chrome.runtime.sendMessage({ type: "easyfax.launchContextReady" });
      if (response && response.opened) {
        return;
      }
    } catch {
      // Ignore if popup cannot be opened automatically in this browser state.
    }

    if (pdfPayload && pdfPayload.pdfDataUrl) {
      toast("EasyFax captured this chart PDF. Click the EasyFax extension icon.");
      return;
    }

    if (context.pdfUrl) {
      toast("EasyFax captured chart context. Document link detected; popup will try to fetch it.");
      return;
    }

    toast("EasyFax context captured. PDF URL was not detected on this view.");
  }

  function ensureEasyFaxButton() {
    const editButton = findEditButton();
    if (!editButton || !editButton.parentElement) {
      scheduleRetry();
      return;
    }

    if (deepQuerySelector(`#${EASYFAX_BUTTON_ID}`)) {
      return;
    }

    const easyFaxButton = document.createElement("button");
    easyFaxButton.id = EASYFAX_BUTTON_ID;
    easyFaxButton.type = "button";
    easyFaxButton.className = "narrative-btn narrative-header-btn";
    easyFaxButton.title = "Send with EasyFax";
    easyFaxButton.style.margin = "0px 2px";
    easyFaxButton.style.display = "inline-flex";
    easyFaxButton.style.alignItems = "center";
    easyFaxButton.style.justifyContent = "center";
    easyFaxButton.style.fontWeight = "700";
    easyFaxButton.style.height = "32px";
    easyFaxButton.style.width = "38px";
    easyFaxButton.style.borderRadius = "5px";
    easyFaxButton.style.outline = "none";
    easyFaxButton.style.textAlign = "center";
    easyFaxButton.style.cursor = "pointer";
    easyFaxButton.style.padding = "0px";
    easyFaxButton.style.border = "1px solid #4178be";
    easyFaxButton.style.background = "#fff";
    easyFaxButton.style.color = "#3767a4";
    easyFaxButton.style.minWidth = "unset";
    easyFaxButton.style.lineHeight = "1";
    easyFaxButton.style.fontFamily = "Arial,sans-serif";
    easyFaxButton.style.fontSize = "1em";
    easyFaxButton.innerHTML = `
      <svg viewBox="0 0 113.92 122.88" width="18" height="18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
        <path fill="#4ba042" fill-rule="evenodd" d="M86.18,67.4A27.74,27.74,0,1,1,58.44,95.14,27.74,27.74,0,0,1,86.18,67.4Z"/>
        <path fill="#212121" d="M46.4,104.45a2.82,2.82,0,1,1,0,5.64H6.57A6.57,6.57,0,0,1,0,103.53v-97A6.55,6.55,0,0,1,1.93,1.93,6.5,6.5,0,0,1,6.57,0H87.22a6.59,6.59,0,0,1,6.57,6.57V56a2.83,2.83,0,1,1-5.65,0V6.57a.9.9,0,0,0-.27-.65.94.94,0,0,0-.65-.28H6.57a1,1,0,0,0-.66.27,1,1,0,0,0-.26.66v96.95a.88.88,0,0,0,.27.64,1,1,0,0,0,.66.28H46.4ZM23.79,65V59.3H65.51V65Zm0-18.57V40.74H70v5.64Zm0-18.56V22.17H70v5.65Zm0,55.76V77.87H48.88v5.71Z"/>
        <path fill="#fff" d="M70.14,93.29l5.66-.08.42.11a22.06,22.06,0,0,1,3.23,2.27,21.81,21.81,0,0,1,2.08,2,81,81,0,0,1,6.48-9A77.13,77.13,0,0,1,96,80.3l.55-.21h6.18l-1.25,1.38A132,132,0,0,0,91,94.65a129.25,129.25,0,0,0-8.44,14l-.77,1.5-.72-1.52a36.74,36.74,0,0,0-4.77-7.74,31.23,31.23,0,0,0-6.62-6.13l.46-1.51Z"/>
      </svg>
    `;
    easyFaxButton.addEventListener("click", onEasyFaxClick);

    editButton.parentElement.insertBefore(easyFaxButton, editButton);

    if (retryTimerId) {
      window.clearTimeout(retryTimerId);
      retryTimerId = null;
    }
  }

  function scheduleRetry() {
    if (retryTimerId || retries >= 25) {
      return;
    }

    retries += 1;
    retryTimerId = window.setTimeout(() => {
      retryTimerId = null;
      ensureEasyFaxButton();
    }, 800);
  }

  ensureEasyFaxButton();

  const observer = new MutationObserver(() => {
    ensureEasyFaxButton();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
