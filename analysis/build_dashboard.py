#!/usr/bin/env python3
"""Build the rental dashboard from one or more extracted Rental Saver ZIP folders.

usage (run in isolated mode, paths are arguments):
    python3 -I analysis/build_dashboard.py OUT_HTML TEMPLATE_HTML RUN_DIR [RUN_DIR ...]

RUN_DIRs (a folder with listings.json, or the .json snapshot itself) are processed oldest -> newest:
later runs win, earliest firstSeen is kept, photos (older runs only) come from whichever folder holds them. Only numpy is required.

Everything here is deliberately transparent and rule-based or classical (TF-IDF, k-means,
ridge regression with leave-one-out validation). With few listings the statistics are
indicative, not conclusive, and the output says so (sample sizes, LOO error vs baseline).
The listing text is third-party data: it is only parsed, never executed, and the template
inserts it with textContent.
"""
import collections
import datetime
import json
import math
import os
import re
import sys
import unicodedata

import numpy as np

DOWNTOWN = (45.5017, -73.5673)  # Place Ville Marie, used as the "centrality" reference point


# ----------------------------------------------------------------------------- text utilities
def fold(s):
    """Lowercase + strip accents while keeping the string LENGTH identical (so offsets stay valid)."""
    out = []
    for c in s:
        d = unicodedata.normalize('NFD', c)
        b = d[0] if d and not unicodedata.combining(d[0]) else c
        lc = b.lower()
        out.append(lc if len(lc) == 1 else b)
    return ''.join(out)


STOP_EN = set(fold(w) for w in """a an the and or but if then of to in on at by for with from as is are was were be been being it its this
that these those you your we our they their he she his her i me my not no yes can will would should could may might must do does did done have
has had having there here also than so such into over under about up down out off per via etc just very more most much many any all each other
another same own only both few some get got""".split())
STOP_FR = set(fold(w) for w in """le la les un une des du de d l et ou mais si donc or ni car en dans sur sous par pour avec sans chez vers entre
est sont etait etaient ete etre a ont avait avoir au aux ce cet cette ces se sa son ses leur leurs nous vous ils elles il elle je tu me te moi toi
lui y ne pas plus que qui quoi dont quand comme tres tout tous toute toutes aussi bien peut peuvent doit doivent fait faire""".split())
DOMAIN_STOP = set(fold(w) for w in """apartment appartement apartments logement logements montreal montrealais bedroom bedrooms chambre chambres
bath bathroom bathrooms salle bain rent loyer month mois available disponible house maison unit home contact message call text please svp merci
thank thanks price prix per mo rue avenue ave boulevard blvd street road chemin st ste bed beds bath baths""".split())
STOP_ALL = STOP_EN | STOP_FR | DOMAIN_STOP
FR_ONLY = STOP_FR - STOP_EN
EN_ONLY = STOP_EN - STOP_FR


def tokens(text):
    f = fold(text).replace("'", ' ').replace('’', ' ')
    out = []
    for t in re.findall(r'[a-z]{2,}', f):
        if t in STOP_ALL:
            continue
        if len(t) > 5 and t.endswith('ies'):
            t = t[:-3] + 'y'
        elif len(t) > 5 and t.endswith(('shes', 'ches', 'xes', 'sses')):
            t = t[:-2]
        elif len(t) > 4 and t.endswith('s') and not t.endswith(('ss', 'us', 'is')):
            t = t[:-1]
        out.append(t)
    return out


def with_bigrams(toks):
    return toks + [a + ' ' + b for a, b in zip(toks, toks[1:])]


def tfidf(docs, min_df):
    n = len(docs)
    df = collections.Counter(t for d in docs for t in set(d))
    vocab = sorted(t for t, c in df.items() if c >= min_df)
    index = {t: i for i, t in enumerate(vocab)}
    X = np.zeros((n, len(vocab)))
    for i, d in enumerate(docs):
        for t, c in collections.Counter(d).items():
            j = index.get(t)
            if j is not None:
                X[i, j] = (1 + math.log(c)) * (math.log((1 + n) / (1 + df[t])) + 1)
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return X / norms, vocab, df


def detect_language(text):
    toks = re.findall(r'[a-z]+', fold(text))
    fr = sum(1 for t in toks if t in FR_ONLY)
    en = sum(1 for t in toks if t in EN_ONLY)
    if fr + en < 6:
        return 'unknown'
    if fr > 1.6 * en:
        return 'fr'
    if en > 1.6 * fr:
        return 'en'
    return 'bilingual'


