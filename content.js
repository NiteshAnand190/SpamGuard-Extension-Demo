// CONFIGURATION
const API_URL = "https://spam-guard-api.onrender.com";

function isContextValid() {
    try {
        // chrome.runtime.id becomes undefined when the extension
        // context is invalidated. This is the official Chrome way
        // to detect a dead context from a content script.
        return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
        return false;
    }
}

function safeStorageGet(key, callback, defaultValue = {}) {
    if (!isContextValid()) {
        callback(defaultValue);
        return;
    }
    try {
        chrome.storage.local.get(key, (data) => {
            if (chrome.runtime.lastError) {
                console.warn("SpamGuard: storage.get error —", chrome.runtime.lastError.message);
                callback(defaultValue);
                return;
            }
            callback(data);
        });
    } catch (e) {
        console.warn("SpamGuard: storage.get threw —", e.message);
        callback(defaultValue);
    }
}

function safeStorageSet(obj) {
    if (!isContextValid()) return;
    try {
        chrome.storage.local.set(obj);
    } catch (e) {
        console.warn("SpamGuard: storage.set threw —", e.message);
    }
}

// GET LOGO URL
const logoUrl = chrome.runtime.getURL("logo.png");

// UI CREATION
const overlay = document.createElement("div");
overlay.id = "spam-guard-overlay";
overlay.className = "minimized";
overlay.style.bottom = "30px";
overlay.style.right = "30px";

overlay.innerHTML = `
  <div id="sg-minimized-icon">
    <img src="${logoUrl}" style="width: 100%; height: 100%; object-fit: cover; pointer-events: none; border-radius: 50%;">
  </div>

  <div id="sg-expanded-view">
    <div class="sg-header" id="sg-drag-header">
      <div style="display: flex; align-items: center; pointer-events: none;">
        <span>🛡️ Spam Guard</span>
      </div>
      <div>
        <span id="sg-power" class="sg-power-btn" title="Turn Off Extension">OFF</span>
        <span id="sg-minimize" style="font-size: 18px; cursor: pointer;">−</span>
      </div>
    </div>
    <div class="sg-content">
      <div class="sg-verdict" id="sg-verdict">Waiting...</div>
      <div class="sg-bar-bg"><div class="sg-bar-fill" id="sg-bar"></div></div>
      <div class="sg-explanation" id="sg-explanation">Open an email to scan.</div>
      <button id="sg-rescan" class="sg-rescan-btn" style="display:none;">🔄 Rescan</button>
    </div>
  </div>
`;
document.body.appendChild(overlay);

// DRAG & DROP LOGIC
let isDragging = false;
let hasMoved = false;
let dragOffset = { x: 0, y: 0 };

const header = document.getElementById('sg-drag-header');
const minIcon = document.getElementById('sg-minimized-icon');

function startDrag(e) {
    if (e.button !== 0) return;
    if (e.target.id === 'sg-power' || e.target.id === 'sg-minimize') return;

    isDragging = true;
    hasMoved = false;

    const rect = overlay.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;

    overlay.style.bottom = 'auto';
    overlay.style.right = 'auto';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';

    document.addEventListener('mousemove', doDrag);
    document.addEventListener('mouseup', stopDrag);
    e.preventDefault();
}

function doDrag(e) {
    if (!isDragging) return;
    hasMoved = true;

    let newX = e.clientX - dragOffset.x;
    let newY = e.clientY - dragOffset.y;

    const windowW = window.innerWidth;
    const windowH = window.innerHeight;
    const widgetW = overlay.offsetWidth;
    const widgetH = overlay.offsetHeight;

    if (newX < 0) newX = 0;
    if (newX + widgetW > windowW) newX = windowW - widgetW;
    if (newY < 0) newY = 0;
    if (newY + widgetH > windowH) newY = windowH - widgetH;

    overlay.style.left = newX + 'px';
    overlay.style.top = newY + 'px';
}

function stopDrag() {
    isDragging = false;
    document.removeEventListener('mousemove', doDrag);
    document.removeEventListener('mouseup', stopDrag);
}

header.addEventListener('mousedown', startDrag);
minIcon.addEventListener('mousedown', startDrag);

// SMART BOUNDARY CHECK
function adjustPosition() {
    if (overlay.style.left && overlay.style.left !== "auto") {
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        const expandedWidth = 320;

        let currentLeft = parseFloat(overlay.style.left);
        let currentTop = parseFloat(overlay.style.top);

        if (currentLeft + expandedWidth > winW) {
            let newLeft = winW - expandedWidth - 20;
            overlay.style.left = Math.max(0, newLeft) + "px";
        }

        if (currentTop > winH - 200) {
            let newTop = winH - 300;
            overlay.style.top = Math.max(0, newTop) + "px";
        }
    }
}

