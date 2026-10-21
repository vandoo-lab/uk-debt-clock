# Updating the UK Debt Clock

This is the checklist for the monthly scheduled update. A person can follow it too.

The live site is https://vandoo-lab.github.io/uk-debt-clock/. GitHub Pages publishes whatever is on `main`.

## Ground rules

- **Routine monthly ONS update:** publish straight to `main` once every check passes.
- **Anything else** (a new OBR forecast or Budget, new DWP benefit tables, a new PESA, new population or household estimates): prepare it on a branch called `update/<what>-<yyyy-mm-dd>`, push the branch, and **do not merge to `main`**. Tell the owner what changed and wait for their go-ahead.
- Never change the page's wording, layout or design during a data update. Never delete files or history.
- If a check fails, or a figure looks wrong, stop. Publish nothing and report what you found.

## 1. Start clean

```bash
cd "/Users/stephendoo/Documents/Claude/Projects/Debt clock"
git status --short          # must be empty; if not, stop and report
git pull --ff-only origin main
```

Pushing uses the repository's deploy key (`~/.ssh/uk_debt_clock_deploy`, set as `core.sshCommand` for this repository).

## 2. Is there a new ONS release?

Open the latest ONS bulletin: https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance/bulletins/publicsectorfinances/latest

Compare its reference month with `"latest": {"label": ...}` in `data/data.js`, and with `YTD_VS_OBR["label"]` in `scripts/build_data.py`. If both already match the bulletin, there is nothing to do: stop and say so.

## 3. Update the year-to-date figures from the bulletin

In `scripts/build_data.py`, update `YTD_VS_OBR` from the bulletin, for the financial year to date against the OBR forecast:

| Field | Bulletin figure |
|---|---|
| `label` | e.g. "April to October 2026" |
| `months` | months since April, inclusive |
| `borrowing` | public sector net borrowing, year to date, £bn |
| `obrProfile` | the OBR forecast for the same period, £bn |
| `benefitsOvershoot` | how far net social benefits (including pensions) are above the forecast, £bn |
| `interestOvershoot` | how far debt interest is above the forecast, £bn |
| `benefitsGrowthPct` | net social benefits growth on the same period last year, % |

Use only figures stated in the bulletin. If one isn't given, keep last month's value and say so in the report.

## 4. Rebuild the data

```bash
[ -x .venv/bin/python ] || (python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt)
rm -f data/raw/ons_*.csv
.venv/bin/python -I scripts/build_data.py
```

## 5. Check before publishing

- The script printed the new month, and its net debt (£bn) matches the bulletin.
- `data/data.js` parses, and `latestGross.debtBn` is close to the bulletin's general government gross debt.
- Net debt moved by less than £60bn from last month, and `debtPct` moved by less than 2 points. A bigger jump means something needs a closer look: stop and report.
- `git diff --stat` shows only `data/data.js` and `scripts/build_data.py`.
- Serve the folder with `python3 -m http.server 8765` and load the page. It should show no console errors, and the clock and the step headlines should show the new figures. Skip this check if no browser is available, and say so in the report.

## 6. Publish

```bash
git add data/data.js scripts/build_data.py
git commit -m "Monthly data update: ONS <Month YYYY> public sector finances"
git push origin main
```

GitHub Pages republishes within a couple of minutes. Check that https://vandoo-lab.github.io/uk-debt-clock/data/data.js shows the new month.

## 7. Look for non-routine updates

Check each source. If any has a newer edition than the one the site uses, prepare it on a branch and do **not** publish (see the ground rules):

| Source | Where to look | In use now |
|---|---|---|
| OBR forecast | https://obr.uk/data/ (public finances databank) and https://obr.uk/publications/ | March 2026 EFO, September 2026 databank |
| DWP benefit tables | https://www.gov.uk/government/collections/benefit-expenditure-and-caseload-tables | Spring Forecast 2026 |
| PESA | https://www.gov.uk/government/collections/public-expenditure-statistical-analyses-pesa | PESA 2026 |
| Population and households | ONS mid-year estimates; Families and households | mid-2025; 2025 |

For a new OBR or DWP edition:
1. Update the URLs in `SOURCES`.
2. Delete the old file in `data/raw/`, rerun the script on this Mac so it downloads the new file, and commit the new file. The OBR and DWP sites block GitHub's servers.
3. Check that every headline and conclusion figure still makes sense with the new numbers. List any sentence whose meaning changes.

## 8. Report

Say in a few lines what was published: the month, the new debt figure, debt-to-GDP and borrowing against the forecast. Also say what is waiting for approval on a branch, and anything you skipped or couldn't check.
