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
  /* Browser port of analysis/build_dashboard.py: turns tracked listing views into the dashboard DATA object.
 * Same facts, evidence, red flags, near-duplicates and benchmark price as the Python builder. Left out on purpose:
 * the k-means themes and the ridge regression (they are not reliable at small sample sizes), so DATA.clusters is
 * empty and the model block says the fair price is the median of comparable listings.
 * Listing text is third-party data: it is only matched against patterns here, never executed or inserted as HTML. */
function fbmAnalyze(rawViews, scans, meta) {
  'use strict';
  const DOWNTOWN = [45.5017, -73.5673];

  // ---- text utilities (fold keeps the string LENGTH so match offsets stay valid)
  const fold = (s) => {
    let out = '';
    for (const c of String(s || '')) {
      const d = c.normalize('NFD');
      const first = d ? String.fromCodePoint(d.codePointAt(0)) : '';
      const b = first && !/\p{M}/u.test(first) ? first : c;
      const lc = b.toLowerCase();
      out += lc.length === b.length ? lc : b;
    }
    return out;
  };
  const words = (s) => new Set(s.split(/\s+/).map(fold));
  const STOP_EN = words('a an the and or but if then of to in on at by for with from as is are was were be been being it its this that these those you your we our they their he she his her i me my not no yes can will would should could may might must do does did done have has had having there here also than so such into over under about up down out off per via etc just very more most much many any all each other another same own only both few some get got');
  const STOP_FR = words('le la les un une des du de d l et ou mais si donc or ni car en dans sur sous par pour avec sans chez vers entre est sont etait etaient ete etre a ont avait avoir au aux ce cet cette ces se sa son ses leur leurs nous vous ils elles il elle je tu me te moi toi lui y ne pas plus que qui quoi dont quand comme tres tout tous toute toutes aussi bien peut peuvent doit doivent fait faire');
  const DOMAIN_STOP = words('apartment appartement apartments logement logements montreal montrealais bedroom bedrooms chambre chambres bath bathroom bathrooms salle bain rent loyer month mois available disponible house maison unit home contact message call text please svp merci thank thanks price prix per mo rue avenue ave boulevard blvd street road chemin st ste bed beds bath baths');
  const STOP_ALL = new Set([...STOP_EN, ...STOP_FR, ...DOMAIN_STOP]);
  const FR_ONLY = new Set([...STOP_FR].filter((w) => !STOP_EN.has(w)));
  const EN_ONLY = new Set([...STOP_EN].filter((w) => !STOP_FR.has(w)));

  function tokens(text) {
    const f = fold(text).replace(/['’]/g, ' ');
    const out = [];
    for (let t of f.match(/[a-z]{2,}/g) || []) {
      if (STOP_ALL.has(t)) continue;
      if (t.length > 5 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
      else if (t.length > 5 && /(shes|ches|xes|sses)$/.test(t)) t = t.slice(0, -2);
      else if (t.length > 4 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) t = t.slice(0, -1);
      out.push(t);
    }
    return out;
  }
  const withBigrams = (toks) => toks.concat(toks.slice(1).map((b, i) => toks[i] + ' ' + b));

  function tfidf(docs, minDf) { // -> { rows: [Map term->weight], df }
    const n = docs.length, df = new Map();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
    const rows = docs.map((d) => {
      const cnt = new Map();
      for (const t of d) cnt.set(t, (cnt.get(t) || 0) + 1);
      const row = new Map();
      let norm = 0;
      for (const [t, c] of cnt) {
        if (df.get(t) < minDf) continue;
        const w = (1 + Math.log(c)) * (Math.log((1 + n) / (1 + df.get(t))) + 1);
        row.set(t, w); norm += w * w;
      }
      norm = Math.sqrt(norm) || 1;
      for (const [t, w] of row) row.set(t, w / norm);
      return row;
    });
    return { rows, df };
  }
  const cosine = (a, b) => { if (a.size > b.size) [a, b] = [b, a]; let s = 0; for (const [t, w] of a) { const o = b.get(t); if (o) s += w * o; } return s; };

  function detectLanguage(text) {
    const toks = fold(text).match(/[a-z]+/g) || [];
    let fr = 0, en = 0;
    for (const t of toks) { if (FR_ONLY.has(t)) fr++; if (EN_ONLY.has(t)) en++; }
    if (fr + en < 6) return 'unknown';
    if (fr > 1.6 * en) return 'fr';
    if (en > 1.6 * fr) return 'en';
    return 'bilingual';
  }

  // ---- fact extraction
  const RX = {
    laundryUnit: String.raw`in[- ]?unit (laundry|washer)|laveuse[^.\n]{0,25}secheuse|washer[^.\n]{0,20}dryer|washer/dryer|lave-?linge|laundry in (the )?(unit|apartment|suite)`,
    laundryBuilding: String.raw`buanderie|laundry room|shared laundry|laundromat|laundry (facilit|on[- ]site)|laundry in (the )?building`,
    laundryHookup: String.raw`hook-?ups?|branchements? (pour )?(la )?(laveuse|secheuse)|entrees? (pour )?laveuse`,
    ac: String.raw`air[- ]?condition|climatis|\ba/c\b|\bac\b|thermopompe|heat pump`,
    parking: String.raw`stationnement|parking|garage|driveway`,
    noParking: String.raw`no parking|pas de stationnement|sans stationnement|parking not (included|available)`,
    dishwasher: String.raw`dishwasher|lave-?vaisselle`,
    elevator: String.raw`elevator|ascenseur`,
    furnished: String.raw`(?<!un)(?<!non )(?<!non-)(?<!semi-)(?<!semi )furnished|(?<!non )(?<!non-)(?<!semi-)(?<!semi )meuble`,
    balcony: String.raw`balcon|balcony|terrasse|patio`,
    pool: String.raw`piscine|swimming pool|\bpool\b`,
    gym: String.raw`\bgym\b|fitness|salle d'?exercice|salle de sport`,
    storage: String.raw`storage|rangement|locker|casier|sous-sol|basement`,
    secured: String.raw`secured? (entry|building)|intercom|interphone|code d'?acces|buzzer|keyless`,
    noSmoking: String.raw`no[- ]smoking|non[- ]?fumeur|smoke[- ]free|pas de fumeur|interdit de fumer`,
    refs: String.raw`references?\b|credit (check|report)|enquete de credit|proof of income|preuve de revenu|employment (letter|verification)|lettre d'?emploi`,
    leaseTransfer: String.raw`lease (transfer|assignment|takeover|take over)|(transfer|assign)(ing)? (of |the |my |our )?(the )?lease|cession de bail|ceder (mon|notre|le) bail|transfert de bail|reprise de bail|sublet|sous-?loca`,
    petsPos: String.raw`(pets?|animaux|animal|dogs?|chiens?|cats?|chats?)[^.\n]{0,30}(allowed|welcome|ok\b|okay|friendly|accept|permis|bienvenu|autoris)|(dog|cat|pet)[- ]friendly`,
    petsNeg: String.raw`no pets?|pets? (are )?not (allowed|permitted|accepted)|no dogs?|no cats?|pas d'?animaux|animaux[^.\n]{0,25}\b(non|pas) (permis|acceptes?|autorises?)|sans animaux|aucun animal|interdit aux animaux|no animals`,
    dogs: String.raw`dogs?[^.\n]{0,25}(allowed|welcome|ok\b|friendly|accept)|chiens?[^.\n]{0,25}(acceptes?|permis|bienvenus?)|chiens? et chats?|dogs? (and|&) cats?`,
    cats: String.raw`cats?[^.\n]{0,25}(allowed|welcome|ok\b|friendly|accept)|chats?[^.\n]{0,25}(acceptes?|permis|bienvenus?)|chiens? et chats?|dogs? (and|&) cats?`,
    july1: String.raw`1er juillet|1 juillet|july 1(st)?\b|1st of july|premier juillet`,
    offPlatform: String.raw`whatsapp|telegram|western union|zelle|gift card|carte cadeau|bitcoin|crypto|wire transfer|virement bancaire`,
    depositFirst: String.raw`(deposit|depot)[^.\n]{0,45}(before|avant)[^.\n]{0,25}(view|visit|visite|showing)|send (a |the )?(deposit|depot)|e-?transfer[^.\n]{0,25}(hold|reserve|secure|garder)`,
    absentOwner: String.raw`out of (the )?(country|town)|overseas|missionary|hors du pays|abroad|currently (living )?in (the )?(uk|usa|europe|france)`,
  };
  const RXC = {}, RXG = {};
  for (const [k, v] of Object.entries(RX)) { RXC[k] = new RegExp(v); RXG[k] = new RegExp(v, 'g'); }
  const INCL = new RegExp(String.raw`included|incl\b|inclus|incluse|comprise|compris|covered|paid by (the )?(landlord|owner)|paye par`);
  const EXCL = new RegExp(String.raw`not included|non[- ]?inclus|non[- ]?incluse|excluded|\bextra\b|additional|tenant|locataire|pas inclus|a la charge|not covered|not provided|separate|to be paid|payable`);
  const UTIL = {
    heat: [/heat(ing)?|chauff/g, /chauffe|heated/],
    hotWater: [/hot water|eau chaude/g, null],
    electricity: [/electricity|electricite|\bhydro\b/g, null],
    internet: [/internet|wi-?fi|\bcable\b/g, null],
  };
  const DELIM = /[.;\n•|!]/g;
  const AREA_NAMES = {
    'plateau': 'Plateau-Mont-Royal', 'mile end': 'Mile End', 'rosemont': 'Rosemont', 'petite-patrie': 'La Petite-Patrie', 'petite patrie': 'La Petite-Patrie',
    'villeray': 'Villeray', 'parc-extension': 'Parc-Extension', 'parc extension': 'Parc-Extension', 'outremont': 'Outremont', 'cote-des-neiges': 'Côte-des-Neiges',
    'cote des neiges': 'Côte-des-Neiges', 'ndg': 'NDG', 'notre-dame-de-grace': 'NDG', 'westmount': 'Westmount', 'cote-saint-luc': 'Côte-Saint-Luc',
    'cote saint-luc': 'Côte-Saint-Luc', 'cote st-luc': 'Côte-Saint-Luc', 'hampstead': 'Hampstead', 'verdun': 'Verdun', 'saint-henri': 'Saint-Henri', 'st-henri': 'Saint-Henri',
    'griffintown': 'Griffintown', 'pointe-saint-charles': 'Pointe-Saint-Charles', 'petite-bourgogne': 'Petite-Bourgogne', 'little burgundy': 'Petite-Bourgogne',
    'ville-marie': 'Ville-Marie', 'downtown': 'Downtown', 'centre-ville': 'Downtown', 'old montreal': 'Old Montréal', 'vieux-montreal': 'Old Montréal',
    'quartier des spectacles': 'Quartier des spectacles', 'gay village': 'The Village', 'le village': 'The Village', 'centre-sud': 'Centre-Sud', 'hochelaga': 'Hochelaga',
    'maisonneuve': 'Maisonneuve', 'mercier': 'Mercier', 'ahuntsic': 'Ahuntsic', 'cartierville': 'Cartierville', 'saint-laurent': 'Saint-Laurent', 'montreal-nord': 'Montréal-Nord',
    'saint-leonard': 'Saint-Léonard', 'anjou': 'Anjou', 'lasalle': 'LaSalle', 'lachine': 'Lachine', 'ville-emard': 'Ville-Émard', 'cote-saint-paul': 'Côte-Saint-Paul',
    'mont-royal': 'Mont-Royal', 'monkland': 'NDG', 'atwater': 'Atwater', 'snowdon': 'Snowdon', 'laval': 'Laval', 'longueuil': 'Longueuil',
  };
  const FAR_AREAS = new Set(['Côte-Saint-Luc', 'Lachine', 'LaSalle', 'Ahuntsic', 'Cartierville', 'Saint-Laurent', 'Montréal-Nord', 'Saint-Léonard', 'Anjou', 'Laval', 'Longueuil']);
  const HYPE_WORDS = /luxur|stunning|magnifique|exceptionnel|must see|ne manquez|rare\b|prime\b|beautiful|spacious|charming|amazing|incroyable|wow|renove|renovated|brand new|neuf|modern|moderne|bright|lumineu/g;
  const STRUCT = {
    'in-unit laundry': ['laundryUnit'], 'laundry in building': ['laundryBuilding'],
    'dog and cat friendly': ['dogs', 'cats', 'pets'], 'cat friendly': ['cats', 'pets'], 'dog friendly': ['dogs', 'pets'],
    'ac available': ['ac'], 'central ac': ['ac'], 'air conditioning': ['ac'],
    'garage parking': ['parking', 'garage'], 'street parking': ['parking'], 'parking available': ['parking'], 'off-street parking': ['parking'],
    'balcony': ['balcony'], 'dishwasher': ['dishwasher'], 'elevator': ['elevator'], 'fitness center': ['gym'], 'pool': ['pool'],
    'secured entry': ['secured'], 'concierge': ['concierge'], 'basement': ['storage'], 'fireplace': ['fireplace'], 'bike parking': ['bikeParking'],
  };
  const WORD_NUM = { un: 1, une: 1, one: 1, deux: 2, two: 2, trois: 3, three: 3, quatre: 4, four: 4, cinq: 5, five: 5 };

  // first match of a global regex starting at `pos`
  function searchFrom(rx, s, pos) { rx.lastIndex = pos; const m = rx.exec(s); return m; }
  function spans(rxg, folded, text, cap = 1) {
    const out = [];
    rxg.lastIndex = 0;
    let m;
    while ((m = rxg.exec(folded))) {
      out.push(text.slice(m.index, m.index + m[0].length));
      if (m[0].length === 0) rxg.lastIndex++;
      if (out.length >= cap) break;
    }
    return out;
  }

  function utilStatus(folded, text, key) {
    const [kw, selfIncl] = UTIL[key];
    let status = null, evidence = null;
    kw.lastIndex = 0;
    let m;
    while ((m = kw.exec(folded))) {
      const mEnd = m.index + m[0].length;
      const endClause = searchFrom(DELIM, folded, mEnd);
      const stop = endClause ? endClause.index : folded.length;
      const after = folded.slice(m.index, Math.min(stop, mEnd + 80));
      const before = folded.slice(Math.max(0, m.index - 45), m.index);
      const pos = mEnd - m.index;
      const e = after.slice(pos).match(EXCL), i = after.slice(pos).match(INCL);
      let found = null;
      if (e && (!i || e.index <= i.index)) found = 'excluded';
      else if (i) found = 'included';
      else if (selfIncl && selfIncl.test(after)) found = /(non|pas|not|un)[- ]?$/.test(before) ? 'excluded' : 'included';
      else if (/(incl(uded|us|ut)?|comprend|comprise)s?\s*[:\-–]\s*[^.\n]{0,40}$/.test(before)) found = 'included';
      else if (/(not included|non inclus|excluded)\s*[:\-–]\s*[^.\n]{0,40}$/.test(before)) found = 'excluded';
      if (found) {
        const ev = text.slice(m.index, Math.min(stop, mEnd + 60)).trim();
        if (status === null || (found === 'excluded' && status === 'included')) { status = found; evidence = ev; }
        if (status === 'excluded') break;
      }
    }
    return [status, evidence];
  }

  function bedsIn(text) {
    const t = fold(text || '');
    let m = t.match(/\b(\d|un|une|deux|trois|quatre|cinq|one|two|three|four|five)[\s-]*(?:chambres?|bedrooms?|beds?|bdrms?|bd|br)\b/);
    if (m) return /^\d$/.test(m[1]) ? +m[1] : WORD_NUM[m[1]];
    m = t.match(/(?:^|[^\d])(\d)\s?(?:1\/2|½|et demi)/);
    if (m) return +m[1] <= 2 ? 0 : +m[1] - 2;
    if (/\b(studio|bachelor|garconniere)\b/.test(t)) return 0;
    return null;
  }
  const inferBeds = (title, desc) => { const a = bedsIn(title); return a != null ? a : bedsIn(desc); };

  function parseListedDays(txt) {
    const t = fold(txt || '');
    if (!t) return null;
    const m = t.match(/(\d+)\s*(minute|hour|heure|day|jour|week|semaine|month|mois)/);
    if (t.includes('over a week')) return 8;
    if (t.includes('yesterday') || t.includes('hier')) return 1;
    if (m) { const n = +m[1], u = m[2]; return n * (u === 'month' || u === 'mois' ? 30 : u === 'week' || u === 'semaine' ? 7 : u === 'day' || u === 'jour' ? 1 : 0); }
    if (t.includes('today') || t.includes('just now') || t.includes('aujourd')) return 0;
    return null;
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const r = 6371, rad = (x) => (x * Math.PI) / 180;
    const p1 = rad(lat1), p2 = rad(lat2), dp = p2 - p1, dl = rad(lon2 - lon1);
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
  }
  const round = (x, d = 0) => { const k = 10 ** d; return Math.round(x * k) / k; };
  const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function enrich(v) {
    const title = v.title || '', desc = v.description || '';
    const text = title + '\n' + desc, f = fold(text);
    const ev = {}, has = {};
    const mark = (flag, evidence) => { has[flag] = true; if (evidence && !(flag in ev)) ev[flag] = evidence; };

    const amen = (v.amenities || []).filter(Boolean);
    let sqft = null, leaseMonths = null;
    for (const a of amen) {
      const al = String(a).toLowerCase().trim();
      for (const fl of STRUCT[al] || []) mark(fl, a);
      let m = al.match(/^([\d,]{3,6})\s*square feet/);
      if (m) sqft = parseInt(m[1].replace(/,/g, ''), 10);
      m = al.match(/^(\d+)\s*(year|month)s?\s*lease/);
      if (m) leaseMonths = +m[1] * (m[2] === 'year' ? 12 : 1);
    }
    for (const flag of ['laundryUnit', 'laundryBuilding', 'laundryHookup', 'ac', 'dishwasher', 'elevator', 'furnished', 'balcony', 'pool', 'gym', 'storage', 'secured', 'noSmoking', 'refs', 'leaseTransfer', 'july1']) {
      const s = spans(RXG[flag], f, text);
      if (s.length) mark(flag, s[0]);
    }
    const park = spans(RXG.parking, f, text);
    if (park.length && !RXC.noParking.test(f)) mark('parking', park[0]);

    const neg = spans(RXG.petsNeg, f, text);
    const pos = spans(RXG.petsPos, f, text, 6).filter((p) => !/\b(non|pas|not|no|sans)\b/.test(fold(p))).slice(0, 1);
    let pets = null;
    if (has.pets || pos.length) { pets = 'ok'; if (pos.length && !('pets' in ev)) ev.pets = pos[0]; }
    if (neg.length && !has.pets) { pets = 'no'; ev.petsNo = neg[0]; }
    if (has.pets && neg.length) ev.petsNo = neg[0];
    for (const key of ['dogs', 'cats']) { const s = spans(RXG[key], f, text); if (s.length && pets !== 'no') mark(key, s[0]); }

    const utils = {};
    for (const key of Object.keys(UTIL)) {
      const [status, evid] = utilStatus(f, text, key);
      utils[key] = status;
      if (status && evid) ev['util_' + key] = evid;
    }
    if (utils.heat === 'included') mark('heatIncl', ev.util_heat);

    if (sqft == null) {
      const m = f.match(/(\d{3,4})\s*(sq\.?\s?ft|sqft|square feet|pi2|pi²|pieds? carres?)/);
      if (m) { sqft = parseInt(m[1], 10); ev.sqft = text.slice(m.index, m.index + m[0].length); }
    }
    if (sqft != null && !(sqft >= 250 && sqft <= 3500)) sqft = null;
    if (leaseMonths == null) {
      const m = f.match(/(\d{1,2})[- ]month lease|bail de (\d{1,2}) mois|(\d{1,2})\s*mois de bail/);
      if (m) leaseMonths = +(m[1] || m[2] || m[3]);
      else if (/(1|one|un)[- ](year|an)\b|12 mois|12 months|bail d'?un an/.test(f)) leaseMonths = 12;
    }
    const qc = text.match(/\b(\d)\s*(?:½|1\/2|et demi)/);
    const qcSize = qc ? qc[1] + '½' : null;

    const named = [];
    for (const [key, name] of Object.entries(AREA_NAMES)) if (f.includes(key) && !named.includes(name)) named.push(name);

    const lat = v.latitude, lon = v.longitude;
    const dist = typeof lat === 'number' && typeof lon === 'number' ? round(haversine(lat, lon, DOWNTOWN[0], DOWNTOWN[1]), 2) : null;
    const price = v.priceAmount;
    let beds = v.bedrooms == null ? null : v.bedrooms;
    const baths = v.bathrooms == null ? null : v.bathrooms;
    let bedsInferred = false;
    if (beds == null) {
      const ib = 'bedroomsInferred' in v ? v.bedroomsInferred : inferBeds(title, desc);
      if (ib != null) { beds = ib; bedsInferred = true; }
    }
    const category = v.category || '';
    const kind = v.kind || (category.toLowerCase().startsWith('rental') ? 'structured' : 'text-only');
    const locTxt = (v.locationText || '').trim();
    const address = /^\d/.test(locTxt) ? locTxt : null;
    const postal = v.postalCode || '';
    const availText = v.availabilityText || '';

    let pts = 0;
    pts += sqft ? 15 : 0;
    pts += (v.availableFrom || availText.toLowerCase().includes('now')) ? 10 : 0;
    pts += leaseMonths ? 10 : 0;
    pts += Object.values(utils).some(Boolean) ? 15 : 0;
    pts += pets ? 10 : 0;
    pts += (has.laundryUnit || has.laundryBuilding || has.laundryHookup) ? 10 : 0;
    pts += (has.parking || RXC.noParking.test(f)) ? 5 : 0;
    pts += (address || postal) ? 10 : 0;
    const nPhotos = v.photoCount != null ? v.photoCount : 0;
    pts += nPhotos >= 8 ? 10 : 0;
    pts += desc.length >= 400 ? 5 : 0;
    let letters = 0, upperN = 0, emoji = 0;
    for (const c of text) {
      if (/\p{L}/u.test(c)) { letters++; if (c !== c.toLowerCase() && c === c.toUpperCase()) upperN++; }
      if (c.codePointAt(0) > 0x2190) emoji++;
    }
    const upper = upperN / Math.max(1, letters);
    HYPE_WORDS.lastIndex = 0;
    const hypeN = (f.match(HYPE_WORDS) || []).length;
    const bang = (text.match(/!/g) || []).length;
    const hype = Math.min(100, Math.round(hypeN * 9 + bang * 6 + emoji * 4 + Math.max(0, upper - 0.12) * 120));

    const flagEv = {};
    const flags = {};
    for (const k of ['offPlatform', 'depositFirst', 'absentOwner']) { flags[k] = RXC[k].test(f); flagEv[k] = spans(RXG[k], f, text)[0] || null; }

    return {
      id: v.id, url: v.url, title, price, priceText: v.price || '',
      beds, baths, sqft, ppsf: price && sqft ? round(price / sqft, 2) : null, pbed: price && beds ? round(price / beds, 0) : null,
      qcSize, type: v.propertyType || null, bedsInferred, kind, category: category || null,
      via: v.foundVia || [], priceFromText: !!v.priceFromText,
      area: postal ? postal.split(/\s+/)[0] : null, postal: postal || null, address, named, city: v.city || null,
      lat: dist != null ? lat : null, lon: dist != null ? lon : null, dist,
      lang: detectLanguage(desc), listedText: v.listedText || '', listedDays: parseListedDays(v.listedText),
      availText, availFrom: v.availableFrom || null, availNow: /now|maintenant/i.test(availText),
      leaseMonths, pets, utils, has, amenities: amen, evidence: ev,
      desc, descLen: desc.length, transparency: pts, hype,
      status: v.status || null, firstSeen: v.firstSeen || null, lastSeen: v.lastSeen || null, goneAt: v.goneAt || null,
      priceHistory: v.priceHistory || [], prevPrice: v.prevPrice == null ? null : v.prevPrice,
      isPending: !!v.isPending, isSold: !!v.isSold, isLive: v.isLive !== false,
      _flags: flags, _flagEv: flagEv, photos: [], photoCount: nPhotos,
    };
  }

  // ---- assemble
  const priced = rawViews.filter((v) => v.priceAmount && v.priceAmount >= 300 && v.priceAmount <= 10000);
  const recs = priced.map(enrich).sort((a, b) => a.price - b.price || (a.id < b.id ? -1 : 1));
  const n = recs.length;
  const docs = recs.map((r) => withBigrams(tokens(r.title + ' ' + r.desc)));
  const { rows: Xs } = tfidf(docs, n >= 8 ? 2 : 1);
  const { rows: Xk, df: dfK } = tfidf(docs, 1);

  recs.forEach((r, i) => {
    const kws = [];
    for (const [t] of [...Xk[i]].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
      if (n >= 8 && dfK.get(t) > 0.6 * n) continue;
      if (kws.some((x) => x.includes(t) || t.includes(x))) continue;
      kws.push(t);
      if (kws.length === 6) break;
    }
    r.keywords = kws; r.cluster = 0;
    const nb = [];
    for (let j = 0; j < n; j++) if (j !== i) nb.push([cosine(Xs[i], Xs[j]), j]);
    nb.sort((a, b) => b[0] - a[0]);
    r.similar = nb.slice(0, 3).filter(([s]) => s >= 0.2).map(([s, j]) => ({ id: recs[j].id, sim: round(s, 2) }));
  });

  const parent = recs.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = recs[i], b = recs[j];
    const spot = a.lat && b.lat && Math.abs(a.lat - b.lat) < 0.0003 && Math.abs(a.lon - b.lon) < 0.0003;
    const nearPrice = Math.abs(a.price - b.price) <= 0.05 * a.price;
    const sim = cosine(Xs[i], Xs[j]);
    if (sim >= 0.85 || (spot && nearPrice && sim >= 0.3)) parent[find(i)] = find(j);
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) { const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); }
  const dupGroups = [...groups.values()].filter((g) => g.length > 1).map((g) => g.map((i) => recs[i].id));
  for (const g of dupGroups) for (const id of g) recs.find((r) => r.id === id).dupGroup = g;

  // benchmark price: median of the OTHER listings with the same bedroom count (else of everyone else)
  const model = { n, enabled: false, useful: false, baselineMAE: 0, features: [], note: '' };
  let absErr = 0;
  const bedGroups = new Map();
  for (const r of recs) { if (!bedGroups.has(r.beds)) bedGroups.set(r.beds, []); bedGroups.get(r.beds).push(r.price); }
  const overall = median(recs.map((r) => r.price));
  recs.forEach((r, i) => {
    const others = recs.filter((_, j) => j !== i).map((o) => o.price);
    const same = recs.filter((o, j) => j !== i && o.beds === r.beds).map((o) => o.price);
    const base = same.length >= 2 ? median(same) : others.length ? median(others) : r.price;
    absErr += Math.abs(r.price - base);
    r.predicted = Math.round(base);
    r.dealPct = round(((base - r.price) / base) * 100, 1);
    const grp = bedGroups.get(r.beds);
    const bench = grp.length >= 3 ? median(grp) : overall;
    r.vsMedian = round(((r.price - bench) / bench) * 100, 1);
    r.drivers = [];
  });
  model.baselineMAE = n ? round(absErr / n, 1) : 0;
  model.note = 'Fair price = median of the other listings with the same bedroom count (the in-app dashboard uses this benchmark; the regression model is only in the Python builder, where it was rarely better at small sample sizes).';

  for (const r of recs) {
    const fl = [];
    if (r._flags.offPlatform) fl.push({ sev: 'serious', code: 'offPlatform', label: 'Off-platform payment or contact', why: 'Mentions ' + (r._flagEv.offPlatform || 'an off-platform channel') + '. Common in rental scams.' });
    if (r._flags.depositFirst) fl.push({ sev: 'serious', code: 'depositFirst', label: 'Deposit requested before a visit', why: 'Quebec landlords generally cannot require a security deposit, and paying before viewing is a classic scam pattern.' });
    if (r._flags.absentOwner) fl.push({ sev: 'serious', code: 'absentOwner', label: 'Owner abroad / unavailable', why: 'Mentions "' + (r._flagEv.absentOwner || 'out of country') + '".' });
    if (n >= 6 && r.dealPct >= 25 && r.vsMedian <= -20) fl.push({ sev: 'warn', code: 'tooCheap', label: 'Priced far below comparable listings', why: `${r.dealPct.toFixed(0)}% under the fair-price estimate and ${Math.abs(r.vsMedian).toFixed(0)}% under the median. Verify before paying anything.` });
    if (r.descLen < 150 && !r.sqft) fl.push({ sev: 'info', code: 'thin', label: 'Very little detail in the ad', why: 'Short description and no square footage.' });
    if (r.dupGroup) fl.push({ sev: 'info', code: 'dupe', label: `Near-duplicate of ${r.dupGroup.length - 1} other listing(s)`, why: 'Very similar text or the same spot: probably the same landlord or building.' });
    if (r.kind === 'text-only') fl.push({ sev: 'info', code: 'textOnly', label: 'Not filed under Rentals (text-only ad)', why: 'Posted in another category, so there are no structured details: bedrooms and amenities come from the text' + (r.bedsInferred ? ' (bedrooms inferred)' : ', and the bedroom count is unknown') + ', and the fair-price estimate is less reliable.' });
    if (r.priceFromText) fl.push({ sev: 'info', code: 'priceFromText', label: 'Rent taken from the description', why: 'The listed price was a placeholder, so the rent was read from the ad text. Check it with the landlord.' });
    const far = r.named.filter((a) => FAR_AREAS.has(a));
    if (far.length && r.dist != null && r.dist < 2.5) fl.push({ sev: 'info', code: 'pinMismatch', label: 'Map pin may be wrong', why: `The text mentions ${far[0]} but Facebook's pin is only ${r.dist.toFixed(1)} km from downtown. The pin is approximate: trust the address in the text.` });
    if (r.isPending || r.isSold) fl.push({ sev: 'warn', code: 'pending', label: 'Marked pending or sold', why: 'Facebook shows this listing as no longer available.' });
    r.redFlags = fl;
    delete r._flags; delete r._flagEv;
  }

  const totals = new Map();
  for (const d of docs) for (const t of new Set(d)) totals.set(t, (totals.get(t) || 0) + 1);
  const phrases = [...totals].sort((a, b) => b[1] - a[1]).filter(([t, c]) => c >= 2 && (t.includes(' ') || t.length > 3)).slice(0, 18);

  const d = new Date(), pad = (x) => String(x).padStart(2, '0');
  return {
    meta: { generated: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`, sources: ['in-app history'], n, downtown: DOWNTOWN, key: 'in-app:' + ((meta && meta.profile) || '') },
    listings: recs, model, clusters: [], phrases, dupGroups,
    scans: scans || [], queries: (meta && meta.queries) || [], profile: (meta && meta.profile) || null, unpriced: rawViews.length - recs.length,
  };
}


  const FBM_DASH_HTML = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>\n:root{\n  color-scheme:light;\n  --page:#f9f9f7;--surface:#fcfcfb;--sunk:#f3f3f0;--ink:#0b0b0b;--ink2:#52514e;--muted:#6f6d68;--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);\n  --series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--series-hi:#1c5cab;\n  --seq-1:#86b6ef;--seq-2:#5598e7;--seq-3:#2a78d6;--seq-4:#1c5cab;--seq-5:#104281;\n  --div-b3:#1c5cab;--div-b2:#5598e7;--div-b1:#b7d3f6;--div-n:#d9d8d2;--div-r1:#f7c9c7;--div-r2:#ee8d8b;--div-r3:#cf3434;\n  --good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--good-text:#006300;--on-fill:#fff;\n  --shadow:0 1px 2px rgba(0,0,0,.06),0 4px 14px rgba(0,0,0,.06);\n}\n@media (prefers-color-scheme:dark){:root:where(:not([data-theme=\"light\"])){\n  color-scheme:dark;\n  --page:#0d0d0d;--surface:#1a1a19;--sunk:#222221;--ink:#f0efec;--ink2:#c3c2b7;--muted:#a09e97;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);\n  --series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-hi:#9ec5f4;\n  --seq-1:#184f95;--seq-2:#256abf;--seq-3:#3987e5;--seq-4:#6da7ec;--seq-5:#9ec5f4;\n  --div-b3:#4a96ec;--div-b2:#2a6fc4;--div-b1:#234a78;--div-n:#383835;--div-r1:#7a3a39;--div-r2:#c04e4d;--div-r3:#e66767;\n  --good-text:#0ca30c;--shadow:none;\n}}\n:root[data-theme=\"dark\"]{\n  color-scheme:dark;\n  --page:#0d0d0d;--surface:#1a1a19;--sunk:#222221;--ink:#f0efec;--ink2:#c3c2b7;--muted:#a09e97;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);\n  --series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-hi:#9ec5f4;\n  --seq-1:#184f95;--seq-2:#256abf;--seq-3:#3987e5;--seq-4:#6da7ec;--seq-5:#9ec5f4;\n  --div-b3:#4a96ec;--div-b2:#2a6fc4;--div-b1:#234a78;--div-n:#383835;--div-r1:#7a3a39;--div-r2:#c04e4d;--div-r3:#e66767;\n  --good-text:#0ca30c;--shadow:none;\n}\n*{box-sizing:border-box}\n[hidden]{display:none!important}\nhtml{background:var(--page)}\nbody{margin:0;background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,\"Segoe UI\",sans-serif}\nbutton,input,select,textarea{font:inherit;color:inherit}\nbutton{cursor:pointer}\n:focus-visible{outline:2px solid var(--series-1);outline-offset:2px}\n.chrome{background:var(--surface);border-bottom:1px solid var(--grid)}\n@media (min-width:900px){.chrome{position:sticky;top:0;z-index:30}}\n.top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;padding:10px 16px}\n.brand h1{margin:0;font-size:17px;letter-spacing:-.01em}\n.brand .meta{color:var(--muted);font-size:12px}\n.tabs{display:flex;gap:2px;margin-left:auto;flex-wrap:wrap}\n.tab{padding:6px 12px;border:0;background:none;border-radius:8px;color:var(--ink2)}\n.tab:hover{background:var(--sunk)}\n.tab[aria-selected=true]{background:var(--ink);color:var(--surface)}\n.tab small{opacity:.7;margin-left:4px}\n.iconbtn{border:1px solid var(--grid);background:var(--surface);border-radius:8px;padding:5px 9px;color:var(--ink2)}\n.iconbtn:hover{background:var(--sunk)}\n.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 16px 10px;border-top:1px solid var(--grid)}\n.filters label{display:flex;align-items:center;gap:6px;color:var(--ink2);font-size:13px}\n.filters input[type=search]{width:min(260px,100%)}\n.filters input,.filters select{padding:5px 8px;border:1px solid var(--grid);border-radius:8px;background:var(--surface)}\n.filters input[type=number]{width:84px}\n.count{margin-left:auto;color:var(--muted);font-size:13px}\ndetails.pop{position:relative}\ndetails.pop>summary{list-style:none;cursor:pointer;padding:5px 10px;border:1px solid var(--grid);border-radius:8px;color:var(--ink2);font-size:13px;background:var(--surface)}\ndetails.pop>summary::-webkit-details-marker{display:none}\ndetails.pop[open]>summary{background:var(--sunk)}\ndetails.pop .menu{position:absolute;z-index:40;top:calc(100% + 6px);left:0;min-width:240px;max-height:60vh;overflow:auto;padding:10px;background:var(--surface);border:1px solid var(--grid);border-radius:10px;box-shadow:var(--shadow);display:grid;gap:4px}\n.menu label{justify-content:space-between;width:100%}\n.menu .n{color:var(--muted);font-variant-numeric:tabular-nums}\n.chip{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;border:1px solid var(--grid);background:var(--surface);color:var(--ink2);font-size:12px;white-space:nowrap}\n.chip.kw{background:var(--sunk)}\n.chips{display:flex;flex-wrap:wrap;gap:5px}\nmain{padding:16px}\n.split{display:grid;grid-template-columns:minmax(0,1fr) 440px;gap:16px;align-items:start}\n.listhead{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}\n.seg{border:1px solid var(--grid);background:var(--surface);padding:4px 10px;color:var(--ink2)}\n.seg:first-of-type{border-radius:8px 0 0 8px}.seg:last-of-type{border-radius:0 8px 8px 0;border-left:0}\n.seg[aria-pressed=true]{background:var(--ink);color:var(--surface);border-color:var(--ink)}\n.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}\n.card{background:var(--surface);border:1px solid var(--grid);border-radius:12px;overflow:hidden;cursor:pointer;display:flex;flex-direction:column}\n.card:hover{border-color:var(--axis)}\n.card.sel{outline:2px solid var(--series-1);outline-offset:-2px}\n.card.dim{opacity:.55}\n.thumb{position:relative;aspect-ratio:4/3;background:var(--sunk);overflow:hidden}\n.thumb img{width:100%;height:100%;object-fit:cover;display:block}\n.noimg{display:grid;place-items:center;height:100%;color:var(--muted);font-size:12px}\n.badge{position:absolute;left:8px;top:8px;display:inline-flex;align-items:center;gap:6px;background:var(--surface);color:var(--ink);padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;box-shadow:var(--shadow);border:1px solid var(--grid)}\n.dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:var(--div-n);flex:none}\n.dot.b3{background:var(--div-b3)}.dot.b2{background:var(--div-b2)}.dot.b1{background:var(--div-b1)}.dot.n{background:var(--div-n)}.dot.r1{background:var(--div-r1)}.dot.r2{background:var(--div-r2)}.dot.r3{background:var(--div-r3)}\n.dot.ring{box-shadow:inset 0 0 0 1px var(--axis)}\n.toprow{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 0}\n.badge.static,.star.static{position:static;box-shadow:none}\n.star{position:absolute;right:6px;top:6px;border:0;background:var(--surface);border-radius:999px;width:30px;height:30px;line-height:30px;text-align:center;box-shadow:var(--shadow);color:var(--ink2);padding:0}\n.star[aria-pressed=true]{color:#d99a00}\n.cbody{padding:10px 12px 12px;display:grid;gap:4px}\n.price{font-size:20px;font-weight:700;letter-spacing:-.01em}\n.price .per{font-size:12px;font-weight:400;color:var(--muted);margin-left:2px}\n.facts,.where{color:var(--ink2);font-size:13px}\n.where{color:var(--muted)}\n.warnrow{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--ink2)}\ntable.t{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--grid);border-radius:12px;overflow:hidden;font-size:13px}\n.t th,.t td{padding:6px 10px;border-bottom:1px solid var(--grid);text-align:left;white-space:nowrap}\n.t th{background:var(--sunk);color:var(--ink2);font-weight:600;position:sticky;top:0}\n.t th.sortable{cursor:pointer;user-select:none}\n.t td.num,.t th.num{text-align:right;font-variant-numeric:tabular-nums}\n.t tbody tr{cursor:pointer}.t tbody tr:hover{background:var(--sunk)}.t tr.sel{background:var(--sunk);box-shadow:inset 3px 0 0 var(--series-1)}\n.t img{width:56px;height:42px;object-fit:cover;border-radius:6px;display:block;background:var(--sunk)}\n.tw{overflow-x:auto;border-radius:12px}\n.detail{position:sticky;top:var(--chrome-h,120px);max-height:calc(100vh - var(--chrome-h,120px) - 16px);overflow:auto;background:var(--surface);border:1px solid var(--grid);border-radius:12px;padding:0}\n.detail .pad{padding:14px 16px}\n.dhead{display:flex;gap:10px;align-items:flex-start;justify-content:space-between}\n.dhead h2{margin:0;font-size:16px;line-height:1.3}\n.dprice{font-size:26px;font-weight:700;letter-spacing:-.02em}\n.gallery{background:var(--sunk);position:relative}\n.gallery .main{aspect-ratio:4/3;width:100%;object-fit:cover;display:block;cursor:zoom-in}\n.gallery .nav{position:absolute;top:50%;transform:translateY(-50%);border:0;background:var(--surface);width:34px;height:34px;border-radius:50%;box-shadow:var(--shadow)}\n.gallery .prev{left:8px}.gallery .next{right:8px}\n.gallery .count{position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.6);color:#fff;border-radius:999px;padding:1px 9px;font-size:12px;margin:0}\n.strip{display:flex;gap:4px;overflow-x:auto;padding:6px}\n.strip img{width:64px;height:48px;object-fit:cover;border-radius:6px;cursor:pointer;opacity:.7;flex:none}\n.strip img.on{opacity:1;outline:2px solid var(--series-1)}\n.sec{border-top:1px solid var(--grid);padding:12px 16px}\n.sec h3{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}\ndl.facts2{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0}\ndl.facts2 dt{color:var(--muted)}dl.facts2 dd{margin:0}\n.desc{white-space:pre-wrap;max-height:240px;overflow:auto;background:var(--sunk);padding:10px;border-radius:8px;font-size:13px}\n.desc.full{max-height:none}\nmark{background:color-mix(in srgb,var(--series-1) 25%,transparent);color:inherit;border-radius:3px;padding:0 1px}\n.btnrow{display:flex;flex-wrap:wrap;gap:6px}\n.btn{border:1px solid var(--grid);background:var(--surface);border-radius:8px;padding:5px 10px;color:var(--ink2);text-decoration:none;display:inline-block;font-size:13px}\n.btn:hover{background:var(--sunk)}\n.btn.on{background:var(--ink);color:var(--surface);border-color:var(--ink)}\ntextarea.note{width:100%;min-height:70px;border:1px solid var(--grid);border-radius:8px;background:var(--surface);padding:8px;resize:vertical}\n.flag{display:flex;gap:8px;align-items:flex-start;padding:6px 0}\n.flag .ic{flex:none;width:20px;text-align:center;font-weight:700}\n.flag.serious .ic{color:var(--critical)}.flag.warn .ic{color:#b35900}.flag.info .ic{color:var(--ink2)}\n.flag b{font-weight:600}\n.flag p{margin:0;color:var(--ink2);font-size:13px}\n.muted{color:var(--muted)}\n.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px}\n.cc{background:var(--surface);border:1px solid var(--grid);border-radius:12px;padding:14px 16px 10px;min-width:0}\n.cc.wide{grid-column:1/-1}\n.cc header{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:6px}\n.cc h2{margin:0;font-size:14px}.cc .sub{margin:2px 0 0;color:var(--muted);font-size:12px}\n.cc .vt{display:flex;flex:none}\n.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}\n.tile{background:var(--surface);border:1px solid var(--grid);border-radius:12px;padding:12px 14px}\n.tile .l{color:var(--muted);font-size:12px}.tile .v{font-size:24px;font-weight:700;letter-spacing:-.02em;margin:2px 0}.tile .s{color:var(--muted);font-size:12px}\nsvg.chart{width:100%;height:auto;display:block;overflow:visible}\nsvg text{font-family:inherit;fill:var(--ink2);font-size:11px}\nsvg .tick{fill:var(--muted)}\nsvg .lab{fill:var(--ink)}\nsvg .grid{stroke:var(--grid);stroke-width:1}\nsvg .axis{stroke:var(--axis);stroke-width:1}\nsvg .hit{fill:transparent}\nsvg .bar{fill:var(--series-1)}\nsvg .bar.hi{fill:var(--series-hi)}\nsvg .pt{stroke:var(--surface);stroke-width:2}\nsvg .ringsel{fill:none;stroke:var(--ink);stroke-width:2}\nsvg .hover-ring{fill:none;stroke:var(--ink);stroke-width:1.5;pointer-events:none}\nsvg .line{fill:none;stroke:var(--series-1);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}\nsvg .ref{stroke:var(--ink2);stroke-width:1}\n.legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px;font-size:12px;color:var(--ink2)}\n.legend span{display:inline-flex;align-items:center;gap:5px}\n.sw{width:12px;height:12px;border-radius:3px;display:inline-block;flex:none}\n.segbar{display:flex;height:28px;gap:2px;margin:8px 0}\n.segbar div{border-radius:4px;color:var(--on-fill);font-size:12px;display:flex;align-items:center;padding-left:8px;white-space:nowrap}\n.list{margin:0;padding:0;list-style:none;display:grid;gap:2px}\n.list li{display:flex;gap:10px;justify-content:space-between;padding:5px 6px;border-radius:6px;cursor:pointer}\n.list li:hover{background:var(--sunk)}\n.theme{border:1px solid var(--grid);border-radius:10px;padding:10px 12px}\n.themes{display:grid;gap:10px}\n.notice{background:var(--sunk);border-radius:8px;padding:8px 12px;color:var(--ink2);font-size:13px;margin:6px 0}\n.empty{padding:40px;text-align:center;color:var(--muted)}\n#tip{position:fixed;z-index:100;pointer-events:none;background:var(--surface);color:var(--ink);border:1px solid var(--axis);border-radius:8px;padding:6px 10px;box-shadow:var(--shadow);font-size:12px;max-width:260px}\n#tip b{font-size:13px}#tip .r{display:flex;justify-content:space-between;gap:14px;color:var(--ink2)}#tip .r span:last-child{color:var(--ink);font-weight:600}\n#lightbox,#help{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.8);display:grid;place-items:center;padding:20px}\n#lightbox img{max-width:100%;max-height:100%;border-radius:8px}\n#help .box{background:var(--surface);border-radius:12px;padding:18px 22px;max-width:420px;width:100%}\n#help h2{margin:0 0 10px}\n#help dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0}\nkbd{background:var(--sunk);border:1px solid var(--grid);border-bottom-width:2px;border-radius:5px;padding:0 6px;font:12px ui-monospace,monospace}\n.closebtn{display:none}\n@media (max-width:1000px){\n  .split{grid-template-columns:minmax(0,1fr)}\n  .detail{position:fixed;inset:0;z-index:60;max-height:none;border-radius:0;display:none}\n  .detail.open{display:block}\n  .closebtn{display:inline-block}\n  .tabs{margin-left:0}\n}\n@media (max-width:520px){.cards{grid-template-columns:1fr}.grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}}\n</style></head><body>\n<noscript>This dashboard needs JavaScript.</noscript>\n<div class=\"chrome\" id=\"chrome\">\n  <div class=\"top\">\n    <div class=\"brand\"><h1>Rental Dashboard</h1><div class=\"meta\" id=\"meta\"></div></div>\n    <nav class=\"tabs\" role=\"tablist\" id=\"tabs\"></nav>\n    <button class=\"iconbtn\" id=\"theme\" title=\"Toggle light / dark\" aria-label=\"Toggle light or dark theme\">◐</button>\n    <button class=\"iconbtn\" id=\"helpbtn\" title=\"Keyboard shortcuts (?)\" aria-label=\"Keyboard shortcuts\">?</button>\n  </div>\n  <section class=\"filters\" id=\"filters\" aria-label=\"Filters\"></section>\n</div>\n<main id=\"main\"></main>\n<div id=\"tip\" role=\"tooltip\" hidden></div>\n<div id=\"lightbox\" hidden></div>\n<div id=\"help\" hidden></div>\n</body></html>";
function fbmMountDashboard(document, window, DATA) {
'use strict';
const history = window.history, location = window.location;

'use strict';

(function () {
const L = DATA.listings, META = DATA.meta, MODEL = DATA.model;
const byId = new Map(L.map((r) => [r.id, r]));
const HAS_PHOTOS = L.some((r) => r.photos.length > 0); // newer snapshots have none: the layout drops the picture areas
const $ = (sel, el = document) => el.querySelector(sel);

// ------------------------------------------------------------------ DOM helpers (all text via textContent)
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (k.startsWith('aria-') && typeof v === 'boolean') { e.setAttribute(k, String(v)); continue; }
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs || {}) { const v = attrs[k]; if (v == null || v === false) continue; if (k === 'text') e.textContent = v; else if (k === 'fill' && String(v).startsWith('var(')) e.style.fill = v; else e.setAttribute(k, v); }
  for (const c of kids.flat(Infinity)) if (c) e.append(c);
  return e;
}
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const money = (n) => (n == null || isNaN(n) ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
const signed = (n, suf = '') => (n > 0 ? '+' : n < 0 ? '−' : '') + (suf === '$' ? '$' : '') + Math.abs(Math.round(n)).toLocaleString('en-US') + (suf === '$' ? '' : suf);
const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
L.forEach((r) => { r._hay = fold([r.title, r.desc, r.amenities.join(' '), r.named.join(' '), r.area, r.postal, r.address].join(' ')); });

// ------------------------------------------------------------------ stats
const clean = (a) => a.filter((x) => x != null && !isNaN(x));
function median(a) { const b = clean(a).sort((x, y) => x - y), n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : null; }
function ranks(a) { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; }
function pearson(x, y) { const n = x.length; if (n < 3) return null; const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null; }
function spearman(x, y) { return x.length < 3 ? null : pearson(ranks(x), ranks(y)); }
function ols(x, y) { const n = x.length; if (n < 3) return null; const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; } if (!sxx) return null; const slope = sxy / sxx; return { slope, intercept: my - slope * mx, r: pearson(x, y) }; }
function niceTicks(lo, hi, n = 5) { const span = hi - lo || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0)), norm = step0 / mag, step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag; const out = []; for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.5; v += step) out.push(+v.toFixed(10)); return out; }
const lin = (d0, d1, r0, r1) => (v) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));
const hash = (str) => { let x = 0; for (const c of str) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; };

// ------------------------------------------------------------------ persistence (per-viewer conveniences only)
const PFX = 'rentdash:' + META.key + ':';
const store = {
  get(k, d) { try { const v = localStorage.getItem(PFX + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(PFX + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const user = { starred: store.get('starred', {}), hidden: store.get('hidden', {}), notes: store.get('notes', {}) };
let compare = store.get('compare', []).filter((id) => byId.has(id));
const saveUser = () => { store.set('starred', user.starred); store.set('hidden', user.hidden); store.set('notes', user.notes); store.set('compare', compare); };

// ------------------------------------------------------------------ definitions
const FLAGS = [
  ['laundryUnit', 'In-unit laundry'], ['laundryBuilding', 'Laundry in building'], ['parking', 'Parking'], ['ac', 'A/C'], ['heatIncl', 'Heating included'],
  ['dogs', 'Dogs OK'], ['cats', 'Cats OK'], ['dishwasher', 'Dishwasher'], ['elevator', 'Elevator'], ['balcony', 'Balcony / terrace'], ['furnished', 'Furnished'],
  ['gym', 'Gym'], ['pool', 'Pool'], ['storage', 'Storage'], ['secured', 'Secured entry'], ['noSmoking', 'No smoking'], ['leaseTransfer', 'Lease transfer'],
];
const FLAG_LABEL = Object.fromEntries(FLAGS);
const CHIP_ORDER = ['laundryUnit', 'laundryBuilding', 'parking', 'ac', 'heatIncl', 'dogs', 'cats', 'dishwasher', 'balcony', 'elevator', 'furnished', 'leaseTransfer'];
const BINS = [['b3', 20, '20%+ under'], ['b2', 10, '10–20% under'], ['b1', 3, '3–10% under'], ['n', -3, 'within 3%'], ['r1', -10, '3–10% over'], ['r2', -20, '10–20% over'], ['r3', -Infinity, '20%+ over']];
const dealBin = (p) => (p >= 20 ? 'b3' : p >= 10 ? 'b2' : p >= 3 ? 'b1' : p > -3 ? 'n' : p > -10 ? 'r1' : p > -20 ? 'r2' : 'r3');
const dealText = (p) => (Math.abs(p) < 3 ? 'Fair price' : `${Math.abs(Math.round(p))}% ${p > 0 ? 'under' : 'over'} fair`);
const SORTS = {
  deal: ['Best value', (a, b) => b.dealPct - a.dealPct], price: ['Price, low to high', (a, b) => a.price - b.price], priceDesc: ['Price, high to low', (a, b) => b.price - a.price],
  sqft: ['Largest', (a, b) => (b.sqft || 0) - (a.sqft || 0)], ppsf: ['$/sq ft, low to high', (a, b) => (a.ppsf ?? 1e9) - (b.ppsf ?? 1e9)],
  dist: ['Closest to downtown', (a, b) => (a.dist ?? 99) - (b.dist ?? 99)], transp: ['Most detailed ad', (a, b) => b.transparency - a.transparency],
  listed: ['Newest first', (a, b) => (a.listedDays ?? 99) - (b.listedDays ?? 99)],
  seen: ['Recently found', (a, b) => String(b.firstSeen || '').localeCompare(String(a.firstSeen || '')) || b.dealPct - a.dealPct],
};
const VIEWS = [['browse', 'Browse'], ['compare', 'Compare'], ['market', 'Market'], ['insights', 'Insights'], ['shortlist', 'Shortlist']];

// ------------------------------------------------------------------ state
const F = { q: '', min: '', max: '', beds: '', baths: '', area: '', must: {}, hideFlagged: false, hideTransfer: false, showHidden: false, showGone: false, type: '', avail: '' };
const S = { view: (location.hash.slice(1) || 'browse'), layout: store.get('layout', 'cards'), sort: store.get('sort', 'deal'), sel: null, photo: 0, showFull: false };
if (!VIEWS.some((v) => v[0] === S.view)) S.view = 'browse';

function passes(r, keepGone) {
  if (!F.showHidden && user.hidden[r.id]) return false;
  if (!keepGone && !F.showGone && r.status === 'GONE') return false;
  if (F.type && r.kind !== F.type) return false;
  if (F.min !== '' && r.price < +F.min) return false;
  if (F.max !== '' && r.price > +F.max) return false;
  if (F.beds !== '' && (F.beds === '3' ? (r.beds || 0) < 3 : r.beds !== +F.beds)) return false;
  if (F.baths !== '' && (F.baths === '2' ? (r.baths || 0) < 2 : r.baths !== +F.baths)) return false;
  if (F.area && r.area !== F.area) return false;
  for (const k in F.must) if (F.must[k] && !r.has[k]) return false;
  if (F.hideFlagged && r.redFlags.some((f) => f.sev !== 'info')) return false;
  if (F.hideTransfer && r.has.leaseTransfer) return false;
  if (F.avail === 'now' && !r.availNow) return false;
  if (F.avail === 'dated' && !r.availFrom) return false;
  if (F.q) for (const t of fold(F.q).split(/\s+/).filter(Boolean)) if (!r._hay.includes(t)) return false;
  return true;
}
const filtered = () => L.filter((r) => passes(r)).sort(SORTS[S.sort][1]);

// ------------------------------------------------------------------ tooltip + chart primitives
const tip = $('#tip');
function tipShow(ev, rows) {
  tip.replaceChildren(...rows.map((r, i) => (i === 0 && typeof r === 'string' ? h('b', { text: r }) : Array.isArray(r) ? h('div', { class: 'r' }, h('span', { text: r[0] }), h('span', { text: r[1] })) : h('div', { text: r }))));
  tip.hidden = false;
  const w = tip.offsetWidth, hh = tip.offsetHeight;
  tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, ev.clientX + 14)) + 'px';
  tip.style.top = Math.min(window.innerHeight - hh - 8, Math.max(8, ev.clientY + 14)) + 'px';
}
const tipHide = () => { tip.hidden = true; };
function hoverable(el, rows, onClick) {
  el.addEventListener('pointermove', (ev) => tipShow(ev, rows));
  el.addEventListener('pointerleave', tipHide);
  el.addEventListener('focus', () => { const b = el.getBoundingClientRect(); tipShow({ clientX: b.left + b.width / 2, clientY: b.top }, rows); });
  el.addEventListener('blur', tipHide);
  if (onClick) { el.addEventListener('click', onClick); el.addEventListener('keydown', (e) => { if (e.key === 'Enter') onClick(); }); }
}
function attachNearest(svg, pts, onPick) {
  const ring = s('circle', { r: 9, class: 'hover-ring', style: 'display:none' });
  svg.append(ring);
  let cur = null;
  const local = (ev) => { const b = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal; return [(ev.clientX - b.left) * vb.width / b.width, (ev.clientY - b.top) * vb.height / b.height, vb.width / b.width]; };
  svg.addEventListener('pointermove', (ev) => {
    const [px, py, k] = local(ev); let best = null, bd = 1e12;
    for (const p of pts) { const d = (p.x - px) ** 2 + (p.y - py) ** 2; if (d < bd) { bd = d; best = p; } }
    if (best && Math.sqrt(bd) <= 28 * k) { cur = best; ring.setAttribute('cx', best.x); ring.setAttribute('cy', best.y); ring.style.display = ''; tipShow(ev, best.tip); svg.style.cursor = 'pointer'; }
    else { cur = null; ring.style.display = 'none'; tipHide(); svg.style.cursor = ''; }
  });
  svg.addEventListener('pointerleave', () => { ring.style.display = 'none'; tipHide(); });
  svg.addEventListener('click', () => { if (cur && onPick) onPick(cur.id); });
}
const colPath = (x, y, w, hg, r = 4) => { r = Math.min(r, w / 2, hg); return `M${x},${y + hg}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hg}Z`; };
const rowPath = (x, y, w, hg, r = 4) => { r = Math.min(r, hg / 2, w); return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hg - r}Q${x + w},${y + hg} ${x + w - r},${y + hg}H${x}Z`; };
const rowPathL = (x, y, w, hg, r = 4) => { r = Math.min(r, hg / 2, w); return `M${x},${y}H${x - w + r}Q${x - w},${y} ${x - w},${y + r}V${y + hg - r}Q${x - w},${y + hg} ${x - w + r},${y + hg}H${x}Z`; };
const PL = { W: 560, H: 250, l: 50, r: 16, t: 14, b: 34 };
function newSvg(H = PL.H, label = '') { return s('svg', { viewBox: `0 0 ${PL.W} ${H}`, class: 'chart', role: 'img', 'aria-label': label }); }
function yAxis(svg, y, ticks, fmt, x0 = PL.l, x1 = PL.W - PL.r) {
  for (const t of ticks) { svg.append(s('line', { x1: x0, x2: x1, y1: y(t), y2: y(t), class: 'grid' }), s('text', { x: x0 - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick', text: fmt(t) })); }
}
function dataTable(cols, rows, caption) {
  return h('div', { class: 'tw' }, h('table', { class: 't' }, caption ? h('caption', { class: 'muted', text: caption, style: 'text-align:left;padding:4px 2px' }) : null,
    h('thead', null, h('tr', null, cols.map((c) => h('th', { class: c.num ? 'num' : '', text: c.label })))),
    h('tbody', null, rows.map((r) => h('tr', null, cols.map((c, i) => h('td', { class: c.num ? 'num' : '', text: r[i] == null ? '—' : String(r[i]) })))))));
}
const cardMode = {};
function chartCard(title, sub, draw, table, wide) {
  const body = h('div');
  const bC = h('button', { class: 'seg', 'aria-pressed': 'true', text: 'Chart' }), bT = h('button', { class: 'seg', 'aria-pressed': 'false', text: 'Table' });
  const paint = () => {
    const m = cardMode[title] || 'chart';
    bC.setAttribute('aria-pressed', m === 'chart'); bT.setAttribute('aria-pressed', m === 'table');
    body.replaceChildren(m === 'chart' ? draw() : table());
  };
  bC.onclick = () => { cardMode[title] = 'chart'; paint(); }; bT.onclick = () => { cardMode[title] = 'table'; paint(); };
  paint();
  return h('section', { class: 'cc' + (wide ? ' wide' : '') }, h('header', null, h('div', null, h('h2', { text: title }), h('p', { class: 'sub', text: sub })), h('div', { class: 'vt' }, bC, bT)), body);
}
const tile = (l, v, sub) => h('div', { class: 'tile' }, h('div', { class: 'l', text: l }), h('div', { class: 'v', text: v }), h('div', { class: 's', text: sub || '' }));
const legendItems = (items) => h('div', { class: 'legend' }, items.map(([cls, label, style]) => h('span', null, h('i', { class: cls, style }), label)));

// ------------------------------------------------------------------ small UI bits
function select(id, opts = {}) {
  S.sel = id; S.photo = 0; S.showFull = false;
  if (S.view === 'browse') { markSelected(opts.scroll !== false); renderDetail(); const d = $('#detail'); if (d && window.innerWidth <= 1000) d.classList.add('open'); }
  else { go('browse'); }
}
function toggle(map, id) { if (map[id]) delete map[id]; else map[id] = true; saveUser(); }
function toggleCompare(id) { const i = compare.indexOf(id); if (i >= 0) compare.splice(i, 1); else { if (compare.length >= 4) compare.shift(); compare.push(id); } saveUser(); renderTabs(); if (S.view === 'compare') render(); else renderDetail(); }
function dealBadge(r, cls = 'badge') {
  return h('span', { class: cls, title: `Fair price estimate ${money(r.predicted)}` }, h('i', { class: 'dot ' + dealBin(r.dealPct) + (dealBin(r.dealPct) === 'n' ? ' ring' : '') }), dealText(r.dealPct));
}
function starBtn(r, extra = '') {
  const b = h('button', { class: 'star ' + extra, 'aria-pressed': !!user.starred[r.id], 'aria-label': 'Shortlist', title: 'Shortlist (s)', text: user.starred[r.id] ? '★' : '☆' });
  b.addEventListener('click', (e) => { e.stopPropagation(); toggle(user.starred, r.id); b.textContent = user.starred[r.id] ? '★' : '☆'; b.setAttribute('aria-pressed', !!user.starred[r.id]); renderTabs(); if (S.sel === r.id) renderDetail(); });
  return b;
}
const chipsFor = (r) => CHIP_ORDER.filter((k) => r.has[k]).slice(0, 5).map((k) => h('span', { class: 'chip', text: FLAG_LABEL[k] }));
const statusText = (r) => ({ NEW: 'New', PRICE_DOWN: `Price cut (was ${money(r.prevPrice)})`, PRICE_UP: `Price up (was ${money(r.prevPrice)})`, GONE: 'Gone' + (r.goneAt ? ' ' + r.goneAt : ''), BACK: 'Back on the market' })[r.status];
const statusChip = (r) => (statusText(r) ? h('span', { class: 'chip', style: 'font-weight:600', text: statusText(r) }) : null);
const kindChip = (r) => (r.kind === 'text-only' ? h('span', { class: 'chip', title: 'Posted outside the Rentals category: details come from the text', text: 'text-only ad' }) : null);
const warnCount = (r) => r.redFlags.filter((f) => f.sev !== 'info').length;
const layoutText = (r) => [r.beds === 0 ? 'Studio' + (r.bedsInferred ? '*' : '') : r.beds != null ? r.beds + ' bd' + (r.bedsInferred ? '*' : '') : null, r.baths != null ? r.baths + ' ba' : null, r.sqft ? r.sqft + ' sq ft' : null].filter(Boolean).join(' · ');
const whereText = (r) => [r.named[0] || r.area, r.dist != null ? r.dist.toFixed(1) + ' km to downtown' : null].filter(Boolean).join(' · ');

// ------------------------------------------------------------------ BROWSE
function card(r) {
  const img = r.photos[0] ? h('img', { src: r.photos[0], loading: 'lazy', alt: '' }) : h('div', { class: 'noimg', text: 'No photo' });
  const wc = warnCount(r);
  return h('article', { class: 'card' + (user.hidden[r.id] ? ' dim' : ''), tabindex: '0', 'data-id': r.id, onclick: () => select(r.id, { scroll: false }), onkeydown: (e) => { if (e.key === 'Enter') select(r.id, { scroll: false }); } },
    HAS_PHOTOS ? h('div', { class: 'thumb' }, img, dealBadge(r), starBtn(r)) : h('div', { class: 'toprow' }, dealBadge(r, 'badge static'), starBtn(r, 'static')),
    h('div', { class: 'cbody' },
      h('div', { class: 'price' }, money(r.price), h('span', { class: 'per', text: '/mo' })),
      h('div', { class: 'facts', text: layoutText(r) }),
      h('div', { class: 'where', text: whereText(r) }),
      h('div', { class: 'chips', style: 'margin-top:4px' }, statusChip(r), kindChip(r), chipsFor(r)),
      wc ? h('div', { class: 'warnrow' }, h('b', { text: '⚠' }), `${wc} warning${wc > 1 ? 's' : ''}`) : null));
}
function listTable(list) {
  const cols = [['', null], ...(HAS_PHOTOS ? [['', null]] : []), ['Price', 'price', 1], ['Layout', null], ['Sq ft', 'sqft', 1], ['$/sq ft', 'ppsf', 1], ['To downtown', 'dist', 1], ['Area', null], ['Value', 'deal', 1], ['Listed', 'listed'], ['Listing', null]];
  return h('div', { class: 'tw' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, cols.map(([label, key, num]) => h('th', { class: (key ? 'sortable ' : '') + (num ? 'num' : ''), text: label + (key && S.sort === key ? ' ▾' : ''), onclick: key ? () => { S.sort = key === 'price' && S.sort === 'price' ? 'priceDesc' : key; store.set('sort', S.sort); render(); } : null })))),
    h('tbody', null, list.map((r) => h('tr', { 'data-id': r.id, onclick: () => select(r.id, { scroll: false }) },
      h('td', null, h('span', { text: user.starred[r.id] ? '★' : '' })),
      HAS_PHOTOS ? h('td', null, r.photos[0] ? h('img', { src: r.photos[0], loading: 'lazy', alt: '' }) : null) : null,
      h('td', { class: 'num', text: money(r.price) }), h('td', { text: [r.beds, r.baths].map((x) => (x == null ? '?' : x)).join(' / ') }),
      h('td', { class: 'num', text: r.sqft || '—' }), h('td', { class: 'num', text: r.ppsf ? '$' + r.ppsf.toFixed(2) : '—' }), h('td', { class: 'num', text: r.dist != null ? r.dist.toFixed(1) + ' km' : '—' }),
      h('td', { text: r.named[0] || r.area || '—' }), h('td', { class: 'num' }, dealBadge(r, 'chip')), h('td', { text: r.listedText.replace('Listed ', '') || '—' }),
      h('td', { text: r.title, style: 'max-width:240px;overflow:hidden;text-overflow:ellipsis' }))))));
}
function renderBrowse(list) {
  const main = $('#main');
  if (!list.length) { main.replaceChildren(h('div', { class: 'empty' }, h('p', { text: 'No listings match these filters.' }), h('button', { class: 'btn', text: 'Reset filters', onclick: resetFilters }))); return; }
  if (!S.sel || !list.some((r) => r.id === S.sel)) S.sel = list[0].id;
  const head = h('div', { class: 'listhead' },
    h('span', { class: 'seg-group' }, h('button', { class: 'seg', 'aria-pressed': S.layout === 'cards', text: 'Cards', onclick: () => { S.layout = 'cards'; store.set('layout', S.layout); render(); } }), h('button', { class: 'seg', 'aria-pressed': S.layout === 'table', text: 'Table', onclick: () => { S.layout = 'table'; store.set('layout', S.layout); render(); } })),
    h('label', { class: 'muted' }, 'Sort ', h('select', { onchange: (e) => { S.sort = e.target.value; store.set('sort', S.sort); render(); } }, Object.entries(SORTS).map(([k, v]) => h('option', { value: k, selected: k === S.sort, text: v[0] })))),
    h('span', { class: 'muted', text: 'Tip: j / k to move, s to shortlist, x to hide, c to compare, ? for all shortcuts' }));
  const listEl = S.layout === 'cards' ? h('div', { class: 'grid' }, list.map(card)) : listTable(list);
  main.replaceChildren(h('div', { class: 'split' }, h('div', null, head, listEl), h('aside', { class: 'detail', id: 'detail', 'aria-label': 'Listing details' })));
  markSelected(false); renderDetail();
}
function markSelected(scroll) {
  document.querySelectorAll('[data-id]').forEach((el) => { const on = el.dataset.id === S.sel; el.classList.toggle('sel', on); if (on && scroll) el.scrollIntoView({ block: 'nearest' }); });
}
function highlighted(r, full) {
  const text = r.desc || '', low = text.toLowerCase(), ranges = [];
  for (const [flag, ev] of Object.entries(r.evidence)) { const i = low.indexOf(String(ev).toLowerCase()); if (i >= 0 && ev.length > 2) ranges.push([i, i + ev.length, flag]); }
  ranges.sort((a, b) => a[0] - b[0]);
  const out = []; let pos = 0;
  for (const [a, b, flag] of ranges) { if (a < pos) continue; out.push(text.slice(pos, a), h('mark', { title: flag.replace(/^util_/, '').replace(/([A-Z])/g, ' $1').toLowerCase(), text: text.slice(a, b) })); pos = b; }
  out.push(text.slice(pos));
  return h('div', { class: 'desc' + (full ? ' full' : '') }, out);
}
function priceStrip(r, list) {
  const W = 400, H = 58, x = lin(Math.min(...list.map((o) => o.price)) - 50, Math.max(...list.map((o) => o.price)) + 50, 14, W - 14);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `This listing ${money(r.price)} versus fair estimate ${money(r.predicted)}` });
  svg.append(s('line', { x1: 14, x2: W - 14, y1: 26, y2: 26, class: 'axis' }));
  for (const o of list) if (o.id !== r.id) { const c = s('circle', { cx: x(o.price), cy: 26, r: 3.5, fill: 'var(--axis)' }); svg.append(c); }
  svg.append(s('line', { x1: x(r.predicted), x2: x(r.predicted), y1: 12, y2: 40, class: 'ref' }), s('text', { x: x(r.predicted), y: 9, 'text-anchor': 'middle', text: 'fair ' + money(r.predicted) }));
  svg.append(s('circle', { cx: x(r.price), cy: 26, r: 6, class: 'pt', fill: 'var(--series-1)' }), s('text', { x: x(r.price), y: 54, 'text-anchor': 'middle', class: 'lab', text: money(r.price) }));
  return svg;
}
function renderDetail() {
  const box = $('#detail'); if (!box) return;
  const r = byId.get(S.sel); if (!r) { box.replaceChildren(); return; }
  const list = filtered();
  const ph = r.photos, pi = Math.min(S.photo, Math.max(0, ph.length - 1));
  const gallery = !HAS_PHOTOS ? null : ph.length ? h('div', { class: 'gallery' },
    h('img', { class: 'main', src: ph[pi], alt: 'Photo ' + (pi + 1), onclick: () => lightbox(r, pi) }),
    ph.length > 1 ? [h('button', { class: 'nav prev', 'aria-label': 'Previous photo', text: '‹', onclick: () => { S.photo = (pi - 1 + ph.length) % ph.length; renderDetail(); } }), h('button', { class: 'nav next', 'aria-label': 'Next photo', text: '›', onclick: () => { S.photo = (pi + 1) % ph.length; renderDetail(); } })] : null,
    h('p', { class: 'count', text: `${pi + 1} / ${ph.length}` }),
    ph.length > 1 ? h('div', { class: 'strip' }, ph.map((p, i) => h('img', { src: p, loading: 'lazy', alt: '', class: i === pi ? 'on' : '', onclick: () => { S.photo = i; renderDetail(); } }))) : null) : h('div', { class: 'noimg', style: 'height:160px', text: 'No photos saved for this listing' });
  const facts = [
    ['Layout', layoutText(r) + (r.qcSize ? ` (${r.qcSize})` : '') + (r.type ? ' · ' + r.type : '') + (r.bedsInferred ? '  (* bedrooms read from the ad text)' : '')],
    ['Ad type', r.kind === 'structured' ? 'Filed under Rentals' : 'Text-only: posted in another category'],
    ['Status', statusText(r) || 'Unchanged'], ['Found via', (r.via || []).join(', ') || '—'],
    ['Where', [r.address, r.named.join(', '), r.postal ? r.postal + ' (approx.)' : null].filter(Boolean).join(' · ') || '—'],
    ['Downtown', r.dist != null ? r.dist.toFixed(1) + ' km' : '—'],
    ['Available', r.availNow ? 'Now' : r.availFrom || r.availText || 'Not stated'],
    ['Listed', r.listedText.replace('Listed ', '') || '—'],
    ['Lease', r.leaseMonths ? r.leaseMonths + ' months' : r.has.leaseTransfer ? 'Lease transfer' : 'Not stated'],
    ['Pets', r.pets === 'ok' ? ['Allowed', r.has.dogs ? '(dogs ok)' : '', r.has.cats ? '(cats ok)' : ''].filter(Boolean).join(' ') : r.pets === 'no' ? 'Not allowed' : 'Not stated'],
    ['Heat', r.utils.heat || 'Not stated'], ['Hot water', r.utils.hotWater || 'Not stated'], ['Electricity', r.utils.electricity || 'Not stated'], ['Internet', r.utils.internet || 'Not stated'],
    ['Ad quality', `${r.transparency}/100 complete · ${r.hype}/100 salesy · ${r.lang === 'unknown' ? 'language n/a' : r.lang.toUpperCase()}`],
  ];
  const gaps = r.price - r.predicted;
  const sim = r.similar.map((x) => byId.get(x.id)).filter(Boolean);
  put(box,
    gallery,
    h('div', { class: 'pad' },
      h('div', { class: 'dhead' }, h('div', null, h('div', { class: 'dprice' }, money(r.price), h('span', { class: 'muted', style: 'font-size:13px;font-weight:400', text: ' /mo' })), h('h2', { text: r.title })), h('button', { class: 'iconbtn closebtn', text: '✕ Close', onclick: () => $('#detail').classList.remove('open') })),
      h('div', { class: 'btnrow', style: 'margin-top:10px' },
        h('button', { class: 'btn' + (user.starred[r.id] ? ' on' : ''), text: user.starred[r.id] ? '★ Shortlisted' : '☆ Shortlist', onclick: () => { toggle(user.starred, r.id); renderTabs(); render(); } }),
        h('button', { class: 'btn' + (compare.includes(r.id) ? ' on' : ''), text: compare.includes(r.id) ? '✓ Comparing' : 'Compare', onclick: () => toggleCompare(r.id) }),
        h('button', { class: 'btn', text: user.hidden[r.id] ? 'Unhide' : 'Hide', onclick: () => { toggle(user.hidden, r.id); render(); } }),
        h('a', { class: 'btn', href: r.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open on Facebook ↗' }),
        r.lat != null ? h('a', { class: 'btn', href: `https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lon}#map=16/${r.lat}/${r.lon}`, target: '_blank', rel: 'noopener noreferrer', text: 'Map (approx.) ↗' }) : null)),
    h('div', { class: 'sec' }, h('h3', { text: 'Price check' }),
      h('p', { style: 'margin:0 0 4px' }, dealBadge(r, 'chip'), ` Asking ${money(Math.abs(gaps))} ${gaps <= 0 ? 'below' : 'above'} the fair estimate of ${money(r.predicted)}. `, h('span', { class: 'muted', text: (MODEL.useful ? 'Estimate from the price model. ' : `Estimate = median of the other ${r.beds ?? '?'}-bed listings. `) + `This ad is ${Math.abs(r.vsMedian)}% ${r.vsMedian <= 0 ? 'below' : 'above'} their median.` })),
      list.length > 1 ? priceStrip(r, list) : null,
      r.drivers.length ? h('p', { class: 'muted', style: 'margin:4px 0 0', text: 'Main drivers: ' + r.drivers.map((d) => `${d.label} ${signed(d.delta, '$')}`).join(', ') }) : null,
      r.ppsf ? h('p', { class: 'muted', style: 'margin:4px 0 0', text: `$${r.ppsf.toFixed(2)} per sq ft · ${money(r.pbed)} per bedroom` }) : h('p', { class: 'muted', style: 'margin:4px 0 0', text: `${money(r.pbed)} per bedroom` })),
    r.redFlags.length ? h('div', { class: 'sec' }, h('h3', { text: 'Checks' }), r.redFlags.map((f) => h('div', { class: 'flag ' + f.sev }, h('span', { class: 'ic', 'aria-hidden': 'true', text: f.sev === 'serious' ? '⚠' : f.sev === 'warn' ? '▲' : 'ℹ' }), h('div', null, h('b', { text: f.label }), h('span', { class: 'muted', text: f.sev === 'info' ? ' (info)' : f.sev === 'warn' ? ' (check)' : ' (serious)' }), h('p', { text: f.why }))))) : null,
    h('div', { class: 'sec' }, h('h3', { text: 'Details' }), h('dl', { class: 'facts2' }, facts.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]))),
    h('div', { class: 'sec' }, h('h3', { text: 'Amenities found' }), h('div', { class: 'chips' }, [...FLAGS.filter(([k]) => r.has[k]).map(([, l]) => h('span', { class: 'chip', text: l })), ...r.amenities.filter((a) => !/laundry|friendly|parking|ac|heating|lease/i.test(a)).map((a) => h('span', { class: 'chip kw', text: a }))].filter(Boolean)),
      r.keywords.length ? [h('h3', { text: 'Distinctive words in this ad', style: 'margin-top:12px' }), h('div', { class: 'chips' }, r.keywords.map((k) => h('span', { class: 'chip kw', text: k })))] : null,
      DATA.clusters.length > 1 ? h('p', { class: 'muted', style: 'margin:10px 0 0', text: 'Theme: ' + (DATA.clusters[r.cluster].terms.slice(0, 3).join(' · ') || '—') }) : null),
    sim.length ? h('div', { class: 'sec' }, h('h3', { text: 'Similar ads' }), h('ul', { class: 'list' }, sim.map((o) => h('li', { onclick: () => select(o.id) }, h('span', { text: `${money(o.price)} · ${layoutText(o)} · ${o.named[0] || o.area || ''}` }), h('span', { class: 'muted', text: Math.round(r.similar.find((x) => x.id === o.id).sim * 100) + '% alike' }))))) : null,
    r.priceHistory.length > 1 ? h('div', { class: 'sec' }, h('h3', { text: 'Price history' }), h('p', { style: 'margin:0', text: r.priceHistory.map((p) => `${p.date}: ${money(p.amount)}`).join('  →  ') })) : null,
    h('div', { class: 'sec' }, h('h3', { text: 'Description' + (Object.keys(r.evidence).length ? ' (extracted facts highlighted)' : '') }), highlighted(r, S.showFull), r.descLen > 600 ? h('button', { class: 'btn', style: 'margin-top:6px', text: S.showFull ? 'Show less' : 'Show all', onclick: () => { S.showFull = !S.showFull; renderDetail(); } }) : null),
    h('div', { class: 'sec' }, h('h3', { text: 'My notes' }), h('textarea', { class: 'note', placeholder: 'Questions to ask, visit time, impressions…', 'aria-label': 'Notes', oninput: (e) => { if (e.target.value) user.notes[r.id] = e.target.value; else delete user.notes[r.id]; saveUser(); } }, user.notes[r.id] || '')),
    h('div', { class: 'sec muted', style: 'font-size:12px', text: `Saved ${r.firstSeen || '?'}${r.lastSeen && r.lastSeen !== r.firstSeen ? ' · last seen ' + r.lastSeen : ''} · listing ${r.id}` }));
  const ta = $('textarea.note', box); if (ta) ta.value = user.notes[r.id] || '';
}
function lightbox(r, i) {
  const box = $('#lightbox'); let k = i;
  const paint = () => box.replaceChildren(h('img', { src: r.photos[k], alt: 'Photo ' + (k + 1), onclick: (e) => e.stopPropagation() }));
  box.hidden = false; paint();
  box.onclick = () => { box.hidden = true; };
  box._step = (d) => { k = (k + d + r.photos.length) % r.photos.length; paint(); };
}

// ------------------------------------------------------------------ COMPARE
function renderCompare() {
  const main = $('#main');
  const items = compare.map((id) => byId.get(id)).filter(Boolean);
  if (items.length < 1) { main.replaceChildren(h('div', { class: 'empty' }, h('p', { text: 'Pick up to 4 listings to compare side by side.' }), h('p', { class: 'muted', text: 'Press c on a selected listing, or use the Compare button in its details.' }))); return; }
  const rows = [
    ['Price', (r) => r.price, money, 'min'], ['Fair-price gap', (r) => r.dealPct, (v) => dealText(v), 'max'], ['Bedrooms', (r) => r.beds, (v) => v, 'max'], ['Bathrooms', (r) => r.baths, (v) => v, 'max'],
    ['Sq ft', (r) => r.sqft, (v) => v, 'max'], ['$ / sq ft', (r) => r.ppsf, (v) => '$' + v.toFixed(2), 'min'], ['Km to downtown', (r) => r.dist, (v) => v.toFixed(1), 'min'],
    ['Area', (r) => r.named[0] || r.area, (v) => v], ['Available', (r) => (r.availNow ? 'Now' : r.availFrom || r.availText || null), (v) => v], ['Lease (months)', (r) => r.leaseMonths, (v) => v],
    ['Heat included', (r) => r.has.heatIncl ? 'Yes' : r.utils.heat === 'excluded' ? 'No' : null, (v) => v], ['Electricity', (r) => r.utils.electricity, (v) => v],
    ['In-unit laundry', (r) => (r.has.laundryUnit ? 'Yes' : r.has.laundryBuilding ? 'In building' : null), (v) => v], ['Parking', (r) => (r.has.parking ? 'Yes' : null), (v) => v], ['A/C', (r) => (r.has.ac ? 'Yes' : null), (v) => v],
    ['Pets', (r) => (r.pets === 'ok' ? 'Allowed' : r.pets === 'no' ? 'No' : null), (v) => v], ['Dishwasher', (r) => (r.has.dishwasher ? 'Yes' : null), (v) => v], ['Furnished', (r) => (r.has.furnished ? 'Yes' : null), (v) => v],
    ['Ad completeness', (r) => r.transparency, (v) => v + '/100', 'max'], ['Warnings', (r) => warnCount(r), (v) => v, 'min'],
  ];
  const best = (fn, dir) => { if (!dir) return null; const vals = items.map(fn).filter((v) => v != null); if (vals.length < 2) return null; const t = dir === 'min' ? Math.min(...vals) : Math.max(...vals); return vals.filter((v) => v === t).length === vals.length ? null : t; };
  main.replaceChildren(h('div', { class: 'tw' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, h('th'), items.map((r) => h('th', { style: 'vertical-align:top;min-width:170px' },
      r.photos[0] ? h('img', { src: r.photos[0], alt: '', style: 'width:100%;height:110px;margin-bottom:6px' }) : null,
      h('div', { text: r.title, style: 'white-space:normal' }), h('div', { class: 'btnrow', style: 'margin-top:6px' }, h('button', { class: 'btn', text: 'Open', onclick: () => select(r.id) }), h('button', { class: 'btn', text: 'Remove', onclick: () => toggleCompare(r.id) })))))),
    h('tbody', null, rows.map(([label, fn, fmt, dir]) => { const b = best(fn, dir); return h('tr', { style: 'cursor:default' }, h('td', { text: label, style: 'color:var(--muted)' }), items.map((r) => { const v = fn(r); const isBest = b != null && v === b; return h('td', { style: isBest ? 'font-weight:700' : '' }, v == null ? h('span', { class: 'muted', text: 'not stated' }) : fmt(v), isBest ? h('span', { class: 'muted', text: '  ✓ best', style: 'font-weight:400;font-size:11px' }) : null); })); })))));
}

// ------------------------------------------------------------------ MARKET
const quantile = (a, q) => { const b = clean(a).sort((x, y) => x - y); if (!b.length) return null; const i = (b.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return b[lo] + (b[hi] - b[lo]) * (i - lo); };
function evolutionRows(list) { // one row per run of the script, restricted to the listings in `list`
  const ids = new Set(list.map((r) => r.id));
  return (DATA.scans || []).map((sc) => {
    const prices = sc.prices || {};
    return { n: sc.n, date: sc.date, at: sc.at || null, complete: !!sc.complete, full: !!sc.full, seen: sc.seen,
      all: Object.entries(prices).filter(([id]) => ids.has(id)).map(([, p]) => p),
      fresh: (sc.newIds || []).filter((id) => ids.has(id) && prices[id] != null).map((id) => prices[id]) };
  }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.n - b.n));
}
function priceMoves(list) {
  let cuts = 0, ups = 0; const pct = [];
  list.forEach((r) => { for (let i = 1; i < r.priceHistory.length; i++) { const a = r.priceHistory[i - 1].amount, b = r.priceHistory[i].amount; if (b < a) { cuts++; pct.push((b - a) / a * 100); } else if (b > a) ups++; } });
  return { cuts, ups, med: pct.length ? median(pct) : null };
}
function evolutionChart(list) {
  const rows = evolutionRows(list);
  const mk = (r, vals) => ({ ...r, v: median(vals), lo: quantile(vals, 0.25), hi: quantile(vals, 0.75), cnt: vals.length });
  const A = rows.filter((r) => r.complete && r.all.length >= 3).map((r) => mk(r, r.all));      // whole market: only complete runs are comparable
  const B = rows.filter((r) => r.fresh.length >= 2).map((r) => mk(r, r.fresh));                 // asking rent of listings new in that run
  const pts = A.concat(B);
  if (!pts.length) return h('p', { class: 'muted', text: rows.length ? 'Not enough priced listings in this selection yet. Complete runs need 3+ listings and new-listing points need 2+.' : 'No price log in this data. Run the script (v4) and rebuild: every run adds a point here.' });
  const Q = { W: 1100, H: 280, l: 58, r: 24, t: 16, b: 40 };
  // x = real time of the run; older entries without a timestamp are spread across their day in run order
  const dayRank = {}; rows.forEach((r) => { dayRank[r.date] = (dayRank[r.date] || 0) + 1; r.rank = dayRank[r.date] - 1; });
  const tx = (r) => (r.at ? Date.parse(r.at) : new Date(r.date + 'T00:00:00').getTime() + r.rank * 3600e3);
  const xs = rows.map(tx), x0 = Math.min(...xs), x1 = Math.max(...xs), sameDay = x1 - x0 < 36 * 3600e3;
  const X = (r) => (x1 === x0 ? (Q.l + Q.W - Q.r) / 2 : Q.l + 20 + ((tx(r) - x0) / (x1 - x0)) * (Q.W - Q.l - Q.r - 40));
  const ys = pts.flatMap((p) => [p.lo, p.hi]), yt = niceTicks(Math.min(...ys) - 40, Math.max(...ys) + 40, 5);
  const Y = lin(yt[0], yt[yt.length - 1], Q.H - Q.b, Q.t);
  const svg = s('svg', { viewBox: `0 0 ${Q.W} ${Q.H}`, class: 'chart', role: 'img', 'aria-label': 'Median asking rent over time' });
  yAxis(svg, Y, yt, money, Q.l, Q.W - Q.r);
  svg.append(s('line', { x1: Q.l, x2: Q.W - Q.r, y1: Q.H - Q.b, y2: Q.H - Q.b, class: 'axis' }));
  const label = (r) => (sameDay && r.at ? new Date(r.at).toTimeString().slice(0, 5) : r.date.slice(5));
  rows.filter((r, i) => rows.length <= 8 || i % Math.ceil(rows.length / 8) === 0).forEach((r) => svg.append(s('text', { x: X(r), y: Q.H - Q.b + 18, 'text-anchor': 'middle', class: 'tick', text: label(r) })));
  [[A, '--series-1', 'All listings seen (complete runs)'], [B, '--series-2', 'New listings, asking rent']].forEach(([S_, v, name]) => {
    if (S_.length > 1) svg.append(s('path', { d: S_.map((p, i) => `${i ? 'L' : 'M'}${X(p)},${Y(p.v)}`).join(''), class: 'line', style: `stroke:var(${v})` }));
    S_.forEach((p) => {
      const cx = X(p), cy = Y(p.v), tipRows = [`${p.date}${p.at ? ' ' + new Date(p.at).toTimeString().slice(0, 5) : ''} · run #${p.n}`, ['Series', name], ['Median', money(p.v)], ['Middle half', `${money(p.lo)} – ${money(p.hi)}`], ['Listings', p.cnt]];
      svg.append(s('circle', { cx, cy, r: 5.5, class: 'pt', fill: `var(${v})` }));
      const hit = s('circle', { cx, cy, r: 14, class: 'hit', tabindex: '0', 'aria-label': `${name} ${p.date}: median ${money(p.v)}` });
      hoverable(hit, tipRows); svg.append(hit);
    });
  });
  const moves = priceMoves(list);
  return h('div', null, svg, legendItems([['sw', 'All listings seen (complete runs only)', 'background:var(--series-1)'], ['sw', 'New listings: asking rent when first seen', 'background:var(--series-2)']]),
    h('p', { class: 'muted', style: 'margin:4px 0 0;font-size:12px', text: `${rows.length} run${rows.length === 1 ? '' : 's'} logged${rows.length < 3 ? '. Trends need more runs: each scan adds a point.' : '.'} Quick runs only see the newest listings, so they feed the orange line only. Includes listings that have since disappeared. Price moves seen: ${moves.cuts} cuts, ${moves.ups} raises.` }));
}
function evolutionTable(list) {
  return dataTable([{ label: 'Date' }, { label: 'Run', num: 1 }, { label: 'Type' }, { label: 'Listings seen', num: 1 }, { label: 'Median rent', num: 1 }, { label: 'Middle half' }, { label: 'New listings', num: 1 }, { label: 'Median of new', num: 1 }],
    evolutionRows(list).map((r) => [r.date, r.n, r.complete ? 'full pass' : r.full ? 'full (cut short)' : 'quick', r.all.length, r.complete && r.all.length ? money(median(r.all)) : 'n/a (partial)', r.complete && r.all.length ? `${money(quantile(r.all, 0.25))} – ${money(quantile(r.all, 0.75))}` : '—', r.fresh.length, r.fresh.length ? money(median(r.fresh)) : '—']));
}
function monthLabel(iso) { const [y, m] = iso.split('-'); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1] + ' ' + y; }
function histChart(list) {
  const prices = list.map((r) => r.price), lo = Math.min(...prices), hi = Math.max(...prices);
  const width = [25, 50, 100, 200].find((w) => Math.ceil((hi + 1 - Math.floor(lo / w) * w) / w) <= 14) || 200;
  const start = Math.floor(lo / width) * width, nb = Math.max(1, Math.ceil((hi + 1 - start) / width));
  const bins = Array.from({ length: nb }, (_, i) => ({ a: start + i * width, b: start + (i + 1) * width, items: [] }));
  list.forEach((r) => bins[Math.min(nb - 1, Math.floor((r.price - start) / width))].items.push(r));
  const mx = Math.max(...bins.map((b) => b.items.length)), ticks = niceTicks(0, mx, Math.min(5, mx)).filter((t) => Number.isInteger(t));
  const y = lin(0, ticks[ticks.length - 1] || 1, PL.H - PL.b, PL.t), slot = (PL.W - PL.l - PL.r) / nb, bw = Math.min(24, slot - 4);
  const svg = newSvg(PL.H, `Histogram of monthly rent, ${list.length} listings`);
  yAxis(svg, y, ticks, (t) => t);
  svg.append(s('line', { x1: PL.l, x2: PL.W - PL.r, y1: PL.H - PL.b, y2: PL.H - PL.b, class: 'axis' }));
  const med = median(prices), xm = PL.l + ((med - start) / (nb * width)) * (PL.W - PL.l - PL.r);
  bins.forEach((b, i) => {
    const x = PL.l + i * slot + (slot - bw) / 2, n = b.items.length, top = y(n), isSel = b.items.some((r) => r.id === S.sel);
    if (n) svg.append(s('path', { d: colPath(x, top, bw, PL.H - PL.b - top), class: 'bar' + (isSel ? ' hi' : '') }));
    if (n) svg.append(s('text', { x: x + bw / 2, y: top - 5, 'text-anchor': 'middle', class: 'tick', text: n }));
    const hit = s('rect', { x: PL.l + i * slot, y: PL.t, width: slot, height: PL.H - PL.b - PL.t, class: 'hit', tabindex: '0', 'aria-label': `${money(b.a)} to ${money(b.b - 1)}: ${n} listings` });
    hoverable(hit, [`${money(b.a)} – ${money(b.b - 1)}`, ['Listings', n], ...(n ? [['Median', money(median(b.items.map((r) => r.price)))]] : [])], n ? () => select(b.items[0].id) : null);
    svg.append(hit);
    if (i % Math.ceil(nb / 7) === 0) svg.append(s('text', { x: PL.l + i * slot, y: PL.H - PL.b + 16, 'text-anchor': 'start', class: 'tick', text: money(b.a) }));
  });
  svg.append(s('line', { x1: xm, x2: xm, y1: PL.t, y2: PL.H - PL.b, class: 'ref' }), s('text', { x: xm + 4, y: PL.t + 8, class: 'lab', text: 'median ' + money(med) }));
  return h('div', null, svg, h('p', { class: 'muted', style: 'margin:2px 0 0;font-size:12px', text: `${width === 25 || width === 50 ? '$' + width : money(width)} bins. Highlighted bar = the selected listing.` }));
}
function histTable(list) {
  const p = list.map((r) => r.price).sort((a, b) => a - b), q = (f) => p[Math.min(p.length - 1, Math.floor(f * (p.length - 1) + 0.5))];
  return dataTable([{ label: 'Statistic' }, { label: 'Monthly rent', num: 1 }], [['Cheapest', money(p[0])], ['25th percentile', money(q(0.25))], ['Median', money(median(p))], ['75th percentile', money(q(0.75))], ['Most expensive', money(p[p.length - 1])], ['Listings', p.length]]);
}
function scatterChart(list, xKey, yKey, opts) {
  const pts = list.filter((r) => r[xKey] != null && r[yKey] != null);
  if (pts.length < 2) return h('p', { class: 'muted', text: 'Not enough listings with this data.' });
  const xs = pts.map((r) => r[xKey]), ys = pts.map((r) => r[yKey]);
  const xt = niceTicks(opts.x0 ?? Math.min(...xs), opts.x1 ?? Math.max(...xs), 5), yt = niceTicks(opts.y0 ?? Math.min(...ys), opts.y1 ?? Math.max(...ys), 5);
  const x = lin(xt[0], xt[xt.length - 1], PL.l, PL.W - PL.r), y = lin(yt[0], yt[yt.length - 1], PL.H - PL.b, PL.t);
  const svg = newSvg(PL.H, opts.label);
  yAxis(svg, y, yt, opts.yFmt);
  svg.append(s('line', { x1: PL.l, x2: PL.W - PL.r, y1: PL.H - PL.b, y2: PL.H - PL.b, class: 'axis' }));
  xt.forEach((t) => svg.append(s('text', { x: x(t), y: PL.H - PL.b + 16, 'text-anchor': 'middle', class: 'tick', text: opts.xFmt(t) })));
  svg.append(s('text', { x: (PL.l + PL.W - PL.r) / 2, y: PL.H - 2, 'text-anchor': 'middle', text: opts.xLabel }));
  if (opts.diag) svg.append(s('line', { x1: x(xt[0]), y1: y(xt[0]), x2: x(xt[xt.length - 1]), y2: y(xt[xt.length - 1]), class: 'ref', 'stroke-dasharray': '' }));
  let fit = null;
  if (opts.trend) { fit = ols(xs, ys); if (fit && pts.length >= 4) { const a = xt[0], b = xt[xt.length - 1]; svg.append(s('path', { d: `M${x(a)},${y(fit.intercept + fit.slope * a)}L${x(b)},${y(fit.intercept + fit.slope * b)}`, class: 'line' })); } }
  const nearest = [];
  pts.forEach((r) => {
    const cx = x(r[xKey]), cy = y(r[yKey]);
    const dot = s('circle', { cx, cy, r: 5.5, class: 'pt', fill: opts.color(r), tabindex: '0', 'aria-label': `${r.title}, ${money(r.price)}` });
    const tipRows = opts.tip(r);
    hoverable(dot, tipRows, () => select(r.id));
    svg.append(dot);
    nearest.push({ x: cx, y: cy, id: r.id, tip: tipRows });
    if (r.id === S.sel) svg.append(s('circle', { cx, cy, r: 9, class: 'ringsel' }));
  });
  attachNearest(svg, nearest, (id) => select(id));
  return h('div', null, svg, opts.legend || null, fit && pts.length >= 4 ? h('p', { class: 'muted', style: 'margin:4px 0 0;font-size:12px', text: opts.fitText(fit, pts.length) }) : null);
}
const dealLegend = () => legendItems(BINS.map(([k, , label]) => ['dot ' + k + (k === 'n' ? ' ring' : ''), label]));
function stripChart(list) {
  const groups = [...new Set(list.map((r) => r.beds))].filter((b) => b != null).sort((a, b) => a - b);
  if (!groups.length) return h('p', { class: 'muted', text: 'No bedroom data.' });
  const prices = list.map((r) => r.price), yt = niceTicks(Math.min(...prices) - 50, Math.max(...prices) + 50, 5), y = lin(yt[0], yt[yt.length - 1], PL.H - PL.b, PL.t), slot = (PL.W - PL.l - PL.r) / groups.length;
  const svg = newSvg(PL.H, 'Monthly rent by number of bedrooms'); yAxis(svg, y, yt, money);
  svg.append(s('line', { x1: PL.l, x2: PL.W - PL.r, y1: PL.H - PL.b, y2: PL.H - PL.b, class: 'axis' }));
  const nearest = [];
  groups.forEach((g, i) => {
    const items = list.filter((r) => r.beds === g), cx0 = PL.l + slot * (i + 0.5), med = median(items.map((r) => r.price));
    svg.append(s('text', { x: cx0, y: PL.H - PL.b + 16, 'text-anchor': 'middle', class: 'tick', text: g === 0 ? 'Studio' : g + (g === 1 ? ' bedroom' : ' bedrooms') + '  (n=' + items.length + ')' }));
    svg.append(s('line', { x1: cx0 - 40, x2: cx0 + 40, y1: y(med), y2: y(med), class: 'ref' }), s('text', { x: cx0 + 44, y: y(med) + 4, class: 'lab', text: 'median ' + money(med) }));
    items.forEach((r) => { const cx = cx0 + (((hash(r.id) % 100) / 100) - 0.5) * 60, cy = y(r.price); const t = [r.title, ['Rent', money(r.price)], ['Fair gap', dealText(r.dealPct)]]; svg.append(s('circle', { cx, cy, r: 5.5, class: 'pt', fill: 'var(--series-1)' })); if (r.id === S.sel) svg.append(s('circle', { cx, cy, r: 9, class: 'ringsel' })); nearest.push({ x: cx, y: cy, id: r.id, tip: t }); });
  });
  attachNearest(svg, nearest, (id) => select(id));
  return svg;
}
function premiumRows(list) {
  const rows = [];
  for (const [k, label] of FLAGS) {
    const w = list.filter((r) => r.has[k]), wo = list.filter((r) => !r.has[k]);
    if (w.length < 2 || wo.length < 2) continue;
    const mw = median(w.map((r) => r.price)), mo = median(wo.map((r) => r.price));
    rows.push({ k, label, nw: w.length, no: wo.length, mw, mo, diff: mw - mo, thin: Math.min(w.length, wo.length) < 4 });
  }
  return rows.sort((a, b) => b.diff - a.diff);
}
function premiumChart(list) {
  const rows = premiumRows(list);
  if (!rows.length) return h('p', { class: 'muted', text: 'Not enough listings with and without each amenity (need at least 2 of each).' });
  const rh = 30, H = rows.length * rh + 30, mx = Math.max(100, ...rows.map((r) => Math.abs(r.diff))), cx = PL.l + 110 + (PL.W - PL.l - PL.r - 110) / 2, scale = (PL.W - PL.l - PL.r - 110) / 2 - 56;
  const svg = s('svg', { viewBox: `0 0 ${PL.W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Median rent difference with versus without each amenity' });
  svg.append(s('line', { x1: cx, x2: cx, y1: 6, y2: H - 22, class: 'axis' }), s('text', { x: cx + 8, y: H - 6, class: 'tick', text: 'costs more →' }), s('text', { x: cx - 8, y: H - 6, 'text-anchor': 'end', class: 'tick', text: '← costs less' }));
  rows.forEach((r, i) => {
    const yy = 8 + i * rh, w = Math.max(2, Math.abs(r.diff) / mx * scale);
    svg.append(s('text', { x: PL.l + 104, y: yy + 14, 'text-anchor': 'end', class: 'lab', text: r.label }));
    svg.append(s('path', { d: r.diff >= 0 ? rowPath(cx, yy + 3, w, 18) : rowPathL(cx, yy + 3, w, 18), class: 'bar', style: r.thin ? 'opacity:.45' : '' }));
    svg.append(s('text', { x: r.diff >= 0 ? cx + w + 6 : cx - w - 6, 'text-anchor': r.diff >= 0 ? 'start' : 'end', y: yy + 16, class: 'lab', text: signed(r.diff, '$') + (r.thin ? ' (thin)' : '') }));
    const hit = s('rect', { x: PL.l, y: yy, width: PL.W - PL.l - PL.r, height: rh - 4, class: 'hit', tabindex: '0', 'aria-label': `${r.label}: ${signed(r.diff)} dollars` });
    hoverable(hit, [r.label, ['With', `${money(r.mw)} (n=${r.nw})`], ['Without', `${money(r.mo)} (n=${r.no})`], ['Difference', signed(r.diff, '$')]]);
    svg.append(hit);
  });
  return h('div', null, svg, h('p', { class: 'muted', style: 'margin:2px 0 0;font-size:12px', text: 'Raw medians, not adjusted for size or location. "Thin" = fewer than 4 listings on one side.' }));
}
function premiumTable(list) { return dataTable([{ label: 'Amenity' }, { label: 'With: median', num: 1 }, { label: 'n', num: 1 }, { label: 'Without: median', num: 1 }, { label: 'n', num: 1 }, { label: 'Difference', num: 1 }], premiumRows(list).map((r) => [r.label, money(r.mw), r.nw, money(r.mo), r.no, signed(r.diff, '$')])); }
function areaRows(list) {
  const m = new Map(); list.forEach((r) => { const k = r.area || 'unknown'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  return [...m].map(([k, a]) => ({ k, n: a.length, med: median(a.map((r) => r.price)), pbed: median(a.map((r) => r.pbed)), dist: median(a.map((r) => r.dist)), names: [...new Set(a.flatMap((r) => r.named))].slice(0, 2).join(', '), ids: a.map((r) => r.id) })).sort((a, b) => b.med - a.med);
}
function areaChart(list) {
  const rows = areaRows(list).slice(0, 14), rh = 26, H = rows.length * rh + 14, lab = 56, mx = Math.max(...rows.map((r) => r.med)), x0 = PL.l + lab - 30;
  const svg = s('svg', { viewBox: `0 0 ${PL.W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Median rent by postal area' });
  rows.forEach((r, i) => {
    const yy = 4 + i * rh, w = r.med / mx * (PL.W - x0 - 110);
    svg.append(s('text', { x: x0 - 8, y: yy + 14, 'text-anchor': 'end', class: 'lab', text: r.k }), s('path', { d: rowPath(x0, yy + 3, w, 16), class: 'bar' }), s('text', { x: x0 + w + 6, y: yy + 15, class: 'lab', text: money(r.med) + '  n=' + r.n }));
    const hit = s('rect', { x: 0, y: yy, width: PL.W, height: rh - 2, class: 'hit', tabindex: '0', 'aria-label': `${r.k}: median ${money(r.med)}, ${r.n} listings` });
    hoverable(hit, [r.k + (r.names ? ' · ' + r.names : ''), ['Listings', r.n], ['Median rent', money(r.med)], ['Median per bedroom', money(r.pbed)], ['Median km to downtown', r.dist != null ? r.dist.toFixed(1) : '—']], () => select(r.ids[0]));
    svg.append(hit);
  });
  return h('div', null, svg, h('p', { class: 'muted', style: 'margin:2px 0 0;font-size:12px', text: 'Postal-code prefix (first 3 characters); n = listings in that area.' }));
}
function areaTable(list) { return dataTable([{ label: 'Area' }, { label: 'Listings', num: 1 }, { label: 'Median rent', num: 1 }, { label: 'Median / bedroom', num: 1 }, { label: 'Median km to downtown', num: 1 }, { label: 'Named in ads' }], areaRows(list).map((r) => [r.k, r.n, money(r.med), money(r.pbed), r.dist != null ? r.dist.toFixed(1) : '—', r.names || '—'])); }
function availRows(list) {
  const m = new Map(); list.forEach((r) => { const k = r.availNow ? '0-now' : r.availFrom ? '1-' + r.availFrom.slice(0, 7) : '2-?'; m.set(k, (m.get(k) || 0) + 1); });
  return [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => ({ k, n, label: k === '0-now' ? 'Now' : k === '2-?' ? 'No date given' : monthLabel(k.slice(2)) }));
}
function availChart(list) {
  const rows = availRows(list), mx = Math.max(...rows.map((r) => r.n)), ticks = niceTicks(0, mx, Math.min(4, mx)).filter(Number.isInteger), y = lin(0, ticks[ticks.length - 1] || 1, PL.H - PL.b, PL.t), slot = (PL.W - PL.l - PL.r) / rows.length, bw = Math.min(24, slot - 6);
  const svg = newSvg(PL.H, 'Listings by availability'); yAxis(svg, y, ticks, (t) => t);
  svg.append(s('line', { x1: PL.l, x2: PL.W - PL.r, y1: PL.H - PL.b, y2: PL.H - PL.b, class: 'axis' }));
  rows.forEach((r, i) => {
    const x = PL.l + i * slot + (slot - bw) / 2, top = y(r.n);
    svg.append(s('path', { d: colPath(x, top, bw, PL.H - PL.b - top), class: 'bar' }), s('text', { x: x + bw / 2, y: top - 5, 'text-anchor': 'middle', class: 'tick', text: r.n }), s('text', { x: x + bw / 2, y: PL.H - PL.b + 16, 'text-anchor': 'middle', class: 'tick', text: r.label.replace(' given', '') }));
    const hit = s('rect', { x: PL.l + i * slot, y: PL.t, width: slot, height: PL.H - PL.b - PL.t, class: 'hit', tabindex: '0', 'aria-label': `${r.label}: ${r.n}` });
    hoverable(hit, [r.label, ['Listings', r.n]]); svg.append(hit);
  });
  return h('div', null, svg, h('p', { class: 'muted', style: 'margin:2px 0 0;font-size:12px', text: "Quebec's traditional moving day is July 1: many leases start then." }));
}
function mapChart(list) {
  const pts = list.filter((r) => r.lat != null);
  if (pts.length < 2) return h('p', { class: 'muted', text: 'Not enough listings with a location.' });
  const dt = META.downtown, k = Math.cos(dt[0] * Math.PI / 180), W = PL.W, H = 330, pad = 30;
  const X = (r) => (r.lon - dt[1]) * k * 111.32, Y = (r) => (r.lat - dt[0]) * 110.57;
  const xs = pts.map(X).concat(0), ys = pts.map(Y).concat(0), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sc = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1)), ox = (W - (x1 - x0) * sc) / 2 - x0 * sc, oy = (H + (y1 - y0) * sc) / 2 + y0 * sc;
  const px = (v) => ox + v * sc, py = (v) => oy - v * sc;
  const sorted = pts.map((r) => r.price).sort((a, b) => a - b), cut = [0.2, 0.4, 0.6, 0.8].map((f) => sorted[Math.floor(f * (sorted.length - 1))]);
  const bin = (p) => (p <= cut[0] ? 1 : p <= cut[1] ? 2 : p <= cut[2] ? 3 : p <= cut[3] ? 4 : 5);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Map of listings relative to downtown' });
  [2, 4, 6, 8].forEach((km) => { svg.append(s('circle', { cx: px(0), cy: py(0), r: km * sc, fill: 'none', class: 'grid' }), s('text', { x: px(0) + km * sc * 0.707 + 3, y: py(0) - km * sc * 0.707 - 3, class: 'tick', text: km + ' km' })); });
  svg.append(s('path', { d: `M${px(0)},${py(0) - 8}L${px(0) + 7},${py(0)}L${px(0)},${py(0) + 8}L${px(0) - 7},${py(0)}Z`, fill: 'var(--ink)' }), s('text', { x: px(0) + 11, y: py(0) + 4, class: 'lab', text: 'Downtown' }));
  const nearest = [];
  pts.forEach((r) => {
    const cx = px(X(r)), cy = py(Y(r)), t = [r.title, ['Rent', money(r.price)], ['Area', r.named[0] || r.area || '—'], ['To downtown', r.dist.toFixed(1) + ' km']];
    const dot = s('circle', { cx, cy, r: 6, class: 'pt', fill: `var(--seq-${bin(r.price)})`, tabindex: '0', 'aria-label': `${r.title} ${money(r.price)}` }); hoverable(dot, t, () => select(r.id)); svg.append(dot);
    nearest.push({ x: cx, y: cy, id: r.id, tip: t }); if (r.id === S.sel) svg.append(s('circle', { cx, cy, r: 10, class: 'ringsel' }));
  });
  attachNearest(svg, nearest, (id) => select(id));
  const lg = legendItems([1, 2, 3, 4, 5].map((i) => ['sw', i === 1 ? `up to ${money(cut[0])}` : i === 5 ? `over ${money(cut[3])}` : `${money(cut[i - 2])}–${money(cut[i - 1])}`, `background:var(--seq-${i})`]));
  return h('div', null, svg, lg, h('p', { class: 'muted', style: 'margin:4px 0 0;font-size:12px', text: 'Facebook shows approximate pins. No basemap is loaded (works offline); rings are distance from downtown.' }));
}
function renderMarket(list) {
  const main = $('#main');
  if (list.length < 2) { main.replaceChildren(h('div', { class: 'empty', text: 'Need at least 2 listings in the current filter to show market charts.' })); return; }
  const med = median(list.map((r) => r.price)), pct = (f) => Math.round(list.filter(f).length / list.length * 100) + '%';
  const sq = list.filter((r) => r.ppsf);
  const evoList = L.filter((r) => passes(r, true)), mv = priceMoves(evoList);
  const kpis = h('div', { class: 'kpis' }, tile('Listings', String(list.length), `of ${L.length} saved`), tile('Price moves seen', `${mv.cuts} ↓ · ${mv.ups} ↑`, mv.med != null ? `cuts and raises; typical cut ${Math.abs(mv.med).toFixed(1)}%` : 'cuts and raises: none yet'), tile('Median rent', money(med), `range ${money(Math.min(...list.map((r) => r.price)))}–${money(Math.max(...list.map((r) => r.price)))}`),
    tile('Median per bedroom', money(median(list.map((r) => r.pbed))), 'rent ÷ bedrooms'), tile('Median $/sq ft', sq.length ? '$' + median(sq.map((r) => r.ppsf)).toFixed(2) : '—', `${sq.length} listings state size`),
    tile('In-unit laundry', pct((r) => r.has.laundryUnit), 'of listings'), tile('Pets allowed', pct((r) => r.pets === 'ok'), `${pct((r) => r.pets == null)} don't say`), tile('Heating included', pct((r) => r.has.heatIncl), `${pct((r) => r.utils.heat == null)} don't say`));
  const thin = list.length < 20 ? h('div', { class: 'notice', text: `Small sample (${list.length} listings): treat medians and trends as indicative. Save more searches over time and rebuild this dashboard to firm them up.` }) : null;
  const scTip = (r) => [r.title, ['Rent', money(r.price)], ['To downtown', r.dist.toFixed(1) + ' km'], ['Fair gap', dealText(r.dealPct)]];
  put(main, kpis, thin, h('div', { class: 'cards' },
    chartCard('Price evolution', 'Median asking rent at each run of the script', () => evolutionChart(evoList), () => evolutionTable(evoList), true),
    chartCard('Rent distribution', 'How many listings at each price', () => histChart(list), () => histTable(list)),
    chartCard('Rent by bedrooms', 'Each dot is a listing; line = median', () => stripChart(list), () => dataTable([{ label: 'Bedrooms' }, { label: 'n', num: 1 }, { label: 'Median', num: 1 }, { label: 'Min', num: 1 }, { label: 'Max', num: 1 }], [...new Set(list.map((r) => r.beds))].filter((b) => b != null).sort((a, b) => a - b).map((b) => { const a = list.filter((r) => r.beds === b).map((r) => r.price); return [b, a.length, money(median(a)), money(Math.min(...a)), money(Math.max(...a))]; }))),
    chartCard('Rent vs distance to downtown', 'Colour = value vs fair price (blue cheaper, red pricier)', () => scatterChart(list, 'dist', 'price', { label: 'Rent against distance to downtown', xFmt: (t) => t + ' km', yFmt: money, xLabel: 'Kilometres from downtown', trend: true, color: (r) => `var(--div-${dealBin(r.dealPct)})`, tip: scTip, legend: dealLegend(), fitText: (f, n) => `Trend: ${signed(f.slope, '$')} per km (r = ${f.r.toFixed(2)}, n = ${n}${n < 10 ? ', very small sample' : ''}).` }),
      () => dataTable([{ label: 'Listing' }, { label: 'Km', num: 1 }, { label: 'Rent', num: 1 }, { label: 'Fair gap', num: 1 }], list.filter((r) => r.dist != null).sort((a, b) => a.dist - b.dist).map((r) => [r.title.slice(0, 40), r.dist.toFixed(1), money(r.price), dealText(r.dealPct)]))),
    chartCard('Map', 'Position relative to downtown, shaded by rent', () => mapChart(list), () => dataTable([{ label: 'Listing' }, { label: 'Area' }, { label: 'Rent', num: 1 }, { label: 'Km', num: 1 }], list.filter((r) => r.lat != null).map((r) => [r.title.slice(0, 40), r.named[0] || r.area || '—', money(r.price), r.dist.toFixed(1)]))),
    chartCard('Amenity premiums', 'Median rent with vs without (raw, not adjusted)', () => premiumChart(list), () => premiumTable(list)),
    chartCard('Rent by area', 'Median rent per postal-code prefix', () => areaChart(list), () => areaTable(list)),
    chartCard('Availability', 'When listings can be moved into', () => availChart(list), () => dataTable([{ label: 'Availability' }, { label: 'Listings', num: 1 }], availRows(list).map((r) => [r.label, r.n])))));
}

// ------------------------------------------------------------------ INSIGHTS
function segmentsCard(list) {
  const defs = [
    ['Filed under Rentals', (r) => r.kind === 'structured'], ['Text-only (filed in another category)', (r) => r.kind === 'text-only'],
    ['Lease transfers / sublets', (r) => r.has.leaseTransfer], ['Everything else', (r) => !r.has.leaseTransfer],
    ['Low-effort ads (completeness under 50)', (r) => r.transparency < 50], ['Detailed ads (50 or more)', (r) => r.transparency >= 50],
  ];
  const rows = defs.map(([label, f]) => { const g = list.filter(f), v = g.map((r) => r.vsMedian); return [label, g.length, g.length ? money(median(g.map((r) => r.price))) : '—', g.length ? signed(median(v), '%') : '—', g.length < 5 ? (g.length ? 'thin: under 5 listings' : '') : '']; });
  return h('section', { class: 'cc wide' }, h('header', null, h('div', null, h('h2', { text: 'Are lease transfers and badly-filed ads really cheaper?' }), h('p', { class: 'sub', text: 'Median rent versus comparable listings (same bedroom count). Negative = cheaper.' }))),
    dataTable([{ label: 'Segment' }, { label: 'Listings', num: 1 }, { label: 'Median rent', num: 1 }, { label: 'vs comparable', num: 1 }, { label: 'Reliability' }], rows),
    h('p', { class: 'muted', style: 'font-size:12px;margin:6px 0 0', text: 'Segments overlap. Treat anything under about 30 listings per row as a hint, not a finding, and remember very cheap, low-effort ads are also what scams look like.' }));
}
function valueRanking(list) {
  const rows = [...list].sort((a, b) => b.dealPct - a.dealPct), mx = Math.max(10, ...rows.map((r) => Math.abs(r.dealPct)));
  const rh = 24, H = rows.length * rh + 14, cx = 352, half = 148;
  const svg = s('svg', { viewBox: `0 0 ${PL.W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Listings ranked by value against fair price' });
  svg.append(s('line', { x1: cx, x2: cx, y1: 2, y2: H - 8, class: 'axis' }));
  rows.forEach((r, i) => {
    const yy = 4 + i * rh, w = Math.max(2, Math.abs(r.dealPct) / mx * half), left = r.dealPct < 0;
    svg.append(s('text', { x: 4, y: yy + 14, class: 'tick', text: money(r.price) }), s('text', { x: 56, y: yy + 14, class: 'lab', text: (r.named[0] || r.area || '').slice(0, 16) }));
    svg.append(s('path', { d: left ? rowPathL(cx, yy + 3, w, 16) : rowPath(cx, yy + 3, w, 16), style: `fill:var(--div-${dealBin(r.dealPct)})` }), s('text', { x: left ? cx - w - 6 : cx + w + 6, 'text-anchor': left ? 'end' : 'start', y: yy + 15, class: 'lab', text: signed(r.dealPct, '%') }));
    const hit = s('rect', { x: 0, y: yy, width: PL.W, height: rh - 2, class: 'hit', tabindex: '0', 'aria-label': `${r.title} ${dealText(r.dealPct)}` });
    hoverable(hit, [r.title, ['Rent', money(r.price)], ['Fair estimate', money(r.predicted)], ['Gap', dealText(r.dealPct)]], () => select(r.id)); svg.append(hit);
  });
  return h('div', null, svg, dealLegend());
}
function qualityChart(list) {
  return scatterChart(list, 'transparency', 'hype', { label: 'Ad completeness against salesy tone', x0: 0, x1: 100, y0: 0, y1: 100, xFmt: (t) => t, yFmt: (t) => t, xLabel: 'Ad completeness (higher = more facts stated)', color: () => 'var(--series-1)', tip: (r) => [r.title, ['Completeness', r.transparency + '/100'], ['Salesy tone', r.hype + '/100'], ['Rent', money(r.price)]], fitText: () => '' });
}
function languageBar(list) {
  const c = {}; list.forEach((r) => { c[r.lang] = (c[r.lang] || 0) + 1; });
  const order = [['en', 'English', 'var(--series-1)'], ['fr', 'French', 'var(--series-2)'], ['bilingual', 'Bilingual', 'var(--series-3)'], ['unknown', 'Too short to tell', 'var(--axis)']].filter(([k]) => c[k]);
  return h('div', null, h('div', { class: 'segbar', role: 'img', 'aria-label': order.map(([k, l]) => `${l} ${c[k]}`).join(', ') }, order.map(([k, l, col]) => h('div', { style: `flex:${c[k]};background:${col};${k === 'unknown' ? 'color:var(--ink)' : ''}`, title: `${l}: ${c[k]}`, text: c[k] / list.length >= 0.12 ? `${Math.round(c[k] / list.length * 100)}%` : '' }))),
    h('div', { class: 'legend' }, order.map(([k, l, col]) => h('span', null, h('i', { class: 'sw', style: `background:${col}` }), `${l} (${c[k]})`))));
}
function phraseChart() {
  const rows = DATA.phrases.slice(0, 14), mx = rows[0] ? rows[0][1] : 1, rh = 24, H = rows.length * rh + 8, x0 = PL.l + 100;
  if (!rows.length) return h('p', { class: 'muted', text: 'No repeated terms yet.' });
  const svg = s('svg', { viewBox: `0 0 ${PL.W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Most repeated words and phrases' });
  rows.forEach(([t, n], i) => { const yy = 4 + i * rh, w = n / mx * (PL.W - x0 - 60); svg.append(s('text', { x: x0 - 8, y: yy + 14, 'text-anchor': 'end', class: 'lab', text: t }), s('path', { d: rowPath(x0, yy + 3, w, 16), class: 'bar' }), s('text', { x: x0 + w + 6, y: yy + 15, class: 'lab', text: n + ' ads' })); const hit = s('rect', { x: 0, y: yy, width: PL.W, height: rh - 2, class: 'hit', tabindex: '0', 'aria-label': `${t}: ${n} ads` }); hoverable(hit, [t, ['Ads using it', n]]); svg.append(hit); });
  return svg;
}
function modelCard(list) {
  const body = h('div');
  body.append(h('div', { class: 'notice', text: MODEL.note }));
  if (MODEL.enabled) body.append(h('p', { class: 'muted', style: 'margin:4px 0', text: `Out-of-sample error (leave-one-out): model $${MODEL.looMAE} vs simple benchmark $${MODEL.baselineMAE}; R² ${MODEL.looR2}. n = ${MODEL.n}.` }));
  if (MODEL.useful && MODEL.features.length) {
    const rows = [...MODEL.features].sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef)), mx = Math.max(...rows.map((r) => Math.max(Math.abs(r.lo), Math.abs(r.hi)))) || 1, rh = 28, H = rows.length * rh + 26, cx = 360, half = 150;
    const svg = s('svg', { viewBox: `0 0 ${PL.W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Estimated effect of each factor on monthly rent with 90% intervals' });
    svg.append(s('line', { x1: cx, x2: cx, y1: 2, y2: H - 20, class: 'axis' }), s('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'tick', text: 'no effect' }));
    rows.forEach((r, i) => { const yy = 6 + i * rh, sx = (v) => cx + v / mx * half; svg.append(s('text', { x: 200, y: yy + 14, 'text-anchor': 'end', class: 'lab', text: r.label }), s('line', { x1: sx(r.lo), x2: sx(r.hi), y1: yy + 10, y2: yy + 10, class: 'ref' }), s('circle', { cx: sx(r.coef), cy: yy + 10, r: 5, class: 'pt', fill: 'var(--series-1)' })); const hit = s('rect', { x: 0, y: yy, width: PL.W, height: rh - 2, class: 'hit', tabindex: '0', 'aria-label': r.label }); hoverable(hit, [r.label, ['Effect', signed(r.coef, '$') + (r.kind === 'bin' ? ' if present' : ' per unit')], ['90% range', `${signed(r.lo, '$')} to ${signed(r.hi, '$')}`]]); svg.append(hit); });
    body.append(svg, h('p', { class: 'muted', style: 'margin:2px 0 0;font-size:12px', text: 'Dot = estimated effect on monthly rent, line = 90% bootstrap range. Ranges that cross zero are not distinguishable from no effect.' }));
  } else {
    const vars = [['Km to downtown', 'dist'], ['Square feet', 'sqft'], ['Bedrooms', 'beds'], ['Bathrooms', 'baths'], ['Ad completeness', 'transparency'], ['Salesy tone', 'hype'], ['Description length', 'descLen']];
    const rows = vars.map(([label, k]) => { const p = list.filter((r) => r[k] != null); const rho = spearman(p.map((r) => r[k]), p.map((r) => r.price)); return rho == null ? null : [label, p.length, rho.toFixed(2), Math.abs(rho) < 0.2 ? 'negligible' : Math.abs(rho) < 0.4 ? 'weak' : Math.abs(rho) < 0.6 ? 'moderate' : 'strong']; }).filter(Boolean);
    body.append(h('h3', { class: 'muted', style: 'margin:10px 0 4px;font-size:12px', text: 'WHAT CAN BE SAID INSTEAD: RANK CORRELATION WITH RENT (current filter)' }), dataTable([{ label: 'Factor' }, { label: 'n', num: 1 }, { label: 'Spearman ρ', num: 1 }, { label: 'Strength' }], rows));
  }
  return body;
}
function renderInsights(list) {
  const main = $('#main');
  if (!list.length) { main.replaceChildren(h('div', { class: 'empty', text: 'No listings in the current filter.' })); return; }
  const flagged = list.filter((r) => r.redFlags.length).sort((a, b) => b.redFlags.filter((f) => f.sev !== 'info').length - a.redFlags.filter((f) => f.sev !== 'info').length);
  const ic = (sev) => (sev === 'serious' ? '⚠' : sev === 'warn' ? '▲' : 'ℹ');
  const dups = DATA.dupGroups.map((g) => g.map((id) => byId.get(id)).filter((r) => r && list.includes(r))).filter((g) => g.length > 1);
  main.replaceChildren(h('div', { class: 'cards' },
    chartCard('Best value ranking', 'Asking rent vs the fair-price estimate for each listing', () => valueRanking(list), () => dataTable([{ label: 'Listing' }, { label: 'Rent', num: 1 }, { label: 'Fair estimate', num: 1 }, { label: 'Gap', num: 1 }], [...list].sort((a, b) => b.dealPct - a.dealPct).map((r) => [r.title.slice(0, 36), money(r.price), money(r.predicted), signed(r.dealPct, '%')]))),
    h('section', { class: 'cc' }, h('header', null, h('div', null, h('h2', { text: 'What the ads are about' }), h('p', { class: 'sub', text: 'Listings grouped by the words in their text (TF-IDF + k-means)' }))),
      DATA.clusters.length > 1 ? h('div', { class: 'themes' }, DATA.clusters.map((c) => { const mem = c.members.map((id) => byId.get(id)).filter((r) => r && list.includes(r)); return h('div', { class: 'theme' }, h('div', { style: 'display:flex;justify-content:space-between;gap:8px' }, h('b', { text: c.terms.slice(0, 3).join(' · ') || 'Theme ' + (c.id + 1) }), h('span', { class: 'muted', text: `${mem.length} ads · median ${money(median(mem.map((r) => r.price)))}` })), h('div', { class: 'chips', style: 'margin:6px 0' }, c.terms.map((t) => h('span', { class: 'chip kw', text: t }))), h('div', { class: 'chips' }, mem.map((r) => h('button', { class: 'chip', text: `${money(r.price)} · ${r.named[0] || r.area || ''}`, onclick: () => select(r.id) })))); })) : h('p', { class: 'muted', text: 'Too few listings to find themes.' }),
      h('p', { class: 'muted', style: 'font-size:12px', text: 'Themes are descriptive, not categories to trust: with few ads they mostly reflect which landlord wrote them.' })),
    chartCard('Ad completeness vs salesy tone', 'Dots high and to the right are detailed ads; high on the left are vague and salesy', () => qualityChart(list), () => dataTable([{ label: 'Listing' }, { label: 'Completeness', num: 1 }, { label: 'Salesy', num: 1 }], list.map((r) => [r.title.slice(0, 36) + ' ' + money(r.price), r.transparency, r.hype]))),
    chartCard('Language of the ads', 'Detected from stop words', () => languageBar(list), () => dataTable([{ label: 'Language' }, { label: 'Ads', num: 1 }], Object.entries(list.reduce((a, r) => ((a[r.lang] = (a[r.lang] || 0) + 1), a), {})))),
    chartCard('Most repeated terms', 'Across all saved ads (after removing common words)', () => phraseChart(), () => dataTable([{ label: 'Term' }, { label: 'Ads', num: 1 }], DATA.phrases)),
    h('section', { class: 'cc' }, h('header', null, h('div', null, h('h2', { text: 'Checks & red flags' }), h('p', { class: 'sub', text: 'Transparent rules, not accusations: always verify in person' }))),
      flagged.length ? flagged.map((r) => h('div', { style: 'padding:6px 0;border-top:1px solid var(--grid)' }, h('button', { class: 'btn', style: 'margin-bottom:4px', text: `${money(r.price)} · ${r.title}`, onclick: () => select(r.id) }), r.redFlags.map((f) => h('div', { class: 'flag ' + f.sev }, h('span', { class: 'ic', 'aria-hidden': 'true', text: ic(f.sev) }), h('div', null, h('b', { text: f.label }), h('p', { text: f.why })))))) : h('p', { class: 'muted', text: 'Nothing flagged in the current filter.' }),
      dups.length ? [h('h3', { class: 'muted', style: 'margin:12px 0 4px;font-size:12px', text: 'NEAR-DUPLICATE ADS' }), dups.map((g) => h('div', { class: 'chips', style: 'margin:4px 0' }, g.map((r) => h('button', { class: 'chip', text: `${money(r.price)} · ${r.title.slice(0, 24)}`, onclick: () => select(r.id) }))))] : null),
    segmentsCard(list),
    h('section', { class: 'cc wide' }, h('header', null, h('div', null, h('h2', { text: 'Price model' }), h('p', { class: 'sub', text: 'Does anything beyond bedroom count explain rent? Validated by leaving each listing out in turn' }))), modelCard(list))));
}

// ------------------------------------------------------------------ SHORTLIST
function csv(rows) { return rows.map((r) => r.map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n'); }
function renderShortlist() {
  const main = $('#main'), items = L.filter((r) => user.starred[r.id]).sort(SORTS[S.sort][1]);
  if (!items.length) { main.replaceChildren(h('div', { class: 'empty' }, h('p', { text: 'Your shortlist is empty.' }), h('p', { class: 'muted', text: 'Press s on a listing (or click the star) to add it. Notes and stars are saved in this browser.' }))); return; }
  const exportCsv = () => {
    const rows = [['price', 'beds', 'baths', 'sqft', 'area', 'km_to_downtown', 'fair_gap_pct', 'available', 'title', 'url', 'notes'], ...items.map((r) => [r.price, r.beds, r.baths, r.sqft, r.named[0] || r.area, r.dist, r.dealPct, r.availNow ? 'now' : r.availFrom, r.title, r.url, user.notes[r.id]])];
    const url = URL.createObjectURL(new Blob(['﻿' + csv(rows)], { type: 'text/csv' }));
    const a = h('a', { href: url, download: 'shortlist.csv' }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  main.replaceChildren(h('div', { class: 'listhead' }, h('b', { text: `${items.length} shortlisted` }), h('button', { class: 'btn', text: 'Export CSV', onclick: exportCsv }), h('button', { class: 'btn', text: 'Compare these (max 4)', onclick: () => { compare = items.slice(0, 4).map((r) => r.id); saveUser(); renderTabs(); go('compare'); } })),
    h('div', { class: 'tw' }, h('table', { class: 't' }, h('thead', null, h('tr', null, (HAS_PHOTOS ? [''] : []).concat(['Price', 'Layout', 'Area', 'Value', 'Notes']).map((t) => h('th', { text: t })))),
      h('tbody', null, items.map((r) => h('tr', { onclick: () => select(r.id) }, HAS_PHOTOS ? h('td', null, r.photos[0] ? h('img', { src: r.photos[0], alt: '', loading: 'lazy' }) : null) : null, h('td', { text: money(r.price) }), h('td', { text: layoutText(r) }), h('td', { text: r.named[0] || r.area || '—' }), h('td', null, dealBadge(r, 'chip')), h('td', { text: user.notes[r.id] || '', style: 'white-space:normal;max-width:360px' })))))));
}

// ------------------------------------------------------------------ chrome: tabs, filters, router
function renderTabs() {
  $('#tabs').replaceChildren(...VIEWS.map(([k, label]) => {
    const n = k === 'compare' ? compare.length : k === 'shortlist' ? Object.keys(user.starred).length : 0;
    return h('button', { class: 'tab', role: 'tab', 'aria-selected': S.view === k, onclick: () => go(k) }, label, n ? h('small', { text: n }) : null);
  }));
}
function resetFilters() { Object.assign(F, { q: '', min: '', max: '', beds: '', baths: '', area: '', must: {}, hideFlagged: false, hideTransfer: false, showHidden: false, showGone: false, type: '', avail: '' }); renderFilters(); render(); }
function renderFilters() {
  const bar = $('#filters'), areas = [...new Map(L.filter((r) => r.area).map((r) => [r.area, 0])).keys()].sort();
  const num = (key, ph) => h('input', { type: 'number', placeholder: ph, value: F[key], min: '0', 'aria-label': ph, oninput: (e) => { F[key] = e.target.value; render(); } });
  const sel = (key, label, opts) => h('select', { 'aria-label': label, onchange: (e) => { F[key] = e.target.value; render(); } }, opts.map(([v, t]) => h('option', { value: v, selected: F[key] === v, text: t })));
  const mustCount = Object.values(F.must).filter(Boolean).length;
  const mustSummary = h('summary', { text: mustCount ? `Must have (${mustCount})` : 'Must have' });
  put(bar,
    h('input', { type: 'search', id: 'q', placeholder: 'Search (e.g. chiens, metro, balcon)  /', 'aria-label': 'Search', value: F.q, oninput: (e) => { F.q = e.target.value; render(); }, onsearch: (e) => { F.q = e.target.value; render(); } }),
    h('label', null, 'Rent', num('min', 'Min $'), '–', num('max', 'Max $')),
    sel('beds', 'Bedrooms', [['', 'Any beds'], ['1', '1 bed'], ['2', '2 beds'], ['3', '3+ beds']]),
    sel('baths', 'Bathrooms', [['', 'Any baths'], ['1', '1 bath'], ['2', '2+ baths']]),
    sel('area', 'Area', [['', 'Any area'], ...areas.map((a) => [a, `${a} (${L.filter((r) => r.area === a).length})`])]),
    L.some((r) => r.kind === 'text-only') ? sel('type', 'Ad type', [['', 'Any ad type'], ['structured', 'Filed under Rentals'], ['text-only', 'Text-only (other category)']]) : null,
    h('details', { class: 'pop' }, mustSummary,
      h('div', { class: 'menu' }, FLAGS.filter(([k]) => L.some((r) => r.has[k])).map(([k, label]) => h('label', null, h('span', null, h('input', { type: 'checkbox', checked: !!F.must[k], onchange: (e) => { F.must[k] = e.target.checked; const c = Object.values(F.must).filter(Boolean).length; mustSummary.textContent = c ? `Must have (${c})` : 'Must have'; render(); } }), ' ' + label), h('span', { class: 'n', text: L.filter((r) => r.has[k]).length }))))),
    sel('avail', 'Availability', [['', 'Any availability'], ['now', 'Available now'], ['dated', 'Has a date']]),
    h('details', { class: 'pop' }, h('summary', { text: 'More' }), h('div', { class: 'menu' },
      h('label', null, h('span', null, h('input', { type: 'checkbox', checked: F.hideFlagged, onchange: (e) => { F.hideFlagged = e.target.checked; render(); } }), ' Hide listings with warnings')),
      h('label', null, h('span', null, h('input', { type: 'checkbox', checked: F.hideTransfer, onchange: (e) => { F.hideTransfer = e.target.checked; render(); } }), ' Hide lease transfers / sublets')),
      h('label', null, h('span', null, h('input', { type: 'checkbox', checked: F.showGone, onchange: (e) => { F.showGone = e.target.checked; render(); } }), ' Show listings that disappeared')),
      h('label', null, h('span', null, h('input', { type: 'checkbox', checked: F.showHidden, onchange: (e) => { F.showHidden = e.target.checked; render(); } }), ' Show listings I hid')))),
    h('button', { class: 'iconbtn', text: 'Reset', onclick: resetFilters }),
    h('span', { class: 'count', id: 'count' }));
}
function go(view) { S.view = view; history.replaceState(null, '', '#' + view); renderTabs(); render(); window.scrollTo(0, 0); }
function render() {
  tipHide();
  const list = filtered();
  $('#count') && ($('#count').textContent = `${list.length} of ${L.length} listings`);
  ({ browse: renderBrowse, compare: renderCompare, market: renderMarket, insights: renderInsights, shortlist: renderShortlist })[S.view](list);
}

// ------------------------------------------------------------------ keyboard
function showHelp() {
  const box = $('#help');
  box.replaceChildren(h('div', { class: 'box', onclick: (e) => e.stopPropagation() }, h('h2', { text: 'Keyboard shortcuts' }), h('dl', null,
    [['/', 'Search'], ['j  k', 'Next / previous listing'], ['← →', 'Previous / next photo'], ['s', 'Shortlist the selected listing'], ['x', 'Hide the selected listing'], ['c', 'Add to compare'], ['o', 'Open on Facebook'], ['1 – 5', 'Switch view'], ['Esc', 'Close dialogs'], ['?', 'This help']].flatMap(([k, d]) => [h('dt', null, h('kbd', { text: k })), h('dd', { style: 'margin:0', text: d })]))));
  box.hidden = false; box.onclick = () => { box.hidden = true; };
}
document.addEventListener('keydown', (e) => {
  const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
  if (e.key === 'Escape') { $('#lightbox').hidden = true; $('#help').hidden = true; const d = $('#detail'); d && d.classList.remove('open'); if (typing) { if (t.id === 'q' && F.q) { F.q = ''; t.value = ''; render(); } t.blur(); } return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const lb = $('#lightbox');
  if (!lb.hidden && lb._step && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { lb._step(e.key === 'ArrowRight' ? 1 : -1); return; }
  const r = byId.get(S.sel), list = filtered(), i = list.findIndex((x) => x.id === S.sel);
  switch (e.key) {
    case '/': e.preventDefault(); $('#q').focus(); break;
    case '?': showHelp(); break;
    case 'j': case 'ArrowDown': if (S.view === 'browse' && list.length) { e.preventDefault(); select(list[Math.min(list.length - 1, i + 1)].id); } break;
    case 'k': case 'ArrowUp': if (S.view === 'browse' && list.length) { e.preventDefault(); select(list[Math.max(0, i - 1)].id); } break;
    case 'ArrowRight': if (r && r.photos.length > 1 && S.view === 'browse') { S.photo = (S.photo + 1) % r.photos.length; renderDetail(); } break;
    case 'ArrowLeft': if (r && r.photos.length > 1 && S.view === 'browse') { S.photo = (S.photo - 1 + r.photos.length) % r.photos.length; renderDetail(); } break;
    case 's': if (r) { toggle(user.starred, r.id); renderTabs(); render(); } break;
    case 'x': if (r) { toggle(user.hidden, r.id); render(); } break;
    case 'c': if (r) toggleCompare(r.id); break;
    case 'o': if (r) window.open(r.url, '_blank', 'noopener,noreferrer'); break;
    default: if (/^[1-5]$/.test(e.key)) go(VIEWS[+e.key - 1][0]);
  }
});

// ------------------------------------------------------------------ init
function applyTheme(t) { if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); }
applyTheme(store.get('theme', null));
$('#theme').onclick = () => { const dark = window.matchMedia('(prefers-color-scheme: dark)').matches; const cur = document.documentElement.getAttribute('data-theme') || (dark ? 'dark' : 'light'); const next = cur === 'dark' ? 'light' : 'dark'; applyTheme(next); store.set('theme', next); render(); };
$('#helpbtn').onclick = showHelp;
$('#meta').textContent = `${META.n} listings · ${META.sources.join(', ')} · built ${META.generated}`;
const setChromeH = () => document.documentElement.style.setProperty('--chrome-h', $('#chrome').offsetHeight + 'px');
addEventListener('resize', setChromeH);
renderTabs(); renderFilters(); render(); setChromeH();
addEventListener('hashchange', () => { const v = location.hash.slice(1); if (VIEWS.some((x) => x[0] === v) && v !== S.view) go(v); });
})();

}


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
