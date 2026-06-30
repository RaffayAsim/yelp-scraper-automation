const express = require('express');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const puppeteer = puppeteerExtra;
const xl = require('excel4node');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const EXTENSION_PATH = process.env.EXTENSION_PATH || 'C:\\Users\\dell\\Downloads\\crx_extracted\\src';
const EXPORTS_DIR = process.env.EXPORTS_DIR || path.join(__dirname, 'exports');
const DEBUG_DIR = process.env.DEBUG_DIR || path.join(__dirname, 'debug');
const TIMINGS_FILE = path.join(__dirname, 'timings.json');
const LEARNED_CLICK_FILE = path.join(__dirname, 'learned-click-target.json');
const JOB_RETENTION_MS = 60 * 60 * 1000;
const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || path.join(__dirname, '.chrome-profile');
const FACEBOOK_PROFILE_DIR = process.env.FACEBOOK_PROFILE_DIR || path.join(CHROME_USER_DATA_DIR, 'facebook-main');
const MANUAL_TRAIN_TIMEOUT_MS = 45000;
const BROWSER_LAUNCH_TIMEOUT_MS = 45000;
const CHROME_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE_PATH || undefined;

const START_BUTTON_SELECTOR = '#extension_gms_start_btn';
const START_BUTTON_TEXT = 'start auto extract';

const jobs = new Map();

for (const dirPath of [EXPORTS_DIR, DEBUG_DIR, CHROME_USER_DATA_DIR, FACEBOOK_PROFILE_DIR]) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/exports', express.static(EXPORTS_DIR));

let timings = {};
if (fs.existsSync(TIMINGS_FILE)) {
  timings = JSON.parse(fs.readFileSync(TIMINGS_FILE, 'utf8'));
}

let learnedClickTarget = null;
if (fs.existsSync(LEARNED_CLICK_FILE)) {
  try {
    learnedClickTarget = JSON.parse(fs.readFileSync(LEARNED_CLICK_FILE, 'utf8'));
  } catch (error) {
    learnedClickTarget = null;
  }
}

function saveTimings() {
  fs.writeFileSync(TIMINGS_FILE, JSON.stringify(timings, null, 2));
}

function saveLearnedClickTarget(target) {
  learnedClickTarget = target;
  fs.writeFileSync(LEARNED_CLICK_FILE, JSON.stringify(target, null, 2));
}

function sanitizeSegment(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 40) || 'unknown';
}

function getElapsedSeconds(startedAt) {
  return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
}

function getPublicJob(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    platform: job.platform,
    keyword: job.keyword,
    location: job.location,
    searchDomain: job.searchDomain,
    yelpDomain: job.yelpDomain,
    leadsTotal: job.leadsTotal,
    leadsFiltered: job.leadsFiltered,
    elapsedSeconds: getElapsedSeconds(job.startedAt),
    previewLeads: job.previewLeads,
    filename: job.filename,
    fileUrl: job.fileUrl,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt
  };
}

function broadcastJob(job) {
  const payload = `data: ${JSON.stringify(getPublicJob(job))}\n\n`;
  for (const client of job.clients) {
    client.write(payload);
  }
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  broadcastJob(job);
}

function normalizePlatformInput(rawPlatform, rawDomain = '') {
  const platform = String(rawPlatform || '').trim().toLowerCase();
  const domain = String(rawDomain || '').trim().toLowerCase();

  if (
    platform === 'google_maps' ||
    platform === 'google maps' ||
    platform === 'googlemaps' ||
    platform === 'google' ||
    platform === 'maps'
  ) {
    return 'google_maps';
  }

  if (
    platform === 'facebook_pages' ||
    platform === 'facebook pages' ||
    platform === 'facebook' ||
    platform === 'fb'
  ) {
    return 'facebook_pages';
  }

  if (domain.includes('google.')) {
    return 'google_maps';
  }

  if (domain.includes('facebook.')) {
    return 'facebook_pages';
  }

  return 'yelp';
}

function normalizeSearchDomain(platform, rawDomain) {
  const input = String(rawDomain || '').trim().toLowerCase();

  if (platform === 'google_maps') {
    // Force a single stable host for Maps automation.
    return 'www.google.com';
  }

  if (platform === 'facebook_pages') {
    // Use the logged-in Chrome profile to access Facebook search directly.
    return 'www.facebook.com';
  }

  return input || 'www.yelp.com';
}

function createJob({ keyword, location, platform, searchDomain }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const normalizedPlatform = normalizePlatformInput(platform, searchDomain);
  const normalizedDomain = normalizeSearchDomain(normalizedPlatform, searchDomain);

  const job = {
    id,
    status: 'queued',
    phase: 'Waiting to start',
    progress: 2,
    platform: normalizedPlatform,
    keyword,
    location,
    searchDomain: normalizedDomain,
    yelpDomain: normalizedDomain,
    leadsTotal: 0,
    leadsFiltered: 0,
    previewLeads: [],
    filename: null,
    fileUrl: null,
    error: null,
    clients: new Set(),
    startedAt: Date.now(),
    createdAt: now,
    completedAt: null
  };

  jobs.set(id, job);
  return job;
}

function buildSearchUrl(job) {
  const platform = normalizePlatformInput(job.platform, job.searchDomain);
  const domain = normalizeSearchDomain(platform, job.searchDomain);

  if (platform === 'google_maps') {
    const query = `${job.keyword} ${job.location}`.trim();
    return `https://${domain}/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }

  if (platform === 'facebook_pages') {
    const query = `${job.keyword} ${job.location}`.trim();
    // facebook.com/search/pages/ requires a logged-in session but avoids challenge pages
    return `https://www.facebook.com/search/pages/?q=${encodeURIComponent(query)}`;
  }

  return `https://${domain}/search?find_desc=${encodeURIComponent(job.keyword)}&find_loc=${encodeURIComponent(job.location)}`;
}

function closeJobClients(job) {
  for (const client of job.clients) {
    client.end();
  }
  job.clients.clear();
}

function scheduleJobCleanup(jobId) {
  setTimeout(() => {
    jobs.delete(jobId);
  }, JOB_RETENTION_MS);
}

function clearChromeSingletonLocks(profileDir) {
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  for (const file of lockFiles) {
    const fullPath = path.join(profileDir, file);
    try {
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath, { force: true });
      }
    } catch (_) {
      // ignore lock cleanup errors
    }
  }
}

async function launchBrowserWithTimeout(launchOptions, timeoutMs) {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Chrome launch timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([puppeteer.launch(launchOptions), timeoutPromise]);
}

function isPlatformUrl(url, platform) {
  const u = String(url || '').toLowerCase();
  if (platform === 'google_maps') {
    return u.includes('google.com/maps') || u.includes('maps.google.');
  }
  if (platform === 'facebook_pages') {
    return u.includes('facebook.com/') || u.includes('bing.com/search') || u.includes('google.com/search');
  }
  return u.includes('yelp.');
}

function platformLabel(platform) {
  if (platform === 'google_maps') return 'Google Maps';
  if (platform === 'facebook_pages') return 'Facebook Pages';
  return 'Yelp';
}