# ----------------------------------------------------------------------------- fact extraction
RX = {
    'laundryUnit': r"in[- ]?unit (laundry|washer)|laveuse[^.\n]{0,25}secheuse|washer[^.\n]{0,20}dryer|washer/dryer|lave-?linge|laundry in (the )?(unit|apartment|suite)",
    'laundryBuilding': r"buanderie|laundry room|shared laundry|laundromat|laundry (facilit|on[- ]site)|laundry in (the )?building",
    'laundryHookup': r"hook-?ups?|branchements? (pour )?(la )?(laveuse|secheuse)|entrees? (pour )?laveuse",
    'ac': r"air[- ]?condition|climatis|\ba/c\b|\bac\b|thermopompe|heat pump",
    'parking': r"stationnement|parking|garage|driveway",
    'noParking': r"no parking|pas de stationnement|sans stationnement|parking not (included|available)",
    'dishwasher': r"dishwasher|lave-?vaisselle",
    'elevator': r"elevator|ascenseur",
    'furnished': r"(?<!un)(?<!non )(?<!non-)(?<!semi-)(?<!semi )furnished|(?<!non )(?<!non-)(?<!semi-)(?<!semi )meuble",
    'balcony': r"balcon|balcony|terrasse|patio",
    'pool': r"piscine|swimming pool|\bpool\b",
    'gym': r"\bgym\b|fitness|salle d'?exercice|salle de sport",
    'storage': r"storage|rangement|locker|casier|sous-sol|basement",
    'secured': r"secured? (entry|building)|intercom|interphone|code d'?acces|buzzer|keyless",
    'noSmoking': r"no[- ]smoking|non[- ]?fumeur|smoke[- ]free|pas de fumeur|interdit de fumer",
    'refs': r"references?\b|credit (check|report)|enquete de credit|proof of income|preuve de revenu|employment (letter|verification)|lettre d'?emploi",
    'leaseTransfer': r"lease (transfer|assignment|takeover|take over)|(transfer|assign)(ing)? (of |the |my |our )?(the )?lease|cession de bail|ceder (mon|notre|le) bail|transfert de bail|reprise de bail|sublet|sous-?loca",
    'petsPos': r"(pets?|animaux|animal|dogs?|chiens?|cats?|chats?)[^.\n]{0,30}(allowed|welcome|ok\b|okay|friendly|accept|permis|bienvenu|autoris)|(dog|cat|pet)[- ]friendly",
    'petsNeg': r"no pets?|pets? (are )?not (allowed|permitted|accepted)|no dogs?|no cats?|pas d'?animaux|animaux[^.\n]{0,25}\b(non|pas) (permis|acceptes?|autorises?)|sans animaux|aucun animal|interdit aux animaux|no animals",
    'dogs': r"dogs?[^.\n]{0,25}(allowed|welcome|ok\b|friendly|accept)|chiens?[^.\n]{0,25}(acceptes?|permis|bienvenus?)|chiens? et chats?|dogs? (and|&) cats?",
    'cats': r"cats?[^.\n]{0,25}(allowed|welcome|ok\b|friendly|accept)|chats?[^.\n]{0,25}(acceptes?|permis|bienvenus?)|chiens? et chats?|dogs? (and|&) cats?",
    'july1': r"1er juillet|1 juillet|july 1(st)?\b|1st of july|premier juillet",
    'offPlatform': r"whatsapp|telegram|western union|zelle|gift card|carte cadeau|bitcoin|crypto|wire transfer|virement bancaire",
    'depositFirst': r"(deposit|depot)[^.\n]{0,45}(before|avant)[^.\n]{0,25}(view|visit|visite|showing)|send (a |the )?(deposit|depot)|e-?transfer[^.\n]{0,25}(hold|reserve|secure|garder)",
    'absentOwner': r"out of (the )?(country|town)|overseas|missionary|hors du pays|abroad|currently (living )?in (the )?(uk|usa|europe|france)",
}
RXC = {k: re.compile(v) for k, v in RX.items()}

INCL = re.compile(r"included|incl\b|inclus|incluse|comprise|compris|covered|paid by (the )?(landlord|owner)|paye par")
EXCL = re.compile(r"not included|non[- ]?inclus|non[- ]?incluse|excluded|\bextra\b|additional|tenant|locataire|pas inclus|a la charge|not covered|not provided|separate|to be paid|payable")
UTIL = {
    'heat': (re.compile(r"heat(ing)?|chauff"), re.compile(r"chauffe|heated")),
    'hotWater': (re.compile(r"hot water|eau chaude"), None),
    'electricity': (re.compile(r"electricity|electricite|\bhydro\b"), None),
    'internet': (re.compile(r"internet|wi-?fi|\bcable\b"), None),
}
DELIM = re.compile(r"[.;\n•|!]")

AREA_NAMES = {
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
}
FAR_AREAS = {'Côte-Saint-Luc', 'Lachine', 'LaSalle', 'Ahuntsic', 'Cartierville', 'Saint-Laurent', 'Montréal-Nord', 'Saint-Léonard', 'Anjou', 'Laval', 'Longueuil'}
HYPE_WORDS = re.compile(r"luxur|stunning|magnifique|exceptionnel|must see|ne manquez|rare\b|prime\b|beautiful|spacious|charming|amazing|incroyable|wow|renove|renovated|brand new|neuf|modern|moderne|bright|lumineu")


def spans(rx, folded, text, cap=1):
    """Evidence = the matched text from the ORIGINAL string (offsets are valid: fold keeps length)."""
    out = []
    for m in rx.finditer(folded):
        out.append(text[m.start():m.end()])
        if len(out) >= cap:
            break
    return out


