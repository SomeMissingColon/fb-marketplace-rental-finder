// ==UserScript==
// @name         FB Marketplace Rental Saver
// @namespace    local.fbm-rental-saver
// @version      5.1.0
// @downloadURL  http://127.0.0.1:46653/fb-marketplace-rental-app.user.js
// @updateURL    http://127.0.0.1:46653/fb-marketplace-rental-app.user.js
// @description  Runs a set of French + English Marketplace searches (newest first) for rentals around Montréal, tracks every listing locally (facts + description, no images), logs prices over time and exports a JSON snapshot.
// @match        https://*.facebook.com/*
// @noframes
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      fbcdn.net
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

/*
 * HOW IT WORKS
 *  - "Run all queries": the script builds the search URLs itself (French + English keywords, your area and
 *    max price, sorted by newest) and visits them one after the other in THIS tab (a visible tab is needed
 *    for the results to scroll-load). The run survives the page reloads: its state lives in GM storage.
 *    Each query stops early once it meets several already-known listings in a row (newest first), so
 *    repeat runs are short. Every few runs a FULL pass scrolls every query to the end, which is the only
 *    time listings that vanished can be flagged as gone.
 *  - New listings are opened one at a time in a background tab (long random pauses between them). That tab
 *    runs this same script in "worker" mode: it reads the listing's embedded page data and hands it back
 *    through GM storage. A plain fetch() of a listing URL does NOT contain the listing data.
 *  - Each listing is classified: structured (filed under Rentals), text-only (a rental filed in some other
 *    category, typically lease transfers) or unrelated (skipped for good). Bedrooms are inferred from the text
 *    when the ad has none ("4½" = 2 bedrooms in Québec notation).
 *  - Local history (userscript storage): every tracked listing with its price history, plus a per-scan price
 *    log used for the market price evolution. Known listings are never reopened; their price is updated
 *    from the search card. History is committed only when the snapshot has been produced.
 *  - Output: one JSON snapshot (schema 2: listings + scan log). CSV of everything tracked from the panel.
 *    No images are downloaded. Seller names/IDs are not collected.
 *  - If Facebook shows a "going too fast / temporarily blocked" page the run stops and saves what it has.
 *
 *  Keep the tab in the foreground while a run is in progress. Stop = save what's done so far.
 */
