# Marketplace rental finder

**One app:** install `fb-marketplace-rental-app.user.js` in Violentmonkey. It scrapes, keeps the history, saves a few
photos per listing (downscaled, in the browser's IndexedDB) and shows the dashboard in the page: click **Dashboard** in
the panel on any Marketplace page. Nothing to download or transfer. The file is generated:

```bash
python3 -I tools/build_app.py fb-marketplace-rental-saver.user.js app/analysis.js dashboard/template.html fb-marketplace-rental-app.user.js
```

`fb-marketplace-rental-saver.user.js` is the scraper source, `app/analysis.js` the browser port of the analysis,
`dashboard/template.html` the UI.

**Install / update:** serve this folder locally, e.g.
`python3 -I -m http.server 46653 --bind 127.0.0.1 --directory .`, open
`http://127.0.0.1:46653/fb-marketplace-rental-app.user.js` in a browser with Violentmonkey and confirm. The script header
carries that address as its update URL, so Violentmonkey's update check picks up every new `@version`.
Bump the version when you rebuild. The Python builder below still works for offline use from JSON snapshots.

- `fb-marketplace-rental-saver.user.js`: the Violentmonkey script. One click runs a set of French + English
  searches (newest first) around Montréal, tracks every listing in its own local history (facts + description,
  **no images**), logs prices over time, and downloads a JSON snapshot.
- `analysis/build_dashboard.py`: turns one or more snapshots into the dashboard (needs only Python + numpy).
- `dashboard/template.html`: the dashboard UI. `dashboard/index.html` is generated: open it in a browser (works offline).
- `data/`: your snapshots (older runs are folders holding `listings.json` and photos; newer ones are single
  `fb-rentals-YYYY-MM-DD.json` files).

## Using the script

1. Open any Facebook Marketplace page and click **Run all queries**. The script builds the search URLs itself
   (your area, max price, sorted by newest), visits each in this tab, then reads the NEW listings in background tabs.
   Keep the tab in the foreground. **Stop & save** keeps what is done. If you wander off, the panel offers **Resume**.
2. **Scan this page** scans whatever search you have open instead (it never takes listings away from the main profile).
3. Settings are at the top of the script (`CFG`) and in the panel: max price, bedrooms (pre-filter on the card title;
   unknown counts are kept), max new listings per run, full pass, area (`CFG.area`), and **edit** for the list of searches.

What a run does:

- **Quick runs** stop each search after 15 known listings in a row (newest first), so they are short. They refresh
  prices only near the top of the results.
- Every 5th run (and the first) is a **full pass**: every search scrolls to the end. Only a full pass can flag a
  listing as **gone** and refresh every price.
- At most `maxNewPerRun` (40) new listings are opened per run, newest results first. The rest are saved as a
  **backlog** (the panel shows "N waiting") that is opened first on the next run, so a quick run never strands them.
  Anything left unopened by a stopped or blocked run goes to the backlog too.
- Panel settings (max rent, bedrooms, new per run, skip rooms, re-open known) are saved, because the run reloads the
  page for every search.
- Each listing is classed **structured** (filed under Rentals), **text-only** (a rental filed elsewhere, typically a
  lease transfer; bedrooms are inferred from the text, "4½" = 2 bedrooms) or **unrelated** (skipped for good).
- If Facebook shows a "going too fast / temporarily blocked" page, the run stops and saves what it has.

## Price evolution

Every run adds a point to a price log (every tracked listing seen, with its asking rent). The dashboard's **Market**
tab charts the median over time: all listings seen (complete runs only, because quick runs only see the newest ones)
and the asking rent of new listings. Listings that have since disappeared stay in the log, so the history is not lost.

## Refresh the dashboard after a run

```bash
mv ~/Downloads/fb-rentals-YYYY-MM-DD.json data/
python3 -I analysis/build_dashboard.py dashboard/index.html dashboard/template.html \
    data/rentals-2026-11-13 data/fb-rentals-YYYY-MM-DD.json
```

Runs are listed oldest -> newest. A newest snapshot already contains every listing and the whole price log, so
passing only the newest file is enough.

## Notes

- Stars, hidden listings, compare picks and notes in the dashboard are saved in your browser, not in the files.
- Listing text is third-party data. The dashboard only ever inserts it as plain text, and the build step only parses it.
- The "fair price" is a benchmark (median of the other listings with the same bedroom count) unless the regression
  beats it out-of-sample; the Insights tab says which one is in use and why.
- Seller names and IDs are never collected.

## Disclaimer

This automates a logged-in browser session on Facebook Marketplace. Meta's Terms of Service (section 3.2) forbid
collecting data from its products by automated means without permission, and Facebook may throttle or restrict an
account that looks automated. The script is deliberately slow (random pauses, daily limit, 48 h cool-down after a
block) but that lowers the risk, it does not remove it. Use it on your own account, for personal use, at your own risk.
It never collects seller names or IDs. Scraped data stays in your browser and is not part of this repository.