def util_status(folded, text, key):
    """'included' / 'excluded' / None for heat, hot water, electricity, internet, using the clause after the keyword."""
    kw, self_incl = UTIL[key]
    status, evidence = None, None
    for m in kw.finditer(folded):
        end_clause = DELIM.search(folded, m.end())
        stop = end_clause.start() if end_clause else len(folded)
        after = folded[m.start():min(stop, m.end() + 80)]
        before = folded[max(0, m.start() - 45):m.start()]
        e = EXCL.search(after, m.end() - m.start())
        i = INCL.search(after, m.end() - m.start())
        found = None
        if e and (not i or e.start() <= i.start()):
            found = 'excluded'
        elif i:
            found = 'included'
        elif self_incl and self_incl.search(after):
            found = 'excluded' if re.search(r"(non|pas|not|un)[- ]?$", before) else 'included'
        elif re.search(r"(incl(uded|us|ut)?|comprend|comprise)s?\s*[:\-–]\s*[^.\n]{0,40}$", before):
            found = 'included'
        elif re.search(r"(not included|non inclus|excluded)\s*[:\-–]\s*[^.\n]{0,40}$", before):
            found = 'excluded'
        if found:
            ev = text[m.start():min(stop, m.end() + 60)].strip()
            if status is None or (found == 'excluded' and status == 'included'):
                status, evidence = found, ev
            if status == 'excluded':
                break
    return status, evidence


STRUCT = {  # Facebook's structured amenity labels -> flags
    'in-unit laundry': ['laundryUnit'], 'laundry in building': ['laundryBuilding'],
    'dog and cat friendly': ['dogs', 'cats', 'pets'], 'cat friendly': ['cats', 'pets'], 'dog friendly': ['dogs', 'pets'],
    'ac available': ['ac'], 'central ac': ['ac'], 'air conditioning': ['ac'],
    'garage parking': ['parking', 'garage'], 'street parking': ['parking'], 'parking available': ['parking'], 'off-street parking': ['parking'],
    'balcony': ['balcony'], 'dishwasher': ['dishwasher'], 'elevator': ['elevator'], 'fitness center': ['gym'], 'pool': ['pool'],
    'secured entry': ['secured'], 'concierge': ['concierge'], 'basement': ['storage'], 'fireplace': ['fireplace'], 'bike parking': ['bikeParking'],
}


WORD_NUM = {'un': 1, 'une': 1, 'one': 1, 'deux': 2, 'two': 2, 'trois': 3, 'three': 3, 'quatre': 4, 'four': 4, 'cinq': 5, 'five': 5}


def _beds_in(text):
    t = fold(text or '')
    m = re.search(r"\b(\d|un|une|deux|trois|quatre|cinq|one|two|three|four|five)[\s-]*(?:chambres?|bedrooms?|beds?|bdrms?|bd|br)\b", t)
    if m:
        g = m.group(1)
        return int(g) if g.isdigit() else WORD_NUM[g]
    m = re.search(r"(?:^|[^\d])(\d)\s?(?:1/2|\u00bd|et demi)", t)  # Quebec rooms: 3.5 = 1 bedroom, 4.5 = 2, 5.5 = 3
    if m:
        r = int(m.group(1))
        return 0 if r <= 2 else r - 2
    if re.search(r"\b(studio|bachelor|garconniere)\b", t):
        return 0
    return None


def infer_bedrooms(title, desc):
    a = _beds_in(title)
    return a if a is not None else _beds_in(desc)


def parse_listed_days(txt):
    t = fold(txt or '')
    if not t:
        return None
    m = re.search(r'(\d+)\s*(minute|hour|heure|day|jour|week|semaine|month|mois)', t)
    if 'over a week' in t:
        return 8
    if 'yesterday' in t or 'hier' in t:
        return 1
    if m:
        n, u = int(m.group(1)), m.group(2)
        return n * (30 if u in ('month', 'mois') else 7 if u in ('week', 'semaine') else 1 if u in ('day', 'jour') else 0)
    if 'today' in t or 'just now' in t or "aujourd" in t:
        return 0
    return None


