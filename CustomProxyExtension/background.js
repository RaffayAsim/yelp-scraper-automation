// List of the 5 hardcoded free proxy servers from Kurva API/VPNLY
const PROXY_SERVERS = [
  {
    host: "ge-hub.freeruproxy.ink",
    port: 443,
    scheme: "https",
    username: "openproxy",
    password: "7a379d234cd89887",
    country: "DE",
    name: "Germany (Dusseldorf - Main)"
  },
  {
    host: "de-hub.freeruproxy.ink",
    port: 443,
    scheme: "https",
    username: "openproxy",
    password: "7a379d234cd89887",
    country: "DE",
    name: "Germany (Dusseldorf - Fallback)"
  },
  {
    host: "us-hub.freeruproxy.ink",
    port: 443,
    scheme: "https",
    username: "openproxy",
    password: "685ce62bfdf0d359",
    country: "US",
    name: "USA (Chicago)"
  },
  {
    host: "fr-hub.freeruproxy.ink",
    port: 443,
    scheme: "https",
    username: "openproxy",
    password: "abc21f3a79de33dc",
    country: "FR",
    name: "France (Paris)"
  },
  {
    host: "nl-hub.freeruproxy.ink",
    port: 443,
    scheme: "https",
    username: "openproxy",
    password: "2ad5c3cece9f19f6",
    country: "NL",
    name: "Netherlands (Amsterdam)"
  }
];

const API_URL = "https://api.kurva.cc";
let activeProxy = null;

// Sets the proxy configuration in Chrome
function setProxy(server) {
  const config = {
    mode: "fixed_servers",
    rules: {
      singleProxy: {
        scheme: server.scheme,
        host: server.host,
        port: parseInt(server.port)
      },
      bypassList: ["localhost", "127.0.0.1"]
    }
  };

  chrome.proxy.settings.set(
    { value: config, scope: "regular" },
    () => {
      activeProxy = server;
      chrome.storage.local.set({ activeProxy: server });
      console.log(`Connected to proxy: ${server.host}`);
    }
  );
}

// Disables proxy configuration
function disableProxy() {
  chrome.proxy.settings.clear({ scope: "regular" }, () => {
    activeProxy = null;
    chrome.storage.local.remove("activeProxy");
    console.log("Proxy disabled");
  });
}

// Measures latency to a specific proxy host using a lightweight fetch
async function measureLatency(server) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3-second timeout

    // Attempting a quick fetch to evaluate response time.
    await fetch(`https://${server.host}/generate_204?t=${start}`, {
      method: "HEAD",
      mode: "no-cors",
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return Date.now() - start;
  } catch (e) {
    return Infinity; // Server is unreachable or timed out
  }
}

// Finds the best server by testing latency
async function selectAndConnectBestServer() {
  console.log("Finding best proxy server...");
  let bestServer = null;
  let lowestLatency = Infinity;

  for (const server of PROXY_SERVERS) {
    const latency = await measureLatency(server);
    console.log(`Server ${server.host} latency: ${latency}ms`);
    if (latency < lowestLatency) {
      lowestLatency = latency;
      bestServer = server;
    }
  }

  if (bestServer && lowestLatency !== Infinity) {
    console.log(`Selected best server: ${bestServer.host} (${lowestLatency}ms)`);
    setProxy(bestServer);
  } else {
    // If all checks fail, fall back to the first server in the list
    console.warn("Could not determine latency. Falling back to the default server.");
    setProxy(PROXY_SERVERS[0]);
  }
}

// Check api.kurva.cc status
async function checkApiStatus() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(API_URL, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const data = await response.json();
    return data && data.status === true;
  } catch (e) {
    console.error("API status check failed:", e);
    return false;
  }
}

// Handles Proxy Authentication
chrome.webRequest.onAuthRequired.addListener(
  (details) => {
    if (activeProxy && details.isProxy) {
      return {
        authCredentials: {
          username: activeProxy.username,
          password: activeProxy.password
        }
      };
    }
    return {};
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);

// Monitor connection changes or check latency periodically
if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.create("rotate-check", { periodInMinutes: 15 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "rotate-check") {
      selectAndConnectBestServer();
    }
  });
} else {
  console.warn("chrome.alarms is undefined. Make sure the 'alarms' permission is listed in manifest.json and the extension has been reloaded.");
}

// Auto-connect on Startup and Install
chrome.runtime.onStartup.addListener(() => {
  selectAndConnectBestServer();
});

chrome.runtime.onInstalled.addListener(() => {
  selectAndConnectBestServer();
});

// Handle requests from popup.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "connectBest") {
    selectAndConnectBestServer().then(() => {
      sendResponse({ status: "connected", activeProxy: activeProxy });
    });
    return true; // keep channel open for async response
  } else if (request.action === "disconnect") {
    disableProxy();
    sendResponse({ status: "disconnected" });
  } else if (request.action === "getServers") {
    // Measure latency for each server dynamically when requested by popup
    const promises = PROXY_SERVERS.map(async (s) => {
      const lat = await measureLatency(s);
      return {
        host: s.host,
        country: s.country,
        name: s.name,
        latency: lat
      };
    });
    Promise.all(promises).then((serversWithLatency) => {
      sendResponse({ servers: serversWithLatency, activeProxy: activeProxy });
    });
    return true;
  } else if (request.action === "connectTo") {
    const target = PROXY_SERVERS.find(s => s.host === request.host);
    if (target) {
      setProxy(target);
      sendResponse({ status: "connected", activeProxy: target });
    } else {
      sendResponse({ status: "error", message: "Server not found" });
    }
  } else if (request.action === "checkApi") {
    checkApiStatus().then((isOnline) => {
      sendResponse({ online: isOnline });
    });
    return true;
  }
});