async function getOrCreatePlatformLockedPage(browser, platform) {
  const pages = await browser.pages();
  let selected = null;

  // Prefer an already-open tab that matches the requested platform.
  for (const p of pages) {
    try {
      if (isPlatformUrl(p.url(), platform)) {
        selected = p;
        break;
      }
    } catch (_) {
      // ignore
    }
  }

  // Otherwise reuse a blank/new tab if present.
  if (!selected) {
    selected = pages.find((p) => {
      try {
        const u = String(p.url() || '').toLowerCase();
        return !u || u === 'about:blank' || u.includes('newtab');
      } catch (_) {
        return false;
      }
    }) || null;
  }

  if (!selected) {
    selected = await browser.newPage();
  }

  // Keep only the controlled tab to avoid platform drift and wrong-focus clicks.
  for (const p of pages) {
    if (p === selected) {
      continue;
    }
    try {
      await p.close();
    } catch (_) {
      // ignore close race
    }
  }

  await selected.bringToFront();
  return selected;
}

// Read leads from the extension's dashboard page which has real chrome.storage access.
// Falls back to polling browser targets for the dashboard tab.
async function readLeadsFromExtension(browser) {
  try {
    const targets = browser.targets();
    const dashTarget = targets.find(t =>
      t.url().includes('dashboard.html') ||
      (t.type() === 'page' && t.url().includes('chrome-extension://'))
    );
    if (dashTarget) {
      const dashPage = await dashTarget.page();
      if (dashPage) {
        const leads = await dashPage.evaluate(() =>
          new Promise(resolve => {
            chrome.storage.local.get(['leads'], r => resolve(Array.isArray(r.leads) ? r.leads : []));
          })
        ).catch(() => []);
        if (leads.length) {
          console.log(`[leads] Read ${leads.length} leads from extension dashboard page`);
          return leads;
        }
      }
    }
  } catch (e) {
    console.log('[leads] dashboard target read failed:', e.message);
  }
  return [];
}

async function readLeadsFromActiveYelpPage(page) {
  try {
    let bestLeads = [];

    for (const frame of page.frames()) {
      try {
        const leads = await frame.evaluate(() => {
          if (Array.isArray(window.leads)) {
            return window.leads;
          }
          return [];
        });

        if (Array.isArray(leads) && leads.length > bestLeads.length) {
          bestLeads = leads;
        }
      } catch (error) {
        // Some frames cannot be evaluated due to origin restrictions.
      }
    }

    if (bestLeads.length > 0) {
      console.log(`[leads] Read ${bestLeads.length} leads from active page frames`);
      return bestLeads;
    }
  } catch (error) {
    console.log('[leads] active page read failed:', error.message);
  }

  try {
    const leads = await page.evaluate(() => {
      if (Array.isArray(window.leads)) {
        return window.leads;
      }
      return [];
    });

    if (Array.isArray(leads) && leads.length) {
      console.log(`[leads] Read ${leads.length} leads from active page (top window)`);
      return leads;
    }
  } catch (error) {
    console.log('[leads] active page top-window read failed:', error.message);
  }

  return [];
}

async function readLeadsFromDomBridge(page) {
  try {
    let bestLeads = [];

    for (const frame of page.frames()) {
      try {
        const leads = await frame.evaluate(() => {
          const raw = document.documentElement.getAttribute('data-yscraper-live-leads') || '';
          if (!raw) {
            return [];
          }
          try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
          } catch (_) {
            return [];
          }
        });

        if (Array.isArray(leads) && leads.length > bestLeads.length) {
          bestLeads = leads;
        }
      } catch (_) {
        // ignore frame eval errors
      }
    }

    if (bestLeads.length > 0) {
      console.log(`[leads] Read ${bestLeads.length} leads from DOM bridge`);
      return bestLeads;
    }
  } catch (error) {
    console.log('[leads] DOM bridge read failed:', error.message);
  }

  return [];
}

async function readLeadsWithFallback(browser, page) {
  const storageLeads = await readLeadsFromExtension(browser);
  if (storageLeads.length > 0) {
    return storageLeads;
  }

  const domBridgeLeads = await readLeadsFromDomBridge(page);
  if (domBridgeLeads.length > 0) {
    return domBridgeLeads;
  }

  const pageLeads = await readLeadsFromActiveYelpPage(page);
  if (pageLeads.length > 0) {
    return pageLeads;
  }

  return [];
}

function normalizeWebsiteValue(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    return '';
  }

  const lower = value.toLowerCase();
  // Google internal links are not business websites.
  if (
    lower.includes('google.com/maps') ||
    lower.includes('google.com/search') ||
    lower.includes('maps.google.') ||
    lower.includes('maps.app.goo.gl') ||
    lower.includes('goo.gl/maps')
  ) {
    return '';
  }

  return value;
}

function normalizeLead(lead) {
  return {
    name: lead.name || lead.title || '',
    phone: lead.phone || lead.telephone || '',
    email: lead.email || '',
    address: lead.address || lead.location || '',
    category: lead.category || lead.categories || '',
    rating: lead.rating || lead.stars || '',
    reviews: lead.reviews || lead.reviewCount || '',
    website: normalizeWebsiteValue(lead.website || lead.url || ''),
    latitude: lead.latitude || lead.lat || '',
    longitude: lead.longitude || lead.lng || ''
  };
}

function toPreviewRows(leads) {
  // Keep a rolling live window so newly scraped leads keep appearing in UI.
  return leads.slice(-200).reverse().map((lead) => ({
    name: lead.name || '',
    address: lead.address || '',
    phone: lead.phone || '',
    email: lead.email || '',
    website: lead.website || ''
  }));
}

// Legacy shim kept for compatibility — now delegates to extension storage
async function readLeadsFromPage(_page, browser) {
  return readLeadsFromExtension(browser);
}

async function saveDebugScreenshot(page, name) {
  const filePath = path.join(DEBUG_DIR, `${name}_${Date.now()}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function installManualClickRecorder(page) {
  for (const frame of page.frames()) {
    try {
      await frame.evaluate((startText) => {
        if (window.__yscraperManualRecorderInstalled) {
          return;
        }

        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

        const getCssPath = (el) => {
          if (!el || !el.nodeType) {
            return null;
          }
          if (el.id) {
            return `#${el.id}`;
          }
          const path = [];
          let node = el;
          while (node && node.nodeType === 1 && node !== document.body) {
            let selector = node.nodeName.toLowerCase();
            if (node.className && typeof node.className === 'string') {
              const classes = node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2);
              if (classes.length) {
                selector += `.${classes.join('.')}`;
              }
            }
            const parent = node.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter((child) => child.nodeName === node.nodeName);
              if (siblings.length > 1) {
                selector += `:nth-of-type(${siblings.indexOf(node) + 1})`;
              }
            }
            path.unshift(selector);
            node = node.parentElement;
          }
          return path.join(' > ');
        };

        document.addEventListener('click', (event) => {
          if (!event || !event.isTrusted) {
            return;
          }
          const el = event.target;
          if (!el) {
            return;
          }
          const text = normalize(el.innerText || el.textContent || '');
          const id = String(el.id || '').toLowerCase();
          const isStartButton = id === 'extension_gms_start_btn' || text.includes(startText);
          if (!isStartButton) {
            return;
          }

          const rect = el.getBoundingClientRect();
          window.__yscraperLastManualStartClick = {
            id: el.id || '',
            className: String(el.className || ''),
            text: (el.innerText || el.textContent || '').trim(),
            selector: getCssPath(el),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            timestamp: Date.now()
          };
        }, true);

        window.__yscraperManualRecorderInstalled = true;
      }, START_BUTTON_TEXT);
    } catch (error) {
      // Some frames may not allow script execution.
    }
  }
}