// UI STATE LOGIC

minIcon.addEventListener("click", (e) => {
    if (!hasMoved) {
        overlay.classList.remove("minimized");
        adjustPosition();
    }
});

document.getElementById("sg-minimize").addEventListener("click", (e) => {
    e.stopPropagation();
    overlay.classList.add("minimized");
});

document.getElementById("sg-power").addEventListener("click", (e) => {
    e.stopPropagation();
    safeStorageSet({ isActive: false });
    overlay.style.display = "none";
    alert("SpamGuard is OFF. Use the extension toolbar icon to turn it back ON.");
});

document.getElementById("sg-rescan").addEventListener("click", (e) => {
    e.stopPropagation();
    updateUI("Scanning...", "gray", 0, "Re-analyzing email...");
    document.getElementById("sg-rescan").style.display = "none";
    scanEmailWithRetry();
});

// Load initial ON/OFF state — guarded
safeStorageGet("isActive", (data) => {
    if (data.isActive === false) overlay.style.display = "none";
});

if (isContextValid()) {
    try {
        chrome.runtime.onMessage.addListener((request) => {
            if (request.action === "TOGGLE_WIDGET") {
                overlay.style.display = request.state ? "block" : "none";
            }
        });
    } catch (e) {
        console.warn("SpamGuard: could not add message listener —", e.message);
    }
}

// EMAIL DETECTION
function isEmailCurrentlyOpen() {
    return /\/[a-zA-Z0-9]{10,}$/.test(location.hash);
}

// CORE LOGIC: DETECT EMAIL & SCAN
let lastUrl = location.href;

new MutationObserver(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;

    if (!isContextValid()) {
        updateUI("⚠️ Extension Reloaded", "orange", 0, "Please reload this Gmail tab to re-activate SpamGuard.");
        return;
    }

    safeStorageGet("isActive", (data) => {
        if (isEmailCurrentlyOpen() && data.isActive !== false) {
            overlay.classList.remove("minimized");
            adjustPosition();
            document.getElementById("sg-rescan").style.display = "none";
            updateUI("Scanning...", "gray", 0, "Analyzing content and sender...");
            setTimeout(scanEmailWithRetry, 1000);
        }
    });
}).observe(document, { subtree: true, childList: true });

// RETRY LOGIC
function scanEmailWithRetry(attempt = 1, maxAttempts = 6) {
    const emailBodyNode = document.querySelector('.a3s');

    if (!emailBodyNode) {
        if (attempt < maxAttempts) {
            setTimeout(() => scanEmailWithRetry(attempt + 1, maxAttempts), 800);
        } else {
            updateUI("⚠️ Could Not Read", "orange", 0, "Email body not found. Try clicking into the email.");
            document.getElementById("sg-rescan").style.display = "block";
        }
        return;
    }

    scanEmail(emailBodyNode);
}

async function scanEmail(emailBodyNode) {
    const subjectNode = document.querySelector('h2[data-thread-perm-id]');
    const senderNode = document.querySelector('span.gD');
    const senderEmail = senderNode ? senderNode.getAttribute("email") : "Unknown Sender";
    const isSpamFolder = window.location.href.includes("#spam") || window.location.href.includes("/spam/");

    const bodyText = emailBodyNode.innerText;
    const subjectText = subjectNode ? subjectNode.innerText : "No Subject";

    try {
        const response = await fetch(`${API_URL}/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                subject: subjectText,
                body: bodyText,
                sender: senderEmail
            })
        });
        const data = await response.json();

        document.getElementById("sg-rescan").style.display = "block";

        if (data.verdict === "SPAM") {
            updateUI("⚠️ SPAM DETECTED", "red", data.confidence_score, data.explanation);
        } else if (isSpamFolder && data.verdict === "SAFE") {
            updateUI("⚠️ GOOGLE MARKED SPAM", "orange", 50, "Our AI thinks this looks safe, but Google marked it as Spam. Be careful.");
        } else {
            updateUI("✅ LOOKS SAFE", "green", data.confidence_score, data.explanation);
        }

    } catch (error) {
        console.error("SpamGuard fetch error:", error);
        updateUI("Connection Error", "orange", 0, "Check backend or internet.");
        document.getElementById("sg-rescan").style.display = "block";
    }
}

function updateUI(text, colorClass, confidence, explanation) {
    const verdictEl = document.getElementById("sg-verdict");
    const barEl = document.getElementById("sg-bar");
    const expEl = document.getElementById("sg-explanation");

    verdictEl.className = "sg-verdict";
    barEl.className = "sg-bar-fill";
    verdictEl.innerText = text;
    verdictEl.classList.add(`text-${colorClass}`);
    barEl.style.width = `${confidence}%`;
    barEl.classList.add(`bg-${colorClass}`);
    expEl.innerText = explanation;
}