def haversine(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def enrich(v):
    """Turn one raw listing view into the dashboard record (facts, evidence, scores)."""
    title, desc = v.get('title') or '', v.get('description') or ''
    text = title + '\n' + desc
    f = fold(text)
    ev = {}   # flag -> matched text
    has = {}

    def mark(flag, evidence=None):
        has[flag] = True
        if evidence:
            ev.setdefault(flag, evidence)

    amen = [a for a in (v.get('amenities') or []) if a]
    sqft, lease_months = None, None
    for a in amen:
        al = a.lower().strip()
        for fl in STRUCT.get(al, []):
            mark(fl, a)
        m = re.match(r'([\d,]{3,6})\s*square feet', al)
        if m:
            sqft = int(m.group(1).replace(',', ''))
        m = re.match(r'(\d+)\s*(year|month)s?\s*lease', al)
        if m:
            lease_months = int(m.group(1)) * (12 if m.group(2) == 'year' else 1)

    for flag in ['laundryUnit', 'laundryBuilding', 'laundryHookup', 'ac', 'dishwasher', 'elevator', 'furnished', 'balcony', 'pool', 'gym',
                 'storage', 'secured', 'noSmoking', 'refs', 'leaseTransfer', 'july1']:
        s = spans(RXC[flag], f, text)
        if s:
            mark(flag, s[0])
    park = spans(RXC['parking'], f, text)
    if park and not RXC['noParking'].search(f):
        mark('parking', park[0])

    # pets: structured labels first, then text with negation
    neg = spans(RXC['petsNeg'], f, text)
    # a "positive" match that itself contains a negation ("animaux ... non acceptes") is not positive
    pos = [p for p in spans(RXC['petsPos'], f, text, cap=6) if not re.search(r"\b(non|pas|not|no|sans)\b", fold(p))][:1]
    pets = None
    if has.get('pets') or pos:
        pets = 'ok'
        if pos:
            ev.setdefault('pets', pos[0])
    if neg and not has.get('pets'):
        pets, ev['petsNo'] = 'no', neg[0]
    if has.get('pets') and neg:
        ev['petsNo'] = neg[0]  # conflicting statements: keep both, surface the conflict
    for flag, key in (('dogs', 'dogs'), ('cats', 'cats')):
        s = spans(RXC[key], f, text)
        if s and pets != 'no':
            mark(flag, s[0])

    utils = {}
    for key in UTIL:
        status, evid = util_status(f, text, key)
        utils[key] = status
        if status and evid:
            ev['util_' + key] = evid
    if utils['heat'] == 'included':
        mark('heatIncl', ev.get('util_heat'))

    if sqft is None:
        m = re.search(r'(\d{3,4})\s*(sq\.?\s?ft|sqft|square feet|pi2|pi²|pieds? carres?)', f)
        if m:
            sqft = int(m.group(1))
            ev['sqft'] = text[m.start():m.end()]
    if sqft is not None and not (250 <= sqft <= 3500):
        sqft = None
    if lease_months is None:
        m = re.search(r'(\d{1,2})[- ]month lease|bail de (\d{1,2}) mois|(\d{1,2})\s*mois de bail', f)
        if m:
            lease_months = int(next(g for g in m.groups() if g))
        elif re.search(r"(1|one|un)[- ](year|an)\b|12 mois|12 months|bail d'?un an", f):
            lease_months = 12
    qc = re.search(r'\b(\d)\s*(?:½|1/2|et demi)', text)
    qc_size = f'{qc.group(1)}½' if qc else None

    named = []
    for key, name in AREA_NAMES.items():
        if key in f and name not in named:
            named.append(name)

    lat, lon = v.get('latitude'), v.get('longitude')
    dist = round(haversine(lat, lon, *DOWNTOWN), 2) if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) else None
    price = v.get('priceAmount')
    beds, baths = v.get('bedrooms'), v.get('bathrooms')
    beds_inferred = False
    if beds is None:
        ib = v.get('bedroomsInferred') if 'bedroomsInferred' in v else infer_bedrooms(title, desc)
        if ib is not None:
            beds, beds_inferred = ib, True
    category = v.get('category') or ''
    kind = v.get('kind') or ('structured' if category.lower().startswith('rental') else 'text-only')
    loc_txt = (v.get('locationText') or '').strip()
    address = loc_txt if re.match(r'\d', loc_txt) else None
    postal = v.get('postalCode') or ''
    avail_text = v.get('availabilityText') or ''

    # transparency (how complete is the ad) and hype (how salesy is the text)
    pts = 0
    pts += 15 if sqft else 0
    pts += 10 if (v.get('availableFrom') or 'now' in avail_text.lower()) else 0
    pts += 10 if lease_months else 0
    pts += 15 if any(utils.values()) else 0
    pts += 10 if pets else 0
    pts += 10 if (has.get('laundryUnit') or has.get('laundryBuilding') or has.get('laundryHookup')) else 0
    pts += 5 if (has.get('parking') or RXC['noParking'].search(f)) else 0
    pts += 10 if (address or postal) else 0
    n_photos = v.get('photoCount') if v.get('photoCount') is not None else (v.get('photosSaved') or len(v.get('photoFiles') or []))
    pts += 10 if n_photos >= 8 else 0
    pts += 5 if len(desc) >= 400 else 0
    letters = [c for c in text if c.isalpha()]
    upper = sum(1 for c in letters if c.isupper()) / max(1, len(letters))
    emoji = sum(1 for c in text if ord(c) > 0x2190)
    hype = min(100, round(len(HYPE_WORDS.findall(f)) * 9 + text.count('!') * 6 + emoji * 4 + max(0, upper - 0.12) * 120))

    rec = {
        'id': v['id'], 'url': v.get('url'), 'title': title, 'price': price, 'priceText': v.get('price') or '',
        'beds': beds, 'baths': baths, 'sqft': sqft,
        'ppsf': round(price / sqft, 2) if price and sqft else None,
        'pbed': round(price / beds, 0) if price and beds else None,
        'qcSize': qc_size, 'type': v.get('propertyType') or None, 'bedsInferred': beds_inferred, 'kind': kind, 'category': category or None,
        'via': v.get('foundVia') or [], 'priceFromText': bool(v.get('priceFromText')),
        'area': postal.split()[0] if postal else None, 'postal': postal or None, 'address': address,
        'named': named, 'city': v.get('city') or None,
        'lat': lat if dist is not None else None, 'lon': lon if dist is not None else None, 'dist': dist,
        'lang': detect_language(desc), 'listedText': v.get('listedText') or '', 'listedDays': parse_listed_days(v.get('listedText')),
        'availText': avail_text, 'availFrom': v.get('availableFrom') or None, 'availNow': 'now' in avail_text.lower() or 'maintenant' in avail_text.lower(),
        'leaseMonths': lease_months, 'pets': pets, 'utils': utils,
        'has': {k: True for k, val in has.items() if val}, 'amenities': amen, 'evidence': ev,
        'desc': desc, 'descLen': len(desc), 'transparency': pts, 'hype': hype,
        'status': v.get('status'), 'firstSeen': v.get('firstSeen'), 'lastSeen': v.get('lastSeen'), 'goneAt': v.get('goneAt'),
        'priceHistory': v.get('priceHistory') or [], 'prevPrice': v.get('prevPrice'),
        'isPending': bool(v.get('isPending')), 'isSold': bool(v.get('isSold')), 'isLive': v.get('isLive') is not False,
        '_flags': {k: bool(RXC[k].search(f)) for k in ('offPlatform', 'depositFirst', 'absentOwner')},
        '_flag_ev': {k: (spans(RXC[k], f, text) or [None])[0] for k in ('offPlatform', 'depositFirst', 'absentOwner')},
    }
    return rec