async function getManualRecordedClick(page) {
  for (const [frameIndex, frame] of page.frames().entries()) {
    try {
      const info = await frame.evaluate(() => window.__yscraperLastManualStartClick || null);
      if (info) {
        return {
          frameIndex,
          frameUrl: frame.url(),
          ...info
        };
      }
    } catch (error) {
      // Try next frame.
    }
  }
  return null;
}

async function waitForManualTrainingClick(page, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const clickInfo = await getManualRecordedClick(page);
    if (clickInfo) {
      return clickInfo;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function findStartButtonMeta(page) {
  const frames = page.frames();
  for (const [frameIndex, frame] of frames.entries()) {
    try {
      const result = await frame.evaluate((selector, startText) => {
        const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();

        const isTarget = (el) => {
          if (!el) {
            return false;
          }
          if (el.id === 'extension_gms_start_btn') {
            return true;
          }
          const text = normalize(el.innerText || el.textContent || '');
          return text.includes(startText);
        };

        const queue = [document.documentElement || document.body || document];
        const seen = new Set();

        while (queue.length) {
          const root = queue.shift();
          if (!root || seen.has(root)) {
            continue;
          }
          seen.add(root);

          const direct = root.querySelector ? root.querySelector(selector) : null;
          if (isTarget(direct)) {
            const rect = direct.getBoundingClientRect();
            return {
              found: true,
              text: (direct.innerText || direct.textContent || '').trim(),
              id: direct.id || '',
              className: String(direct.className || ''),
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            };
          }

          const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (const node of nodes) {
            if (isTarget(node)) {
              const rect = node.getBoundingClientRect();
              return {
                found: true,
                text: (node.innerText || node.textContent || '').trim(),
                id: node.id || '',
                className: String(node.className || ''),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              };
            }
            if (node.shadowRoot) {
              queue.push(node.shadowRoot);
            }
          }

          if (root.shadowRoot) {
            queue.push(root.shadowRoot);
          }
        }

        return { found: false };
      }, START_BUTTON_SELECTOR, START_BUTTON_TEXT);

      if (result && result.found) {
        return {
          found: true,
          frameIndex,
          frameUrl: frame.url(),
          ...result
        };
      }
    } catch (error) {
      // Continue scanning frames.
    }
  }

  return { found: false };
}

async function getFrameViewportOffset(frame) {
  let offsetX = 0;
  let offsetY = 0;
  let currentFrame = frame;

  while (currentFrame.parentFrame()) {
    const frameElement = await currentFrame.frameElement();
    const rect = await frameElement.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
    offsetX += rect.x;
    offsetY += rect.y;
    currentFrame = currentFrame.parentFrame();
  }

  return { x: offsetX, y: offsetY };
}

async function listButtonCandidates(page) {
  const candidates = [];

  for (const [frameIndex, frame] of page.frames().entries()) {
    try {
      const frameButtons = await frame.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('button, [role="button"]'));
        return nodes
          .map((el, idx) => {
            const rect = el.getBoundingClientRect();
            const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            const style = window.getComputedStyle(el);
            const visible =
              rect.width > 0 &&
              rect.height > 0 &&
              style &&
              style.visibility !== 'hidden' &&
              style.display !== 'none';

            return {
              indexInFrame: idx,
              text,
              id: el.id || '',
              className: String(el.className || ''),
              visible,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            };
          })
          .filter((item) => item.visible && item.text);
      });

      for (const item of frameButtons) {
        candidates.push({
          frameIndex,
          frameUrl: frame.url(),
          ...item
        });
      }
    } catch (error) {
      // Ignore inaccessible frames.
    }
  }

  return candidates.map((candidate, idx) => ({
    ...candidate,
    buttonNumber: idx + 1
  }));
}

async function clickCandidateByNumber(page, buttonNumber) {
  const number = Number(buttonNumber);
  if (!Number.isInteger(number) || number < 1) {
    return { clicked: false, reason: 'invalid-button-number' };
  }

  const candidates = await listButtonCandidates(page);
  const candidate = candidates[number - 1];
  if (!candidate) {
    return { clicked: false, reason: 'button-number-not-found' };
  }

  const frame = page.frames()[candidate.frameIndex];
  if (!frame || !candidate.rect || candidate.rect.width <= 0 || candidate.rect.height <= 0) {
    return { clicked: false, reason: 'invalid-candidate-rect' };
  }

  let clickX = candidate.rect.x + candidate.rect.width / 2;
  let clickY = candidate.rect.y + candidate.rect.height / 2;

  if (frame !== page.mainFrame()) {
    const offset = await getFrameViewportOffset(frame);
    clickX += offset.x;
    clickY += offset.y;
  }

  clickX = Math.max(1, Math.round(clickX));
  clickY = Math.max(1, Math.round(clickY));

  await page.bringToFront();
  await page.mouse.move(clickX, clickY, { steps: 8 });
  await page.mouse.click(clickX, clickY, { delay: 80 });

  return {
    clicked: true,
    method: 'learned-button-number',
    buttonNumber: candidate.buttonNumber,
    frameIndex: candidate.frameIndex,
    frameUrl: candidate.frameUrl,
    text: candidate.text,
    id: candidate.id,
    className: candidate.className,
    clickX,
    clickY
  };
}

async function clickStartButtonOnce(page) {
  return clickByLiveCoords(page, START_BUTTON_SELECTOR.replace('#', ''), START_BUTTON_TEXT);
}

async function clickExportButtonOnce(page) {
  return clickByLiveCoords(page, 'extension_gms_download_btn', 'export results');
}

async function clickByLiveCoords(page, id, fallbackText) {
  console.log(`[click] Searching for button id="${id}" text="${fallbackText}" across ${page.frames().length} frame(s)`);

  for (const frame of page.frames()) {
    try {
      // First try: get ElementHandle and call .click() directly — most reliable
      let handle = await frame.$(`#${id}`).catch(() => null);

      if (!handle) {
        // Fallback: find by text
        const handles = await frame.$$('button, [role="button"]');
        for (const h of handles) {
          const txt = await h.evaluate(el => (el.innerText || el.textContent || '').toLowerCase().trim());
          if (txt.includes(fallbackText.toLowerCase())) {
            handle = h;
            break;
          }
        }
      }

      if (handle) {
        const box = await handle.boundingBox();
        if (!box || box.width === 0) {
          console.log('[click] Found handle but zero bounding box, skipping frame');
          continue;
        }
        console.log(`[click] Found button at x=${Math.round(box.x + box.width/2)} y=${Math.round(box.y + box.height/2)} in frame: ${frame.url().slice(0,60)}`);
        await page.bringToFront();
        // Use ElementHandle.click() — Puppeteer scrolls to it and clicks the center
        await handle.click({ delay: 150 });
        console.log('[click] ElementHandle.click() sent successfully');
        return { clicked: true, method: 'element-handle', frameUrl: frame.url() };
      }
    } catch (err) {
      console.log(`[click] Frame error: ${err.message}`);
    }
  }

  console.log('[click] Button not found in any frame');
  return { clicked: false, reason: 'element-not-found-in-any-frame' };
}

