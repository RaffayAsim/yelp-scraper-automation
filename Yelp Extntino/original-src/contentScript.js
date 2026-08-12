console.log("inject new script.");(()=>{var a=document.createElement("script");a.src=chrome.runtime.getURL("injected.js");a.onload=function(){this.remove()};(document.head||document.documentElement).appendChild(a)})();var auto_extract_flag=!1,processing_flag=!1,leads=[],leads_lnglat=new Set,leads_lnglat_map=new Map,find_phone_from_detail=!0,collect_email=!0,collect_phone=!0;
chrome.storage.sync.get(null,function(a){collect_phone=a.hasOwnProperty("collect_phone")&&!0===a.collect_phone?!0:!1;collect_email=a.hasOwnProperty("collect_email")&&!0===a.collect_email?!0:!1});
(()=>{
const getCurrentPageBizUrls = () => {
  const urls = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
    try {
      const data = JSON.parse(script.textContent.trim());
      if (data["@type"] === "SearchResultsPage" && data.mainEntity && data.mainEntity.itemListElement) {
        data.mainEntity.itemListElement.forEach(el => {
          if (el.item && el.item.url) {
            urls.push(new URL(el.item.url, window.location.href).toString());
          }
        });
      }
    } catch(e) {}
  });
  return urls;
};

const extractCurrentPageLeads = async () => {
  const currentLeads = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
    try {
      const data = JSON.parse(script.textContent.trim());
      if (data["@type"] === "SearchResultsPage" && data.mainEntity && data.mainEntity.itemListElement) {
        data.mainEntity.itemListElement.forEach(el => {
          if (el.item && el.item.url) {
            const urlObj = new URL(el.item.url, window.location.href);
            const pathname = urlObj.pathname;
            const parts = pathname.split('/').filter(Boolean);
            const slug = parts[parts.length - 1];
            currentLeads.push({
              bizId: slug,
              businessUrl: urlObj.toString(),
              name: el.item.name || slug
            });
          }
        });
      }
    } catch(e) {}
  });

  const unparsedLeads = currentLeads.filter(b => !leads_lnglat.has(b.bizId));
  
  const processLead = async (b) => {
    if (!auto_extract_flag) return;
    try {
      await new Promise(r => setTimeout(r, Math.random() * 1500));
      document.getElementById("extension_gms_leads_info").innerHTML = `Scraping ${b.name}...`;
      const r = await extract(b.businessUrl, b.bizId) || ["","",""];
      b.phone = r[0] || "";
      if (r[1]) b.address = r[1];
      if (r[2]) b.website = r[2];
      
      if (b.website && collect_email) {
        try {
          const d = await extractemail(b.website, "", true);
          if (d) {
            for (const f in d) {
              b[f] = [...d[f]].join();
            }
          }
        } catch (e) {
          console.warn("email error:", e);
        }
      }
      leads_lnglat.add(b.bizId);
      leads.push(b);
      document.getElementById("extension_gms_download_btn").innerText = `Export Results(${leads.length})`;
    } catch (err) {
      console.warn("Detail failed:", b.businessUrl, err);
    }
  };

  const chunkSize = 3;
  for (let i = 0; i < unparsedLeads.length; i += chunkSize) {
    if (!auto_extract_flag) break;
    const chunk = unparsedLeads.slice(i, i + chunkSize);
    await Promise.all(chunk.map(b => processLead(b)));
  }
  document.getElementById("extension_gms_leads_info").innerHTML = "";
};