# ----------------------------------------------------------------------------- modelling
def kmeans(Z, k, seed=7, restarts=14, iters=80):
    rng = np.random.default_rng(seed)
    best = None
    for _ in range(restarts):
        idx = [int(rng.integers(len(Z)))]
        for _ in range(1, k):
            d2 = np.min(((Z[:, None, :] - Z[idx][None, :, :]) ** 2).sum(-1), axis=1)
            idx.append(int(rng.choice(len(Z), p=d2 / d2.sum())) if d2.sum() > 0 else int(rng.integers(len(Z))))
        C = Z[idx].copy()
        for _ in range(iters):
            lab = ((Z[:, None, :] - C[None, :, :]) ** 2).sum(-1).argmin(1)
            newC = np.array([Z[lab == j].mean(0) if (lab == j).any() else C[j] for j in range(k)])
            if np.allclose(newC, C):
                break
            C = newC
        inertia = float(((Z - C[lab]) ** 2).sum())
        if best is None or inertia < best[0]:
            best = (inertia, lab)
    return best[1]


def ridge_fit(X, y, lam):
    n = len(y)
    xm, ym = X.mean(0), y.mean()
    Xc, yc = X - xm, y - ym
    Ainv = np.linalg.inv(Xc.T @ Xc + lam * np.eye(X.shape[1]))
    w = Ainv @ Xc.T @ yc
    fit = ym + Xc @ w
    h = 1.0 / n + np.einsum('ij,jk,ik->i', Xc, Ainv, Xc)
    loo = y - (y - fit) / (1 - h)  # exact leave-one-out prediction
    return w, fit, loo, xm, ym


FEATURES = [
    ('beds', 'Bedrooms', 'num'), ('baths', 'Bathrooms', 'num'), ('sqft', 'Square feet', 'num'), ('dist', 'Km to downtown', 'num'),
    ('laundryUnit', 'In-unit laundry', 'bin'), ('parking', 'Parking', 'bin'), ('ac', 'Air conditioning', 'bin'), ('heatIncl', 'Heating included', 'bin'),
    ('pets', 'Pets allowed', 'bin'), ('dishwasher', 'Dishwasher', 'bin'), ('buildingAmen', 'Gym / pool / elevator / concierge', 'bin'),
]


def feature_matrix(recs):
    n = len(recs)
    by_beds = collections.defaultdict(list)
    for r in recs:
        if r['sqft']:
            by_beds[r['beds']].append(r['sqft'])
    all_sq = [r['sqft'] for r in recs if r['sqft']]
    cols, names, kinds = [], [], []
    for key, label, kind in FEATURES:
        col = []
        for r in recs:
            if key == 'pets':
                x = 1.0 if r['pets'] == 'ok' else 0.0
            elif key == 'buildingAmen':
                x = 1.0 if any(r['has'].get(k) for k in ('gym', 'pool', 'elevator', 'concierge')) else 0.0
            elif key == 'heatIncl':
                x = 1.0 if r['has'].get('heatIncl') else 0.0
            elif kind == 'bin':
                x = 1.0 if r['has'].get(key) else 0.0
            elif key == 'sqft':
                x = r['sqft'] or (float(np.median(by_beds[r['beds']])) if by_beds.get(r['beds']) else (float(np.median(all_sq)) if all_sq else float('nan')))
            else:
                x = r.get(key)
                x = float('nan') if x is None else float(x)
            col.append(x)
        a = np.array(col, dtype=float)
        if np.isnan(a).any():
            continue
        uniq = np.unique(a)
        if kind == 'bin':
            pos = int(a.sum())
            if pos < 2 or n - pos < 2:
                continue
        elif len(uniq) < 3:
            continue
        cols.append(a), names.append((key, label)), kinds.append(kind)
    return (np.column_stack(cols) if cols else np.zeros((n, 0))), names