async function clickLearnedTargetOnce(page, target) {
  // Always use live bounding rect — saved coords break if window size changes.
  // We use the saved id/text as the search key, not the saved x/y.
  const id   = (target && target.id)   || START_BUTTON_SELECTOR.replace('#', '');
  const text = (target && target.text) || START_BUTTON_TEXT;
  return clickByLiveCoords(page, id, text);

  if (target && target.type === 'button-number') {
    return clickCandidateByNumber(page, target.buttonNumber);
  }

  if (!target || (!target.selector && !target.id && !target.text)) {
    return { clicked: false, reason: 'no-target' };
  }

  const frames = page.frames();
  for (const [frameIndex, frame] of frames.entries()) {
    try {
      const found = await frame.evaluate((saved, startText) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

        const isCandidate = (el) => {
          if (!el) {
            return false;
          }
          if (saved.id && el.id === saved.id) {
            return true;
          }
          if (saved.selector && el.matches && el.matches(saved.selector)) {
            return true;
          }
          const text = normalize(el.innerText || el.textContent || '');
          if (saved.text && text === normalize(saved.text)) {
            return true;
          }
          return text.includes(startText);
        };

        const scan = document.querySelectorAll('*');
        for (const el of scan) {
          if (isCandidate(el)) {
            const rect = el.getBoundingClientRect();
            return {
              found: true,
              text: (el.innerText || el.textContent || '').trim(),
              id: el.id || '',
              className: String(el.className || ''),
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            };
          }
        }

        return { found: false };
      }, target, START_BUTTON_TEXT);

      if (!found || !found.found || !found.rect || found.rect.width <= 0 || found.rect.height <= 0) {
        continue;
      }

      let clickX = found.rect.x + found.rect.width / 2;
      let clickY = found.rect.y + found.rect.height / 2;

      if (frame !== page.mainFrame()) {
        const offset = await getFrameViewportOffset(frame);
        clickX += offset.x;
        clickY += offset.y;
      }

      clickX = Math.max(1, Math.round(clickX));
      clickY = Math.max(1, Math.round(clickY));

      await page.bringToFront();
      await page.mouse.move(clickX, clickY, { steps: 8 });
      await page.mouse.click(clickX, clickY, { delay: 80 });

      return {
        clicked: true,
        method: 'learned-target',
        frameIndex,
        frameUrl: frame.url(),
        clickX,
        clickY,
        text: found.text,
        id: found.id,
        className: found.className,
        rect: found.rect
      };
    } catch (error) {
      // Continue scanning frames.
    }
  }

  return { clicked: false, reason: 'learned-target-not-found' };
}

async function getStartButtonText(page) {
  const meta = await findStartButtonMeta(page);
  return meta.found ? meta.text : null;
}

async function waitForStartButton(page, maxWaitMs) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const detection = await findStartButtonMeta(page);
    if (detection.found) {
      return detection;
    }
    await page.waitForTimeout(1000);
  }
  return { found: false };
}

