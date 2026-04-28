const EASYFAX_POPUP_PATH = "popup.html";
const EASYFAX_POPUP_WIDTH = 420;
const EASYFAX_POPUP_HEIGHT = 860;
const EASYFAX_DEBUG_LAUNCH = false;

function debugLaunch(message, details) {
  if (!EASYFAX_DEBUG_LAUNCH) {
    return;
  }
  if (typeof details === "undefined") {
    console.info("[EasyFax launch]", message);
    return;
  }
  console.info("[EasyFax launch]", message, details);
}

async function openEasyFaxWindow() {
  const popupUrl = chrome.runtime.getURL(EASYFAX_POPUP_PATH);
  const existingWindows = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
  const existingWindow = existingWindows.find((windowInfo) =>
    Array.isArray(windowInfo.tabs)
    && windowInfo.tabs.some((tab) => String(tab.url || "") === popupUrl)
  );

  if (existingWindow) {
    await chrome.windows.update(existingWindow.id, { focused: true });
    return { opened: true, mode: "window", reused: true };
  }

  await chrome.windows.create({
    url: popupUrl,
    type: "popup",
    focused: true,
    width: EASYFAX_POPUP_WIDTH,
    height: EASYFAX_POPUP_HEIGHT
  });

  return { opened: true, mode: "window", reused: false };
}

async function openEasyFaxSidePanel(windowId) {
  if (!chrome.sidePanel || typeof chrome.sidePanel.open !== "function") {
    throw new Error("sidePanel API not available");
  }
  await chrome.sidePanel.open({ windowId });
  return { opened: true, mode: "sidePanel" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "easyfax.launchContextReady") {
    return undefined;
  }

  (async () => {
    const windowId = sender && sender.tab && sender.tab.windowId ? sender.tab.windowId : undefined;
    debugLaunch("launch requested", { windowId });

    // 1. Try the toolbar action popup first.
    try {
      if (chrome.action && typeof chrome.action.openPopup === "function") {
        await chrome.action.openPopup();
        debugLaunch("opened via action popup");
        sendResponse({ ok: true, opened: true, mode: "action" });
        return;
      }
    } catch {
      // Fall through to next option.
      debugLaunch("action popup failed; falling back");
    }

    // 2. Fallback to side panel when available in the current window.
    if (windowId !== undefined) {
      try {
        const result = await openEasyFaxSidePanel(windowId);
        debugLaunch("opened via side panel", { windowId });
        sendResponse({ ok: true, ...result });
        return;
      } catch (error) {
        debugLaunch("side panel failed; falling back", { windowId, error: String(error && error.message ? error.message : error) });
      }
    }

    // 3. Last resort: open a separate popup window.
    try {
      const result = await openEasyFaxWindow();
      debugLaunch("opened via popup window", result);
      sendResponse({ ok: true, ...result });
      return;
    } catch (error) {
      debugLaunch("popup window failed", { error: String(error && error.message ? error.message : error) });
    }

    debugLaunch("all launch methods failed", { windowId });
    sendResponse({
      ok: false,
      error: "Unable to open EasyFax popup, sidebar, or popup window."
    });
  })();

  return true;
});
