// content.js — injected into every page
// Notifies the background worker when the page finishes significant DOM changes
// so the background can schedule an extra capture after dynamic content loads.

(function () {
  let notified = false;
  let debounceTimer = null;

  function notifyReady() {
    if (notified) return;
    // Debounce: wait 2 s after last DOM mutation before notifying
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      notified = true;
      chrome.runtime.sendMessage({ type: "PAGE_SETTLED" });
    }, 2000);
  }

  // Watch for large DOM mutations (SPAs, lazy-loaded content)
  const observer = new MutationObserver((mutations) => {
    const significant = mutations.some(
      (m) => m.addedNodes.length > 5 || m.removedNodes.length > 5
    );
    if (significant) {
      notified = false; // allow re-notification on big changes
      notifyReady();
    }
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Always notify once on load
  window.addEventListener("load", notifyReady, { once: true });
})();