def price_model(recs):
    """Hedonic ridge regression with exact leave-one-out validation; falls back to a median-by-bedrooms benchmark."""
    n = len(recs)
    y = np.array([float(r['price']) for r in recs])
    # baseline: leave-one-out median of the same bedroom count (else of everyone)
    base = np.zeros(n)
    for i, r in enumerate(recs):
        same = [float(o['price']) for j, o in enumerate(recs) if j != i and o['beds'] == r['beds']]
        others = [float(o['price']) for j, o in enumerate(recs) if j != i]
        base[i] = np.median(same) if len(same) >= 2 else np.median(others) if others else float(r['price'])  # alone: no comparison possible
    base_mae = float(np.abs(y - base).mean())
    out = {'n': n, 'enabled': False, 'baselineMAE': round(base_mae, 1), 'features': [], 'note': ''}
    pred = base.copy()
    drivers = [[] for _ in recs]
    if n < 8:
        out['note'] = f'Only {n} listings: the regression needs at least 8, so the fair-price estimate is the median of comparable listings.'
        return pred, out, drivers
    X, names = feature_matrix(recs)
    if X.shape[1] == 0:
        out['note'] = 'No usable features varied across listings; using the benchmark.'
        return pred, out, drivers
    sd = X.std(0)
    Xs = (X - X.mean(0)) / sd
    best = None
    grid = np.logspace(-1, 4.5, 40)
    for lam in grid:
        w, fit, loo, xm, ym = ridge_fit(Xs, y, lam)
        mse = float(((y - loo) ** 2).mean())
        if best is None or mse < best[0]:
            best = (mse, lam, w, loo, ym)
    _, lam, w, loo, ym = best
    at_edge = bool(lam >= grid[-1] * 0.5)  # cross-validation wants to ignore every feature
    mae = float(np.abs(y - loo).mean())
    ss_res, ss_tot = float(((y - loo) ** 2).sum()), float(((y - y.mean()) ** 2).sum())
    r2 = 1 - ss_res / ss_tot if ss_tot else 0.0
    rng = np.random.default_rng(11)
    boots = []
    for _ in range(400):
        idx = rng.integers(0, n, n)
        if len(np.unique(y[idx])) < 3:
            continue
        wb, *_ = ridge_fit(Xs[idx], y[idx], lam)
        boots.append(wb / sd)
    boots = np.array(boots) if boots else np.zeros((1, Xs.shape[1]))
    coef = w / sd
    lo, hi = np.percentile(boots, 5, axis=0), np.percentile(boots, 95, axis=0)
    useful = bool(mae < 0.95 * base_mae and r2 > 0.05 and not at_edge)
    out.update({'enabled': True, 'useful': bool(useful), 'lambda': round(float(lam), 2), 'looMAE': round(mae, 1), 'looR2': round(r2, 3),
                'features': [{'key': names[j][0], 'label': names[j][1], 'coef': round(float(coef[j]), 1), 'lo': round(float(lo[j]), 1), 'hi': round(float(hi[j]), 1),
                              'kind': 'bin' if X[:, j].max() <= 1 and X[:, j].min() >= 0 and len(np.unique(X[:, j])) == 2 else 'num'}
                             for j in range(len(names))]})
    if useful:
        out['note'] = f'Out-of-sample (leave-one-out) the model beats the simple benchmark: MAE ${mae:.0f} vs ${base_mae:.0f}, R² {r2:.2f}.'
        pred = loo
    else:
        why = 'cross-validation chose to ignore every feature' if at_edge else f'leave-one-out R² is {r2:.2f}'
        out['note'] = (f'No reliable price signal beyond the benchmark at this sample size ({why}). '
                       'Fair price = median of listings with the same bedroom count. Coefficients are hidden because they would be noise.')
        return pred, out, drivers
    xmean = X.mean(0)
    for i in range(n):
        contrib = [(names[j][1], float(coef[j] * (X[i, j] - xmean[j]))) for j in range(len(names))]
        contrib.sort(key=lambda t: -abs(t[1]))
        drivers[i] = [{'label': a, 'delta': round(b)} for a, b in contrib[:3] if abs(b) >= 5]
    return pred, out, drivers


