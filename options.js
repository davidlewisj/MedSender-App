const extensionApi = createExtensionApi();

const form = document.getElementById("settings-form");
const apiKeyInput = document.getElementById("api-key");
const apiBaseInput = document.getElementById("api-base");
const statusEl = document.getElementById("status");
const previewBannerEl = document.getElementById("preview-banner");

form.addEventListener("submit", onSubmit);

init();

async function init() {
  const { settings = {} } = await extensionApi.storage.sync.get(["settings"]);
  apiKeyInput.value = settings.apiKey || "";
  apiBaseInput.value = settings.apiBase || "https://api.medsender.com/api/v2";
  previewBannerEl.hidden = hasChromeExtensionApi();

  if (!hasChromeExtensionApi()) {
    statusEl.textContent = "Preview mode: settings are stored only in this browser.";
  }
}

async function onSubmit(event) {
  event.preventDefault();

  const apiKey = apiKeyInput.value.trim();
  const apiBase = apiBaseInput.value.trim().replace(/\/$/, "");

  if (!apiKey || !apiBase) {
    statusEl.textContent = "API key and base URL are required.";
    return;
  }

  await extensionApi.storage.sync.set({
    settings: {
      apiKey,
      apiBase
    }
  });

  statusEl.textContent = "Settings saved.";
  setTimeout(() => {
    statusEl.textContent = "";
  }, 1800);
}

function hasChromeExtensionApi() {
  return typeof chrome !== "undefined"
    && typeof chrome.storage !== "undefined"
    && typeof chrome.storage.sync !== "undefined"
    && typeof chrome.runtime !== "undefined";
}

function createExtensionApi() {
  if (hasChromeExtensionApi()) {
    return chrome;
  }

  return {
    storage: {
      sync: createStorageArea("easyfax.preview.sync")
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