var a=document.createElement("div");a.className="extension_gms_page";var k=document.createElement("span");k.id="extension_gms_leads_info";k.className="extension_gms_status";const e=document.createElement("button");e.className="extension_gms_button";e.innerText="Start Auto Extract";e.id="extension_gms_start_btn";e.addEventListener("click",async b=>{b=b.target;if(auto_extract_flag)b.innerText="Start Auto Extract",b.style="",auto_extract_flag=!1,console.log("Stop auto extract!");else{b.innerText="Stop Auto Extract";b.style="background-color: #ea4335";auto_extract_flag=!0;console.log("Start auto extract!");while(auto_extract_flag){const l=getCurrentPageBizUrls();0===l.length?console.log("No leads on page"):await extractCurrentPageLeads();if(!auto_extract_flag)break;let g=document.querySelectorAll(".next-link")[0];if(!g){window.scrollTo({top:document.body.scrollHeight,behavior:"smooth"});await new Promise(w=>setTimeout(w,3000));window.scrollTo({top:0,behavior:"smooth"});await new Promise(w=>setTimeout(w,2000));g=document.querySelectorAll(".next-link")[0]}if(!g){console.log("No next page");alert("Arrive at the Last Page!");break}const p=l[0]||"";console.log("Navigating next...");g.click();const u=Date.now();let y=!1;while(Date.now()-u<20000){await new Promise(w=>setTimeout(w,1000));const t=getCurrentPageBizUrls();if(t.length>0&&t[0]!==p){y=!0;break}}if(!y){console.warn("Page change timed out");break}console.log("Page updated");await new Promise(w=>setTimeout(w,2000))}b.innerText="Start Auto Extract";b.style="";auto_extract_flag=!1}});const m=document.createElement("button");m.className="extension_gms_button";m.innerText=`Export Results(${leads.length})`;m.id="extension_gms_download_btn";
m.style="background-color: #54aced";m.addEventListener("click",async()=>{try{for(let b=0;b<leads.length;b++){const d=leads[b].bizId;if(leads_lnglat_map.has(d)){const f=leads_lnglat_map.get(d);f&&(leads[b]={...leads[b],...f})}}}catch(b){console.error("Error adding latitude and longitude to leads:",b)}chrome.runtime.sendMessage({action:"openPage",data:leads});console.log("leads: ",leads)});const n=document.createElement("button");n.className="extension_gms_button";n.innerText="Clear";n.id="extension_gms_clear_btn";
n.style="background-color: #4167b2";n.addEventListener("click",async()=>{window.leads=[];window.leads_lnglat.clear();m.innerText=`Export Results(${leads.length})`});const diagBtn=document.createElement("button");diagBtn.className="extension_gms_button";diagBtn.innerText="Run Diagnostics";diagBtn.id="extension_gms_diagnose_btn";diagBtn.style="background-color: #e67e22; color: white;";diagBtn.addEventListener("click",async()=>{diagBtn.innerText="Diagnosing...";diagBtn.disabled=!0;try{var b={timestamp:(new Date).toISOString(),url:window.location.href,htmlLength:document.documentElement.outerHTML.length,ldJsonScripts:[],apolloScriptsCount:document.querySelectorAll("script[data-apollo-state]").length,hypernovaScriptsCount:document.querySelectorAll("script[data-hypernova-key]").length,bizLinksCount:document.querySelectorAll('a[href*="/biz/"]').length,nextLinkSelectorExists:!!document.querySelector(".next-link"),allScriptKeysFound:[],preloadedStateExists:typeof window.__PRELOADED_STATE__!=="undefined",initialStateExists:typeof window.__INITIAL_STATE__!=="undefined",foundEmailsInText:[],foundEmailsInHtml:[],emailKeysFoundInScripts:[]};var pageText=document.body?document.body.innerText:"";var pageHtml=document.documentElement.outerHTML;var emailRegex=/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;b.foundEmailsInText=[...new Set(pageText.match(emailRegex)||[])];b.foundEmailsInHtml=[...new Set(pageHtml.match(emailRegex)||[])];var findEmailKeys=(obj,path="")=>{if(!obj||typeof obj!=="object")return;for(let k in obj){if(Object.prototype.hasOwnProperty.call(obj,k)){const currentPath=path?`${path}.${k}`:k;if(k.toLowerCase().includes("email")){b.emailKeysFoundInScripts.push({path:currentPath,value:typeof obj[k]==="string"?obj[k]:JSON.stringify(obj[k]).slice(0,100)})}if(typeof obj[k]==="object")try{findEmailKeys(obj[k],currentPath)}catch(e){}}}};document.querySelectorAll('script[type="application/ld+json"]').forEach((l,g)=>{try{b.ldJsonScripts.push({index:g,content:JSON.parse(l.textContent.trim())});findEmailKeys(JSON.parse(l.textContent.trim()),`ldJson[${g}]`)}catch(p){b.ldJsonScripts.push({index:g,raw:l.textContent.slice(0,1000)})}});document.querySelectorAll('script[data-apollo-state]').forEach((l,g)=>{try{var clean=l.textContent.trim().replace(/^\x3c!--|--\x3e$/g,"");var decoded=typeof he!=="undefined"?he.decode(clean):clean;var parsed=JSON.parse(decoded);findEmailKeys(parsed,`apollo[${g}]`)}catch(p){}});["__PRELOADED_STATE__","__INITIAL_STATE__","bootstrapData","hypernova","apolloState"].forEach(l=>{if(typeof window[l]!=="undefined"){b.allScriptKeysFound.push(l);try{findEmailKeys(window[l],`window.${l}`)}catch(e){}}});var d=[];document.querySelectorAll('a[href*="/biz/"]').forEach((l,g)=>{10>g&&d.push({text:l.innerText.trim(),href:l.getAttribute("href"),classes:l.className})});b.sampleBizLinks=d;chrome.runtime.sendMessage({action:"diagnose",data:b},function(f){if(f&&f.success)alert("Diagnostics complete! Saved to debug/diagnostics_result.json");else alert("Diagnostics failed: "+(f?f.error:"no response"))})}catch(b){console.error("Diag failed:",b),alert("Diag failed: "+b.message)}finally{diagBtn.innerText="Run Diagnostics",diagBtn.disabled=!1}});a.appendChild(k);a.appendChild(e);a.appendChild(m);a.appendChild(n);a.appendChild(diagBtn);document.body.insertBefore(a,document.body.firstChild)})();function removeStartSubstring(a,k){return a.startsWith(k)?a.slice(k.length):a}
async function extract(a,k){try{console.log(`[${(new Date).toISOString()}] visit url: `,a);let e=0,m;for(;3>e;)try{document.getElementById("extension_gms_leads_info").innerHTML="Searching Phone for "+k;try{m=await axios.get(a,{timeout:1E4})}catch(g){if(g.response&&400<=g.response.status&&500>g.response.status){console.log(`Received ${g.response.status} status, opening in new tab and retrying...`);const p=window.open(a,"_blank");setTimeout(()=>{p&&!p.closed&&p.close()},3E4);await new Promise(u=>setTimeout(u,
3E4));throw Error(`HTTP ${g.response.status} error - retrying`);}throw g;}const n=(new DOMParser).parseFromString(m.data,"text/html").querySelectorAll("script[data-apollo-state]");let b="",d="",f="";if(0===n.length){console.warn("No scripts with data-apollo-state found for "+a);try{const B=(new DOMParser).parseFromString(m.data,"text/html");if(!b){const C=B.querySelector("a[href^=\"tel:\"]");C&&(b=(C.textContent||"").trim())}if(!d){const C=B.querySelector("address");C&&(d=(C.textContent||"").replace(/\s+/g," ").trim())}if(!f){const C=Array.from(B.querySelectorAll("a[href*=\"biz_redir\"]")).find(D=>D.href&&D.href.includes("url="));if(C)try{const D=new URL(C.href,"https://www.yelp.com").searchParams.get("url");D&&(f=decodeURIComponent(D))}catch(D){}}}catch(z){console.warn("fallback parse error:",z)}return[b,d,f];}n.forEach(g=>{try{const p=g.textContent.trim().replace(/^\x3c!--|--\x3e$/g,""),u=he.decode(p);let w=JSON.parse(u);for(const y in w){const t=w[y];if("BusinessLocation"===
t.__typename&&t.address)try{d=t.address.formatted.replace(/\n/g,", ")}catch(v){console.error("Error formatting address:",v)}if("Business"===t.__typename)for(const v in t){const h=t[v];if(h){if("BusinessPhoneNumber"===h.__typename)try{b=h.formatted}catch(q){console.error("Error accessing phone number:",q)}if("ExternalResources"===h.__typename)try{f=h.website.url}catch(q){console.error("Error accessing website URL:",q)}}}}}catch(p){console.error("Failed to parse JSON:",p)}});document.getElementById("extension_gms_leads_info").innerHTML=
"";const l=(new Date).toISOString();console.log(`[${l}] Name: ${k}, Phone: ${b}, Address: ${d}, Website: ${f}, Base URL: ${a}`);return[b,d,f]}catch(n){console.warn(`Attempt ${e+1} failed for ${a}:`,n);e++;if(3===e)throw n;await new Promise(b=>setTimeout(b,1E3+2E3*Math.random()))}}catch(e){console.warn(`extract phone error: ${a}`,e);return["","",""]}}function decode_cf_email(a){s="";r=parseInt(a.substr(0,2),16);for(j=2;a.length-j;j+=2)c=parseInt(a.substr(j,2),16)^r,s+=String.fromCharCode(c);return s}
function get_domain(a){const k=new Set("ac ad ae af ag ai al am an ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws xk ye yt za zm zw".split(" "));
a=(new URL(a)).host.toLowerCase().split(".");return k.has(a[a.length-1])?a[a.length-3]:a[a.length-2]}
function normalize_social_link(a){try{a.startsWith("//")&&(a="https:"+a);a.startsWith("http")||(a="https://"+a);const k=new Set("/reel /about /tr /privacy /download /pg /settings /vp /profiles".split(" "));let e=new URL(a);if("http:"===e.protocol||""===e.protocol)e.protocol="https:";"instagram.com"===e.host&&(e.host="www.instagram.com");"facebook.com"===e.host&&(e.host="www.facebook.com");"yelp.com"===e.host&&(e.host="www.yelp.com");"www.twitter.com"===e.host&&(e.host="twitter.com");"/"===e.pathname[e.pathname.length-
1]&&(e.pathname=e.pathname.slice(0,-1));return k.has(e.pathname)?"":e.toString()}catch(k){console.warn("normalize_social_link error: ",a,k)}return""}
async function extractemail(a,k,e){try{a.startsWith("//")&&(a="https:"+a);a.startsWith("http")||(a="https://"+a);const v=await chrome.runtime.sendMessage({action:"access",data:{url:a}});if(10>v.length)console.warn("visit error: ",a);else{var m=v.normalize("NFKC");k={instagram:/(((http|https):\/\/)?((www\.)?(?:instagram.com|instagr.am)\/([A-Za-z0-9_.]{2,30})))/ig,facebook:/(?:https?:)?\/\/(?:www\.)?(?:facebook|fb)\.com\/((?![A-z]+\.php)(?!marketplace|gaming|watch|me|messages|help|search|groups)[A-z0-9_\-\.]+)\/?/ig,
youtube:/(?:https?:)?\/\/(?:[A-z]+\.)?youtube\.com\/(channel\/([A-z0-9-_]+)|user\/([A-z0-9]+))\/?/ig,linkedin:/(?:https?:)?\/\/(?:[\w]+\.)?linkedin\.com\/((company|school)\/[A-z0-9-\u00c0-\u00ff\.]+|in\/[\w\-_\u00c0-\u00ff%]+)\/?/ig,twitter:/(?:(?:http|https):\/\/)?(?:www.)?(?:twitter.com)\/(?!(oauth|account|tos|privacy|signup|home|hashtag|search|login|widgets|i|settings|start|share|intent|oct)(['"\?\.\/]|$))([A-Za-z0-9_]{1,15})/igm,email:/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi};var n=new Set,
b={};for(const h in k){b[h]=new Set;var d=m.match(k[h]);d&&d.forEach(q=>{q&&("email"===h?b[h].add(q):(q=normalize_social_link(q))&&b[h].add(q))})}var f=new URL(a);try{var l=(new DOMParser).parseFromString(m,"text/html").querySelector(".__cf_email__");if(l){const h=l.getAttribute("data-cfemail");h&&b.email.add(decode_cf_email(h))}}catch(h){console.warn("DOMParser parsed error: ",a,h)}l=/<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1/gi;d=[];for(var g;g=l.exec(m);)try{d.push((new URL(g[2],f)).toString())}catch(h){console.warn("find links failed: ",
g[2],h)}m="/contact /contact-us /contact-me /about /about-me /about-us /team /our-team /meet-the-team /support /customer-service /feedback /help /sales return location faq".split(" ");for(f=0;f<d.length;f++){var p=d[f];for(g=0;g<m.length;++g)if(p.includes(m[g])){n.add(p);break}}for(p=0;p<d.length;p++)try{const h=d[p];if(!h)continue;const q=(new URL(h)).host.toLowerCase();for(const x in k)if(q.includes(x)){if(0>=b[x].size){const z=normalize_social_link(h);z&&b[x].add(z)}break}}catch(h){console.warn(`error: ${d[p]}`,
h)}if(e&&0<n.size){const h=[...n].map(async q=>await extractemail(q,"",!1));(await Promise.all(h)).map(q=>{if(q)for(const x in q)q[x].forEach(z=>{b[x].add(z)})})}console.log("Email for : ",a,b,[...n].join());var u=new Set,w=new Set,y=".png .jpg .jpeg .gif .webp wixpress.com sentry.io noreply abuse no-reply subscribe mailer-daemon domain.com email.com yourname wix.com".split(" "),t=get_domain(a);b.email.forEach(h=>{h=h.replace("u003e","").toLowerCase();for(let q=0;q<y.length;++q)if(h.includes(y[q]))return;
u.add(h);t&&h.includes(t)&&w.add(h)});b.email=0<w.size?w:u;return b}}catch(v){console.warn(`visit url error: ${a}`,v)}}function formatMinutesToHHMM(a){const k=a%60;return String(Math.floor(a/60)).padStart(2,"0")+":"+String(k).padStart(2,"0")}
function decodeOperationHours(a){const k="Monday Tuesday Wednesday Thursday Friday Saturday Sunday".split(" "),e={};(a.regularHoursMergedWithSpecialHoursForCurrentWeek||[]).forEach((m,n)=>{m=(m.regularHoursRaw||[]).flatMap(([b,d])=>{const f=1440*n;b-=f;d-=f;return d<b?[[b,1440],[0,d]]:[[b,d]]});e[k[n]]=m.length?m.map(([b,d])=>`${formatMinutesToHHMM(b)}-${formatMinutesToHHMM(d)}`).join(", "):"Closed"});return e}
window.addEventListener("message",async function(a){if("search"==a.data.type){processing_flag=!0;try{if(feed=a.data.data.searchPageProps.mainContentComponentsListProps){a=[];for(var k=0;k<feed.length;++k)try{item=feed[k];const b=item.searchResultLayoutType;console.log(b);if("separator"==b)continue;const d=item.bizId;if(!d)continue;if(item.searchResultBusiness?.isAd)continue;if(leads_lnglat.has(d))continue;const f=new URL(window.location.href),l=(new URL(item.businessUrl,f)).toString();(item.searchResultBusiness?.categories||
[]).map(g=>g.title).join(",");var e="";try{e=item.snippet?.text}catch(g){console.error("Error getting snippet text:",g),e=""}a.push({bizId:item.bizId,businessUrl:l,snippet:e})}catch(b){console.error(b)}var m=a.map(async b=>{try{if(!b.phone||!b.address){const d=Math.floor(8E3+1E4*Math.random());await new Promise(p=>setTimeout(p,d));const r=await extract(b.businessUrl,b.bizId)||["","",""];const f=r[0]||"",l=r[1]||"",g=r[2]||"";b.phone=f;l&&0<l.length&&(b.address=l);g&&0<g.length&&(b.website=g)}}catch(d){console.warn("collect phone error: ",b,d)}try{if(b.website){const d=
await extractemail(b.website,"",!0);if(d)for(const f in d)b[f]=[...d[f]].join()}}catch(d){console.warn("collect email error: ",b,d)}return b});document.getElementById("extension_gms_leads_info").innerHTML="Searching Emails... ";var n=await Promise.all(m);document.getElementById("extension_gms_leads_info").innerHTML="";for(m=0;m<n.length;++m){const b=n[m].bizId;leads_lnglat.has(b)||(leads_lnglat.add(b),leads.push(n[m]))}document.getElementById("extension_gms_download_btn").innerText=`Export Results(${leads.length})`;
console.log(leads)}processing_flag=!1}catch(b){console.warn(b),processing_flag=!1}}else if("map"==a.data.type)try{a.data.data instanceof Blob?(e=await (new Response(a.data.data)).text(),k=JSON.parse(e)):k=JSON.parse(a.data.data),Array.isArray(k)&&k.forEach(b=>{b.data&&b.data.businesses&&b.data.businesses.forEach(d=>{try{let f={bizId:d.encid,name:d.name,categories:d.categories?.map(g=>g.title).join(","),rating:d.rating,reviewCount:d.reviewCount,priceRange:d.priceRange,latitude:d.location?.geoCoordinate?.latitude,
longitude:d.location?.geoCoordinate?.longitude},l={};try{d.operationHours&&(l=decodeOperationHours(d.operationHours),f.operationHours=l)}catch(g){console.warn("Error decoding operation hours:",g)}if(leads_lnglat_map.has(f.bizId)){const g=leads_lnglat_map.get(f.bizId);Object.keys(f).forEach(p=>{f[p]&&(g[p]=f[p])})}else leads_lnglat_map.set(f.bizId,f)}catch(f){console.warn("Error processing business data:",f)}})})}catch(b){console.error("Error parsing GQL data:",b)}});

(()=>{const mergeLiveLeadData=()=>{try{if(!Array.isArray(window.leads))return;for(let a=0;a<window.leads.length;a++){const k=window.leads[a];if(!k||!k.bizId)continue;const e=leads_lnglat_map.get(k.bizId);e&&(window.leads[a]={...e,...k,name:k.name||e.name||"",categories:k.categories||e.categories||"",rating:k.rating||e.rating||"",reviewCount:k.reviewCount||e.reviewCount||"",priceRange:k.priceRange||e.priceRange||"",latitude:k.latitude||e.latitude||"",longitude:k.longitude||e.longitude||"",operationHours:k.operationHours||e.operationHours||""})}}catch(a){}};const sync=()=>{try{mergeLiveLeadData();const snapshot=Array.isArray(window.leads)?window.leads:[];document.documentElement.setAttribute("data-yscraper-live-leads",JSON.stringify(snapshot));chrome&&chrome.storage&&chrome.storage.local&&chrome.storage.local.set({leads:snapshot});}catch(a){}};sync();setInterval(sync,1500);})();
