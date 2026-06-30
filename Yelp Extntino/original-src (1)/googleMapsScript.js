(() => {
  // Guard against double-injection
  if (window.__gmsGoogleMapsLoaded) {
    return;
  }
  window.__gmsGoogleMapsLoaded = true;

  // ── State ──────────────────────────────────────────────────────────────────
  let autoExtract = false;
  let leads = [];
  const seen = new Set();
  const failedByKey = new Map();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ── Lead syncing ───────────────────────────────────────────────────────────
  function pushLeads() {
    const snapshot = leads.slice();
    window.leads = snapshot;

    try {
      document.documentElement.setAttribute('data-yscraper-live-leads', JSON.stringify(snapshot));
    } catch (_) {
      // ignore bridge serialization errors
    }

    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ leads: snapshot });
      }
    } catch (_) {
      // ignore storage write errors
    }
  }

  function setStatus(text) {
    const el = document.getElementById('extension_gms_leads_info');
    if (el) el.textContent = text || '';
  }

  function bumpCount() {
    const btn = document.getElementById('extension_gms_download_btn');
    if (btn) btn.innerText = `Export Results(${leads.length})`;
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function waitFor(selector, maxMs = 12000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) { resolve(el); return; }
      const deadline = Date.now() + maxMs;
      const id = setInterval(() => {
        const found = document.querySelector(selector);
        if (found || Date.now() > deadline) { clearInterval(id); resolve(found || null); }
      }, 250);
    });
  }

  function placeKeyFromHref(href) {
    try {
      const cidMatch = href.match(/!1s([^!?&]+)/);
      if (cidMatch && cidMatch[1]) return cidMatch[1];
      const slugMatch = href.match(/\/maps\/place\/([^/]+)/);
      if (slugMatch && slugMatch[1]) return decodeURIComponent(slugMatch[1]);
    } catch (_) {}
    return href.split('?')[0];
  }

  // ── Feed helpers ───────────────────────────────────────────────────────────
  function getFeedEl() {
    return (
      document.querySelector('div[role="feed"]') ||
      document.querySelector('[aria-label*="Results for" i]') ||
      null
    );
  }

  function getResultCards() {
    const feed = getFeedEl();
    const selectors = 'a[href*="/maps/place/"], a.hfpxzc';
    const nodes = feed
      ? Array.from(feed.querySelectorAll(selectors))
      : Array.from(document.querySelectorAll(selectors));

    const dedup = [];
    const seenHrefs = new Set();
    for (const n of nodes) {
      const href = String(n.href || '');
      if (!href || seenHrefs.has(href)) continue;
      seenHrefs.add(href);
      dedup.push(n);
    }
    return dedup;
  }

  // ── Detail panel parsers ───────────────────────────────────────────────────
  function parseText(selector) {
    const el = document.querySelector(selector);
    return el ? String(el.textContent || '').trim() : '';
  }

  function parseName() {
    return (
      parseText('h1.DUwDvf') ||
      parseText('h1[class*="fontHeadlineLarge"]') ||
      parseText('[data-section-id="ap"] h1') ||
      ''
    );
  }

  function parseAddress() {
    const btn = document.querySelector('button[data-item-id="address"]');
    if (btn) {
      const aria = String(btn.getAttribute('aria-label') || '').replace(/^Address:\s*/i, '').trim();
      if (aria) return aria;
      return String(btn.textContent || '').trim();
    }
    return '';
  }

  function parsePhone() {
    const btn = document.querySelector('button[data-item-id^="phone:tel:"]');
    if (btn) {
      const aria = String(btn.getAttribute('aria-label') || '').replace(/^Phone:\s*/i, '').trim();
      if (aria) return aria;
      return String(btn.textContent || '').trim();
    }
    return '';
  }

  function normalizeBusinessWebsite(rawHref) {
    const raw = String(rawHref || '').trim();
    if (!raw) return '';

    try {
      let u = new URL(raw, window.location.origin);

      // Google commonly wraps external links using redirect params.
      if (u.hostname.includes('google.') && (u.pathname === '/url' || u.searchParams.has('q') || u.searchParams.has('url'))) {
        const target = u.searchParams.get('q') || u.searchParams.get('url') || '';
        if (target) {
          u = new URL(target);
        }
      }

      const host = String(u.hostname || '').toLowerCase();
      if (
        !host ||
        host.includes('google.') ||
        host.includes('goo.gl') ||
        host.includes('maps.app')
      ) {
        return '';
      }

      return u.toString();
    } catch (_) {
      return '';
    }
  }

  function parseWebsite() {
    // Strict mode: only trust the dedicated website action in Maps details.
    const websiteAnchor = document.querySelector('a[data-item-id="authority"], a[jsaction*="pane.website"]');
    if (!websiteAnchor) return '';
    return normalizeBusinessWebsite(String(websiteAnchor.href || ''));
  }

  function parseRating() {
    const span = document.querySelector(
      'div[role="main"] span[role="img"][aria-label*="star" i], ' +
      'div[role="main"] span[role="img"][aria-label*="stars" i]'
    );
    if (span) {
      const m = String(span.getAttribute('aria-label') || '').match(/([0-9]+(?:[.,][0-9]+)?)/);
      return m ? m[1] : '';
    }
    return '';
  }

  function parseReviews() {
    const btn = document.querySelector(
      'div[role="main"] button[jsaction*="pane.reviewChart.moreReviews"],' +
      'div[role="main"] button[aria-label*="review" i]'
    );
    if (btn) {
      const m = String(btn.textContent || btn.getAttribute('aria-label') || '').match(/([0-9,]+)/);
      return m ? m[1].replace(/,/g, '') : '';
    }
    return '';
  }

  function parseCategory() {
    const btn = document.querySelector(
      'button[jsaction*="pane.rating.category"],' +
      'div[role="main"] [jsaction*="category"]'
    );
    if (btn) return String(btn.textContent || '').trim();
    return '';
  }

  function snapshotDetailPanel(cardHref) {
    return {
      bizId: placeKeyFromHref(cardHref),
      name: parseName(),
      address: parseAddress(),
      phone: parsePhone(),
      website: parseWebsite(),
      category: parseCategory(),
      rating: parseRating(),
      reviews: parseReviews(),
      businessUrl: window.location.href
    };
  }

  async function waitForDetailPanel(maxMs = 5000) {
    const el = await waitFor('h1.DUwDvf, h1[class*="fontHeadlineLarge"]', maxMs);
    if (el) await sleep(700);
  }

  async function scrollFeedForMore() {
    const feed = getFeedEl();
    if (!feed) {
      window.scrollBy(0, 700);
      await sleep(1000 + Math.floor(Math.random() * 700));
      return;
    }

    const prevHeight = feed.scrollHeight;
    const prevTop = feed.scrollTop;

    // Multi-step scroll tends to trigger lazy loading more reliably than a single jump.
    for (let step = 0; step < 3; step++) {
      feed.scrollTop += 620 + Math.floor(Math.random() * 180);
      feed.dispatchEvent(new WheelEvent('wheel', { deltaY: 650, bubbles: true, cancelable: true }));
      await sleep(500 + Math.floor(Math.random() * 350));
    }

    if (feed.scrollHeight === prevHeight && feed.scrollTop === prevTop) {
      window.scrollBy(0, 800);
      await sleep(900);
      // Keyboard fallback in case feed intercepts native scroll only.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
      await sleep(700);
    }
  }

  // ── Main extraction loop ───────────────────────────────────────────────────
  async function runExtractionLoop() {
    setStatus('Waiting for Google Maps feed to load…');

    const feedEl = await waitFor('div[role="feed"]', 20000);
    if (!feedEl) {
      setStatus('Feed not found. Make sure a Maps search is open.');
      autoExtract = false;
      resetStartBtn();
      return;
    }

    let stagnationRounds = 0;
    const STAGNATION_LIMIT = 12;

    while (autoExtract) {
      const cards = getResultCards();
      const unprocessed = cards.filter((a) => {
        const key = placeKeyFromHref(String(a.href || ''));
        return key && !seen.has(key);
      });

      if (unprocessed.length === 0) {
        stagnationRounds++;
        if (stagnationRounds >= STAGNATION_LIMIT) break;
        setStatus(`Scrolling to load more… (${leads.length} found)`);
        await scrollFeedForMore();
        continue;
      }

      stagnationRounds = 0;

      for (let i = 0; i < unprocessed.length && autoExtract; i++) {
        const anchor = unprocessed[i];
        const key = placeKeyFromHref(String(anchor.href || ''));
        if (!key || seen.has(key)) continue;

        setStatus(`Extracting ${i + 1}/${unprocessed.length} (total: ${leads.length})`);

        try {
          anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await waitForDetailPanel(5000);
        } catch (_) {
          await sleep(2000);
        }

        const lead = snapshotDetailPanel(String(anchor.href || ''));
        if (!lead.name) {
          const fallbackName = String(anchor.getAttribute('aria-label') || anchor.textContent || '').trim();
          if (fallbackName) {
            lead.name = fallbackName.split('\n')[0].trim();
          }
        }

        if (lead.name) {
          seen.add(key);
          failedByKey.delete(key);
          leads.push(lead);
          pushLeads();
          bumpCount();

          // Small organic cooldown every 4 captures to reduce anti-bot signals.
          if (leads.length % 4 === 0) {
            setStatus(`Cooling down briefly… (${leads.length})`);
            await sleep(3200 + Math.floor(Math.random() * 1800));
          }
        } else {
          const failedCount = (failedByKey.get(key) || 0) + 1;
          failedByKey.set(key, failedCount);
          // Only mark as seen after repeated failure; this reduces early drop-off.
          if (failedCount >= 2) {
            seen.add(key);
          }
        }

        await sleep(1700 + Math.floor(Math.random() * 1000));
      }

      await scrollFeedForMore();
    }

    autoExtract = false;
    resetStartBtn();
    setStatus(`Done — ${leads.length} lead(s) extracted`);
    setTimeout(() => setStatus(''), 3000);
    alert('Extraction complete!');
  }

  function resetStartBtn() {
    const btn = document.getElementById('extension_gms_start_btn');
    if (btn) {
      btn.innerText = 'Start Auto Extract';
      btn.style.cssText = '';
    }
  }

  // ── Toolbar (fixed overlay — not injected into Google Maps DOM) ────────────
  function mountToolbar() {
    if (document.getElementById('extension_gms_start_btn')) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'extension_gms_page';
    wrapper.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:2147483647',
      'display:flex',
      'flex-direction:row',
      'align-items:center',
      'justify-content:flex-end',
      'gap:10px',
      'padding:7px 16px',
      'background:#111',
      'border-bottom:1.5px solid #333',
      'font-family:sans-serif'
    ].join(';');

    const status = document.createElement('span');
    status.id = 'extension_gms_leads_info';
    status.style.cssText = 'color:#ddd;font-size:13px;margin-right:auto;';

    const startBtn = document.createElement('button');
    startBtn.id = 'extension_gms_start_btn';
    startBtn.className = 'extension_gms_button';
    startBtn.innerText = 'Start Auto Extract';
    applyBtnStyle(startBtn, '#1a73e8');
    startBtn.addEventListener('click', async (evt) => {
      const btn = evt.currentTarget;
      if (autoExtract) {
        autoExtract = false;
        btn.innerText = 'Start Auto Extract';
        applyBtnStyle(btn, '#1a73e8');
        setStatus('Stopping…');
        return;
      }
      autoExtract = true;
      btn.innerText = 'Stop Auto Extract';
      applyBtnStyle(btn, '#ea4335');
      setStatus('Starting…');
      runExtractionLoop().catch((err) => {
        console.warn('[GMS] extraction error', err);
        autoExtract = false;
        resetStartBtn();
        setStatus('Error — check console');
      });
    });

    const exportBtn = document.createElement('button');
    exportBtn.id = 'extension_gms_download_btn';
    exportBtn.className = 'extension_gms_button';
    exportBtn.innerText = 'Export Results(0)';
    applyBtnStyle(exportBtn, '#34a853');
    exportBtn.addEventListener('click', () => {
      pushLeads();
      chrome.runtime.sendMessage({ action: 'openPage', data: leads });
    });

    const clearBtn = document.createElement('button');
    clearBtn.id = 'extension_gms_clear_btn';
    clearBtn.className = 'extension_gms_button';
    clearBtn.innerText = 'Clear';
    applyBtnStyle(clearBtn, '#5f6368');
    clearBtn.addEventListener('click', () => {
      leads = [];
      seen.clear();
      pushLeads();
      bumpCount();
      setStatus('Cleared');
      setTimeout(() => setStatus(''), 800);
    });

    wrapper.appendChild(status);
    wrapper.appendChild(startBtn);
    wrapper.appendChild(exportBtn);
    wrapper.appendChild(clearBtn);

    // Attach to documentElement so it survives body re-renders
    (document.documentElement || document.body).appendChild(wrapper);

    // Push page content down so toolbar doesn't cover anything
    const bodyPad = parseInt(document.body.style.paddingTop || '0', 10);
    document.body.style.paddingTop = Math.max(bodyPad, 52) + 'px';
  }

  function applyBtnStyle(btn, bg) {
    btn.style.cssText = [
      'cursor:pointer',
      'padding:6px 14px',
      'border:none',
      'border-radius:4px',
      'font-size:13px',
      'font-weight:600',
      'color:#fff',
      `background:${bg}`,
      'white-space:nowrap'
    ].join(';');
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  function bootstrap() {
    const href = window.location.href;
    if (!href.includes('/maps/search') && !href.includes('/maps/place')) return;
    mountToolbar();
    pushLeads();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }

  // Handle SPA navigation via popstate
  window.addEventListener('popstate', () => setTimeout(bootstrap, 900));

  // Intercept History API pushState / replaceState (Google Maps uses these heavily)
  const _push = history.pushState.bind(history);
  history.pushState = function (...args) {
    _push(...args);
    setTimeout(bootstrap, 900);
  };

  const _replace = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    _replace(...args);
    setTimeout(bootstrap, 400);
  };

  // MutationObserver fallback in case Google blows away the toolbar node
  const toolbarObserver = new MutationObserver(() => {
    if (!document.getElementById('extension_gms_start_btn') &&
        (window.location.href.includes('/maps/search') ||
         window.location.href.includes('/maps/place'))) {
      mountToolbar();
    }
  });
  toolbarObserver.observe(document.documentElement, { childList: true, subtree: false });

})();
