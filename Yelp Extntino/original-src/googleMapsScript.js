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
  let collect_email = true;
  let collect_phone = true;

  try {
    chrome.storage.sync.get(null, function(a) {
      collect_phone = a.hasOwnProperty("collect_phone") && a.collect_phone === false ? false : true;
      collect_email = a.hasOwnProperty("collect_email") && a.collect_email === false ? false : true;
    });
  } catch(e) {}
  const failedByKey = new Map();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function saveStateToStorage() {
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          autoExtract: autoExtract,
          leads: leads,
          seenKeys: Array.from(seen)
        });
      }
    } catch (_) {}
  }

  // ── Lead syncing ───────────────────────────────────────────────────────────
  function pushLeads() {
    const snapshot = leads.slice();
    window.leads = snapshot;

    try {
      document.documentElement.setAttribute('data-yscraper-live-leads', JSON.stringify(snapshot));
    } catch (_) {
      // ignore bridge serialization errors
    }

    saveStateToStorage();
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
        if (stagnationRounds >= STAGNATION_LIMIT) {
          const nextBtn = document.querySelector('button[aria-label="Next page"], button[id="ppd-next-button"], button[jsaction*="pane.paginationNavigation.nextPage"]');
          if (nextBtn && !nextBtn.disabled && nextBtn.getAttribute('aria-disabled') !== 'true') {
            setStatus('Navigating to next page…');
            nextBtn.click();
            stagnationRounds = 0;
            await sleep(5000);
            continue;
          }
          break;
        }
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
    saveStateToStorage();
    alert('Extraction complete!');
  }

  function resetStartBtn() {
    const btn = document.getElementById('extension_gms_start_btn');
    if (btn) {
      btn.innerText = 'Start Auto Extract';
      applyBtnStyle(btn, '#1a73e8');
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
    if (autoExtract) {
      startBtn.innerText = 'Stop Auto Extract';
      applyBtnStyle(startBtn, '#ea4335');
    } else {
      startBtn.innerText = 'Start Auto Extract';
      applyBtnStyle(startBtn, '#1a73e8');
    }
    startBtn.addEventListener('click', async (evt) => {
      const btn = evt.currentTarget;
      if (autoExtract) {
        autoExtract = false;
        btn.innerText = 'Start Auto Extract';
        applyBtnStyle(btn, '#1a73e8');
        setStatus('Stopping…');
        saveStateToStorage();
        return;
      }
      autoExtract = true;
      btn.innerText = 'Stop Auto Extract';
      applyBtnStyle(btn, '#ea4335');
      setStatus('Starting…');
      saveStateToStorage();
      runExtractionLoop().catch((err) => {
        console.warn('[GMS] extraction error', err);
        autoExtract = false;
        resetStartBtn();
        setStatus('Error — check console');
        saveStateToStorage();
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
          bizLinksCount: document.querySelectorAll('a[href*="/maps/place/"]').length,
          sampleBizLinks: []
        };
        document.querySelectorAll('script[type="application/ld+json"]').forEach((l, g) => {
          try {
            b.ldJsonScripts.push({ index: g, content: JSON.parse(l.textContent.trim()) });
          } catch(p) {
            b.ldJsonScripts.push({ index: g, raw: l.textContent.slice(0, 1000) });
          }
        });
        document.querySelectorAll('a[href*="/maps/place/"]').forEach((l, g) => {
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

  function decode_cf_email(a){let s="";let r=parseInt(a.substr(0,2),16);for(let j=2;a.length-j;j+=2){let c=parseInt(a.substr(j,2),16)^r;s+=String.fromCharCode(c);}return s}
  function get_domain(a){const k=new Set("ac ad ae af ag ai al am an ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws xk ye yt za zm zw".split(" "));
  a=(new URL(a)).host.toLowerCase().split(".");return k.has(a[a.length-1])?a[a.length-3]:a[a.length-2]}
  function normalize_social_link(a){try{a.startsWith("//")&&(a="https:"+a);a.startsWith("http")||(a="https://"+a);const k=new Set("/reel /about /tr /privacy /download /pg /settings /vp /profiles".split(" "));let e=new URL(a);if("http:"===e.protocol||""===e.protocol)e.protocol="https:";"instagram.com"===e.host&&(e.host="www.instagram.com");"facebook.com"===e.host&&(e.host="www.facebook.com");"yelp.com"===e.host&&(e.host="www.yelp.com");"www.twitter.com"===e.host&&(e.host="twitter.com");"/"===e.pathname[e.pathname.length-1]&&(e.pathname=e.pathname.slice(0,-1));return k.has(e.pathname)?"":e.toString()}catch(k){console.warn("normalize_social_link error: ",a,k)}return""}
  async function extractemail(a,k,e){try{a.startsWith("//")&&(a="https:"+a);a.startsWith("http")||(a="https://"+a);const v=await chrome.runtime.sendMessage({action:"access",data:{url:a}});if(10>v.length)console.warn("visit error: ",a);else{var m=v.normalize("NFKC");k={instagram:/(((http|https):\/\/)?((www\.)?(?:instagram.com|instagr.am)\/([A-Za-z0-9_.]{2,30})))/ig,facebook:/(?:https?:)?\/\/(?:www\.)?(?:facebook|fb)\.com\/((?![A-z]+\.php)(?!marketplace|gaming|watch|me|messages|help|search|groups)[A-z0-9_\-\.]+)\/?/ig,
  youtube:/(?:https?:)?\/\/(?:[A-z]+\.)?youtube\.com\/(channel\/([A-z0-9-_]+)|user\/([A-z0-9]+))\/?/ig,linkedin:/(?:https?:)?\/\/(?:[\w]+\.)?linkedin\.com\/((company|school)\/[A-z0-9-\u00c0-\u00ff\.]+|in\/[\w\-_\u00c0-\u00ff%]+)\/?/ig,twitter:/(?:(?:http|https):\/\/)?(?:www.)?(?:twitter.com)\/(?!(oauth|account|tos|privacy|signup|home|hashtag|search|login|widgets|i|settings|start|share|intent|oct)(['"\?\.\/]|$))([A-Za-z0-9_]{1,15})/igm,email:/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi};var n=new Set,
  b={};for(const h in k){b[h]=new Set;var d=m.match(k[h]);d&&d.forEach(q=>{q&&("email"===h?b[h].add(q):(q=normalize_social_link(q))&&b[h].add(q))})}var f=new URL(a);try{var l=(new DOMParser).parseFromString(m,"text/html").querySelector(".__cf_email__");if(l){const h=l.getAttribute("data-cfemail");h&&b.email.add(decode_cf_email(h))}}catch(h){console.warn("DOMParser parsed error: ",a,h)}l=/<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1/gi;d=[];for(var g;g=l.exec(m);)try{d.push((new URL(g[2],f)).toString())}catch(h){console.warn("find links failed: ",g[2],h)}m="/contact /contact-us /contact-me /about /about-me /about-us /team /our-team /meet-the-team /support /customer-service /feedback /help /sales return location faq".split(" ");for(f=0;f<d.length;f++){var p=d[f];for(g=0;g<m.length;++g)if(p.includes(m[g])){n.add(p);break}}for(p=0;p<d.length;p++)try{const h=d[p];if(!h)continue;const q=(new URL(h)).host.toLowerCase();for(const x in k)if(q.includes(x)){if(0>=b[x].size){const z=normalize_social_link(h);z&&b[x].add(z)}break}}catch(h){console.warn(`error: ${d[p]}`,h)}if(e&&0<n.size){const h=[...n].map(async q=>await extractemail(q,"",!1));(await Promise.all(h)).map(q=>{if(q)for(const x in q)q[x].forEach(z=>{b[x].add(z)})})}console.log("Email for : ",a,b,[...n].join());var u=new Set,w=new Set,y=".png .jpg .jpeg .gif .webp wixpress.com sentry.io noreply abuse no-reply subscribe mailer-daemon domain.com email.com yourname wix.com".split(" "),t=get_domain(a);b.email.forEach(h=>{h=h.replace("u003e","").toLowerCase();for(let q=0;q<y.length;++q)if(h.includes(y[q]))return;
  u.add(h);t&&h.includes(t)&&w.add(h)});b.email=0<w.size?w:u;return b}}catch(v){console.warn(`visit url error: ${a}`,v)}}

  // Load persisted state if exists
  try {
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['autoExtract', 'leads', 'seenKeys'], (res) => {
        if (res.leads && Array.isArray(res.leads)) {
          leads = res.leads;
          window.leads = leads;
          bumpCount();
        }
        if (res.seenKeys && Array.isArray(res.seenKeys)) {
          res.seenKeys.forEach(k => seen.add(k));
        }
        if (res.autoExtract) {
          autoExtract = true;
          const btn = document.getElementById('extension_gms_start_btn');
          if (btn) {
            btn.innerText = 'Stop Auto Extract';
            applyBtnStyle(btn, '#ea4335');
          }
          setStatus('Resuming extraction...');
          runExtractionLoop().catch((err) => {
            console.warn('[GMS] extraction error', err);
            autoExtract = false;
            resetStartBtn();
            setStatus('Error — check console');
            saveStateToStorage();
          });
        }
      });
    }
  } catch (e) {
    console.warn('[GMS] loadState error:', e);
  }

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