(function () {
  'use strict';
  /*__FBM_ANALYSIS__*/
  /*__FBM_DASHBOARD__*/

  const CFG = {
    // ---- what to look for
    maxPrice: 2000,            // monthly rent cap (also sent to Facebook; 0 = none)
    beds: { min: 2, max: 2 },  // pre-filter on the card title only; unknown bedroom count is kept. null = off
    skipRooms: true,           // skip "Private room for rent" style listings
    area: { latitude: 45.44, longitude: -73.25, radius: 54 }, // km; centre of the search area (rounded on purpose: use your own)
    sortBy: 'creation_time_descend', // "Date listed: Newest first" (confirmed in the page's sort label)
    // ---- scanning
    stopAfterKnown: 15,        // newest-first: stop a query after this many known cards in a row (0 = never)
    fullScanEvery: 5,          // every Nth run scrolls every query to the end (needed to flag gone listings)
    fullScan: false,           // force a full pass now
    maxResultsPerQuery: 150,   // safety cap per query
    maxNewPerRun: 40,          // open at most this many NEW listings per run; the rest wait for the next run (0 = all)
    refreshKnown: false,       // true = re-open and re-read listings already in history
    scrollStepMs: 500,
    queryGapMs: [8000, 16000], // pause before moving to the next query
    // ---- reading listings
    itemTimeoutMs: 60000,
    photos: { max: 5, maxPx: 800, quality: 0.72, timeoutMs: 20000 }, // photos kept per listing, downscaled JPEGs in this browser's IndexedDB (0 = none)
    autoDownload: false,       // also download a JSON snapshot at the end of each run (the dashboard in the page needs no file)
    tabGapMs: [6000, 14000],
    breakEvery: 10,
    pace: { stopAfterFails: 3, slowFactor: 1.6, maxSlow: 4, longBreakEvery: [25, 40], longBreakMs: [150000, 300000], dailyBudget: 250, cooldownHours: 48 },
    breakMs: [25000, 45000],
    // ---- bookkeeping
    campaignTtlMs: 3 * 3600 * 1000,
    scanLogKeep: 200,
  };
  const DEFAULT_QUERIES = [
    '2 bedroom apartment', 'apartment for rent', 'lease transfer', 'sublet',
    'appartement 2 chambres', '4 1/2 à louer', '4½', 'cession de bail', 'logement à louer', 'sous-location',
  ];
  const RENTALS_CATEGORY_ID = '1468271819871448'; // Marketplace "Property Rentals" (seen in the page data)
  const MIN_RENT = 300, MAX_RENT = 10000;         // outside this a "price" is a placeholder, not a monthly rent
  const ROOM_RE = /private room|chambre priv[ée]e|room for rent|chambre à louer|roommate|colocataire|colocation/i;
  const BLOCK_RE = /going too fast|temporarily blocked|temporarily restricted|trop rapidement|temporairement bloqu|temporairement restreint/i;
  const RENT_VERB = /for rent|a louer|louer|loyer|cession|transfert de bail|reprise de bail|lease|sublet|sublease|sous-?loc|bail\b|par mois|per month|\/\s?mois|\/\s?month|\/\s?mo\b|monthly|mensuel/;
  const DWELLING = /\d\s?(?:1\/2|½)|chambre|bedroom|\bbd\b|\bbr\b|studio|bachelor|apartment|appartement|logement|condo|loft|duplex|triplex|maison|house|townhouse/;
  const HKEY = 'fbm_history_v1', CKEY = 'fbm_campaign', QKEY = 'fbm_queries', SKEY = 'fbm_settings';
  const SETTING_KEYS = ['maxPrice', 'beds', 'skipRooms', 'maxNewPerRun', 'refreshKnown']; // fullScan is deliberately one-shot
  function loadSettings() { // the run reloads the page for every search, so panel changes must live in storage, not in memory
    try { const v = JSON.parse(GM_getValue(SKEY) || 'null'); if (v) for (const k of SETTING_KEYS) if (k in v) CFG[k] = v[k]; } catch { /* defaults */ }
  }
  function saveSettings() { const v = {}; for (const k of SETTING_KEYS) v[k] = CFG[k]; GM_setValue(SKEY, JSON.stringify(v)); }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = ([a, b]) => a + Math.random() * (b - a);
  const itemIdFromPath = (p) => (p.match(/^\/marketplace\/item\/(\d+)/) || [])[1] || null;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const fmtTime = (s) => { s = Math.max(0, Math.round(s)); return pad(Math.floor(s / 60)) + ':' + pad(s % 60); };
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const credible = (p) => p != null && p >= MIN_RENT && p <= MAX_RENT;

  // ---------------------------------------------------------------------------
  // Run state in memory (a reload starts again from the saved campaign)
  // ---------------------------------------------------------------------------
  const state = {
    running: false, stop: false, paused: false, phase: 'idle', msg: '', startedAt: 0, lastActivity: 0,
    nq: 0, qi: 0, qlabel: '', qfound: 0, total: 0, listingsDone: 0, listingsFailed: 0, ignoredN: 0,
    fileUrl: null, fileName: '', fileBytes: 0,
  };
  const touch = () => { state.lastActivity = Date.now(); };
  function setStatus(msg) { state.msg = msg; touch(); paint(); }

  async function politePause(ms, label) { // 1s steps: visible countdown, Stop stays responsive
    const end = Date.now() + ms;
    while (!state.stop) {
      const left = end - Date.now();
      if (left <= 0) return;
      setStatus(`${label} ${Math.ceil(left / 1000)}s…`);
      await sleep(Math.min(1000, left));
    }
  }

  // ---------------------------------------------------------------------------
  // Text helpers: bedrooms, rent, rental signals (bilingual)
  // ---------------------------------------------------------------------------
  const WORD_NUM = { un: 1, une: 1, one: 1, deux: 2, two: 2, trois: 3, three: 3, quatre: 4, four: 4, cinq: 5, five: 5 };
  function bedroomsIn(text) {
    const t = fold(text);
    let m = t.match(/\b(\d|un|une|deux|trois|quatre|cinq|one|two|three|four|five)[\s-]*(?:chambres?|bedrooms?|beds?|bdrms?|bd|br)\b/);
    if (m) return /^\d$/.test(m[1]) ? +m[1] : WORD_NUM[m[1]];
    m = t.match(/(?:^|[^\d])(\d)\s?(?:1\/2|½|et demi)/); // Québec rooms: 3½ = 1 bedroom, 4½ = 2, 5½ = 3
    if (m) return +m[1] <= 2 ? 0 : +m[1] - 2;
    if (/\b(studio|bachelor|garconniere)\b/.test(t)) return 0;
    return null;
  }
  // Room-in-a-shared-flat ads (colocation) often carry a generic title like "2 Beds 1 Bath", so the description decides.
  // "Ideal for roommates" is a pitch to tenants, not a shared flat, and is blanked out first.
  const PITCH_RE = /(?:ideal|perfect|great|parfait|id[eé]al|convient)[^.!?\n]{0,70}?(?:roommates?|room-?mates?|colocataires?|colocs?|colocation)/gi;
  const SHARED_RE = new RegExp([
    'roommates? wanted', 'looking for (?:a |an |one )?(?:\\w+ ){0,2}(?:roommates?|room-?mates?|colocataire|coloc)', 'recherche (?:un |une )?(?:\\w+ )?(?:colocataire|coloc)',
    '(?:^|[^a-z])(?:furnished |private |small |big |spacious )?room (?:for rent|available|to rent|in (?:a |an |my |our )?(?:shared |\\w+ )?(?:apartment|flat|house|condo))',
    'chambre (?:meubl[eé]e |priv[eé]e |disponible )?(?:[aà] louer|dans (?:un|une|le|mon|notre))', 'chambre (?:meubl[eé]e|priv[eé]e)',
    '(?:dans|en) coloc(?:ation)?\\b', 'colocation (?:de|avec|a|[aà]) ', 'colocs? (?:en or|sympa|cool)',
    'shar(?:e|ing) (?:the|an?|my|our) (?:apartment|flat|house|place|home|kitchen|bathroom|living)', 'tu partageras', 'vous partagerez', 'partage(?:r|ras|z)? (?:l.|le |la |un |une |mon |notre )?(?:appartement|logement|maison|cuisine|salle de bain)',
    'shared (?:apartment|flat|kitchen|bathroom|living room|accommodation)', 'logement partag[eé]', 'per room', 'par chambre',
  ].join('|'), 'i');
  function sharedHousing(title, description, rent, bedrooms) {
    const t = String(title || '') + '\n' + String(description || '').replace(PITCH_RE, ' ');
    const m = t.match(SHARED_RE);
    if (m) return `room in a shared flat ("${m[0].slice(0, 40)}")`;
    if (rent && bedrooms && rent / Math.max(1, bedrooms) < 350 && bedrooms >= 2) return `rent ${rent}$ for ${bedrooms} bedrooms is room-level`;
    return '';
  }
  function inferBedrooms(title, description) {
    const a = bedroomsIn(title);
    return a != null ? a : bedroomsIn(description);
  }
  function inferRentFromText(text) { // for ads whose listed price is a placeholder like $1 or $0
    const t = String(text || '');
    // amounts like 1450, 1 450 (French thousands space), 1,450 or 1.450, with an optional cents part
    const re = /\$\s*(\d{1,2}[ \u00a0,.]\d{3}|\d{3,4})(?:[.,]\d{2})?|(\d{1,2}[ \u00a0,.]\d{3}|\d{3,4})(?:[.,]\d{2})?\s*\$/g;
    const cands = [];
    for (let m; (m = re.exec(t));) {
      const v = +String(m[1] || m[2]).replace(/[ \u00a0,.]/g, '');
      if (v < MIN_RENT || v > 6000) continue;
      const near = fold(t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30));
      cands.push({ v, rentWord: /mois|month|\/mo|loyer|rent/.test(near) });
    }
    return (cands.find((c) => c.rentWord) || (cands.length === 1 ? cands[0] : null) || {}).v || null;
  }
  function detectBlock() {
    try { return BLOCK_RE.test(String((document.body && document.body.innerText) || '').slice(0, 4000)); } catch { return false; }
  }

  // ---------------------------------------------------------------------------
  // History (persists in the userscript's storage) + the active run ("campaign")
  // ---------------------------------------------------------------------------
  function loadHistory() {
    try {
      const h = JSON.parse(GM_getValue(HKEY) || 'null');
      if (h && h.listings) { h.ignored = h.ignored || {}; h.scanLog = h.scanLog || []; h.pending = h.pending || {}; return h; }
    } catch { /* fall through */ }
    return { scans: 0, listings: {}, ignored: {}, scanLog: [], pending: {} };
  }
  function saveHistory(h) { GM_setValue(HKEY, JSON.stringify(h)); }
  function loadCampaign() {
    try { const c = JSON.parse(GM_getValue(CKEY) || 'null'); if (c && Date.now() - c.updatedAt < CFG.campaignTtlMs) return c; } catch { /* none */ }
    return null;
  }
  function saveCampaign(c) { c.updatedAt = Date.now(); GM_setValue(CKEY, JSON.stringify(c)); }
  // While listings are being read the page does not reload, so the state need not be written after every listing:
  // the whole campaign (every search card + every record read so far) is one big value, and a userscript manager
  // hands its stored values to each tab it opens, so writing and loading it 150 times slows every listing tab.
  let ckptN = 0;
  function checkpoint(c, force) {
    if (!force && ++ckptN % 5 !== 0) return;
    const txt = JSON.stringify(c);
    c.updatedAt = Date.now();
    GM_setValue(CKEY, JSON.stringify(c));
    if (ckptN % 25 === 0 || force) console.info(`[FBM] campaign state ${(txt.length / 1024).toFixed(0)} KB, history ${((GM_getValue(HKEY) || '').length / 1024).toFixed(0)} KB`);
  }
  function clearCampaign() { GM_deleteValue(CKEY); }

  function queryList() {
    try { const v = JSON.parse(GM_getValue(QKEY) || 'null'); if (Array.isArray(v) && v.length) return v.map(String).filter(Boolean); } catch { /* defaults */ }
    return DEFAULT_QUERIES.slice();
  }
  function searchUrl(q) {
    const p = new URLSearchParams({ query: q, sortBy: CFG.sortBy, exact: 'false' });
    if (CFG.maxPrice) p.set('maxPrice', String(CFG.maxPrice));
    p.set('latitude', String(CFG.area.latitude)); p.set('longitude', String(CFG.area.longitude)); p.set('radius', String(CFG.area.radius));
    return `${location.origin}/marketplace/montreal/search?${p}`;
  }
  const profileKey = () => `auto:${CFG.area.latitude},${CFG.area.longitude},r${CFG.area.radius}`; // not the rent cap: changing it must not split the history
  function scanKeyOf() { // for "scan this page": identifies this exact search
    const p = new URLSearchParams(location.search);
    for (const k of ['ref', 'referral_code', 'referral_story_type', 'tracking', '__tn__', '__cft__', 'sort']) p.delete(k);
    p.sort();
    const q = p.toString();
    return location.pathname + (q ? '?' + q : '');
  }

  // ---------------------------------------------------------------------------
  // Extraction (runs on a listing page)
  // ---------------------------------------------------------------------------
  function walk(o, fn, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 40) return;
    fn(o);
    for (const k in o) walk(o[k], fn, depth + 1);
  }
  const DATE_RE = /(\d{4})[\/.-](\d{2})[\/.-](\d{2})/;

  // The listing's data is split over several objects that share the listing id, so merge them.
  // The merged `location` key is the VIEWER's search location; the listing's own location is the one
  // carrying `reverse_geocode_detailed`. `listing_photos` is only a "whole payload has arrived" marker
  // and a photo COUNT: no image is ever requested.
  function extractListing(id) {
    const m = {};
    let loc = null;
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      const t = s.textContent;
      if (!t.includes(id)) continue;
      let j;
      try { j = JSON.parse(t); } catch { continue; }
      walk(j, (o) => {
        if (o.id !== id) return;
        for (const k in o) if (!(k in m)) m[k] = o[k];
        if (!loc && o.location && o.location.reverse_geocode_detailed) loc = o.location;
      });
    }
    if (typeof m.marketplace_listing_title !== 'string' || !Array.isArray(m.listing_photos)) return null;

    const photoKeys = new Set(), photoUris = [];
    for (const p of m.listing_photos) { const u = p && p.image && p.image.uri; if (u && !photoKeys.has(u.split('?')[0])) { photoKeys.add(u.split('?')[0]); photoUris.push(u); } }

    const features = [];
    for (const s of Array.isArray(m.pdp_display_sections) ? m.pdp_display_sections : []) {
      for (const f of s.pdp_fields || []) features.push({ section: s.section_type || '', icon: f.icon_name || '', label: f.display_label || '' });
    }
    const labelOf = (icon) => (features.find((f) => f.icon === icon) || {}).label || '';
    const bb = labelOf('bedrooms-bathrooms');
    const bedM = bb.match(/(\d+(?:[.,]\d+)?)\s*(?:beds?|bedrooms?|chambres?)/i);
    const bathM = bb.match(/(\d+(?:[.,]\d+)?)\s*(?:baths?|bathrooms?|salles?)/i);
    const num = (x) => (x ? Number(x[1].replace(',', '.')) : null);
    const bedrooms = /studio/i.test(bb) ? 0 : num(bedM);
    const clock = labelOf('clock');
    const parts = clock.split('·').map((s) => s.trim()).filter(Boolean);
    const isAvail = (p) => DATE_RE.test(p) || /avail|disponib/i.test(p);
    const dm = clock.match(DATE_RE);
    const geo = (loc && loc.reverse_geocode_detailed) || {};
    const SKIP_ICONS = ['bedrooms-bathrooms', 'building-city', 'pin', 'clock'];

    const title = m.marketplace_listing_title;
    const description = (m.redacted_description && m.redacted_description.text) || '';
    const categoryId = String(m.marketplace_listing_category_id || (m.marketplace_listing_category && m.marketplace_listing_category.id) || '');
    const categoryName = m.marketplace_listing_category_name || '';
    const slug = (m.marketplace_listing_category && m.marketplace_listing_category.slug) || '';
    const inRentals = categoryId === RENTALS_CATEGORY_ID || /^rentals?$/i.test(categoryName) || slug === 'propertyrentals';
    const ftext = fold(title + '\n' + description);
    // structured = filed under Rentals; text-only = a rental filed elsewhere; unrelated = not a rental at all
    const kind = inRentals ? 'structured' : (RENT_VERB.test(ftext) && DWELLING.test(ftext) ? 'text-only' : 'unrelated');

    let priceAmount = m.listing_price ? Number(m.listing_price.amount) : null;
    let price = (m.formatted_price && m.formatted_price.text) || '';
    let priceFromText = false;
    if (priceAmount != null && priceAmount < MIN_RENT) { // "$1" style placeholder: look for the real rent in the text
      const r = inferRentFromText(description);
      if (r) { priceAmount = r; price = `$${r}`; priceFromText = true; }
    }

    return {
      id,
      url: `${location.origin}/marketplace/item/${id}/`,
      title, price, priceAmount, priceFromText,
      currency: m.listing_price ? m.listing_price.currency : '',
      description,
      category: categoryName, categoryId, inRentals, kind,
      bedrooms,
      bedroomsInferred: inferBedrooms(title, description),
      bathrooms: num(bathM),
      propertyType: labelOf('building-city'),
      amenities: features.filter((f) => !SKIP_ICONS.includes(f.icon)).map((f) => f.label).filter(Boolean),
      locationText: labelOf('pin'),
      city: geo.city || '', state: geo.state || '', postalCode: geo.postal_code || '',
      latitude: loc && typeof loc.latitude === 'number' ? loc.latitude : null,
      longitude: loc && typeof loc.longitude === 'number' ? loc.longitude : null,
      listedText: parts.find((p) => !isAvail(p)) || '',
      availabilityText: parts.find(isAvail) || '',
      availableFrom: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : '',
      additionalFees: m.additional_fees_description || '',
      isLive: m.is_live !== false, isPending: !!m.is_pending, isSold: !!m.is_sold,
      photoCount: photoKeys.size, photoUris,
    };
  }

  // ---------------------------------------------------------------------------
  // Photos: a few downscaled JPEGs per listing, kept as blobs in IndexedDB (same origin for the worker tab,
  // the search tab and the in-page dashboard). The listing page already loads these images, so the extra
  // traffic is a handful of small CDN requests per listing, spaced out like the rest of the run.
  // ---------------------------------------------------------------------------
  let photoDbP = null;
  const photoDb = () => photoDbP || (photoDbP = new Promise((res, rej) => {
    const r = indexedDB.open('fbm_photos', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('p');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const idbDo = async (mode, fn) => { const db = await photoDb(); return new Promise((res, rej) => { const tx = db.transaction('p', mode); const rq = fn(tx.objectStore('p')); tx.oncomplete = () => res(rq && rq.result); tx.onerror = () => rej(tx.error); }); };
  const photoPut = (id, blobs) => idbDo('readwrite', (st) => st.put(blobs, id));
  const photoGet = (id) => idbDo('readonly', (st) => st.get(id));
  const photoDel = (id) => idbDo('readwrite', (st) => st.delete(id)).catch(() => {});
  const photoKeysAll = () => idbDo('readonly', (st) => st.getAllKeys()).catch(() => []);
  const gmBlob = (url) => new Promise((res, rej) => GM_xmlhttpRequest({ method: 'GET', url, responseType: 'blob', timeout: 12000, onload: (r) => (r.status < 400 && r.response ? res(r.response) : rej(new Error('http ' + r.status))), onerror: () => rej(new Error('network')), ontimeout: () => rej(new Error('timeout')) }));
  async function shrinkImage(blob) {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, CFG.photos.maxPx / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', CFG.photos.quality));
  }
  async function capturePhotos(id, uris) { // -> number saved
    const out = [];
    for (const u of uris.slice(0, CFG.photos.max)) {
      try { out.push(await shrinkImage(await gmBlob(u))); } catch { /* skip this one */ }
      await sleep(250 + Math.random() * 450);
    }
    if (out.length) await photoPut(id, out);
    return out.length;
  }

  // Why a listing page yielded no data: a short label for the log (page text is only matched, never stored).
  function diagnosePage() {
    let t = '', title = '';
    try { t = String((document.body && document.body.innerText) || '').slice(0, 3000); title = String(document.title || '').slice(0, 60); } catch { /* ignore */ }
    if (/log in|se connecter|connexion/i.test(title) || (/log in to continue|connectez-vous pour continuer/i.test(t))) return 'login wall (not signed in on this tab)';
    if (/isn.t available|no longer available|n.est plus disponible|contenu n.est pas disponible|this content isn.t available/i.test(t)) return 'listing removed or unavailable';
    if (/something went wrong|une erreur s.est produite|try again later/i.test(t)) return 'Facebook error page';
    if (!t.trim()) return 'page empty (still loading or blank)';
    return `page loaded but no listing data (title "${title}", ${t.length} chars)`;
  }

  async function waitForListing(id, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const data = extractListing(id);
      if (data) return data;
      await sleep(250);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Worker mode: this tab was opened to read one listing
  // ---------------------------------------------------------------------------
  async function runWorkerIfNeeded() {
    const id = itemIdFromPath(location.pathname);
    if (!id || !GM_getValue('fbm_job_' + id)) return false;
    const data = await waitForListing(id, 30000);
    if (data) {
      data.photosSaved = 0;
      if (CFG.photos && CFG.photos.max > 0 && data.photoUris && data.photoUris.length) {
        try { data.photosSaved = await Promise.race([capturePhotos(id, data.photoUris), sleep(CFG.photos.timeoutMs).then(() => 0)]); } catch { /* photos are optional */ }
      }
      delete data.photoUris;
    }
    GM_setValue('fbm_res_' + id, JSON.stringify(data || { error: diagnosePage(), blocked: detectBlock() }));
    return true;
  }

  async function fetchListingViaTab(id) { // -> { data, blocked }
    GM_setValue('fbm_job_' + id, Date.now());
    GM_deleteValue('fbm_res_' + id);
    const tab = GM_openInTab(`${location.origin}/marketplace/item/${id}/`, { active: false, insert: true, setParent: true });
    const t0 = Date.now();
    let res = null;
    while (Date.now() - t0 < CFG.itemTimeoutMs && !state.stop) {
      const raw = GM_getValue('fbm_res_' + id);
      if (raw) { try { res = JSON.parse(raw); } catch { /* keep waiting */ } if (res) break; }
      await sleep(250);
    }
    try { if (tab && tab.close) tab.close(); } catch { /* ignore */ }
    GM_deleteValue('fbm_job_' + id);
    GM_deleteValue('fbm_res_' + id);
    const reason = !res ? (state.stop ? 'stopped' : 'timeout: the tab never reported back (throttled in background, closed, or script did not run)') : res.error || '';
    return { data: res && !res.error ? res : null, blocked: !!(res && res.blocked), reason };
  }

  // ---------------------------------------------------------------------------
  // Search results: cards, filters, scanning one query page
  // ---------------------------------------------------------------------------
  const parsePrice = (txt) => { const d = (txt || '').replace(/[^\d]/g, ''); return d ? parseInt(d, 10) : null; };
  // A card's text is: price, [old struck-through price when reduced], title, location.
  const PRICE_LINE_RE = /^(?:CA)?\$\s?\d[\d,.\s ]*$|^\d[\d,.\s ]*\$$/i;
  function parseCard(id, lines) {
    let i = 0;
    const priceLines = [];
    while (i < lines.length && PRICE_LINE_RE.test(lines[i])) priceLines.push(lines[i++]);
    const rest = lines.slice(i);
    return { id, priceText: priceLines[0] || '', oldPriceText: priceLines[1] || '', price: parsePrice(priceLines[0]), title: rest[0] || '', location: rest.length > 1 ? rest[rest.length - 1] : '' };
  }
  function passes(card) { // decided from the card alone, before any page is opened
    if (CFG.skipRooms && (ROOM_RE.test(card.title) || SHARED_RE.test(card.title))) return false;
    if (CFG.maxPrice && card.price && card.price > CFG.maxPrice) return false;
    if (CFG.beds) { const b = bedroomsIn(card.title); if (b != null && (b < CFG.beds.min || b > CFG.beds.max)) return false; }
    return true;
  }

  // Scrolls the current results page, collecting cards in the order they appear (newest first when sorted so).
  // stopped: 'bottom' (end reached) | 'known' (early stop) | 'cap' | 'stop' | 'blocked'
  async function scanQueryPage(c, known) {
    const se = document.scrollingElement;
    const found = new Map();
    let consec = 0, stopped = null;
    const grab = () => {
      for (const a of document.querySelectorAll('a[href*="/marketplace/item/"]')) {
        const id = itemIdFromPath(new URL(a.href, location.href).pathname);
        if (!id || found.has(id)) continue;
        found.set(id, parseCard(id, a.innerText.split('\n').map((s) => s.trim()).filter(Boolean)));
        consec = known.has(id) ? consec + 1 : 0;
      }
    };
    for (let i = 0; i < 40 && !document.querySelector('a[href*="/marketplace/item/"]'); i++) { // page may still be loading
      if (detectBlock()) return { cards: [], stopped: 'blocked' };
      await sleep(500);
    }
    se.scrollTo(0, 0);
    await sleep(800);
    grab();
    let stale = 0, last = found.size;
    for (let i = 0; i < 600 && !stopped; i++) {
      if (state.stop) stopped = 'stop';
      else if (detectBlock()) stopped = 'blocked';
      else if (found.size >= CFG.maxResultsPerQuery) stopped = 'cap';
      else if (!c.full && CFG.stopAfterKnown && consec >= CFG.stopAfterKnown) stopped = 'known';
      else if (stale >= 3) stopped = 'bottom';
      if (stopped) break;
      se.scrollBy(0, Math.round(innerHeight * 0.7));
      await sleep(CFG.scrollStepMs);
      grab();
      const bottom = se.scrollTop + innerHeight >= se.scrollHeight - 5;
      if (bottom) { await sleep(1500); grab(); }
      if (found.size !== last) { stale = 0; last = found.size; state.qfound = found.size; setStatus(`Search ${state.qi + 1}/${state.nq} “${state.qlabel}”: ${found.size} cards`); }
      else if (bottom) stale++;
    }
    se.scrollTo(0, 0);
    return { cards: [...found.values()], stopped: stopped || 'cap' };
  }

  // ---------------------------------------------------------------------------
  // History records, snapshot rows, CSV
  // ---------------------------------------------------------------------------
  const csvCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const DETAIL_KEYS = ['description', 'category', 'categoryId', 'inRentals', 'kind', 'bedrooms', 'bedroomsInferred', 'bathrooms', 'propertyType', 'amenities',
    'locationText', 'city', 'state', 'postalCode', 'latitude', 'longitude', 'listedText', 'availabilityText', 'availableFrom', 'additionalFees',
    'isLive', 'isPending', 'isSold', 'currency', 'photoCount', 'photosSaved'];

  function makeRecord(L, card, day, scanNo, key, prev) {
    // Price tracking uses the search CARD price on both sides (later scans only see cards), except for ads whose
    // card price is a placeholder: those track the rent found in the text.
    const pagePrice = L.priceAmount != null && !Number.isNaN(L.priceAmount) ? L.priceAmount : null;
    const amount = L.priceFromText ? pagePrice : (card.price != null && credible(card.price) ? card.price : pagePrice);
    const rec = {
      id: L.id, url: L.url, title: L.title, price: L.priceFromText ? L.price : (card.priceText || L.price), priceAmount: amount, priceFromText: !!L.priceFromText,
      location: card.location, foundVia: card.via || [], firstSeen: prev ? prev.firstSeen : day, lastSeen: day, lastScan: scanNo, scanKey: key, gone: false,
      priceHistory: prev ? prev.priceHistory.slice() : [], detail: {}, savedAt: day,
    };
    for (const k of DETAIL_KEYS) rec.detail[k] = L[k];
    const last = rec.priceHistory[rec.priceHistory.length - 1];
    if (amount != null && (!last || last.amount !== amount)) rec.priceHistory.push({ date: day, amount });
    return rec;
  }
  function toView(rec, info) {
    const { detail, ...rest } = rec;
    return { ...rest, ...detail, status: (info && info.status) || (rec.gone ? 'GONE' : 'SEEN'), prevPrice: info && info.prev != null ? info.prev : null };
  }
  const CSV_COLS = [
    ['status', 'status'], ['id', 'id'], ['price', 'price'], ['previous_price', 'prevPrice'], ['title', 'title'], ['kind', 'kind'],
    ['bedrooms', 'bedrooms'], ['bedrooms_from_text', 'bedroomsInferred'], ['bathrooms', 'bathrooms'], ['type', 'propertyType'], ['category', 'category'],
    ['location', 'locationText'], ['city', 'city'], ['postal_code', 'postalCode'], ['latitude', 'latitude'], ['longitude', 'longitude'],
    ['available_from', 'availableFrom'], ['available', 'availabilityText'], ['listed', 'listedText'], ['amenities', 'amenities'], ['found_via', 'foundVia'],
    ['url', 'url'], ['photos_on_listing', 'photoCount'], ['first_seen', 'firstSeen'], ['last_seen', 'lastSeen'], ['gone_at', 'goneAt'],
  ];
  function buildCsv(views) {
    const cell = (v) => csvCell(Array.isArray(v) ? v.join('; ') : v);
    return '﻿' + [CSV_COLS.map((c) => csvCell(c[0])).join(','), ...views.map((r) => CSV_COLS.map(([, key]) => cell(r[key])).join(','))].join('\n');
  }

  // ---------------------------------------------------------------------------
  // Downloads
  // ---------------------------------------------------------------------------
  function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.append(a); a.click(); a.remove();
  }
  function offerFile(text, filename, type) { // the snapshot: downloaded now and kept as a link in the panel
    const blob = new Blob([text], { type });
    if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
    state.fileUrl = URL.createObjectURL(blob);
    state.fileName = filename; state.fileBytes = blob.size;
    triggerDownload(state.fileUrl, filename);
  }
  function downloadText(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    triggerDownload(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---------------------------------------------------------------------------
  // The run ("campaign"): search phase -> read phase -> finalize
  // ---------------------------------------------------------------------------
  function newCampaign(mode) {
    const hist = loadHistory(), auto = mode === 'auto', backlog = mode === 'backlog'; // backlog: no search, just read the waiting listings
    const full = backlog ? false : !auto || CFG.fullScan || hist.scans === 0 || (CFG.fullScanEvery > 0 && (hist.scans + 1) % CFG.fullScanEvery === 0);
    return {
      id: Date.now().toString(36), mode, profile: auto || backlog ? profileKey() : scanKeyOf(), day: today(), scanNo: hist.scans + 1, full,
      startedAt: Date.now(), updatedAt: Date.now(), phase: 'search', qi: 0, stop: false, complete: !backlog, blocked: false,
      queries: backlog ? [] : auto ? queryList().map((q) => ({ label: q, url: searchUrl(q) })) : [{ label: 'this page', url: location.href }],
      cards: {}, perQuery: [], toOpen: [], deferred: 0, readIdx: 0, opened: 0, readStartedAt: 0, fresh: {}, info: {}, failed: [], ignored: [],
    };
  }
  function onQueryPage(c) {
    if (c.mode !== 'auto') return true;
    const q = c.queries[c.qi];
    return !!q && /\/marketplace\/[^/]+\/search\/?$/.test(location.pathname) && new URLSearchParams(location.search).get('query') === q.label;
  }
  function navigate(url) { setStatus('Opening the next search…'); location.assign(url); }

  function startRun(mode) {
    if (state.running) return;
    const cool = cooldownLeftMs();
    if (cool > 0) { setStatus(`Cooling down after a Facebook slow-down: wait ${fmtLeft(cool)} before the next run.`); return; }
    if (budgetUsed() >= CFG.pace.dailyBudget) { setStatus(`Daily limit reached (${CFG.pace.dailyBudget} pages opened today). Try again tomorrow.`); return; }
    const c = newCampaign(mode);
    saveCampaign(c);
    state.stop = false; state.paused = false;
    if (mode === 'auto' && !onQueryPage(c)) { navigate(c.queries[0].url); return; }
    runCampaign();
  }

  async function runCampaign() {
    let c = loadCampaign();
    if (!c || state.running) return;
    Object.assign(state, { running: true, paused: false, stop: !!c.stop, startedAt: c.startedAt, lastActivity: Date.now(), nq: c.queries.length, qi: c.qi, listingsDone: Object.keys(c.fresh).length, listingsFailed: c.failed.length, ignoredN: c.ignored.length });
    refreshButtons();
    try {
      if (c.phase === 'search') {
        const known = new Set(); { const h = loadHistory(); Object.keys(h.listings).forEach((k) => known.add(k)); Object.keys(h.ignored).forEach((k) => known.add(k)); Object.keys(h.pending).forEach((k) => known.add(k)); }
        state.phase = 'search';
        while (c.qi < c.queries.length && !state.stop) {
          const q = c.queries[c.qi];
          if (!onQueryPage(c)) { navigate(q.url); return; } // reload resumes here
          Object.assign(state, { qi: c.qi, qlabel: q.label, qfound: 0 });
          setStatus(`Search ${c.qi + 1}/${c.queries.length} “${q.label}”: loading…`);
          const res = await scanQueryPage(c, known);
          for (const card of res.cards) {
            const ex = c.cards[card.id];
            if (ex) { if (!ex.via.includes(q.label)) ex.via.push(q.label); } else c.cards[card.id] = { ...card, via: [q.label] };
          }
          c.perQuery.push({ q: q.label, found: res.cards.length, fresh: res.cards.filter((x) => !known.has(x.id)).length, stopped: res.stopped });
          if (res.stopped !== 'bottom' || res.cards.length === 0) c.complete = false;
          if (res.stopped === 'blocked') { abortBlocked(c); break; }
          c.qi++; saveCampaign(c);
          if (c.qi < c.queries.length && !state.stop) {
            await politePause(rand(CFG.queryGapMs), `Next search in`);
            if (!state.stop) { navigate(c.queries[c.qi].url); return; }
          }
        }
        // search finished (or stopped): queue what to open. This run's results first (newest first), then the backlog
        // left over from earlier runs. Whatever the cap leaves behind is saved as the backlog for the next run.
        const hist = loadHistory();
        const isNew = (x) => !hist.ignored[x.id] && (CFG.refreshKnown || !hist.listings[x.id]);
        const queue = [], queued = new Set();
        const enqueue = (x) => { if (!queued.has(x.id) && passes(x) && isNew(x)) { queued.add(x.id); queue.push(x); } };
        Object.values(c.cards).forEach(enqueue);
        Object.values(hist.pending).forEach(enqueue);
        const cap = state.stop ? 0 : (CFG.maxNewPerRun || queue.length);
        const open = queue.slice(0, cap);
        c.leftover = queue.slice(cap).map(slimCard);
        c.pendingCards = {}; open.forEach((x) => { if (!c.cards[x.id]) c.pendingCards[x.id] = slimCard(x); });
        if (state.stop) c.complete = false;
        c.deferred = c.leftover.length; c.queued = true;
        c.toOpen = open.map((x) => x.id); c.phase = 'read'; c.readStartedAt = Date.now(); saveCampaign(c);
      }
      if (c.phase === 'read') await readPhase(c);
      finalizeCampaign(c);
      state.live = null;
      const seen = Object.keys(c.cards).length, waiting = Object.keys(loadHistory().pending).length;
      const fr = {}; for (const id of c.failed) { const k = ((c.failReasons || {})[id] || 'unknown').split(/[:(]/)[0].trim(); fr[k] = (fr[k] || 0) + 1; }
      const frTxt = Object.keys(fr).length ? ` (${Object.entries(fr).map(([k, n]) => `${n}× ${k}`).join(', ')})` : '';
      setStatus(`Done: ${state.listingsDone} new, ${state.listingsFailed} failed${frTxt}, ${state.ignoredN} unrelated skipped, ${seen} seen${waiting ? `, ${waiting} more waiting for the next run (they go first)` : ''}${c.blocked ? '. Stopped early: Facebook asked us to slow down' : state.stop ? ' (stopped early)' : ''}.`);
    } catch (e) {
      console.error('[FBM]', e);
      state.phase = 'idle';
      setStatus('Error: ' + e.message);
      try { c = loadCampaign(); if (c && Object.keys(c.fresh).length) { c.complete = false; finalizeCampaign(c, true); setStatus(`Error: ${e.message}. Saved a partial snapshot.`); } } catch { /* ignore */ }
    } finally {
      state.running = false; state.live = null;
      refreshButtons(); updateHistLine(); paint();
    }
  }

  const slimCard = (x) => ({ id: x.id, priceText: x.priceText, price: x.price, title: x.title, location: x.location, via: x.via || [], fails: x.fails || 0 });

  // Politeness bookkeeping, kept in storage so it survives reloads: pages opened today, and the cool-down after a block.
  const BUDGET_KEY = 'fbm_budget', COOL_KEY = 'fbm_cooldown_until';
  const budgetUsed = () => { try { const b = JSON.parse(GM_getValue(BUDGET_KEY) || 'null'); return b && b.day === today() ? b.n : 0; } catch { return 0; } };
  const budgetAdd = () => GM_setValue(BUDGET_KEY, JSON.stringify({ day: today(), n: budgetUsed() + 1 }));
  const cooldownLeftMs = () => Math.max(0, Number(GM_getValue(COOL_KEY) || 0) - Date.now());
  const fmtLeft = (ms) => (ms >= 3600000 ? Math.round(ms / 3600000) + ' h' : Math.ceil(ms / 60000) + ' min');

  function abortBlocked(c) {
    GM_setValue(COOL_KEY, Date.now() + CFG.pace.cooldownHours * 3600000);
    c.blocked = true; c.complete = false; c.stop = true; state.stop = true; saveCampaign(c);
    setStatus('Facebook asked us to slow down: stopping and saving what we have.');
  }

  // Applied to the opened page, where the facts are certain: dropped listings are ignored for good.
  function dropReason(L) {
    if (CFG.skipRooms) { const sh = sharedHousing(L.title, L.description, L.priceAmount, L.bedrooms); if (sh) return sh; }
    const b = L.bedrooms != null ? L.bedrooms : L.bedroomsInferred;
    if (CFG.beds && b != null && (b < CFG.beds.min || b > CFG.beds.max)) return `${b} bedroom(s), wanted ${CFG.beds.min}-${CFG.beds.max}`;
    return '';
  }

  async function readPhase(c) {
    state.live = c;
    state.phase = 'read'; state.total = c.toOpen.length; state.startedAt = c.readStartedAt || Date.now();
    const hist = loadHistory();
    let consec = 0, nextLong = c.opened + CFG.pace.longBreakEvery[0] + Math.floor(Math.random() * (CFG.pace.longBreakEvery[1] - CFG.pace.longBreakEvery[0]));
    while (c.readIdx < c.toOpen.length && !state.stop) {
      if (budgetUsed() >= CFG.pace.dailyBudget) { setStatus(`Daily limit reached (${CFG.pace.dailyBudget} pages today): the rest wait in the queue.`); state.stop = true; break; }
      const id = c.toOpen[c.readIdx];
      const pc = c.pendingCards && c.pendingCards[id];
      const card = c.cards[id] || { ...pc, price: null, priceText: '' }; // a backlog card's price is stale: take the page's own price
      const slow = Math.min(CFG.pace.maxSlow, Math.pow(CFG.pace.slowFactor, consec)); // slower after every consecutive failure
      if (c.opened > 0 || consec > 0) {
        if (c.opened >= nextLong) { nextLong = c.opened + CFG.pace.longBreakEvery[0] + Math.floor(Math.random() * (CFG.pace.longBreakEvery[1] - CFG.pace.longBreakEvery[0])); await politePause(rand(CFG.pace.longBreakMs), 'Resting for a few minutes:'); }
        else { const lb = c.opened % CFG.breakEvery === 0; await politePause(rand(lb ? CFG.breakMs : CFG.tabGapMs) * slow, lb ? 'Taking a longer break:' : slow > 1 ? 'Slowing down, next listing in' : 'Next listing in'); }
      }
      if (state.stop) break;
      setStatus(`Reading listing ${c.readIdx + 1}/${c.toOpen.length}: ${card.title.slice(0, 28)}`);
      let r = await fetchListingViaTab(id); budgetAdd();
      if (r.blocked) { abortBlocked(c); break; }
      if (!r.data && !state.stop) {
        await politePause(rand(CFG.tabGapMs), 'Retrying in');
        if (!state.stop) { r = await fetchListingViaTab(id); budgetAdd(); if (r.blocked) { abortBlocked(c); break; } }
      }
      if (!r.data) { if (!state.stop) { c.failed.push(id); (c.failReasons = c.failReasons || {})[id] = r.reason || 'unknown'; console.warn(`[FBM] failed ${id} (${card.title.slice(0, 40)}): ${r.reason || 'unknown'}`); setStatus(`Failed: ${r.reason || 'unknown'}`); state.listingsFailed++; c.readIdx++; consec++; checkpoint(c); touch(); if (consec >= CFG.pace.stopAfterFails) { c.complete = false; state.stop = true; setStatus(`${consec} listings in a row failed: stopping to be safe (this can be Facebook throttling). The rest wait in the queue. Try again later.`); } } continue; }
      const L = r.data;
      consec = 0; c.opened++;
      const why = L.kind === 'unrelated' ? 'not a rental' : dropReason(L);
      if (why) { c.ignored.push(id); state.ignoredN++; (c.dropReasons = c.dropReasons || {})[id] = why; photoDel(id); console.info(`[FBM] skipped ${id} (${String(L.title).slice(0, 40)}): ${why}`); }
      else {
        const prev = hist.listings[id];
        c.fresh[id] = makeRecord(L, card, c.day, c.scanNo, (prev && c.mode !== 'auto') ? prev.scanKey : c.profile, prev);
        c.info[id] = { status: prev ? 'REFRESHED' : 'NEW' };
        state.listingsDone++;
      }
      c.readIdx++; checkpoint(c); touch();
    }
    checkpoint(c, true);
  }

  // Applies everything to the history, produces the snapshot, then commits.
  function finalizeCampaign(c, partial) {
    const hist = loadHistory(), { day, scanNo, profile } = c, info = Object.assign({}, c.info);
    state.phase = 'done';
    // 1) known listings seen in this run: update from their card (no page load needed)
    for (const card of Object.values(c.cards)) {
      const rec = hist.listings[card.id];
      if (!rec) continue;
      rec.lastSeen = day; rec.lastScan = scanNo;
      if (c.mode === 'auto' || !rec.scanKey) rec.scanKey = profile; // a one-off page scan never takes listings away from the main profile
      if (rec.gone) { rec.gone = false; delete rec.goneAt; info[card.id] = { status: 'BACK' }; }
      if (!rec.priceFromText && credible(card.price) && rec.priceAmount != null && card.price !== rec.priceAmount && !c.fresh[card.id]) {
        info[card.id] = { status: card.price < rec.priceAmount ? 'PRICE_DOWN' : 'PRICE_UP', prev: rec.priceAmount };
        rec.priceHistory.push({ date: day, amount: card.price });
        rec.priceAmount = card.price; rec.price = card.priceText;
      }
    }
    // 2) commit what this run read
    const newIds = [];
    for (const id of Object.keys(c.fresh)) { if (!hist.listings[id]) newIds.push(id); hist.listings[id] = c.fresh[id]; }
    for (const id of c.ignored) hist.ignored[id] = day;
    if (c.queued) { // the backlog = what the cap left behind + whatever a stopped run did not get to
      const waiting = {};
      const tail = c.toOpen.slice(c.readIdx).map((id) => c.cards[id] || (c.pendingCards || {})[id]).filter(Boolean);
      // a listing that failed for a reason that may pass (timeout, error page) goes back in the queue; a removed one does not
      const retry = (c.failed || []).filter((id) => !/removed|unavailable/.test((c.failReasons || {})[id] || '')).map((id) => c.cards[id] || (c.pendingCards || {})[id]).filter(Boolean)
        .map((x) => ({ ...x, fails: ((hist.pending[x.id] || {}).fails || 0) + 1 })).filter((x) => x.fails < 3); // give up after 3 failed attempts
      for (const x of [...tail, ...(c.leftover || []), ...retry]) if (!hist.listings[x.id] && !hist.ignored[x.id] && Object.keys(waiting).length < 500) waiting[x.id] = slimCard(x);
      hist.pending = waiting;
    }
    // 3) a listing missing from a COMPLETE run is gone
    const complete = !!c.complete && !c.stop && !state.stop && !partial;
    if (complete) {
      for (const rec of Object.values(hist.listings)) {
        if (rec.scanKey === profile && rec.lastScan !== scanNo && !rec.gone) { rec.gone = true; rec.goneAt = day; info[rec.id] = { status: 'GONE' }; }
      }
    }
    // 4) the price log for this run: every tracked listing seen, with its current asking rent
    const prices = {};
    for (const card of Object.values(c.cards)) { const rec = hist.listings[card.id]; if (rec && credible(rec.priceAmount)) prices[card.id] = rec.priceAmount; }
    for (const id of Object.keys(c.fresh)) { const rec = hist.listings[id]; if (rec && credible(rec.priceAmount) && prices[id] == null) prices[id] = rec.priceAmount; } // backlog listings were observed too
    hist.scanLog.push({ n: scanNo, date: day, at: new Date().toISOString(), cap: CFG.maxPrice, profile, mode: c.mode, full: !!c.full, complete, seen: Object.keys(c.cards).length, opened: Object.keys(c.fresh).length, newIds, queries: c.queries.map((q) => q.label), perQuery: c.perQuery, prices });
    if (hist.scanLog.length > CFG.scanLogKeep) hist.scanLog.splice(0, hist.scanLog.length - CFG.scanLogKeep);
    hist.scans = scanNo;

    const views = Object.values(hist.listings).filter((r) => r.scanKey === profile).map((r) => toView(r, info[r.id]))
      .sort((a, b) => (a.priceAmount == null) - (b.priceAmount == null) || a.priceAmount - b.priceAmount);
    const snapshot = { schema: 2, generated: new Date().toISOString(), profile, mode: c.mode, queries: c.queries.map((q) => q.label), scans: hist.scanLog.filter((s) => s.profile === profile), listings: views };
    if (CFG.autoDownload) offerFile(JSON.stringify(snapshot, null, 2), `fb-rentals-${day}${partial || c.stop || state.stop ? '-partial' : ''}.json`, 'application/json');
    if (c.failed.length) {
      const byReason = {};
      for (const id of c.failed) { const r = (c.failReasons || {})[id] || 'unknown'; (byReason[r] = byReason[r] || []).push(id); }
      for (const [r, ids] of Object.entries(byReason)) console.warn(`[FBM] ${ids.length} listing(s) could not be read - ${r}:`, ids.join(', '));
    }
    saveHistory(hist); // after the snapshot exists, so an interrupted run is simply repeated
    clearCampaign();
  }

  async function saveCurrentListing() {
    if (state.running) return;
    const id = itemIdFromPath(location.pathname);
    if (!id) return;
    state.running = true; state.stop = false; state.phase = 'read'; refreshButtons();
    try {
      setStatus('Reading listing…');
      const L = await waitForListing(id, 8000);
      if (!L) { state.phase = 'idle'; setStatus('Listing data not on this page. Reload (F5) and try again.'); return; }
      offerFile(JSON.stringify(L, null, 2), `fb-listing-${L.id}.json`, 'application/json');
      state.phase = 'done'; state.total = 1; state.listingsDone = 1;
      setStatus('Saved.');
    } catch (e) { console.error('[FBM]', e); state.phase = 'idle'; setStatus('Error: ' + e.message); }
    finally { state.running = false; refreshButtons(); paint(); }
  }

  function exportHistory() { downloadText(JSON.stringify(loadHistory(), null, 2), `fbm-history-${today()}.json`, 'application/json'); }
  // ---------------------------------------------------------------------------
  // The dashboard, in the page: an overlay iframe fed straight from the local history (no file to move around).
  // The dashboard code runs here, in the userscript, against the iframe's document, so Facebook's page policy
  // never has to allow it. Listing text reaches the page only through textContent.
  // ---------------------------------------------------------------------------
  function dashboardViews(hist) {
    const last = hist.scanLog[hist.scanLog.length - 1];
    const profile = last ? last.profile : null;
    const newIds = new Set(last ? last.newIds : []);
    const views = Object.values(hist.listings).filter((r) => !profile || r.scanKey === profile).map((r) => {
      let info = null;
      const ph = r.priceHistory || [];
      if (newIds.has(r.id)) info = { status: 'NEW' };
      else if (last && ph.length >= 2 && ph[ph.length - 1].date === last.date) { const a = ph[ph.length - 1].amount, b = ph[ph.length - 2].amount; info = { status: a < b ? 'PRICE_DOWN' : 'PRICE_UP', prev: b }; }
      return toView(r, info);
    });
    return { views, profile, scans: hist.scanLog.filter((x) => !profile || x.profile === profile) };
  }

  async function openDashboard() {
    if (document.getElementById('fbm-dash')) return;
    const hist = loadHistory();
    const { views, profile, scans } = dashboardViews(hist);
    if (!views.length) { setStatus('Nothing tracked yet: run the queries first.'); return; }
    const data = fbmAnalyze(views, scans, { profile, queries: (scans.filter((x) => x.queries && x.queries.length).pop() || { queries: [] }).queries });
    const urls = [];
    try {
      for (const r of data.listings) {
        const blobs = await photoGet(r.id).catch(() => null);
        if (blobs && blobs.length) r.photos = blobs.map((b) => { const u = URL.createObjectURL(b); urls.push(u); return u; });
      }
    } catch { /* no photos available: the dashboard drops the picture areas */ }
    const host = document.createElement('div');
    host.id = 'fbm-dash';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#111';
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff';
    const close = document.createElement('button');
    close.textContent = '✕ Close';
    close.style.cssText = 'position:absolute;right:14px;bottom:14px;z-index:2;padding:7px 12px;border:0;border-radius:8px;background:#2d88ff;color:#fff;font:600 13px system-ui;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4)';
    close.onclick = () => { host.remove(); for (const u of urls) URL.revokeObjectURL(u); };
    host.append(frame, close);
    document.body.append(host);
    const doc = frame.contentDocument;
    doc.open(); doc.write(FBM_DASH_HTML); doc.close();
    fbmMountDashboard(doc, frame.contentWindow, data);
  }

  function exportCsv() { downloadText(buildCsv(Object.values(loadHistory().listings).map((r) => toView(r, null))), `fbm-tracked-${today()}.csv`, 'text/csv'); }
  function clearHistory() {
    if (state.running) return;
    if (!confirm('Delete the saved history (listings, price log)? Every listing will count as new next time.')) return;
    GM_deleteValue(HKEY); clearCampaign();
    updateHistLine(); setStatus('History cleared.');
  }
  function editQueries() {
    const v = prompt('Searches to run, separated by semicolons (French and English). Empty = restore the defaults.', queryList().join('; '));
    if (v === null) return;
    const arr = v.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
    if (arr.length) GM_setValue(QKEY, JSON.stringify(arr)); else GM_deleteValue(QKEY);
    updateQueriesLine();
  }

  // ---------------------------------------------------------------------------
  // UI (small floating panel; Facebook is an SPA so it re-renders on URL change)
  // ---------------------------------------------------------------------------
  let panel, statusEl, statsEl, warnEl, barEl, linkEl, histTextEl, queriesTextEl, pausedEl, queueEl, backlogBtn, lastPath = null, queueSig = "";

  function refreshButtons() {
    if (!panel) return;
    const waiting = Object.keys(loadHistory().pending).length;
    pendingAt = 0; // the queue picture re-reads the backlog
    panel.querySelectorAll('button[data-act]').forEach((b) => { b.disabled = b.dataset.act === 'stop' ? !state.running : b.dataset.act === 'backlog' ? (state.running || !waiting) : state.running; });
    if (backlogBtn) backlogBtn.textContent = waiting ? `Read waiting (${waiting})` : 'Read waiting';
  }

  // The queue, drawn: one square per listing still to read (grey), done (green), failed (red), reading now (blue).
  // While a run is in its reading phase it shows that run's list plus what the cap pushed to the next run (faint).
  let pendingCache = [], pendingAt = 0;
  function paintQueue() {
    if (!queueEl) return;
    const c = state.live;
    let items;
    if (c && c.toOpen) {
      const failed = new Set(c.failed || []);
      items = c.toOpen.map((id, i) => {
        const card = c.cards[id] || (c.pendingCards || {})[id] || {};
        const st = i < c.readIdx ? (failed.has(id) ? 'failed' : (c.ignored || []).includes(id) ? 'skipped' : 'done') : i === c.readIdx ? 'now' : 'wait';
        return { st, t: `${st}: ${card.title || id}${card.priceText ? ' ' + card.priceText : ''}` };
      }).concat((c.leftover || []).map((x) => ({ st: 'later', t: `next run: ${x.title}${x.priceText ? ' ' + x.priceText : ''}` })));
    } else {
      if (Date.now() - pendingAt > 3000) { pendingCache = Object.values(loadHistory().pending); pendingAt = Date.now(); } // history is a big value: do not parse it on every repaint
      items = pendingCache.map((x) => ({ st: 'wait', t: `waiting: ${x.title}${x.priceText ? ' ' + x.priceText : ''}` }));
    }
    const sig = items.length + ':' + items.map((x) => x.st[0]).join('');
    if (sig === queueSig) return;
    queueSig = sig;
    queueEl.replaceChildren();
    if (!items.length) return;
    const COL = { done: '#3fb950', failed: '#f85149', skipped: '#8b949e', now: '#2d88ff', wait: '#6e7681', later: '#3a3f47' };
    const counts = {};
    for (const x of items) counts[x.st] = (counts[x.st] || 0) + 1;
    const head = el('div', {}, 'Queue: ' + ['now', 'wait', 'done', 'failed', 'skipped', 'later'].filter((k) => counts[k]).map((k) => `${counts[k]} ${{ now: 'reading', wait: 'waiting', done: 'done', failed: 'failed', skipped: 'skipped', later: 'for next run' }[k]}`).join(' · '));
    head.style.cssText = 'font-size:12px;opacity:.85;margin-bottom:4px';
    const grid = el('div'); grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:2px;max-height:96px;overflow:auto';
    for (const x of items.slice(0, 600)) {
      const d = el('div'); d.title = x.t; d.style.cssText = `width:8px;height:8px;border-radius:2px;background:${COL[x.st]}${x.st === 'now' ? ';outline:1px solid #fff' : ''}`;
      grid.append(d);
    }
    queueEl.append(head, grid);
  }
  function updateHistLine() {
    refreshButtons();
    if (!histTextEl) return;
    const h = loadHistory(), n = Object.keys(h.listings).length, w = Object.keys(h.pending).length;
    histTextEl.textContent = `Tracking: ${n} listing${n === 1 ? '' : 's'}` + (w ? ` · ${w} waiting` : '');
  }
  function updateQueriesLine() { if (queriesTextEl) queriesTextEl.textContent = `${queryList().length} searches`; }

  function paint() {
    if (!panel) return;
    statusEl.textContent = state.msg;
    let pct = 0, stats = '';
    const elapsed = (Date.now() - state.startedAt) / 1000;
    if (state.phase === 'search') {
      pct = state.nq ? (state.qi / state.nq) * 100 : 0;
      stats = `Search ${state.qi + 1}/${state.nq}${state.qlabel ? ` “${state.qlabel}”` : ''} · ${state.qfound} cards`;
    } else if (state.phase === 'read' || state.phase === 'done') {
      const done = state.listingsDone + state.listingsFailed + state.ignoredN;
      pct = state.total ? Math.min(100, (done / state.total) * 100) : (state.phase === 'read' ? 0 : 100);
      const eta = state.running && done >= 2 ? (elapsed / done) * (state.total - done) : null;
      stats = `Listings ${done}/${state.total}` + (state.listingsFailed ? ` · ${state.listingsFailed} failed` : '') + (state.ignoredN ? ` · ${state.ignoredN} unrelated` : '') +
        ` · ${fmtTime(elapsed)}` + (eta != null ? ` · ~${fmtTime(eta)} left` : '');
    }
    paintQueue();
    barEl.style.width = pct + '%';
    statsEl.textContent = stats;
    const idle = (Date.now() - state.lastActivity) / 1000;
    warnEl.textContent = state.running && idle > 20 ? `No progress for ${Math.round(idle)}s (a listing tab times out after ${CFG.itemTimeoutMs / 1000}s).` : '';
    if (pausedEl) pausedEl.style.display = state.paused ? 'block' : 'none';
    if (state.fileUrl) {
      linkEl.style.display = 'block'; linkEl.href = state.fileUrl; linkEl.download = state.fileName;
      linkEl.textContent = `⬇ ${state.fileName} (${Math.max(1, Math.round(state.fileBytes / 1024))} KB) – click if it didn't download`;
    }
  }

  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    for (const k of kids) e.append(k);
    return e;
  }

  function render() {
    if (lastPath === location.pathname && panel && panel.isConnected) return;
    lastPath = location.pathname;
    if (panel) panel.remove();
    panel = statusEl = statsEl = warnEl = barEl = linkEl = histTextEl = queriesTextEl = pausedEl = queueEl = backlogBtn = null; queueSig = '';
    if (!location.pathname.startsWith('/marketplace')) return;

    const isItem = !!itemIdFromPath(location.pathname);
    if (!state.running && !state.msg) state.msg = isItem ? 'Save this listing as JSON.' : 'Run all queries, or open a search and scan that page.';

    panel = el('div');
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:300px;padding:10px 12px;background:#242526;color:#e4e6eb;border:1px solid #3e4042;border-radius:10px;font:13px/1.35 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4)';
    const btnCss = 'padding:6px 10px;border:0;border-radius:6px;background:#2d88ff;color:#fff;font:600 13px system-ui;cursor:pointer;margin:0 6px 6px 0';
    const linkCss = 'color:#6ab0ff;cursor:pointer;text-decoration:underline';
    const mkBtn = (label, act, fn) => { const b = el('button', { textContent: label, onclick: fn }); b.dataset.act = act; b.style.cssText = btnCss; return b; };
    const inCss = 'width:56px;margin:0;background:#3a3b3c;color:#e4e6eb;border:1px solid #3e4042;border-radius:4px;padding:2px 4px';
    const numInput = (get, set) => { const i = el('input', { type: 'number', value: get(), min: 0, onchange: (e) => { set(Number(e.target.value) || 0); saveSettings(); } }); i.style.cssText = inCss; return i; };
    const check = (label, get, set) => { const l = el('label', {}, el('input', { type: 'checkbox', checked: get(), onchange: (e) => { set(e.target.checked); saveSettings(); } }), ' ' + label); l.style.cssText = 'display:block;margin:3px 0'; return l; };

    statusEl = el('div'); statusEl.style.cssText = 'margin:6px 0 0;min-height:2.7em;opacity:.95';
    const barBox = el('div'); barBox.style.cssText = 'height:6px;background:#3a3b3c;border-radius:3px;overflow:hidden;margin:6px 0 4px';
    barEl = el('div'); barEl.style.cssText = 'height:100%;width:0;background:#2d88ff;transition:width .3s';
    barBox.append(barEl);
    statsEl = el('div'); statsEl.style.cssText = 'font-size:12px;opacity:.75;min-height:1.4em';
    warnEl = el('div'); warnEl.style.cssText = 'font-size:12px;color:#ffb347;min-height:1.4em';
    linkEl = el('a'); linkEl.style.cssText = 'display:none;color:#6ab0ff;font-size:12px;word-break:break-all;margin-top:4px';
    const title = el('div', { textContent: 'Rental Saver' }); title.style.cssText = 'font-weight:700;margin-bottom:6px';
    panel.append(title);

    if (isItem) {
      panel.append(mkBtn('Save this listing', 'single', saveCurrentListing));
    } else {
      pausedEl = el('div', {}, 'A run is paused. ', mkBtn('Resume', 'resume', () => { const c = loadCampaign(); if (c) { state.paused = false; if (c.phase === 'search' && !onQueryPage(c)) navigate(c.queries[c.qi].url); else runCampaign(); } }),
        mkBtn('Cancel run', 'cancel', () => { clearCampaign(); state.paused = false; setStatus('Run cancelled.'); }));
      pausedEl.style.cssText = 'display:none;margin:4px 0;color:#ffb347';
      queriesTextEl = el('span');
      const edit = el('a', { textContent: 'edit', onclick: editQueries }); edit.style.cssText = linkCss;
      histTextEl = el('span');
      const exp = el('a', { textContent: 'json', onclick: exportHistory }), csv = el('a', { textContent: 'csv', onclick: exportCsv }), clr = el('a', { textContent: 'clear', onclick: clearHistory });
      exp.style.cssText = csv.style.cssText = clr.style.cssText = linkCss;
      const infoEl = el('div', {}, queriesTextEl, ' · ', edit, el('br'), histTextEl, ' · ', exp, ' · ', csv, ' · ', clr);
      infoEl.style.cssText = 'font-size:12px;opacity:.85;margin-top:6px';
      // one labelled line per setting (a single crowded line wrapped and left a dangling dash)
      const row = (tip, ...kids) => { const d = el('div', { title: tip }, ...kids); d.style.cssText = 'display:flex;align-items:center;gap:6px;margin:3px 0'; return d; };
      const inputs = el('div', {},
        row('Monthly rent cap. Also sent to Facebook as the maximum price.', 'Max rent ($/month)', numInput(() => CFG.maxPrice, (v) => (CFG.maxPrice = v))),
        row('Bedroom range, judged from the card title only. 2 to 2 = exactly 2 bedrooms. Ads that do not state a bedroom count are kept.', 'Bedrooms: from',
          numInput(() => (CFG.beds ? CFG.beds.min : 0), (v) => (CFG.beds = { min: v, max: CFG.beds ? CFG.beds.max : v })), 'to',
          numInput(() => (CFG.beds ? CFG.beds.max : 0), (v) => (CFG.beds = { min: CFG.beds ? CFG.beds.min : v, max: v }))),
        row('Most NEW listings opened in one run (0 = no limit). The rest wait for the next run.', 'Open at most', numInput(() => CFG.maxNewPerRun, (v) => (CFG.maxNewPerRun = v)), 'new listings per run'));
      panel.append(inputs,
        check('skip private rooms', () => CFG.skipRooms, (v) => (CFG.skipRooms = v)),
        check('full pass (scroll every search to the end)', () => CFG.fullScan, (v) => (CFG.fullScan = v)),
        check('re-open known listings too', () => CFG.refreshKnown, (v) => (CFG.refreshKnown = v)),
        el('div', { style: 'margin-top:6px' }),
        mkBtn('Dashboard', 'dash', openDashboard), mkBtn('Run all queries', 'auto', () => startRun('auto')), backlogBtn = mkBtn('Read waiting', 'backlog', () => startRun('backlog')), mkBtn('Scan this page', 'page', () => startRun('page')),
        mkBtn('Stop & save', 'stop', () => { state.stop = true; const c = loadCampaign(); if (c) { c.stop = true; saveCampaign(c); } setStatus('Stopping… will save what is done so far.'); }),
        pausedEl, infoEl);
    }
    queueEl = el('div'); queueEl.style.cssText = 'margin-top:6px';
    panel.append(statusEl, barBox, statsEl, warnEl, queueEl, linkEl);
    document.body.append(panel);
    updateHistLine(); updateQueriesLine(); refreshButtons(); paint();
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  (async function main() {
    if (await runWorkerIfNeeded()) return; // worker tabs get no UI
    loadSettings();
    render();
    let c = loadCampaign();
    if (c && c.mode === 'page' && c.phase === 'search') { clearCampaign(); c = null; } // a one-page scan can't resume after a reload
    if (c && !isItemPage()) {
      if (c.phase === 'search' && !onQueryPage(c)) {
        state.paused = true; setStatus(`A run is paused at search ${c.qi + 1}/${c.queries.length}. Resume or cancel it.`);
      } else { state.msg = 'Resuming the run…'; runCampaign(); }
    }
    setInterval(() => { render(); paint(); }, 500);
  })();
  function isItemPage() { return !!itemIdFromPath(location.pathname); }
})();