# ----------------------------------------------------------------------------- main assembly
def load_runs(run_dirs, out_dir):
    merged, scans, meta = {}, [], {}
    for rd in run_dirs:
        path = rd if os.path.isfile(rd) else os.path.join(rd, 'listings.json')
        with open(path, encoding='utf-8') as fh:
            data = json.load(fh)
        if isinstance(data, dict):  # snapshot schema 2: {listings, scans, queries, profile, ...}
            items = data.get('listings', [])
            if data.get('scans'):
                scans = data['scans']  # the newest snapshot carries the whole log
            meta = {k: data.get(k) for k in ('queries', 'profile', 'generated')}
        else:
            items = data
        for v in items:
            old = merged.get(v['id'])
            if old:
                v['firstSeen'] = min(old.get('firstSeen') or v.get('firstSeen') or '', v.get('firstSeen') or old.get('firstSeen') or '') or None
            merged[v['id']] = v
    photos = {}
    for v in merged.values():
        for rd in reversed(run_dirs):
            folder = os.path.join(rd, v.get('folder') or '')
            if v.get('folder') and os.path.isdir(folder):
                files = [fn for fn in (v.get('photoFiles') or []) if os.path.isfile(os.path.join(folder, fn))]
                if files:
                    photos[v['id']] = [os.path.relpath(os.path.join(folder, fn), out_dir).replace(os.sep, '/') for fn in files]
                    break
    return list(merged.values()), photos, scans, meta


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    out_html, template, run_dirs = os.path.abspath(sys.argv[1]), sys.argv[2], [os.path.abspath(p) for p in sys.argv[3:]]
    out_dir = os.path.dirname(out_html)
    raw, photos, scans, runmeta = load_runs(run_dirs, out_dir)
    priced = [v for v in raw if v.get('priceAmount') and 300 <= v['priceAmount'] <= 10000]  # anything else is a placeholder, not a rent
    recs = [enrich(v) for v in priced]
    recs.sort(key=lambda r: (r['price'], r['id']))
    n = len(recs)
    if n == 0:
        sys.exit('no listings with a price found')

    # --- text models
    docs = [with_bigrams(tokens(r['title'] + ' ' + r['desc'])) for r in recs]
    Xs, vocab, _ = tfidf(docs, min_df=2 if n >= 8 else 1)
    Xk, vocab_k, df_k = tfidf(docs, min_df=1)
    sim = Xs @ Xs.T if Xs.shape[1] else np.zeros((n, n))

    clusters, labels = [], np.zeros(n, dtype=int)
    k = 3 if n >= 12 else 2 if n >= 6 else 1
    if k > 1 and Xs.shape[1] >= 3:
        U, S, Vt = np.linalg.svd(Xs, full_matrices=False)
        d = max(2, min(5, n - 1, len(S)))
        Z = U[:, :d] * S[:d]
        Z = Z / (np.linalg.norm(Z, axis=1, keepdims=True) + 1e-9)
        labels = kmeans(Z, k)
        order = [c for c, _ in collections.Counter(labels).most_common()]
        labels = np.array([order.index(c) for c in labels])
    glob = Xs.mean(0) if Xs.shape[1] else np.zeros(0)
    for c in range(int(labels.max()) + 1):
        members = np.where(labels == c)[0]
        terms = []
        if Xs.shape[1]:
            score = Xs[members].mean(0) - glob
            for j in np.argsort(-score)[:12]:
                if score[j] > 0 and vocab[j] not in terms and not any(vocab[j] in t or t in vocab[j] for t in terms):
                    terms.append(vocab[j])
                if len(terms) == 6:
                    break
        pr = [recs[i]['price'] for i in members]
        clusters.append({'id': c, 'size': int(len(members)), 'terms': terms, 'medianPrice': float(np.median(pr)), 'members': [recs[i]['id'] for i in members]})

    # --- distinctive keywords per listing (unigrams first), similar listings, near-duplicates
    vocab_df_ok = [t for t in vocab_k]
    kidx = {t: j for j, t in enumerate(vocab_k)}
    for i, r in enumerate(recs):
        row = Xk[i]
        cand = [(row[j], vocab_k[j]) for j in np.argsort(-row)[:30] if row[j] > 0]
        kws = []
        for w, t in cand:
            if n >= 8 and df_k[t] > 0.6 * n:
                continue
            if any(t in x or x in t for x in kws):
                continue
            kws.append(t)
            if len(kws) == 6:
                break
        r['keywords'] = kws
        r['cluster'] = int(labels[i])
        nb = [(float(sim[i, j]), j) for j in range(n) if j != i]
        nb.sort(reverse=True)
        r['similar'] = [{'id': recs[j]['id'], 'sim': round(s, 2)} for s, j in nb[:3] if s >= 0.2]

    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for i in range(n):
        for j in range(i + 1, n):
            same_spot = (recs[i]['lat'] and recs[j]['lat'] and abs(recs[i]['lat'] - recs[j]['lat']) < 0.0003 and abs(recs[i]['lon'] - recs[j]['lon']) < 0.0003)
            near_price = abs(recs[i]['price'] - recs[j]['price']) <= 0.05 * recs[i]['price']
            if sim[i, j] >= 0.85 or (same_spot and near_price and sim[i, j] >= 0.3):
                parent[find(i)] = find(j)
    groups = collections.defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)
    dup_groups = [[recs[i]['id'] for i in g] for g in groups.values() if len(g) > 1]
    for g in dup_groups:
        for lid in g:
            next(r for r in recs if r['id'] == lid)['dupGroup'] = g

    # --- price model + benchmarks
    pred, model, drivers = price_model(recs)
    med_by_beds = collections.defaultdict(list)
    for r in recs:
        med_by_beds[r['beds']].append(r['price'])
    overall = float(np.median([r['price'] for r in recs]))
    for i, r in enumerate(recs):
        r['predicted'] = round(float(pred[i]))
        r['dealPct'] = round((float(pred[i]) - r['price']) / float(pred[i]) * 100, 1)
        grp = med_by_beds[r['beds']]
        bench = float(np.median(grp)) if len(grp) >= 3 else overall
        r['vsMedian'] = round((r['price'] - bench) / bench * 100, 1)
        r['drivers'] = drivers[i]

    # --- red flags (transparent rules; informational, not accusations)
    for r in recs:
        flags = []
        if r['_flags']['offPlatform']:
            flags.append({'sev': 'serious', 'code': 'offPlatform', 'label': 'Off-platform payment or contact', 'why': 'Mentions ' + (r['_flag_ev']['offPlatform'] or 'an off-platform channel') + '. Common in rental scams.'})
        if r['_flags']['depositFirst']:
            flags.append({'sev': 'serious', 'code': 'depositFirst', 'label': 'Deposit requested before a visit', 'why': 'Quebec landlords generally cannot require a security deposit, and paying before viewing is a classic scam pattern.'})
        if r['_flags']['absentOwner']:
            flags.append({'sev': 'serious', 'code': 'absentOwner', 'label': 'Owner abroad / unavailable', 'why': 'Mentions "' + (r['_flag_ev']['absentOwner'] or 'out of country') + '".'})
        if n >= 6 and r['dealPct'] >= 25 and r['vsMedian'] <= -20:
            flags.append({'sev': 'warn', 'code': 'tooCheap', 'label': 'Priced far below comparable listings', 'why': f"{r['dealPct']:.0f}% under the fair-price estimate and {abs(r['vsMedian']):.0f}% under the median. Verify before paying anything."})
        if r['descLen'] < 150 and not r['sqft']:
            flags.append({'sev': 'info', 'code': 'thin', 'label': 'Very little detail in the ad', 'why': 'Short description and no square footage.'})
        if r.get('dupGroup'):
            flags.append({'sev': 'info', 'code': 'dupe', 'label': f"Near-duplicate of {len(r['dupGroup']) - 1} other listing(s)", 'why': 'Very similar text or the same spot: probably the same landlord or building.'})
        if r['kind'] == 'text-only':
            flags.append({'sev': 'info', 'code': 'textOnly', 'label': 'Not filed under Rentals (text-only ad)',
                          'why': 'Posted in another category, so there are no structured details: bedrooms and amenities come from the text' + (' (bedrooms inferred)' if r['bedsInferred'] else ', and the bedroom count is unknown') + ', and the fair-price estimate is less reliable.'})
        if r['priceFromText']:
            flags.append({'sev': 'info', 'code': 'priceFromText', 'label': 'Rent taken from the description', 'why': 'The listed price was a placeholder, so the rent was read from the ad text. Check it with the landlord.'})
        far = [a for a in r['named'] if a in FAR_AREAS]
        if far and r['dist'] is not None and r['dist'] < 2.5:
            flags.append({'sev': 'info', 'code': 'pinMismatch', 'label': 'Map pin may be wrong',
                          'why': f"The text mentions {far[0]} but Facebook's pin is only {r['dist']:.1f} km from downtown. The pin is approximate: trust the address in the text."})
        if r['isPending'] or r['isSold']:
            flags.append({'sev': 'warn', 'code': 'pending', 'label': 'Marked pending or sold', 'why': 'Facebook shows this listing as no longer available.'})
        r['redFlags'] = flags
        r.pop('_flags'), r.pop('_flag_ev')
        r['photos'] = photos.get(r['id'], [])

    # --- corpus phrases
    totals = collections.Counter()
    for d in docs:
        for t in set(d):
            totals[t] += 1
    phrases = [[t, c] for t, c in totals.most_common(80) if c >= 2 and (' ' in t or len(t) > 3)][:18]

    data = {
        'meta': {
            'generated': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'), 'sources': [os.path.basename(p) for p in run_dirs], 'n': n,
            'downtown': list(DOWNTOWN), 'key': ','.join(sorted(os.path.basename(p) for p in run_dirs)),
        },
        'listings': recs, 'model': model, 'clusters': clusters, 'phrases': phrases, 'dupGroups': dup_groups,
        'scans': scans, 'queries': runmeta.get('queries') or [], 'profile': runmeta.get('profile'), 'unpriced': len(raw) - len(recs),
    }
    with open(template, encoding='utf-8') as fh:
        html = fh.read()
    marker = '/*__DATA__*/null'
    if marker not in html:
        sys.exit('template is missing the data marker')
    blob = json.dumps(data, ensure_ascii=False, allow_nan=False).replace('<', '\\u003c').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    os.makedirs(out_dir, exist_ok=True)
    with open(out_html, 'w', encoding='utf-8') as fh:
        fh.write(html.replace(marker, blob, 1))  # str.replace does no backslash processing, so this is safe
    print(f'listings: {n} | photos linked: {sum(len(r["photos"]) for r in recs)} | clusters: {len(clusters)} | duplicate groups: {len(dup_groups)}')
    print(f"model: enabled={model['enabled']} useful={model.get('useful')} LOO MAE={model.get('looMAE')} vs baseline MAE={model['baselineMAE']} | {model['note']}")
    print('written:', out_html)


if __name__ == '__main__':
    main()
