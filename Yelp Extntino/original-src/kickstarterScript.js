(() => {
  if (window.__kickstarterScraperLoaded) return;
  window.__kickstarterScraperLoaded = true;

  let autoExtract = false;
  let leads = [];
  const seen = new Set();
  let collect_email = true;

  try {
    chrome.storage.sync.get(null, function(a) {
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

  function logDebug(msg) {
    try {
      const el = document.documentElement;
      const attr = el.getAttribute('data-yscraper-logs') || '[]';
      const arr = JSON.parse(attr);
      arr.push(msg);
      el.setAttribute('data-yscraper-logs', JSON.stringify(arr));
    } catch (_) {}
    console.log(`[Extension-Debug] ${msg}`);
  }

  function setExportCount() {
    const btn = document.getElementById('extension_gms_download_btn');
    if (btn) btn.innerText = `Export Results(${leads.length})`;
  }

  // --- Search Results Helper ---
  function getProjectLinks() {
    const links = Array.from(document.querySelectorAll('a[href*="/projects/"]'));
    const projectUrls = new Set();
    const projectUrlRegex = /\/projects\/([^\/?#]+)\/([^\/?#]+)/i;

    for (const a of links) {
      try {
        const href = String(a.href || '');
        if (!href) continue;
        const u = new URL(href, window.location.origin);
        const match = u.pathname.match(projectUrlRegex);
        if (match && !u.pathname.includes('/search') && !u.pathname.includes('/explore') && !u.pathname.includes('/categories')) {
          const canonicalPath = `/projects/${match[1]}/${match[2]}`;
          projectUrls.add(new URL(canonicalPath, window.location.origin).toString());
        }
      } catch (_) {}
    }
    return Array.from(projectUrls);
  }

  // --- Background Scraper & Parser Helpers ---
  async function fetchHtml(url) {
    try {
      logDebug(`Fetching URL: ${url}`);
      const response = await axios.get(url, { timeout: 12000 });
      const htmlSample = String(response.data || '').slice(0, 150).replace(/\s+/g, ' ');
      logDebug(`Fetched sample for ${url}: ${htmlSample}`);
      return response.data || '';
    } catch (e) {
      console.warn(`[Kickstarter] Failed to fetch URL ${url}:`, e.message);
      logDebug(`Fetch failed for ${url}: ${e.message}`);
      return '';
    }
  }

  function parseProjectPage(html, projectUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Title / Book Name
    let title = '';
    const ogTitle = doc.querySelector('meta[property="og:title"]');
    if (ogTitle) title = String(ogTitle.getAttribute('content') || '').trim();
    if (!title) {
      const titleEl = doc.querySelector('title') || doc.querySelector('h2');
      title = titleEl ? String(titleEl.textContent || '').trim() : '';
    }

    // Debugging: Log any links containing profile or creator in their href
    const debugLinks = [];
    doc.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (href.includes('profile') || href.includes('creator')) {
        debugLinks.push(href);
      }
    });
    logDebug(`Links in ${projectUrl}: ${debugLinks.slice(0, 8).join(', ')}`);

    // Creator Profile URL
    let creatorUrl = '';
    const profileAnchors = Array.from(doc.querySelectorAll('a[href*="/profile/"], a[href*="creator_profile"], a[href$="/creator"], a[href*="/creator/"]'));
    for (const a of profileAnchors) {
      const href = String(a.getAttribute('href') || '');
      // Remove projects restriction as relative profile URLs on project pages contain projects/
      if (href) {
        try {
          creatorUrl = new URL(href, projectUrl).toString();
          break;
        } catch (_) {}
      }
    }

    // Fallback: search for creator URL patterns in text
    if (!creatorUrl) {
      const links = Array.from(doc.querySelectorAll('a'));
      for (const a of links) {
        const href = String(a.getAttribute('href') || '');
        if (href.includes('/profile/') || href.includes('creator_profile') || href.endsWith('/creator') || href.includes('/creator/')) {
          try {
            creatorUrl = new URL(href, projectUrl).toString();
            break;
          } catch (_) {}
        }
      }
    }

    // Creator Name
    let creatorName = '';
    const nameEl = doc.querySelector('.creator-name, a[href*="/profile/"]');
    if (nameEl) creatorName = String(nameEl.textContent || '').trim();
    if (!creatorName) {
      const metaName = doc.querySelector('meta[name="author"]');
      if (metaName) creatorName = String(metaName.getAttribute('content') || '').trim();
    }

    return { title, creatorUrl, creatorName };
  }

  function parseCreatorProfile(html, profileUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Debugging: Log first 10 anchors found in the creator page
    const debugAnchors = [];
    doc.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (href) debugAnchors.push(href);
    });
    logDebug(`Creator ${profileUrl} anchors: ${debugAnchors.slice(0, 12).join(', ')}`);

    const websites = [];
    const socials = {
      facebook: '',
      instagram: '',
      twitter: '',
      youtube: '',
      linkedin: ''
    };

    // Find all links in the bio or websites container
    const anchors = Array.from(doc.querySelectorAll('a[href]'));
    const parsedUrls = new Set();

    for (const a of anchors) {
      const href = String(a.getAttribute('href') || '').trim();
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

      try {
        const u = new URL(href, profileUrl);
        const resolved = u.toString();
        if (parsedUrls.has(resolved)) continue;
        parsedUrls.add(resolved);

        const host = String(u.hostname || '').toLowerCase();
        if (host.includes('kickstarter.com') || host.includes('google.com') || host.includes('amazon.com') || host.includes('apple.com')) {
          continue;
        }

        if (host.includes('facebook.com') || host.includes('fb.com')) {
          socials.facebook = resolved;
        } else if (host.includes('instagram.com')) {
          socials.instagram = resolved;
        } else if (host.includes('twitter.com') || host.includes('x.com')) {
          socials.twitter = resolved;
        } else if (host.includes('youtube.com')) {
          socials.youtube = resolved;
        } else if (host.includes('linkedin.com')) {
          socials.linkedin = resolved;
        } else {
          websites.push(resolved);
        }
      } catch (_) {}
    }

    return {
      website: websites[0] || '',
      allWebsites: websites,
      socials
    };
  }

  // --- Main Extraction Loop ---
  async function runExtraction() {
    setStatus('Scanning search results for projects...');
    let stagnation = 0;
    const STAGNATION_LIMIT = 10;

    while (autoExtract) {
      const urls = getProjectLinks();
      logDebug(`Scraper loop. Found ${urls.length} project links matching /projects/`);
      const freshUrls = urls.filter(u => !seen.has(u));

      if (freshUrls.length === 0) {
        stagnation += 1;
        if (stagnation >= STAGNATION_LIMIT) {
          console.log('[Kickstarter] Stagnation limit reached; ending extraction.');
          logDebug('Extraction ended due to stagnation.');
          break;
        }
        setStatus(`Scrolling to load more projects... (${leads.length} found)`);
        window.scrollBy(0, 900);
        await sleep(1500 + Math.floor(Math.random() * 500));
        continue;
      }

      stagnation = 0;

      for (let i = 0; i < freshUrls.length && autoExtract; i += 1) {
        const projectUrl = freshUrls[i];
        seen.add(projectUrl);

        try {
          const bizId = projectUrl.split('/').slice(-2).join('_');
          setStatus(`Harvesting book: ${i + 1}/${freshUrls.length} (total: ${leads.length})`);

          // 1. Fetch Project Page
          const projectHtml = await fetchHtml(projectUrl);
          if (!projectHtml) continue;

          const projData = parseProjectPage(projectHtml, projectUrl);
          
          // Construct creator profile URL directly using username from projectUrl and /about suffix
          const username = projectUrl.split('/')[4];
          const creatorUrl = new URL(`/profile/${username}/about`, window.location.origin).toString();

          // 2. Fetch Creator Profile Page
          const creatorHtml = await fetchHtml(creatorUrl);
          if (!creatorHtml) continue;

          const profileData = parseCreatorProfile(creatorHtml, creatorUrl);

          const lead = {
            bizId,
            name: projData.creatorName || projData.title || 'Unknown Author',
            phone: '',
            email: '',
            address: 'USA',
            category: 'Author / Publisher',
            rating: '',
            reviews: '',
            website: profileData.website,
            latitude: '',
            longitude: '',
            facebook: profileData.socials.facebook,
            instagram: profileData.socials.instagram,
            twitter: profileData.socials.twitter,
            youtube: profileData.socials.youtube,
            linkedin: profileData.socials.linkedin,
            bookTitle: projData.title,
            businessUrl: projectUrl
          };

          // 3. Email Crawling (via background script)
          if (lead.website && collect_email) {
            try {
              setStatus(`Crawling email for ${lead.name}...`);
              const emailsInfo = await extractemail(lead.website, '', true);
              if (emailsInfo && emailsInfo.email) {
                lead.email = [...emailsInfo.email].join(', ');
              }
            } catch (e) {
              console.warn('[Kickstarter] Email harvester failed:', e.message);
            }
          }

          leads.push(lead);
          pushLeads();
          setExportCount();

          // Organic delay to prevent rate limits
          await sleep(1000 + Math.floor(Math.random() * 1500));
        } catch (err) {
          console.warn('[Kickstarter] Project scrape failed:', projectUrl, err);
        }
      }

      window.scrollBy(0, 900);
      await sleep(1500);
    }

    autoExtract = false;
    const startBtn = document.getElementById('extension_gms_start_btn');
    if (startBtn) {
      startBtn.innerText = 'Start Auto Extract';
      startBtn.style.cssText = '';
    }
    setStatus(`Done - ${leads.length} lead(s) extracted`);
    alert('Extraction complete!');
  }

  // --- Email Crawler Helpers (copied from contentScript.js) ---
  function decode_cf_email(a) {
    let s = "";
    let r = parseInt(a.substr(0, 2), 16);
    for (let j = 2; a.length - j; j += 2) {
      let c = parseInt(a.substr(j, 2), 16) ^ r;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function get_domain(a) {
    const k = new Set("ac ad ae af ag ai al am an ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uri uy uz va vc ve vg vi vn vu wf ws xk ye yt za zm zw".split(" "));
    try {
      const parts = (new URL(a)).host.toLowerCase().split(".");
      return k.has(parts[parts.length - 1]) ? parts[parts.length - 3] : parts[parts.length - 2];
    } catch (_) {
      return '';
    }
  }

  function normalize_social_link(a) {
    try {
      a.startsWith("//") && (a = "https:" + a);
      a.startsWith("http") || (a = "https://" + a);
      const k = new Set("/reel /about /tr /privacy /download /pg /settings /vp /profiles".split(" "));
      let e = new URL(a);
      if ("http:" === e.protocol || "" === e.protocol) e.protocol = "https:";
      "instagram.com" === e.host && (e.host = "www.instagram.com");
      "facebook.com" === e.host && (e.host = "www.facebook.com");
      "www.twitter.com" === e.host && (e.host = "twitter.com");
      "/" === e.pathname[e.pathname.length - 1] && (e.pathname = e.pathname.slice(0, -1));
      return k.has(e.pathname) ? "" : e.toString();
    } catch (k) {
      console.warn("normalize_social_link error: ", a, k);
    }
    return "";
  }

  async function extractemail(a, k, e) {
    try {
      a.startsWith("//") && (a = "https:" + a);
      a.startsWith("http") || (a = "https://" + a);
      const v = await chrome.runtime.sendMessage({ action: "access", data: { url: a } });
      if (10 > v.length) {
        console.warn("visit error: ", a);
        return null;
      }
      
      const m = v.normalize("NFKC");
      const regexes = {
        instagram: /(((http|https):\/\/)?((www\.)?(?:instagram.com|instagr.am)\/([A-Za-z0-9_.]{2,30})))/ig,
        facebook: /(?:https?:)?\/\/(?:www\.)?(?:facebook|fb)\.com\/((?![A-z]+\.php)(?!marketplace|gaming|watch|me|messages|help|search|groups)[A-z0-9_\-\.]+)\/?/ig,
        youtube: /(?:https?:)?\/\/(?:[A-z]+\.)?youtube\.com\/(channel\/([A-z0-9-_]+)|user\/([A-z0-9]+))\/?/ig,
        linkedin: /(?:https?:)?\/\/(?:[\w]+\.)?linkedin\.com\/((company|school)\/[A-z0-9-\u00c0-\u00ff\.]+|in\/[\w\-_\u00c0-\u00ff%]+)\/?/ig,
        twitter: /(?:(?:http|https):\/\/)?(?:www.)?(?:twitter.com)\/(?!(oauth|account|tos|privacy|signup|home|hashtag|search|login|widgets|i|settings|start|share|intent|oct)(['"\?\.\/]|$))([A-Za-z0-9_]{1,15})/igm,
        email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
      };

      const linksToCraw = new Set();
      const results = {};
      
      for (const h in regexes) {
        results[h] = new Set();
        const matches = m.match(regexes[h]);
        if (matches) {
          matches.forEach(q => {
            if (q) {
              if ("email" === h) {
                results[h].add(q);
              } else {
                const norm = normalize_social_link(q);
                if (norm) results[h].add(norm);
              }
            }
          });
        }
      }

      const f = new URL(a);
      try {
        const parser = new DOMParser();
        const parsedDoc = parser.parseFromString(m, "text/html");
        const cfEmailEl = parsedDoc.querySelector(".__cf_email__");
        if (cfEmailEl) {
          const hex = cfEmailEl.getAttribute("data-cfemail");
          if (hex) results.email.add(decode_cf_email(hex));
        }
      } catch (err) {
        console.warn("DOMParser parsed error: ", a, err);
      }

      // Scan page links for contact URLs
      const linkRegex = /<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1/gi;
      let match;
      const allFoundUrls = [];
      while (match = linkRegex.exec(m)) {
        try {
          allFoundUrls.push((new URL(match[2], f)).toString());
        } catch (_) {}
      }

      const contactKeywords = "/contact /contact-us /contact-me /about /about-me /about-us /team /our-team /meet-the-team /support /customer-service /feedback /help /sales return location faq".split(" ");
      for (let i = 0; i < allFoundUrls.length; i++) {
        const foundUrl = allFoundUrls[i];
        for (let j = 0; j < contactKeywords.length; j++) {
          if (foundUrl.includes(contactKeywords[j])) {
            linksToCraw.add(foundUrl);
            break;
          }
        }
      }

      // Check external matches in links
      for (let i = 0; i < allFoundUrls.length; i++) {
        try {
          const foundUrl = allFoundUrls[i];
          if (!foundUrl) continue;
          const host = (new URL(foundUrl)).host.toLowerCase();
          for (const x in regexes) {
            if (host.includes(x)) {
              if (results[x].size === 0) {
                const norm = normalize_social_link(foundUrl);
                if (norm) results[x].add(norm);
              }
              break;
            }
          }
        } catch (_) {}
      }

      // Run recursive check (depth 1)
      if (e && linksToCraw.size > 0) {
        const contactFetches = [...linksToCraw].map(async q => await extractemail(q, "", false));
        const subResults = await Promise.all(contactFetches);
        subResults.forEach(q => {
          if (q) {
            for (const x in q) {
              q[x].forEach(z => results[x].add(z));
            }
          }
        });
      }

      const filteredEmails = new Set();
      const domainSpecificEmails = new Set();
      const blacklist = ".png .jpg .jpeg .gif .webp wixpress.com sentry.io noreply abuse no-reply subscribe mailer-daemon domain.com email.com yourname wix.com".split(" ");
      const rootDomain = get_domain(a);

      results.email.forEach(h => {
        h = h.replace("u003e", "").toLowerCase();
        for (let q = 0; q < blacklist.length; q++) {
          if (h.includes(blacklist[q])) return;
        }
        filteredEmails.add(h);
        if (rootDomain && h.includes(rootDomain)) {
          domainSpecificEmails.add(h);
        }
      });

      results.email = domainSpecificEmails.size > 0 ? domainSpecificEmails : filteredEmails;
      return results;
    } catch (v) {
      console.warn(`visit url error: ${a}`, v);
      return null;
    }
  }

  // --- Toolbar DOM Mounting ---
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
        console.warn('[Kickstarter] Extraction process failed', err);
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

  function isCloudflareChallenge() {
    return !!(
      document.querySelector('#challenge-form') ||
      document.querySelector('#challenge-running-text') ||
      document.title.includes('Security Verification') ||
      document.title.includes('Just a moment') ||
      document.documentElement.innerHTML.includes('cf-challenge')
    );
  }

  function bootstrap() {
    const url = window.location.href;
    if (!url.includes('kickstarter.com')) return;

    if (isCloudflareChallenge()) {
      console.log('[Kickstarter] Cloudflare challenge page detected. Delaying toolbar mount...');
      setTimeout(bootstrap, 1000);
      return;
    }

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
})();