async function getFacebookDiscoveryState(page) {
  return page.evaluate(() => {
    const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const url = String(window.location.href || '').toLowerCase();
    const resultLinks = Array.from(document.querySelectorAll('#b_results .b_algo h2 a[href], #search a h3')).filter(Boolean);
    const verificationPattern = /verify|verification|human|robot|captcha|security check|unusual traffic|one last step/i;
    const noResultsPattern = /there are no results for|no results found|did not match any documents/i;
    const notFoundPattern = /not found/i;

    if (url.includes('bing.com/search')) {
      if (resultLinks.length > 0) {
        return { kind: 'ready', resultCount: resultLinks.length, message: '' };
      }
      if (verificationPattern.test(bodyText)) {
        return { kind: 'challenge', resultCount: 0, message: 'Bing verification required' };
      }
      if (noResultsPattern.test(bodyText)) {
        return { kind: 'no-results', resultCount: 0, message: 'No search results found' };
      }
      return { kind: 'loading', resultCount: 0, message: 'Waiting for Bing results' };
    }

    if (url.includes('google.') && url.includes('/search')) {
      if (resultLinks.length > 0) {
        return { kind: 'ready', resultCount: resultLinks.length, message: '' };
      }
      if (verificationPattern.test(bodyText)) {
        return { kind: 'challenge', resultCount: 0, message: 'Google verification required' };
      }
      if (noResultsPattern.test(bodyText)) {
        return { kind: 'no-results', resultCount: 0, message: 'No search results found' };
      }
      return { kind: 'loading', resultCount: 0, message: 'Waiting for Google results' };
    }

    if (url.includes('facebook.com/')) {
      // Login redirect means the Chrome profile is not logged into Facebook
      if (url.includes('/login') || url.includes('login.php')) {
        return { kind: 'blocked', resultCount: 0, message: 'Facebook requires login. Do one run, log in manually in the opened browser, close it, then retry. Cookies will be reused from the persistent Facebook profile.' };
      }
      if (notFoundPattern.test(bodyText)) {
        return { kind: 'blocked', resultCount: 0, message: 'Facebook returned Not Found' };
      }
      // Look for page card links in the results — indicates results have rendered
      const fbPageLinks = Array.from(document.querySelectorAll('a[href]')).filter(a => {
        const href = String(a.getAttribute('href') || '');
        return /^https?:\/\/(?:www\.)?facebook\.com\/(?!login|search|events|groups|marketplace|friends|watch|reel|story\.php|hashtag|ads|help|settings|privacy|terms|pages\/create)([^/?#]{2,})/i.test(href);
      });
      if (fbPageLinks.length >= 3) {
        return { kind: 'ready', resultCount: fbPageLinks.length, message: '' };
      }
      // React app still rendering
      return { kind: 'loading', resultCount: 0, message: 'Waiting for Facebook search results to render' };
    }

    return { kind: 'ready', resultCount: 0, message: '' };
  });
}

async function waitForFacebookDiscoveryReady(page, job, maxWaitMs) {
  const start = Date.now();
  let lastPhase = '';

  while (Date.now() - start < maxWaitMs) {
    const state = await getFacebookDiscoveryState(page);

    if (state.kind === 'ready' || state.kind === 'no-results') {
      return state;
    }

    if (state.kind === 'blocked') {
      throw new Error(state.message || 'Facebook discovery page is blocked');
    }

    const phase = state.kind === 'challenge'
      ? `Waiting for ${state.message || 'search engine verification'} to clear, then results will continue automatically`
      : 'Waiting for search results to render before extraction starts';

    if (phase !== lastPhase) {
      updateJob(job, {
        phase,
        progress: 27
      });
      console.log(`[nav] Facebook discovery state: ${state.kind}${state.message ? ` (${state.message})` : ''}`);
      lastPhase = phase;
    }

    await page.waitForTimeout(1500);
  }

  throw new Error('Timed out waiting for Facebook discovery results after verification');
}

async function extractFacebookDiscoveryLeads(page) {
  const leads = await page.evaluate(() => {
    const host = String(window.location.hostname || '').toLowerCase();

    const decodeBingTargetUrl = (rawHref) => {
      try {
        const u = new URL(String(rawHref || ''), window.location.origin);
        if (!String(u.hostname || '').toLowerCase().includes('bing.com')) {
          return String(rawHref || '');
        }
        const candidate = u.searchParams.get('u') || u.searchParams.get('url') || '';
        if (!candidate) return String(rawHref || '');
        const decodedCandidate = decodeURIComponent(candidate);
        return /^https?:\/\//i.test(decodedCandidate) ? decodedCandidate : String(rawHref || '');
      } catch (_) {
        return String(rawHref || '');
      }
    };

    const decodeGoogleTargetUrl = (rawHref) => {
      try {
        const u = new URL(String(rawHref || ''), window.location.origin);
        if (!String(u.hostname || '').toLowerCase().includes('google.')) {
          return String(rawHref || '');
        }
        if (u.pathname === '/url') {
          const q = u.searchParams.get('q') || u.searchParams.get('url') || '';
          if (q && /^https?:\/\//i.test(q)) {
            return q;
          }
        }
        return String(rawHref || '');
      } catch (_) {
        return String(rawHref || '');
      }
    };

    const decodeSearchTargetUrl = (rawHref) => decodeBingTargetUrl(decodeGoogleTargetUrl(rawHref));

    const normalizeFbUrl = (href) => {
      try {
        const resolved = decodeSearchTargetUrl(href);
        const u = new URL(String(resolved || ''), window.location.origin);
        u.hash = '';
        const path = String(u.pathname || '').toLowerCase();
        if (!path || path === '/') return '';
        if (
          path.startsWith('/login') ||
          path.startsWith('/watch') ||
          path.startsWith('/search') ||
          path.startsWith('/friends') ||
          path.startsWith('/marketplace') ||
          path.startsWith('/groups') ||
          path.startsWith('/events') ||
          path.startsWith('/messages') ||
          path.startsWith('/story.php') ||
          path.startsWith('/reel') ||
          path.startsWith('/hashtag') ||
          path.startsWith('/share') ||
          path.startsWith('/photo') ||
          path.startsWith('/videos')
        ) {
          return '';
        }
        if (path === '/profile.php') {
          const id = u.searchParams.get('id');
          if (!id) return '';
          u.search = `?id=${id}`;
        } else {
          u.search = '';
        }
        const normalized = u.toString();
        return /facebook\.com\/(pages|profile\.php|[^/?#]+)/i.test(normalized) ? normalized : '';
      } catch (_) {
        return '';
      }
    };

    const extractEmailFromText = (text) => {
      const m = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      return m ? m[0] : '';
    };

    const extractPhoneFromText = (text) => {
      const m = String(text || '').match(/\+?\d[\d\s().-]{7,}/);
      return m ? m[0].trim() : '';
    };

    // ── Facebook direct search (logged-in session) ───────────────────────────
    if (host.includes('facebook.com')) {
      const out = [];
      const seen = new Set();

      // Try article-based cards first (most structured)
      const mainEl = document.querySelector('[data-pagelet="SearchResults0"]') ||
        document.querySelector('div[role="main"]') ||
        document.body;

      const articles = Array.from(mainEl.querySelectorAll('div[role="article"]'));

      for (const article of articles) {
        const links = Array.from(article.querySelectorAll('a[href]'));
        for (const anchor of links) {
          const href = String(anchor.href || '');
          if (!/facebook\.com\/(pages\/[^/?#]+|(?!login|search|events|groups|marketplace|friends|watch|reel|story\.php|hashtag|ads|help|settings|privacy|terms|pages\/create)([^/?#]{2,}))/i.test(href)) continue;

          let cleanUrl;
          try {
            const u = new URL(href);
            u.hash = '';
            u.search = '';
            cleanUrl = u.toString();
          } catch (_) { continue; }

          if (seen.has(cleanUrl)) continue;
          seen.add(cleanUrl);

          const heading = article.querySelector('h2, h3, h4');
          const name = String((heading && heading.textContent) || anchor.getAttribute('aria-label') || anchor.title || anchor.textContent || '').replace(/\s+/g, ' ').trim();
          if (!name || name.length < 2) continue;

          const cardText = String(article.textContent || '').replace(/\s+/g, ' ').trim();
          out.push({
            bizId: cleanUrl,
            name,
            address: '',
            phone: extractPhoneFromText(cardText),
            email: extractEmailFromText(cardText),
            website: '',
            category: '',
            rating: '',
            reviews: '',
            businessUrl: cleanUrl
          });
          break; // one lead per article card
        }
      }

      // Fallback: broad link scan if article cards gave nothing
      if (out.length === 0) {
        const allLinks = Array.from(mainEl.querySelectorAll('a[href]'));
        const navPattern = /^(home|messenger|notifications?|watch|marketplace|groups|gaming|menu|more|create|ads|pages|events|friends|feed|news|search|log ?in|log ?out|sign ?up|help|settings|privacy|terms)$/i;
        for (const anchor of allLinks) {
          const href = String(anchor.href || '');
          if (!/facebook\.com\/(pages\/[^/?#]+|(?!login|search|events|groups|marketplace|friends|watch|reel|story\.php|hashtag|ads|help|settings|privacy|terms|pages\/create)([^/?#]{3,}))/i.test(href)) continue;

          let cleanUrl;
          try {
            const u = new URL(href);
            u.hash = '';
            u.search = '';
            cleanUrl = u.toString();
          } catch (_) { continue; }

          if (seen.has(cleanUrl)) continue;
          seen.add(cleanUrl);

          const name = (anchor.getAttribute('aria-label') || anchor.title || anchor.textContent || '').replace(/\s+/g, ' ').trim();
          if (!name || name.length < 2 || name.length > 120 || navPattern.test(name)) continue;

          const card = anchor.closest('div[role="article"]') || anchor.closest('[data-pagelet]') || anchor.parentElement;
          const cardText = card ? String(card.textContent || '').replace(/\s+/g, ' ').trim() : '';
          out.push({
            bizId: cleanUrl,
            name,
            address: '',
            phone: extractPhoneFromText(cardText),
            email: extractEmailFromText(cardText),
            website: '',
            category: '',
            rating: '',
            reviews: '',
            businessUrl: cleanUrl
          });
        }
      }

      return out;
    }

    // ── Google / Bing search results (fallback if ever redirected there) ──────
    const cards = host.includes('google.')
      ? Array.from(document.querySelectorAll('#search .g, #search div[data-sokoban-container]'))
      : host.includes('bing.com')
      ? Array.from(document.querySelectorAll('#b_results li.b_algo'))
      : [];

    const out = [];
    const seen = new Set();

    for (const card of cards) {
      const heading = card.querySelector('h3, h2');
      const anchor = (heading && heading.closest('a[href]')) || card.querySelector('a[href]');
      const href = String((anchor && (anchor.href || anchor.getAttribute('href'))) || '');

      let url = normalizeFbUrl(href);
      if (!url) {
        const textMatch = String(card.textContent || '').match(/https?:\/\/(?:www\.)?facebook\.com\/[\w\-./?=&%#]+/i);
        if (textMatch && textMatch[0]) {
          url = normalizeFbUrl(textMatch[0]);
        }
      }

      if (!url || seen.has(url)) continue;

      const name = String((heading && heading.textContent) || (anchor && anchor.textContent) || '').replace(/\s+/g, ' ').trim();
      if (!name) continue;

      seen.add(url);
      const cardText = String(card.textContent || '').replace(/\s+/g, ' ').trim();
      out.push({
        bizId: url,
        name,
        address: '',
        phone: extractPhoneFromText(cardText),
        email: extractEmailFromText(cardText),
        website: '',
        category: '',
        rating: '',
        reviews: '',
        businessUrl: url
      });
    }

    return out;
  });

  console.log(`[facebook] Direct search-page extraction found ${Array.isArray(leads) ? leads.length : 0} leads`);
  return Array.isArray(leads) ? leads : [];
}

async function runScrapeJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  const key = `${job.platform}|${job.searchDomain}|${job.keyword}|${job.location}`;
  // Keep Yelp on a long-lived profile.
  // Use a fresh per-job profile only for Google Maps to avoid webhp/session-restore issues.
  // Use a dedicated persistent profile for Facebook so manual login cookies persist across runs.
  const primaryProfileDir = (job.platform === 'google_maps' || job.platform === 'yelp')
    ? path.join(CHROME_USER_DATA_DIR, 'sessions', job.id)
    : job.platform === 'facebook_pages'
    ? FACEBOOK_PROFILE_DIR
    : CHROME_USER_DATA_DIR;
  if (job.platform === 'google_maps' || job.platform === 'yelp') {
    fs.mkdirSync(primaryProfileDir, { recursive: true });
  }
  const yelpFallbackProfileDir = path.join(CHROME_USER_DATA_DIR, 'yelp-fallback', job.id);
  const launchProfileCandidates = (job.platform === 'google_maps' || job.platform === 'yelp')
    ? [primaryProfileDir]
    : job.platform === 'facebook_pages'
    ? [primaryProfileDir]
    : [primaryProfileDir, yelpFallbackProfileDir];
  let browser;

  try {
    updateJob(job, {
      status: 'running',
      phase: 'Launching Chrome with extension',
      progress: 10
    });

    const customProxyExtPath = path.join(__dirname, 'CustomProxyExtension');
    const launchArgs = [
      `--load-extension=${EXTENSION_PATH},${customProxyExtPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check'
    ];

    let launchError = null;
    for (const profileDir of launchProfileCandidates) {
      try {
        fs.mkdirSync(profileDir, { recursive: true });
        clearChromeSingletonLocks(profileDir);
        console.log(`[launch] Trying Chrome profile: ${profileDir}`);
        browser = await launchBrowserWithTimeout({
          executablePath: CHROME_EXECUTABLE_PATH,
          headless: false,
          userDataDir: profileDir,
          ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
          args: launchArgs,
          defaultViewport: null
        }, BROWSER_LAUNCH_TIMEOUT_MS);
        launchError = null;
        break;
      } catch (err) {
        launchError = err;
        console.warn(`[launch] Failed with profile ${profileDir}: ${err.message}`);
      }
    }

    if (!browser) {
      throw launchError || new Error('Unable to launch Chrome with extension');
    }

    // Always use a single platform-locked controlled tab.
    const page = await getOrCreatePlatformLockedPage(browser, job.platform);
    console.log('[launch] Waiting 8 seconds for extension and proxy to initialize...');
    await page.waitForTimeout(8000);

    const searchUrl = buildSearchUrl(job);
    const label = platformLabel(job.platform);

    updateJob(job, {
      phase: `Opening ${label} search results`,
      progress: 20
    });

    if (job.platform === 'google_maps') {
      const searchQuery = `${job.keyword} ${job.location}`.trim();
      const mapsSearchUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchQuery)}`;

      console.log(`[nav] Google Maps canonical search URL: ${mapsSearchUrl}`);

      let mapsOpened = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await page.goto(mapsSearchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
          console.log(`[nav] Maps search attempt ${attempt} timed out (${e.message})`);
        }

        await page.waitForTimeout(2500);
        const current = page.url();
        console.log(`[nav] URL after maps attempt ${attempt}: ${current}`);

        if (current.includes('/maps')) {
          mapsOpened = true;
          break;
        }
      }

      if (!mapsOpened) {
        throw new Error(`Google Maps did not open correctly. Final URL: ${page.url()}`);
      }

      // Wait for result feed or place panel to render before looking for extension controls.
      try {
        await page.waitForFunction(
          () => {
            return !!(
              document.querySelector('div[role="feed"]') ||
              document.querySelector('a[href*="/maps/place/"]') ||
              window.location.href.includes('/maps/place')
            );
          },
          { timeout: 25000 }
        );
      } catch (e) {
        console.log(`[nav] Maps results UI wait timed out (${e.message})`);
      }
    } else {
      console.log(`[nav] Navigating to: ${searchUrl}`);
      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (e) {
        console.log(`[nav] domcontentloaded timed out (${e.message}) — continuing anyway`);
      }
    }
    console.log('[nav] Page loaded');

    updateJob(job, {
      phase: `Waiting for ${label} and extension UI to settle`,
      progress: 25
    });
    // Allow 10 seconds for the extension and proxy tunnel to settle
    const settleMs = 10000;
    await page.waitForTimeout(settleMs);

    // Always save a diagnostic screenshot after page load so we can see what Yelp/Maps actually rendered
    await saveDebugScreenshot(page, 'page_after_load');

    if (job.platform === 'facebook_pages') {
      await waitForFacebookDiscoveryReady(page, job, 180000);

      updateJob(job, {
        phase: 'Extracting Facebook page links from search results',
        progress: 40
      });

      const directLeads = (await extractFacebookDiscoveryLeads(page)).map(normalizeLead);
      const noWebsiteLeads = directLeads.filter((lead) => !lead.website || !String(lead.website).trim());

      updateJob(job, {
        phase: 'Finalizing and filtering no-website leads',
        progress: 94,
        leadsTotal: directLeads.length,
        leadsFiltered: noWebsiteLeads.length,
        previewLeads: toPreviewRows(directLeads)
      });

      await browser.close();
      browser = null;

      const filename = `leads_${sanitizeSegment(job.keyword)}_${sanitizeSegment(job.location)}_${Date.now()}.xlsx`;
      const filepath = path.join(EXPORTS_DIR, filename);
      generateExcelFile(noWebsiteLeads, filepath);

      const elapsedSeconds = getElapsedSeconds(job.startedAt);
      if (!timings[key]) {
        timings[key] = { times: [], lastRun: new Date().toISOString() };
      }
      timings[key].times.push(elapsedSeconds);
      timings[key].lastRun = new Date().toISOString();
      saveTimings();

      updateJob(job, {
        status: 'completed',
        phase: 'Completed',
        progress: 100,
        leadsTotal: directLeads.length,
        leadsFiltered: noWebsiteLeads.length,
        previewLeads: toPreviewRows(directLeads),
        filename,
        fileUrl: `/exports/${filename}`,
        completedAt: new Date().toISOString()
      });

      return;
    }

    await installManualClickRecorder(page);

    updateJob(job, {
      phase: 'Detecting Start Auto Extract button',
      progress: 30
    });

    let clickInfo = { clicked: false, method: null };
    const useLearnedClick = job.platform === 'google_maps';

    if (useLearnedClick && learnedClickTarget) {
      updateJob(job, {
        phase: 'Trying learned click target from previous manual training',
        progress: 31
      });
      clickInfo = await clickLearnedTargetOnce(page, learnedClickTarget);
    }

    if (!clickInfo.clicked) {
      const startButton = await waitForStartButton(page, 30000);
      if (startButton.found) {
        clickInfo = await clickStartButtonOnce(page);
      }
    }

    if (!clickInfo.clicked && useLearnedClick) {
      updateJob(job, {
        phase: 'Auto click failed. Click Start Auto Extract once manually to train (45s timeout)',
        progress: 33
      });

      const manualClick = await waitForManualTrainingClick(page, MANUAL_TRAIN_TIMEOUT_MS);
      if (manualClick) {
        saveLearnedClickTarget({
          selector: manualClick.selector || null,
          id: manualClick.id || null,
          text: manualClick.text || null,
          className: manualClick.className || null
        });
        clickInfo = {
          clicked: true,
          method: 'manual-trained',
          frameUrl: manualClick.frameUrl,
          text: manualClick.text,
          id: manualClick.id
        };
      }
    }

    if (!clickInfo.clicked) {
      const screenshotPath = await saveDebugScreenshot(page, 'start_button_click_failed');
      throw new Error(`Start Auto Extract button click failed. Debug screenshot: ${screenshotPath}`);
    }

    console.log(
      `Triggered Start Auto Extract via ${clickInfo.method || 'unknown'} in frame: ${clickInfo.frameUrl || 'unknown'}`
    );

    updateJob(job, {
      phase: 'Start button clicked — waiting for extraction to begin',
      progress: 34
    });

    // ── Auto-dismiss any dialogs the extension fires ──────────────────────────
    let completionDialogSeen = false;
    let completionDialogMessage = '';
    page.on('dialog', async (dialog) => {
      completionDialogSeen = true;
      completionDialogMessage = String(dialog.message() || '');
      console.log(`[dialog] auto-dismissed: "${completionDialogMessage}"`);
      await dialog.accept();
    });

    // ── Wait until the extension's Start button text changes (extraction began) ─
    let extractionStarted = false;
    for (let i = 0; i < 12; i += 1) {
      await page.waitForTimeout(1000);
      const text = normalizeText(await getStartButtonText(page));
      if (text && !text.includes(START_BUTTON_TEXT)) {
        extractionStarted = true;
        break;
      }
    }
    if (!extractionStarted) {
      console.warn('[scrape] Button text never changed; monitoring completion by button reset.');
    }

    updateJob(job, {
      phase: 'Scraping in progress (live leads syncing)',
      progress: 40
    });

    const MAX_SCRAPE_MS = 15 * 60 * 1000;
    const scrapeStart = Date.now();
    let completionDetected = false;
    let stableResetChecks = 0;
    let lastLiveSignature = '';
    let loopCount = 0;

    while (!completionDetected) {
      await page.waitForTimeout(1500);
      loopCount += 1;

      {
        const liveRawLeads = await readLeadsWithFallback(browser, page);
        const liveNormLeads = liveRawLeads.map(normalizeLead);
        const liveNoWebsiteLeads = liveNormLeads.filter((lead) => !lead.website || !String(lead.website).trim());
        const signature = `${liveNormLeads.length}:${liveNoWebsiteLeads.length}`;

        if (signature !== lastLiveSignature || loopCount % 4 === 0) {
          const progressDuringScrape = Math.min(88, 40 + Math.floor((Date.now() - scrapeStart) / 15000));

          updateJob(job, {
            phase: 'Scraping in progress (live leads syncing)',
            progress: progressDuringScrape,
            leadsTotal: liveNormLeads.length,
            leadsFiltered: liveNoWebsiteLeads.length,
            previewLeads: toPreviewRows(liveNormLeads)
          });

          lastLiveSignature = signature;
        }
      }

      if (completionDialogSeen) {
        completionDetected = true;
        console.log(`[scrape] Completion dialog detected: "${completionDialogMessage}"`);
        break;
      }

      const btnText = normalizeText(await getStartButtonText(page));
      if (btnText && btnText.includes(START_BUTTON_TEXT)) {
        stableResetChecks += 1;
      } else {
        stableResetChecks = 0;
      }

      if (stableResetChecks >= 3) {
        completionDetected = true;
        console.log('[scrape] Start button reset detected consistently; scrape completed.');
        break;
      }

      if (Date.now() - scrapeStart > MAX_SCRAPE_MS) {
        console.warn('[scrape] 15-minute hard cap reached while waiting for completion.');
        break;
      }
    }

    updateJob(job, {
      phase: 'Scrape complete; clicking Export Results in extension',
      progress: 90
    });

    const exportClickInfo = await clickExportButtonOnce(page);
    if (!exportClickInfo.clicked) {
      const screenshotPath = await saveDebugScreenshot(page, 'export_button_click_failed');
      throw new Error(`Export Results click failed. Debug screenshot: ${screenshotPath}`);
    }

    let dashboardOpened = false;
    for (let i = 0; i < 12; i += 1) {
      const dashTarget = browser.targets().find((t) => t.url().includes('dashboard.html'));
      if (dashTarget) {
        dashboardOpened = true;
        console.log('[scrape] Extension dashboard tab opened.');
        break;
      }
      await page.waitForTimeout(1000);
    }

    if (!dashboardOpened) {
      console.warn('[scrape] Dashboard tab not detected after export click; trying storage read anyway.');
    }

    updateJob(job, {
      phase: 'Finalizing and filtering no-website leads',
      progress: 94
    });

    const leads = await readLeadsWithFallback(browser, page);
    console.log(`[scrape] Final lead count: ${leads.length}`);
    if (leads.length > 0) console.log('[scrape] Sample lead keys:', Object.keys(leads[0]).join(', '));

    // Normalise field names — extension may use different keys
    const normLeads = leads.map(normalizeLead);

    const noWebsiteLeads = normLeads.filter(l => !l.website || !String(l.website).trim());

    await browser.close();
    browser = null;

    const filename = `leads_${sanitizeSegment(job.keyword)}_${sanitizeSegment(job.location)}_${Date.now()}.xlsx`;
    const filepath = path.join(EXPORTS_DIR, filename);

    generateExcelFile(noWebsiteLeads, filepath);

    const elapsedSeconds = getElapsedSeconds(job.startedAt);
    if (!timings[key]) {
      timings[key] = { times: [], lastRun: new Date().toISOString() };
    }
    timings[key].times.push(elapsedSeconds);
    timings[key].lastRun = new Date().toISOString();
    saveTimings();

    updateJob(job, {
      status: 'completed',
      phase: 'Completed',
      progress: 100,
      leadsTotal: normLeads.length,
      leadsFiltered: noWebsiteLeads.length,
      previewLeads: toPreviewRows(normLeads),
      filename,
      fileUrl: `/exports/${filename}`,
      completedAt: new Date().toISOString()
    });
  } catch (error) {
    if (browser) {
      const keepOpenOnFail = process.env.KEEP_BROWSER_OPEN_ON_FAIL !== '0';
      if (job.platform === 'google_maps' && keepOpenOnFail) {
        console.warn('[scrape] Google Maps job failed; keeping browser open for 90s for debugging.');
        setTimeout(async () => {
          try {
            await browser.close();
          } catch (_) {
            // ignore
          }
        }, 90_000);
      } else {
        await browser.close();
      }
    }

    updateJob(job, {
      status: 'failed',
      phase: 'Failed',
      progress: 100,
      error: error.message,
      completedAt: new Date().toISOString()
    });
  } finally {
    closeJobClients(job);
    scheduleJobCleanup(jobId);
  }
}

app.get('/api/estimate', (req, res) => {
  const { keyword, location, platform, domain } = req.query;
  const normalizedPlatform = normalizePlatformInput(platform, domain);
  const normalizedDomain = normalizeSearchDomain(normalizedPlatform, domain);
  const key = `${normalizedPlatform}|${normalizedDomain}|${keyword}|${location}`;

  if (timings[key]) {
    const avg = timings[key].times.reduce((a, b) => a + b, 0) / timings[key].times.length;
    res.json({
      estimatedSeconds: Math.round(avg),
      runsCount: timings[key].times.length,
      lastRun: timings[key].lastRun
    });
    return;
  }

  res.json({ estimatedSeconds: null, runsCount: 0 });
});

app.post('/api/scrape', (req, res) => {
  const { keyword, location, yelp_domain, search_domain, platform } = req.body;

  if (!keyword || !location) {
    res.status(400).json({ error: 'Keyword and location required' });
    return;
  }

  if (!fs.existsSync(EXTENSION_PATH)) {
    res.status(400).json({ error: `Extension path not found: ${EXTENSION_PATH}` });
    return;
  }

  const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    res.status(400).json({ error: `manifest.json not found in extension path: ${EXTENSION_PATH}` });
    return;
  }

  const requestedDomain = search_domain || yelp_domain || '';
  const normalizedPlatform = normalizePlatformInput(platform, requestedDomain);
  const normalizedDomain = normalizeSearchDomain(normalizedPlatform, requestedDomain);

  const job = createJob({
    keyword: keyword.trim(),
    location: location.trim(),
    platform: normalizedPlatform,
    searchDomain: normalizedDomain
  });

  runScrapeJob(job.id);

  res.status(202).json({
    success: true,
    jobId: job.id,
    statusUrl: `/api/scrape/${job.id}/status`,
    eventsUrl: `/api/scrape/${job.id}/events`
  });
});

app.get('/api/scrape/:jobId/status', (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    res.status(404).json({ error: 'Job not found or expired' });
    return;
  }

  res.json(getPublicJob(job));
});

app.get('/api/scrape/:jobId/events', (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    res.status(404).json({ error: 'Job not found or expired' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  job.clients.add(res);
  res.write(`data: ${JSON.stringify(getPublicJob(job))}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    job.clients.delete(res);
    res.end();
  });
});

app.get('/exports/:filename', (req, res) => {
  const filepath = path.join(EXPORTS_DIR, req.params.filename);
  if (fs.existsSync(filepath)) {
    res.download(filepath);
    return;
  }
  res.status(404).json({ error: 'File not found' });
});

// Debug screenshot viewer — lists and serves screenshots from /debug/
app.get('/debug-screenshots', (req, res) => {
  try {
    const files = fs.existsSync(DEBUG_DIR)
      ? fs.readdirSync(DEBUG_DIR).filter(f => f.endsWith('.png')).sort().reverse()
      : [];
    const links = files.map(f => `<li><a href="/debug-screenshots/${f}" target="_blank">${f}</a></li>`).join('');
    res.send(`<html><body><h2>Debug Screenshots (${files.length})</h2><ul>${links || '<li>No screenshots yet</li>'}</ul></body></html>`);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get('/debug-screenshots/:filename', (req, res) => {
  const filepath = path.join(DEBUG_DIR, path.basename(req.params.filename));
  if (fs.existsSync(filepath)) {
    res.sendFile(filepath);
    return;
  }
  res.status(404).json({ error: 'Screenshot not found' });
});

function generateExcelFile(leads, filepath) {
  const wb = new xl.Workbook();
  const ws = wb.addWorksheet('Leads');

  const headers = ['Name', 'Phone', 'Address', 'Category', 'Rating', 'Reviews', 'Latitude', 'Longitude'];
  const headerStyle = wb.createStyle({
    font: { bold: true, color: '#FFFFFF', size: 12 },
    fill: { type: 'pattern', patternType: 'solid', fgColor: '#1F4E78', bgColor: '#1F4E78' },
    alignment: { horizontal: 'center', vertical: 'center' }
  });

  headers.forEach((header, index) => {
    ws.cell(1, index + 1).string(header).style(headerStyle);
  });

  leads.forEach((lead, rowIdx) => {
    ws.cell(rowIdx + 2, 1).string(lead.name || '');
    ws.cell(rowIdx + 2, 2).string(lead.phone || '');
    ws.cell(rowIdx + 2, 3).string(lead.address || '');
    ws.cell(rowIdx + 2, 4).string(lead.category || lead.categories || '');
    ws.cell(rowIdx + 2, 5).number(Number(lead.rating) || 0);
    ws.cell(rowIdx + 2, 6).number(Number(lead.reviews || lead.reviewCount) || 0);
    ws.cell(rowIdx + 2, 7).number(Number(lead.latitude) || 0);
    ws.cell(rowIdx + 2, 8).number(Number(lead.longitude) || 0);
  });

  ws.column(1).setWidth(25);
  ws.column(2).setWidth(18);
  ws.column(3).setWidth(30);
  ws.column(4).setWidth(20);
  ws.column(5).setWidth(10);
  ws.column(6).setWidth(10);
  ws.column(7).setWidth(12);
  ws.column(8).setWidth(12);

  wb.write(filepath);
}

const server = app.listen(PORT, () => {
  console.log(`\nYelp Scraper Automation running on http://localhost:${PORT}`);
  console.log(`Extension path: ${EXTENSION_PATH}`);
  console.log(`Chrome user data dir: ${CHROME_USER_DATA_DIR}`);
  console.log(`Exports directory: ${EXPORTS_DIR}`);
  console.log(`Debug screenshots: ${DEBUG_DIR}\n`);
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or change PORT in .env.`);
    process.exit(1);
  }
  console.error('Server startup error:', error);
  process.exit(1);
});
