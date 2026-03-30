document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById("toggleBtn");
  const status = document.getElementById("status");

  // 1. Load saved state
  chrome.storage.local.get("isActive", (data) => {
    const isActive = data.isActive !== false; // Default to true
    updateUI(isActive);
  });

  // 2. Handle Click
  btn.addEventListener("click", () => {
    chrome.storage.local.get("isActive", (data) => {
      const newState = !(data.isActive !== false);
      
      // Save State (This always works, even if the message fails)
      chrome.storage.local.set({ isActive: newState });
      updateUI(newState);

      // Tell the Content Script (Gmail) to hide/show immediately
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { action: "TOGGLE_WIDGET", state: newState }, (response) => {
            if (chrome.runtime.lastError) {
              console.log("Widget not active on this tab (ignoring).");
            }
          });
        }
      });
    });
  });

  function updateUI(isOn) {
    if (isOn) {
      btn.innerText = "Turn OFF";
      btn.className = "off"; // Button turns red
      status.innerText = "Shield is ACTIVE";
      status.style.color = "green";
    } else {
      btn.innerText = "Turn ON";
      btn.className = "on"; // Button turns green
      status.innerText = "Shield is SLEEPING";
      status.style.color = "gray";
    }
  }
});
