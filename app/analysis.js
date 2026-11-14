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
if (typeof module !== 'undefined') module.exports = { fbmAnalyze };
