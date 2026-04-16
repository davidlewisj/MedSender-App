const form = document.getElementById("settings-form");
const apiKeyInput = document.getElementById("api-key");
const apiBaseInput = document.getElementById("api-base");
const statusEl = document.getElementById("status");

form.addEventListener("submit", onSubmit);

init();

async function init() {
  const { settings = {} } = await chrome.storage.sync.get(["settings"]);
  apiKeyInput.value = settings.apiKey || "";
  apiBaseInput.value = settings.apiBase || "https://api.medsender.com/api/v2";
}

async function onSubmit(event) {
  event.preventDefault();

  const apiKey = apiKeyInput.value.trim();
  const apiBase = apiBaseInput.value.trim().replace(/\/$/, "");

  if (!apiKey || !apiBase) {
    statusEl.textContent = "API key and base URL are required.";
    return;
  }

  await chrome.storage.sync.set({
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
