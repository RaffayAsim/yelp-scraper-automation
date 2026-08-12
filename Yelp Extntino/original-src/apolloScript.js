(() => {
  if (window.__apolloScraperLoaded) return;
  window.__apolloScraperLoaded = true;

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

  function logDebug(msg) {
    try {
      const el = document.documentElement;
      const attr = el.getAttribute('data-yscraper-logs') || '[]';
      const arr = JSON.parse(attr);
      arr.push(msg);
      el.setAttribute('data-yscraper-logs', JSON.stringify(arr));
    } catch (_) {}
    console.log(`[Apollo-Debug] ${msg}`);
  }

  function setExportCount() {
    const btn = document.getElementById('extension_gms_download_btn');
    if (btn) btn.innerText = `Export Results(${leads.length})`;
  }

  // --- Lead Extraction logic for Apollo.io ---
  // Since Apollo lists contacts/companies in a table or list, we can scan the DOM
  // for common indicators of a row (e.g. [data-cy="grid-row"], elements with classes containing 'row', or elements inside a table/tbody)
  async function extractPageLeads() {
    logDebug("Scanning page for leads...");
    const pageLeads = [];

    // Let's look for grid rows, table rows, or div elements acting as rows
    const rowSelectors = [
      '[data-cy="grid-row"]',
      'tr',
      'div[role="row"]',
      '.apollo-row',
      '[class*="grid-row"]',
      '[class*="TableRow"]'
    ];

    let rows = [];
    for (const selector of rowSelectors) {
      const found = document.querySelectorAll(selector);
      if (found && found.length > 0) {
        rows = Array.from(found);
        logDebug(`Found ${rows.length} rows using selector: ${selector}`);
        break;
      }
    }

    // Fallback: search for elements containing emails or elements inside a list
    if (rows.length === 0) {
      logDebug("No rows found by standard selectors. Scanning generic container elements.");
      // Look for elements that might contain individual contact structures
      const genericContainers = document.querySelectorAll('[class*="item"], [class*="card"], [class*="container"]');
      rows = Array.from(genericContainers).filter(el => {
        // Must contain at least name-like elements or contact info
        return el.querySelector('a[href*="/people/"]') || el.querySelector('a[href*="/companies/"]') || el.textContent.includes('@');
      });
      logDebug(`Found ${rows.length} rows by generic containers fallback.`);
    }

    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;

    rows.forEach((row, index) => {
      try {
        let name = '';
        let title = '';
        let address = ''; // location
        let phone = '';
        let email = '';
        let website = '';
        let linkedin = '';

        // 1. Look for links to person profile
        const personLink = row.querySelector('a[href*="/people/"], a[href*="profile"]');
        if (personLink) {
          name = personLink.textContent.trim();
          try {
            const u = new URL(personLink.getAttribute('href'), window.location.origin);
            // Deduplicate path as ID
            const pathParts = u.pathname.split('/').filter(Boolean);
            const id = pathParts[pathParts.length - 1] || name;
            linkedin = id; // use path as ID/ref
          } catch (_) {}
        }

        // 2. Look for links to company profile
        const companyLink = row.querySelector('a[href*="/companies/"], a[href*="company"]');
        let companyName = '';
        if (companyLink) {
          companyName = companyLink.textContent.trim();
        }

        // 3. Fallbacks for name and title from raw text content
        const allText = row.innerText || '';
        const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);

        if (!name && lines.length > 0) {
          name = lines[0];
        }

        // If companyName exists, we can append it or use it as category/org
        title = lines.find(line => {
          const lower = line.toLowerCase();
          return !lower.includes(name.toLowerCase()) && 
                 !lower.includes('@') && 
                 !lower.includes('location') && 
                 (lower.includes('manager') || lower.includes('developer') || lower.includes('engineer') || lower.includes('director') || lower.includes('founder') || lower.includes('lead') || lower.includes('vp') || lower.includes('sales') || lower.includes('marketing') || lower.includes('ceo') || lower.includes('cto') || lower.includes('executive'));
        }) || '';

        // Find email address on the row
        const emailMatch = allText.match(emailRegex);
        if (emailMatch) {
          email = emailMatch[0];
        }

        // Find phone number on the row
        const phoneMatch = allText.match(phoneRegex);
        if (phoneMatch) {
          phone = phoneMatch[0];
        }

        // Find location / address on the row
        // Usually contains city, state, or country
        address = lines.find(line => {
          const lower = line.toLowerCase();
          // Check for locations (e.g. USA, London, San Francisco, CA, United States, UK)
          return (lower.includes('united states') || lower.includes('san francisco') || lower.includes('new york') || lower.includes('london') || lower.includes('chicago') || lower.includes('california') || lower.includes('texas') || lower.includes('canada') || lower.includes(', ca') || lower.includes(', ny') || lower.includes(', tx') || lower.includes(', uk') || lower.includes(', de') || lower.includes(', fr') || lower.includes('germany') || lower.includes('france') || lower.includes('australia'));
        }) || '';

        // Find company website or external links
        const extLinks = Array.from(row.querySelectorAll('a[href]'));
        for (const link of extLinks) {
          const href = link.getAttribute('href') || '';
          if (href.includes('linkedin.com')) {
            linkedin = href;
          } else if (href.includes('twitter.com') || href.includes('x.com')) {
            // social
          } else if (!href.includes('apollo.io') && !href.startsWith('/') && !href.startsWith('#') && !href.startsWith('javascript:')) {
            try {
              website = new URL(href).toString();
            } catch (_) {}
          }
        }

        if (name && name.length > 1) {
          const bizId = linkedin || email || name;
          if (bizId && !seen.has(bizId)) {
            seen.add(bizId);
            const leadData = {
              bizId,
              name,
              category: title ? `${title} (at ${companyName || 'Unknown'})` : (companyName || 'Apollo Lead'),
              address: address || 'Global',
              phone: phone || '',
              email: email || '',
              website: website || '',
              linkedin: linkedin || '',
              businessUrl: window.location.href
            };
            pageLeads.push(leadData);
          }
        }
      } catch (err) {
        console.warn("Row parse failed:", err);
      }
    });

    return pageLeads;
  }

  // Find next page button and click it
  async function navigateToNextPage() {
    logDebug("Attempting to find next page button...");
    const nextBtnSelectors = [
      'button[aria-label="Next"]',
      'button[aria-label*="next" i]',
      'button[class*="pagination-next"]',
      '.pagination-next',
      '[class*="pagination" i] button:last-child',
      'button:not([disabled]) .fa-chevron-right',
      'button:not([disabled]) svg[data-icon="chevron-right"]'
    ];

    let nextBtn = null;
    for (const selector of nextBtnSelectors) {
      const el = document.querySelector(selector);
      if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true') {
        // Make sure it's indeed the next button (or has arrow structure)
        nextBtn = el;
        break;
      }
    }

    // Fallback: search all buttons containing text like "Next" or ">"
    if (!nextBtn) {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      nextBtn = buttons.find(btn => {
        const text = (btn.innerText || '').trim();
        return (text === 'Next' || text === '>' || text === '→') && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
      });
    }

    if (nextBtn) {
      logDebug("Clicking next page button...");
      nextBtn.click();
      return true;
    }

    logDebug("Next page button not found or is disabled.");
    return false;
  }

  // --- Main Extraction Loop ---
  async function runExtraction() {
    logDebug("Starting Apollo extraction loop...");
    setStatus('Running extraction...');

    while (autoExtract) {
      // 1. Scrape current page leads
      const extracted = await extractPageLeads();
      if (extracted.length > 0) {
        leads.push(...extracted);
        pushLeads();
        setExportCount();
        setStatus(`Extracted ${extracted.length} leads (Total: ${leads.length})`);
      } else {
        logDebug("No new leads found on this page.");
      }

      await sleep(2500 + Math.random() * 1500);

      if (!autoExtract) break;

      // 2. Navigate to next page
      const hasNext = await navigateToNextPage();
      if (!hasNext) {
        logDebug("Last page reached or next button unavailable.");
        setStatus(`Scrape completed — ${leads.length} leads extracted`);
        alert('Extraction complete! Click Export Results to save.');
        autoExtract = false;
        resetStartBtn();
        break;
      }

      setStatus('Waiting for next page to load...');
      // Wait for page transition
      await sleep(5000 + Math.random() * 2000);
    }
  }

  function resetStartBtn() {
    const btn = document.getElementById('extension_gms_start_btn');
    if (btn) {
      btn.innerText = 'Start Auto Extract';
      applyBtnStyle(btn, '#1a73e8');
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
      'white-space:nowrap',
      'display:inline-block',
      'margin:0'
    ].join(';');
  }

  function mountToolbar() {
    if (document.getElementById('extension_gms_start_btn')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'extension_gms_toolbar_wrapper';
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
        console.warn('[Apollo] Extraction process failed', err);
        autoExtract = false;
        resetStartBtn();
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
        logDebug("Diagnosing Apollo DOM structure...");
        const d = {
          timestamp: (new Date()).toISOString(),
          url: window.location.href,
          htmlLength: document.documentElement.outerHTML.length,
          title: document.title,
          tablesFound: [],
          gridsFound: [],
          customElementsCount: document.querySelectorAll('*').length,
          apolloStateDetected: typeof window.__APOLLO_STATE__ !== 'undefined',
          nextDataDetected: typeof window.__NEXT_DATA__ !== 'undefined',
          dataCyElements: [],
          dataTestIdElements: [],
          paginationControls: [],
          sampleRowsData: [],
          visibleEmails: [],
          visiblePhones: []
        };

        // 1. Scan for standard HTML tables
        document.querySelectorAll('table').forEach((table, index) => {
          const headers = Array.from(table.querySelectorAll('th, td[role="columnheader"]')).map(el => el.textContent.trim());
          const rowsCount = table.querySelectorAll('tr').length;
          d.tablesFound.push({
            index,
            classes: table.className,
            headers,
            rowsCount
          });
        });

        // 2. Scan for elements acting as role="grid" or role="table"
        document.querySelectorAll('[role="grid"], [role="table"]').forEach((grid, index) => {
          const headers = Array.from(grid.querySelectorAll('[role="columnheader"]')).map(el => el.textContent.trim());
          const rowsCount = grid.querySelectorAll('[role="row"]').length;
          d.gridsFound.push({
            index,
            role: grid.getAttribute('role'),
            classes: grid.className,
            headers,
            rowsCount
          });
        });

        // 3. Scan for pagination controls
        const paginationSelectors = [
          '.pagination',
          '[class*="pagination" i]',
          '[class*="page" i]',
          'button[aria-label*="next" i]',
          'button[aria-label*="page" i]',
          'button[aria-label*="prev" i]'
        ];
        const seenPagination = new Set();
        paginationSelectors.forEach(selector => {
          document.querySelectorAll(selector).forEach(el => {
            const tag = el.tagName.toLowerCase();
            const text = el.textContent.trim();
            const key = `${tag}:${text}:${el.className}`;
            if (!seenPagination.has(key)) {
              seenPagination.add(key);
              d.paginationControls.push({
                selector,
                tag,
                text: text.slice(0, 100),
                classes: el.className,
                attributes: Array.from(el.attributes).map(attr => ({ name: attr.name, value: attr.value }))
              });
            }
          });
        });

        // 4. Capture testing/cy attributes
        document.querySelectorAll('[data-cy]').forEach((el, index) => {
          if (index < 30) {
            d.dataCyElements.push({
              tag: el.tagName.toLowerCase(),
              cy: el.getAttribute('data-cy'),
              classes: el.className,
              text: el.textContent.trim().slice(0, 100)
            });
          }
        });

        document.querySelectorAll('[data-testid], [data-test], [data-qa]').forEach((el, index) => {
          if (index < 30) {
            d.dataTestIdElements.push({
              tag: el.tagName.toLowerCase(),
              attrName: el.hasAttribute('data-testid') ? 'data-testid' : el.hasAttribute('data-test') ? 'data-test' : 'data-qa',
              value: el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa'),
              classes: el.className,
              text: el.textContent.trim().slice(0, 100)
            });
          }
        });

        // 5. Gather window-level variables keys
        const interestingWindowVars = ['__APOLLO_STATE__', '__NEXT_DATA__', 'apolloState', 'preloadedState', 'bootstrapData'];
        d.windowStateKeys = {};
        interestingWindowVars.forEach(v => {
          if (typeof window[v] !== 'undefined') {
            try {
              d.windowStateKeys[v] = Object.keys(window[v]).slice(0, 50);
            } catch (err) {
              d.windowStateKeys[v] = `Error: ${err.message}`;
            }
          }
        });

        // 6. Capture sample row data/structures
        const possibleRows = document.querySelectorAll('[data-cy="grid-row"], tr, div[role="row"], .apollo-row, [class*="grid-row"], [class*="TableRow"]');
        possibleRows.forEach((row, index) => {
          if (index < 10) {
            const cells = Array.from(row.querySelectorAll('td, [role="gridcell"], div > div')).map(el => ({
              text: el.textContent.trim(),
              classes: el.className,
              attributes: Array.from(el.attributes).map(a => ({ name: a.name, value: a.value })).slice(0, 5)
            })).slice(0, 10);
            d.sampleRowsData.push({
              index,
              tag: row.tagName.toLowerCase(),
              classes: row.className,
              cells
            });
          }
        });

        // 7. Regex match emails and phones
        const textContent = document.body ? document.body.innerText : '';
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
        d.visibleEmails = [...new Set(textContent.match(emailRegex) || [])].slice(0, 50);
        d.visiblePhones = [...new Set(textContent.match(phoneRegex) || [])].slice(0, 50);

        // Send diagnostics data to backend server
        chrome.runtime.sendMessage({ action: 'diagnose', data: d }, (res) => {
          if (res && res.success) {
            alert('Diagnostics complete! Saved to debug/diagnostics_result.json');
          } else {
            alert('Diagnostics failed: ' + (res ? res.error : 'no response'));
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

    // Shift body down
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
    if (!url.includes('apollo.io')) return;

    if (isCloudflareChallenge()) {
      console.log('[Apollo] Cloudflare challenge detected. Retrying...');
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
