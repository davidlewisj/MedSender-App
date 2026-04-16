chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "easyfax.launchContextReady") {
    return undefined;
  }

  (async () => {
    try {
      if (chrome.action && typeof chrome.action.openPopup === "function") {
        await chrome.action.openPopup();
        sendResponse({ ok: true, opened: true });
        return;
      }

      sendResponse({ ok: true, opened: false });
    } catch (error) {
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
    }
  })();

  return true;
});
