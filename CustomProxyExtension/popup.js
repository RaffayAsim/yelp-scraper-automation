document.addEventListener("DOMContentLoaded", () => {
  try {
    const statusText = document.getElementById("status-text");
    const statusIndicator = document.getElementById("status-indicator");
    const connectBestBtn = document.getElementById("connect-best-btn");
    const disconnectBtn = document.getElementById("disconnect-btn");
    const serversContainer = document.getElementById("servers-container");
    const apiStatus = document.getElementById("api-status");
    const apiStatusText = document.getElementById("api-status-text");

    // Helper to map country codes to flag emojis (with fallback)
    function getFlagEmoji(countryCode) {
      if (!countryCode || typeof countryCode !== 'string' || countryCode.length !== 2) {
        return "🌐";
      }
      try {
        const codePoints = countryCode
          .toUpperCase()
          .split('')
          .map(char => 127397 + char.charCodeAt(0));
        return String.fromCodePoint(...codePoints);
      } catch (e) {
        console.error("Failed to generate flag emoji:", e);
        return "🌐";
      }
    }

    // Update connection status
    function updateStatus() {
      try {
        chrome.storage.local.get(["activeProxy"], (result) => {
          if (chrome.runtime.lastError) {
            console.error("Storage read error:", chrome.runtime.lastError);
            return;
          }
          if (result && result.activeProxy) {
            const flag = getFlagEmoji(result.activeProxy.country || "US");
            statusText.innerText = `${flag} Connected (${result.activeProxy.country})`;
            statusIndicator.classList.add("active");
          } else {
            statusText.innerText = "Disconnected";
            statusIndicator.classList.remove("active");
          }
          loadServers();
        });
      } catch (err) {
        console.error("Error in updateStatus:", err);
      }
    }

    // Check api.kurva.cc status
    function checkApi() {
      try {
        chrome.runtime.sendMessage({ action: "checkApi" }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn("API status check message failed:", chrome.runtime.lastError);
            apiStatus.className = "api-badge offline";
            apiStatusText.innerText = "API Offline";
            return;
          }
          if (response && response.online) {
            apiStatus.className = "api-badge online";
            apiStatusText.innerText = "API Online";
          } else {
            apiStatus.className = "api-badge offline";
            apiStatusText.innerText = "API Offline";
          }
        });
      } catch (err) {
        console.error("Error in checkApi:", err);
      }
    }

    // Load servers dynamically from background script
    function loadServers() {
      try {
        chrome.runtime.sendMessage({ action: "getServers" }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn("Failed to get servers list:", chrome.runtime.lastError);
            return;
          }
          if (!response || !response.servers) return;
          
          const { servers, activeProxy } = response;
          serversContainer.innerHTML = "";

          servers.forEach((server) => {
            const isActive = activeProxy && activeProxy.host === server.host;
            
            const serverItem = document.createElement("div");
            serverItem.className = `server-item ${isActive ? "active" : ""}`;
            
            // Latency rating (handling JSON serialization of Infinity to null)
            let latencyClass = "excellent";
            let latencyText = `${server.latency}ms`;
            if (server.latency === null || server.latency === undefined || server.latency === Infinity) {
              latencyClass = "poor";
              latencyText = "Timeout";
            } else if (server.latency > 350) {
              latencyClass = "poor";
            } else if (server.latency > 150) {
              latencyClass = "good";
            }

            const flag = getFlagEmoji(server.country);
            
            serverItem.innerHTML = `
              <div class="server-info">
                <span class="server-flag">${flag}</span>
                <div class="server-meta">
                  <span class="server-name">${server.name}</span>
                  <span class="server-host">${server.host}</span>
                </div>
              </div>
              <div class="server-status">
                <span class="latency-badge ${latencyClass}">${latencyText}</span>
                <span class="active-indicator"></span>
              </div>
            `;

            // Connect on item click
            serverItem.addEventListener("click", () => {
              statusText.innerText = `Connecting to ${server.name}...`;
              chrome.runtime.sendMessage({ action: "connectTo", host: server.host }, (res) => {
                setTimeout(updateStatus, 500);
              });
            });

            serversContainer.appendChild(serverItem);
          });
        });
      } catch (err) {
        console.error("Error in loadServers:", err);
      }
    }

    // Trigger best connection
    connectBestBtn.addEventListener("click", () => {
      statusText.innerText = "Selecting best server...";
      chrome.runtime.sendMessage({ action: "connectBest" }, () => {
        setTimeout(updateStatus, 1000);
      });
    });

    // Trigger disconnect
    disconnectBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "disconnect" }, () => {
        updateStatus();
      });
    });

    // Initial checks
    updateStatus();
    checkApi();

    // Periodically refresh API status and servers
    setInterval(checkApi, 30000);
    setInterval(loadServers, 10000);
  } catch (globalErr) {
    console.error("Global popup execution error:", globalErr);
  }
});


