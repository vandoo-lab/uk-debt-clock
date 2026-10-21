# UK Debt Clock

A single-page explainer of UK public debt, built only from official statistics.

A live clock of UK government gross debt, then four steps that build to a conclusion:

1. **The debt.** How big it is, where it came from, and your household's share.
2. **The cost.** The yearly interest bill and what that money could pay for instead.
3. **The drivers.** Spending against income, and welfare split into pensioner, health and disability, and other working-age benefits.
4. **The outlook.** The OBR forecast under current plans against the recent trend, and the risks to it.

## Run it

It is a static site. Locally, serve it from the project folder:

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

## Update the data

`scripts/build_data.py` downloads the source files into `data/raw/` and regenerates `data/data.js`.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

```bash
rm -f data/raw/ons_*.csv && .venv/bin/python -I scripts/build_data.py
```

### What updates automatically

The GitHub Action in `.github/workflows/refresh-data.yml` runs daily from the 19th to the 28th of each month, around the ONS public sector finances release. It rebuilds `data/data.js` and commits it when the figures change, and GitHub Pages then republishes the site. This keeps the latest net and gross debt, debt-to-GDP and the clock's starting point current. You can also run it by hand from the repository's Actions tab ("Refresh data", then "Run workflow").

### What needs a person

- **Each month:** the year-to-date borrowing against the OBR forecast (`YTD_VS_OBR` in `scripts/build_data.py`) comes from the text of the ONS bulletin. Update those numbers after each release.
- **After each Budget or fiscal event:** point the OBR databank and DWP benefit table URLs in `SOURCES` at the new editions, delete the old files from `data/raw/`, and run the script on your own computer so it downloads the new ones. Commit the new files: the OBR and DWP websites block GitHub's servers, so the monthly workflow uses the copies saved in the repository.
- **Each July:** update the PESA spending figures (`PESA_2025_26`) from the new PESA release.
- **When ONS publishes new population or household estimates:** update `POPULATION_MID_2025` and `HOUSEHOLDS_2025`.

## Hosting

The site is static and runs on GitHub Pages: Settings → Pages → Deploy from a branch → `main`, folder `/ (root)`. The empty `.nojekyll` file tells GitHub to serve the files as they are.

## Sources

- ONS Public sector finances, series HF6W, HF6X and BKPX
- OBR Public finances databank (September 2026) and Economic and fiscal outlook (March 2026)
- DWP Benefit expenditure and caseload tables 2026 (Spring Forecast 2026)
- HM Treasury PESA 2026, Table 5.2
- ONS mid-2025 population estimates and Families and households 2025
