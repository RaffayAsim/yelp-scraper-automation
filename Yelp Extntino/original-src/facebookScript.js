(() => {
  if (window.__fbScraperLoaded) return;
  window.__fbScraperLoaded = true;

  let autoExtract = false;
  let leads = [];
  const seen = new Set();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function pushLeads() {
    const snapshot = leads.slice();
    window.leads = snapshot;
    try {
      document.documentElement.setAttribute('data-yscraper-live-leads', JSON.stringify(snapshot));
    } catch (_) {}
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ leads: snapshot });
      }
    } catch (_) {}
  }

  function setStatus(text) {
    const el = document.getElementById('extension_gms_leads_info');
    if (el) el.textContent = text || '';
  }

  function setExportCount() {
    const btn = document.getElementById('extension_gms_download_btn');
    if (btn) btn.innerText = `Export Results(${leads.length})`;
  }

  function getHost() {
    return String(window.location.hostname || '').toLowerCase();
  }

  function isBingSearchPage() {
    const host = getHost();
    const path = String(window.location.pathname || '').toLowerCase();
    return host.includes('bing.com') && path.includes('/search');
  }

  function isGoogleSearchPage() {
    const host = getHost();
    const path = String(window.location.pathname || '').toLowerCase();
    return host.includes('google.com') && path.includes('/search');
  }

  function decodeBingTargetUrl(rawHref) {
    try {
      const u = new URL(String(rawHref || ''), window.location.origin);
      const host = String(u.hostname || '').toLowerCase();
      if (!host.includes('bing.com')) return String(rawHref || '');

      const candidate = u.searchParams.get('u') || u.searchParams.get('url') || '';
      if (!candidate) return String(rawHref || '');

      if (/^a1/i.test(candidate)) {
        const b64 = candidate.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '==='.slice((b64.length + 3) % 4);
        const decoded = atob(padded);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }

      const decodedCandidate = decodeURIComponent(candidate);
      if (/^https?:\/\//i.test(decodedCandidate)) return decodedCandidate;

      return String(rawHref || '');
    } catch (_) {
      return String(rawHref || '');
    }
  }

  function decodeGoogleTargetUrl(rawHref) {
    try {
      const u = new URL(String(rawHref || ''), window.location.origin);
      const host = String(u.hostname || '').toLowerCase();
      if (!host.includes('google.')) return String(rawHref || '');

      if (u.pathname === '/url') {
        const q = u.searchParams.get('q') || u.searchParams.get('url') || '';
        if (q && /^https?:\/\//i.test(q)) return q;
      }

      return String(rawHref || '');
    } catch (_) {
      return String(rawHref || '');
    }
  }

  function decodeSearchTargetUrl(rawHref) {
    const googleDecoded = decodeGoogleTargetUrl(rawHref);
    const bingDecoded = decodeBingTargetUrl(googleDecoded);
    return bingDecoded;
  }

  function normalizeFbUrl(href) {
    try {
      const resolved = decodeSearchTargetUrl(href);
      const u = new URL(String(resolved || ''), window.location.origin);
      u.hash = '';
      const path = u.pathname.toLowerCase();
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

      // Keep the profile ID for /profile.php pages; remove noisy trackers elsewhere.
      if (path === '/profile.php') {
        const id = u.searchParams.get('id');
        if (!id) return '';
        u.search = `?id=${id}`;
      } else {
        u.search = '';
      }

      return u.toString();
    } catch (_) {
      return '';
    }
  }

  function getCandidateAnchors() {
    const roots = isBingSearchPage()
      ? [document.querySelector('#b_results'), document]
      : isGoogleSearchPage()
      ? [document.querySelector('#search'), document]
      : [document.querySelector('div[role="main"]'), document].filter(Boolean);

    const anchors = [];
    for (const root of roots) {
      const list = root.querySelectorAll('a[href]');
      for (const a of list) anchors.push(a);
    }

    const out = [];
    const seenUrls = new Set();
    for (const a of anchors) {
      const url = normalizeFbUrl(a.href || '');
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      if (!/facebook\.com\/(pages|profile\.php|[^/?#]+)/i.test(url)) continue;
      out.push(a);
    }
    return out;
  }

  function getBingResultCards() {
    return Array.from(document.querySelectorAll('#b_results li.b_algo'));
  }

  function getGoogleResultCards() {
    return Array.from(document.querySelectorAll('#search .g, #search div[data-sokoban-container]'));
  }

  function extractEmailFromText(text) {
    const m = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return m ? m[0] : '';
  }

  function extractPhoneFromText(text) {
    const m = String(text || '').match(/\+?\d[\d\s().-]{7,}/);
    return m ? m[0].trim() : '';
  }

  function parseLeadFromAnchor(anchor) {
    const url = normalizeFbUrl(anchor.href || '');
    if (!url) return null;

    const card = anchor.closest('li.b_algo, div[role="article"], div[role="listitem"], div[data-pagelet], div') || anchor;
    const cardText = String(card.textContent || '').replace(/\s+/g, ' ').trim();
    const rawName = String(anchor.textContent || anchor.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();

    const name = rawName || cardText.split(' ').slice(0, 6).join(' ');
    if (!name) return null;

    let website = '';
    const links = Array.from(card.querySelectorAll('a[href^="http"]'));
    for (const link of links) {
      const href = String(link.href || '');
      if (!href) continue;
      if (!href.includes('facebook.com') && !href.includes('fb.com') && !href.includes('l.facebook.com')) {
        website = href;
        break;
      }
    }

    return {
      bizId: url,
      name,
      address: '',
      phone: extractPhoneFromText(cardText),
      email: extractEmailFromText(cardText),
      website,
      category: '',
      rating: '',
      reviews: '',
      businessUrl: url
    };
  }

  function parseLeadFromBingCard(card) {
    const link = card.querySelector('h2 a, a[href]');
    const href = String((link && (link.href || link.getAttribute('href'))) || '');
    let url = normalizeFbUrl(href);

    if (!url) {
      const text = String(card.textContent || '');
      const m = text.match(/https?:\/\/(?:www\.)?facebook\.com\/[\w\-./?=&%#]+/i);
      if (m && m[0]) url = normalizeFbUrl(m[0]);
    }

    if (!url) return null;

    const nameEl = card.querySelector('h2, .b_title');
    const name = String((nameEl && nameEl.textContent) || (link && link.textContent) || '').replace(/\s+/g, ' ').trim();
    if (!name) return null;

    const cardText = String(card.textContent || '').replace(/\s+/g, ' ').trim();

    return {
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
    };
  }

  function parseLeadFromGoogleCard(card) {
    const link = card.querySelector('a[href]');
    const href = String((link && (link.href || link.getAttribute('href'))) || '');
    let url = normalizeFbUrl(href);

    if (!url) {
      const text = String(card.textContent || '');
      const m = text.match(/https?:\/\/(?:www\.)?facebook\.com\/[\w\-./?=&%#]+/i);
      if (m && m[0]) url = normalizeFbUrl(m[0]);
    }

    if (!url) return null;

    const nameEl = card.querySelector('h3');
    const name = String((nameEl && nameEl.textContent) || (link && link.textContent) || '').replace(/\s+/g, ' ').trim();
    if (!name) return null;

    const cardText = String(card.textContent || '').replace(/\s+/g, ' ').trim();

    return {
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
    };
  }

  async function scrollForMore() {
    window.scrollBy(0, 900);
    await sleep(1200 + Math.floor(Math.random() * 500));
  }

  async function runExtraction() {
    const searchEngineMode = isGoogleSearchPage() || isBingSearchPage();
    setStatus(searchEngineMode ? 'Scanning web results for Facebook pages...' : 'Scanning Facebook results...');

    let stagnation = 0;
    const STAGNATION_LIMIT = 12;

    while (autoExtract) {
      if (searchEngineMode) {
        const cards = isGoogleSearchPage() ? getGoogleResultCards() : getBingResultCards();
        const freshCards = cards.filter((card) => {
          const link = isGoogleSearchPage()
            ? card.querySelector('a[href]')
            : card.querySelector('h2 a, a[href]');
          const href = String((link && (link.href || link.getAttribute('href'))) || '');
          const key = normalizeFbUrl(href);
          return key && !seen.has(key);
        });

        if (!freshCards.length) {
          break;
        }

        for (let i = 0; i < freshCards.length && autoExtract; i += 1) {
          const card = freshCards[i];
          const lead = isGoogleSearchPage() ? parseLeadFromGoogleCard(card) : parseLeadFromBingCard(card);
          if (!lead || !lead.bizId) continue;
          if (seen.has(lead.bizId)) continue;

          seen.add(lead.bizId);
          leads.push(lead);
          pushLeads();
          setExportCount();
          setStatus(`Extracting ${i + 1}/${freshCards.length} (total: ${leads.length})`);
          await sleep(350 + Math.floor(Math.random() * 250));
        }

        break;
      }

      const anchors = getCandidateAnchors();
      const fresh = anchors.filter((a) => {
        const key = normalizeFbUrl(a.href || '');
        return key && !seen.has(key);
      });

      if (!fresh.length) {
        stagnation += 1;
        if (stagnation >= STAGNATION_LIMIT) break;
        setStatus(`Loading more results... (${leads.length} found)`);
        await scrollForMore();
        continue;
      }

      stagnation = 0;

      for (let i = 0; i < fresh.length && autoExtract; i += 1) {
        const anchor = fresh[i];
        const key = normalizeFbUrl(anchor.href || '');
        if (!key || seen.has(key)) continue;

        setStatus(`Extracting ${i + 1}/${fresh.length} (total: ${leads.length})`);
        const lead = parseLeadFromAnchor(anchor);
        seen.add(key);

        if (lead) {
          leads.push(lead);
          pushLeads();
          setExportCount();
        }

        await sleep(900 + Math.floor(Math.random() * 600));
      }

      await scrollForMore();
    }

    autoExtract = false;
    const startBtn = document.getElementById('extension_gms_start_btn');
    if (startBtn) {
      startBtn.innerText = 'Start Auto Extract';
      startBtn.style.cssText = '';
    }

    setStatus(`Done - ${leads.length} lead(s) extracted`);
    setTimeout(() => setStatus(''), 2000);
    alert('Extraction complete!');
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
    startBtn.addEventListener('click', () => {
      if (autoExtract) {
        autoExtract = false;
        startBtn.innerText = 'Start Auto Extract';
        applyBtnStyle(startBtn, '#1a73e8');
        setStatus('Stopping...');
        return;
      }
      autoExtract = true;
      startBtn.innerText = 'Stop Auto Extract';
      applyBtnStyle(startBtn, '#ea4335');
      setStatus('Starting...');
      runExtraction().catch((err) => {
        console.warn('[FB] extraction error', err);
        autoExtract = false;
        startBtn.innerText = 'Start Auto Extract';
        applyBtnStyle(startBtn, '#1a73e8');
        setStatus('Error - check console');
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
      setExportCount();
      setStatus('Cleared');
      setTimeout(() => setStatus(''), 800);
    });

    wrapper.appendChild(status);
    wrapper.appendChild(startBtn);
    wrapper.appendChild(exportBtn);
    wrapper.appendChild(clearBtn);

    (document.documentElement || document.body).appendChild(wrapper);

    const bodyPad = parseInt(document.body.style.paddingTop || '0', 10);
    document.body.style.paddingTop = Math.max(bodyPad, 52) + 'px';

    pushLeads();
  }

  function shouldActivate() {
    const u = String(window.location.href || '').toLowerCase();
    return (
      u.includes('facebook.com/search') ||
      u.includes('facebook.com/pages') ||
      u.includes('google.com/search') ||
      u.includes('bing.com/search')
    );
  }

  function bootstrap() {
    if (!shouldActivate()) return;
    mountToolbar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }

  window.addEventListener('popstate', () => setTimeout(bootstrap, 800));

  const _push = history.pushState.bind(history);
  history.pushState = function (...args) {
    _push(...args);
    setTimeout(bootstrap, 800);
  };

  const _replace = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    _replace(...args);
    setTimeout(bootstrap, 400);
  };
})();
