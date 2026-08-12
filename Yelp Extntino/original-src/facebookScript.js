(() => {
  if (window.__fbScraperLoaded) return;
  window.__fbScraperLoaded = true;

  let autoExtract = false;
  let leads = [];
  const seen = new Set();
  let collect_email = true;
  let collect_phone = true;

  try {
    chrome.storage.sync.get(null, function(a) {
      collect_phone = a.hasOwnProperty("collect_phone") && a.collect_phone === false ? false : true;
      collect_email = a.hasOwnProperty("collect_email") && a.collect_email === false ? false : true;
    });
  } catch(e) {}

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

  function isGooglePlacesPage() {
    const u = String(window.location.href || '').toLowerCase();
    return isGoogleSearchPage() && (u.includes('tbm=lcl') || u.includes('udm=1') || u.includes('places') || !!document.querySelector('.rllt__details') || !!document.querySelector('[data-cid]'));
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

    const card = anchor.closest('div.cXedhc, div.Vk5nJb, div.rllt__details, li.b_algo, div[role="article"], div[role="listitem"], div[data-pagelet]') || anchor.closest('div') || anchor;
    const cardText = String(card.textContent || '').replace(/\s+/g, ' ').trim();
    const rawName = String(anchor.textContent || anchor.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();

    let name = rawName;
    if (!name || name.toLowerCase() === 'website' || name.toLowerCase() === 'facebook') {
      const heading = card.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], a.jrkubc');
      if (heading) {
        name = heading.textContent.trim();
      } else {
        const anchors = Array.from(card.querySelectorAll('a'));
        for (const a of anchors) {
          const text = a.textContent.trim();
          const href = a.getAttribute('href') || '';
          if (text && text.toLowerCase() !== 'website' && !href.includes('facebook.com') && !href.includes('google.com')) {
            name = text;
            break;
          }
        }
      }
    }

    name = name || cardText.split(' ').slice(0, 6).join(' ');
    if (!name) return null;

    let website = '';
    const links = Array.from(card.querySelectorAll('a[href^="http"]'));
    for (const link of links) {
      const href = String(link.href || '');
      if (!href) continue;
      if (!href.includes('facebook.com') && !href.includes('fb.com') && !href.includes('l.facebook.com') && !href.includes('google.com')) {
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
    let isPlacesView = isGooglePlacesPage();

    while (autoExtract) {
      if (isPlacesView || isGooglePlacesPage()) {
        isPlacesView = true;
        
        // Wait up to 5 seconds for new cards to render in the DOM if needed.
        let cards = [];
        let freshCards = [];
        const cardLoadStart = Date.now();
        while (Date.now() - cardLoadStart < 5000) {
          cards = Array.from(document.querySelectorAll('div.Vk5nJb, div.cXedhc, [data-cid]')).filter(c => {
            return c.querySelector('[role="heading"], div.dbg0pd, span.OSrXXb');
          });
          freshCards = cards.filter(card => {
            const nameEl = card.querySelector('[role="heading"], div.dbg0pd, span.OSrXXb');
            const name = nameEl ? nameEl.textContent.trim() : '';
            const key = card.getAttribute('data-cid') || name;
            return key && !seen.has(key);
          });
          if (freshCards.length > 0) break;
          await sleep(500);
        }

        if (freshCards.length > 0) {
          for (let i = 0; i < freshCards.length && autoExtract; i += 1) {
            const card = freshCards[i];
            const nameEl = card.querySelector('[role="heading"], div.dbg0pd, span.OSrXXb');
            const name = nameEl ? nameEl.textContent.trim() : '';
            const key = card.getAttribute('data-cid') || name;
            if (!key || seen.has(key)) continue;

            seen.add(key);
            setStatus(`Extracting ${i + 1}/${freshCards.length} (total: ${leads.length})`);

            const websiteAnchor = card.querySelector('a.L48Cpd, a[href*="url?q="], a[href*="google.com/url?"]') || 
                                  Array.from(card.querySelectorAll('a')).find(a => {
                                    const t = a.textContent.toLowerCase();
                                    return t.includes('website') || t.includes('site');
                                  });
            let website = '';
            if (websiteAnchor) {
              website = decodeGoogleTargetUrl(websiteAnchor.href);
            }

            const cardText = String(card.textContent || '').replace(/\s+/g, ' ').trim();
            
            const lead = {
              bizId: key,
              name,
              address: '',
              phone: extractPhoneFromText(cardText),
              email: extractEmailFromText(cardText),
              website,
              category: '',
              rating: '',
              reviews: '',
              businessUrl: window.location.href
            };

            const ratingMatch = cardText.match(/([3-5][.,][0-9])\s*\(([^)]+)\)/);
            if (ratingMatch) {
              lead.rating = ratingMatch[1];
              lead.reviews = ratingMatch[2].replace(/,/g, '');
            }

            if (lead.website && collect_email) {
              try {
                setStatus(`Scraping emails for ${lead.name}...`);
                const d = await extractemail(lead.website, "", true);
                if (d) {
                  for (const f in d) {
                    lead[f] = [...d[f]].join();
                  }
                }
              } catch(e) {
                console.warn("email error:", e);
              }
            }

            leads.push(lead);
            pushLeads();
            setExportCount();
            await sleep(350 + Math.floor(Math.random() * 250));
          }
        }

        if (!autoExtract) break;

        let nextBtn = document.querySelector('a#pnnext') || document.querySelector('a[aria-label="Next page"]') || document.querySelector('a[aria-label*="Next"]');
        if (!nextBtn) {
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
          await sleep(2000);
          nextBtn = document.querySelector('a#pnnext') || document.querySelector('a[aria-label="Next page"]') || document.querySelector('a[aria-label*="Next"]');
        }

        if (!nextBtn) {
          console.log("No next page link found");
          break;
        }

        const firstBizName = cards[0] ? (cards[0].querySelector('[role="heading"], div.dbg0pd, span.OSrXXb')?.textContent.trim() || '') : '';
        console.log("Clicking Google Places Next Page...");
        nextBtn.click();

        const startTime = Date.now();
        let updated = false;
        while (Date.now() - startTime < 15000 && autoExtract) {
          await sleep(1000);
          const newCards = Array.from(document.querySelectorAll('div.Vk5nJb, div.cXedhc, [data-cid]')).filter(c => {
            return c.querySelector('[role="heading"], div.dbg0pd, span.OSrXXb');
          });
          const newFirstName = newCards[0] ? (newCards[0].querySelector('[role="heading"], div.dbg0pd, span.OSrXXb')?.textContent.trim() || '') : '';
          if (newCards.length > 0 && newFirstName !== firstBizName) {
            updated = true;
            break;
          }
        }

        if (!updated) {
          console.warn("Google Places page transition timed out");
          break;
        }

        console.log("Google Places Page updated");
        await sleep(2000);
        continue;
      }

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
          const anchors = getCandidateAnchors();
          const freshAnchors = anchors.filter((a) => {
            const key = normalizeFbUrl(a.href || '');
            return key && !seen.has(key);
          });
          for (let i = 0; i < freshAnchors.length && autoExtract; i += 1) {
            const anchor = freshAnchors[i];
            const key = normalizeFbUrl(anchor.href || '');
            if (!key || seen.has(key)) continue;

            seen.add(key);
            const lead = parseLeadFromAnchor(anchor);
            if (lead) {
              if (lead.website && collect_email) {
                try {
                  setStatus(`Scraping emails for ${lead.name}...`);
                  const d = await extractemail(lead.website, "", true);
                  if (d) {
                    for (const f in d) {
                      lead[f] = [...d[f]].join();
                    }
                  }
                } catch(e) {
                  console.warn("email error:", e);
                }
              }
              leads.push(lead);
              pushLeads();
              setExportCount();
            }
            setStatus(`Extracting ${i + 1}/${freshAnchors.length} (total: ${leads.length})`);
            await sleep(350 + Math.floor(Math.random() * 250));
          }
        } else {
          for (let i = 0; i < freshCards.length && autoExtract; i += 1) {
            const card = freshCards[i];
            const lead = isGoogleSearchPage() ? parseLeadFromGoogleCard(card) : parseLeadFromBingCard(card);
            if (!lead || !lead.bizId) continue;
            if (seen.has(lead.bizId)) continue;

            seen.add(lead.bizId);
            if (lead.website && collect_email) {
              try {
                setStatus(`Scraping emails for ${lead.name}...`);
                const d = await extractemail(lead.website, "", true);
                if (d) {
                  for (const f in d) {
                    lead[f] = [...d[f]].join();
                  }
                }
              } catch(e) {
                console.warn("email error:", e);
              }
            }
            leads.push(lead);
            pushLeads();
            setExportCount();
            setStatus(`Extracting ${i + 1}/${freshCards.length} (total: ${leads.length})`);
            await sleep(350 + Math.floor(Math.random() * 250));
          }
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
          if (lead.website && collect_email) {
            try {
              setStatus(`Scraping emails for ${lead.name}...`);
              const d = await extractemail(lead.website, "", true);
              if (d) {
                for (const f in d) {
                  lead[f] = [...d[f]].join();
                }
              }
            } catch(e) {
              console.warn("email error:", e);
            }
          }
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

    const diagBtn = document.createElement('button');
    diagBtn.id = 'extension_gms_diagnose_btn';
    diagBtn.className = 'extension_gms_button';
    diagBtn.innerText = 'Run Diagnostics';
    applyBtnStyle(diagBtn, '#e67e22');
    diagBtn.addEventListener('click', async () => {
      diagBtn.innerText = 'Diagnosing...';
      diagBtn.disabled = true;
      try {
        var b = {
          timestamp: (new Date()).toISOString(),
          url: window.location.href,
          htmlLength: document.documentElement.outerHTML.length,
          ldJsonScripts: [],
          nextLinkSelectorExists: false,
          bizLinksCount: document.querySelectorAll('a[href*="facebook.com"]').length,
          sampleBizLinks: []
        };
        document.querySelectorAll('script[type="application/ld+json"]').forEach((l, g) => {
          try {
            b.ldJsonScripts.push({ index: g, content: JSON.parse(l.textContent.trim()) });
          } catch(p) {
            b.ldJsonScripts.push({ index: g, raw: l.textContent.slice(0, 1000) });
          }
        });
        document.querySelectorAll('a[href*="facebook.com"]').forEach((l, g) => {
          if (g < 10) {
            b.sampleBizLinks.push({
              text: l.innerText.trim(),
              href: l.getAttribute('href'),
              classes: l.className
            });
          }
        });
        chrome.runtime.sendMessage({ action: 'diagnose', data: b }, (f) => {
          if (f && f.success) {
            alert('Diagnostics complete! Saved to debug/diagnostics_result.json');
          } else {
            alert('Diagnostics failed: ' + (f ? f.error : 'no response'));
          }
        });
      } catch (err) {
        alert('Diag failed: ' + err.message);
      } finally {
        diagBtn.innerText = 'Run Diagnostics';
        diagBtn.disabled = false;
      }
    });

    wrapper.appendChild(status);
    wrapper.appendChild(startBtn);
    wrapper.appendChild(exportBtn);
    wrapper.appendChild(clearBtn);
    wrapper.appendChild(diagBtn);

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

  function decode_cf_email(a){let s="";let r=parseInt(a.substr(0,2),16);for(let j=2;a.length-j;j+=2){let c=parseInt(a.substr(j,2),16)^r;s+=String.fromCharCode(c);}return s}
  function get_domain(a){const k=new Set("ac ad ae af ag ai al am an ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws xk ye yt za zm zw".split(" "));
  a=(new URL(a)).host.toLowerCase().split(".");return k.has(a[a.length-1])?a[a.length-3]:a[a.length-2]}
  function normalize_social_link(a){try{a.startsWith("//")&&(a="https:"+a);a.startsWith("http")||(a="https://"+a);const k=new Set("/reel /about /tr /privacy /download /pg /settings /vp /profiles".split(" "));let e=new URL(a);if("http:"===e.protocol||""===e.protocol)e.protocol="https:";"instagram.com"===e.host&&(e.host="www.instagram.com");"facebook.com"===e.host&&(e.host="www.facebook.com");"yelp.com"===e.host&&(e.host="www.yelp.com");"www.twitter.com"===e.host&&(e.host="twitter.com");"/"===e.pathname[e.pathname.length-1]&&(e.pathname=e.pathname.slice(0,-1));return k.has(e.pathname)?"":e.toString()}catch(k){console.warn("normalize_social_link error: ",a,k)}return""}
  async function extractemail(a,k,e){try{a.startsWith("//")&&(a="https:"+a);a.startsWith("http")||(a="https://"+a);const v=await chrome.runtime.sendMessage({action:"access",data:{url:a}});if(10>v.length)console.warn("visit error: ",a);else{var m=v.normalize("NFKC");k={instagram:/(((http|https):\/\/)?((www\.)?(?:instagram.com|instagr.am)\/([A-Za-z0-9_.]{2,30})))/ig,facebook:/(?:https?:)?\/\/(?:www\.)?(?:facebook|fb)\.com\/((?![A-z]+\.php)(?!marketplace|gaming|watch|me|messages|help|search|groups)[A-z0-9_\-\.]+)\/?/ig,
  youtube:/(?:https?:)?\/\/(?:[A-z]+\.)?youtube\.com\/(channel\/([A-z0-9-_]+)|user\/([A-z0-9]+))\/?/ig,linkedin:/(?:https?:)?\/\/(?:[\w]+\.)?linkedin\.com\/((company|school)\/[A-z0-9-\u00c0-\u00ff\.]+|in\/[\w\-_\u00c0-\u00ff%]+)\/?/ig,twitter:/(?:(?:http|https):\/\/)?(?:www.)?(?:twitter.com)\/(?!(oauth|account|tos|privacy|signup|home|hashtag|search|login|widgets|i|settings|start|share|intent|oct)(['"\?\.\/]|$))([A-Za-z0-9_]{1,15})/igm,email:/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi};var n=new Set,
  b={};for(const h in k){b[h]=new Set;var d=m.match(k[h]);d&&d.forEach(q=>{q&&("email"===h?b[h].add(q):(q=normalize_social_link(q))&&b[h].add(q))})}var f=new URL(a);try{var l=(new DOMParser).parseFromString(m,"text/html").querySelector(".__cf_email__");if(l){const h=l.getAttribute("data-cfemail");h&&b.email.add(decode_cf_email(h))}}catch(h){console.warn("DOMParser parsed error: ",a,h)}l=/<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1/gi;d=[];for(var g;g=l.exec(m);)try{d.push((new URL(g[2],f)).toString())}catch(h){console.warn("find links failed: ",g[2],h)}m="/contact /contact-us /contact-me /about /about-me /about-us /team /our-team /meet-the-team /support /customer-service /feedback /help /sales return location faq".split(" ");for(f=0;f<d.length;f++){var p=d[f];for(g=0;g<m.length;++g)if(p.includes(m[g])){n.add(p);break}}for(p=0;p<d.length;p++)try{const h=d[p];if(!h)continue;const q=(new URL(h)).host.toLowerCase();for(const x in k)if(q.includes(x)){if(0>=b[x].size){const z=normalize_social_link(h);z&&b[x].add(z)}break}}catch(h){console.warn(`error: ${d[p]}`,h)}if(e&&0<n.size){const h=[...n].map(async q=>await extractemail(q,"",!1));(await Promise.all(h)).map(q=>{if(q)for(const x in q)q[x].forEach(z=>{b[x].add(z)})})}console.log("Email for : ",a,b,[...n].join());var u=new Set,w=new Set,y=".png .jpg .jpeg .gif .webp wixpress.com sentry.io noreply abuse no-reply subscribe mailer-daemon domain.com email.com yourname wix.com".split(" "),t=get_domain(a);b.email.forEach(h=>{h=h.replace("u003e","").toLowerCase();for(let q=0;q<y.length;++q)if(h.includes(y[q]))return;
  u.add(h);t&&h.includes(t)&&w.add(h)});b.email=0<w.size?w:u;return b}}catch(v){console.warn(`visit url error: ${a}`,v)}}

  const _replace = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    _replace(...args);
    setTimeout(bootstrap, 400);
  };
})();
