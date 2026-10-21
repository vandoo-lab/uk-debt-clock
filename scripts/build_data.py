"""Build data/data.js from official UK government sources.

Downloads the source files into data/raw/ and extracts the figures used by the site.
Re-run whenever ONS, OBR or DWP publish new releases (update the URLs below first).

    python3 -m venv .venv && .venv/bin/pip install openpyxl
    .venv/bin/python -I scripts/build_data.py
"""
import csv
import json
import re
import urllib.request
from datetime import date
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "data.js"

ONS_SERIES = "https://www.ons.gov.uk/generator?format=csv&uri=/economy/governmentpublicsectorandtaxes/publicsectorfinance/timeseries/{}/pusf"
SOURCES = {
    "ons_psf": {
        "name": "ONS — Public sector finances, UK (latest monthly release)",
        "url": "https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance/bulletins/publicsectorfinances/latest",
    },
    "ons_hf6w": {
        "name": "ONS series HF6W — PS net debt (ex public sector banks), £bn",
        "url": "https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance/timeseries/hf6w/pusf",
    },
    "ons_bkpx": {
        "name": "ONS series BKPX — General government gross debt (Maastricht), £m",
        "url": "https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance/timeseries/bkpx/pusf",
    },
    "ons_hf6x": {
        "name": "ONS series HF6X — PS net debt (ex public sector banks), % of GDP",
        "url": "https://www.ons.gov.uk/economy/governmentpublicsectorandtaxes/publicsectorfinance/timeseries/hf6x/pusf",
    },
    "obr_databank": {
        "name": "OBR — Public finances databank, September 2026 (March 2026 EFO forecast)",
        "url": "https://obr.uk/data/",
        "file": "https://obr.uk/download/public-finances-databank-september-2026/",
    },
    "obr_efo": {
        "name": "OBR — Economic and fiscal outlook, March 2026",
        "url": "https://obr.uk/efo/economic-and-fiscal-outlook-march-2026/",
        "published": "2026-03-03",
    },
    "dwp_bec": {
        "name": "DWP — Benefit expenditure and caseload tables 2026 (Spring Forecast 2026)",
        "url": "https://www.gov.uk/government/publications/benefit-expenditure-and-caseload-tables-2026",
        "file": "https://assets.publishing.service.gov.uk/media/69dcdc8c6b695d635c34dcc4/outturn-and-forecast-tables-spring-forecast-2026.xlsx",
        "published": "2026-04-14",
    },
    "hmt_pesa": {
        "name": "HM Treasury — Public Expenditure Statistical Analyses (PESA) 2026, Table 5.2",
        "url": "https://www.gov.uk/government/collections/public-expenditure-statistical-analyses-pesa",
        "file": "https://assets.publishing.service.gov.uk/media/6a608addf869f6a53d0c89ef/PESA_2026_Accessible.pdf",
    },
    "ons_pop": {
        "name": "ONS — Population estimates for the UK: mid-2025",
        "url": "https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/populationestimates/bulletins/annualmidyearpopulationestimates/mid2025",
        "published": "2026-10-01",
    },
    "ons_households": {
        "name": "ONS — Families and households in the UK: 2025",
        "url": "https://www.ons.gov.uk/peoplepopulationandcommunity/birthsdeathsandmarriages/families/bulletins/familiesandhouseholds/2025",
    },
}

# Figures quoted from bulletins/PDFs rather than machine-readable files.
POPULATION_MID_2025 = 69_483_900          # ONS mid-2025, Table 1
HOUSEHOLDS_2025 = 29_000_000              # ONS Families and households 2025 ("29.0 million")
# PESA 2026 Table 5.2, 2025-26 outturn, £ million. Top-level functions only, so no area overlaps another.
# General public services excludes public debt transactions (130,305), which is where debt interest sits.
PESA_2025_26 = {
    "Welfare and social care": 407_270,        # 10. Social protection
    "Health": 257_542,                         # 7. Health
    "Education": 125_721,                      # 9. Education
    "Transport and economy": 93_959,           # 4. Economic affairs (transport 48,923)
    "Defence": 65_418,                         # 2. Defence
    "Police, courts and prisons": 55_720,      # 3. Public order and safety
    "Running government": 165_504 - 130_305,   # 1. General public services, excl. debt transactions
    "Housing and communities": 22_470,         # 6. Housing and community amenities
    "Environment": 19_157,                     # 5. Environment protection
    "Culture and sport": 15_053,               # 8. Recreation, culture and religion
}

# ONS Public sector finances, September 2026: financial year to date vs OBR March 2026 profile, £bn
YTD_VS_OBR = {
    "label": "April to September 2026",
    "months": 6,
    "borrowing": 97.8,
    "obrProfile": 91.8,
    "benefitsOvershoot": 2.5,   # net social benefits (incl. pensions) above forecast
    "interestOvershoot": 3.8,
    "benefitsGrowthPct": 6.8,   # net social benefits vs April-September 2025
}

FIRST_FORECAST_YEAR = 2026  # 2026-27 onwards is OBR forecast in the Sept 2026 databank


def fetch(url, name):
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / name
    if not path.exists():
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (debt-clock data build)"})
        with urllib.request.urlopen(req) as r, open(path, "wb") as f:
            f.write(r.read())
    return path


def ons_series(cdid):
    path = fetch(ONS_SERIES.format(cdid.lower()), f"ons_{cdid.lower()}.csv")
    rows = list(csv.reader(open(path, encoding="utf-8")))
    meta = {r[0]: r[1] for r in rows[:8] if len(r) > 1}
    monthly = [(r[0], float(r[1])) for r in rows if len(r) == 2 and re.fullmatch(r"\d{4} [A-Z]{3}", r[0]) and r[1]]
    return meta, monthly


def fy(y):
    return f"{y}-{str(y + 1)[2:]}"


def obr_databank():
    path = fetch(SOURCES["obr_databank"]["file"], "obr_public_finances_databank_sep2026.xlsx")
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)

    def sheet(name):
        rows = list(wb[name].iter_rows(values_only=True))
        hdr = next(r for r in rows if r[2] == "Public sector current receipts")
        cols = {str(h).rstrip("0123456789").strip(): i for i, h in enumerate(hdr) if h}
        out = {}
        for r in rows:
            if isinstance(r[1], str) and re.fullmatch(r"\d{4}-\d{2}", r[1]):
                out[int(r[1][:4])] = {k: (r[i] if isinstance(r[i], (int, float)) else None) for k, i in cols.items()}
        return out

    bn, pct = sheet("Aggregates (£bn)"), sheet("Aggregates (per cent of GDP)")
    series = []
    for y in range(1990, 2031):
        b, p = bn[y], pct[y]
        series.append({
            "year": fy(y),
            "forecast": y >= FIRST_FORECAST_YEAR,
            "receipts": round(b["Public sector current receipts"], 1),
            "spending": round(b["Total managed expenditure"], 1),
            "borrowing": round(b["Public sector net borrowing"], 1),
            "interest": round(b["Central government debt interest, net of APF"], 1),
            "debt": round(b["Public sector net debt"], 1),
            "gdp": round(b["Nominal GDP (£ billion)"], 1),
            "debtPct": round(p["Public sector net debt"], 1),
            "borrowingPct": round(p["Public sector net borrowing"], 1),
            "interestPct": round(p["Central government debt interest, net of APF"], 2),
            "spendingPct": round(p["Total managed expenditure"], 1),
            "receiptsPct": round(p["Public sector current receipts"], 1),
            "psnflPct": round(p["Public sector net financial liabilities"], 1) if p["Public sector net financial liabilities"] else None,
            "currentBudgetDeficit": round(b["Current budget deficit"], 1),
            "deflator": round(b["GDP Deflator (2025-26=100)"], 2),
            "grossDebt": round(b["General Government Gross Debt"], 1),
            "grossDebtPct": round(p["General Government Gross Debt"], 1),
        })

    rows = list(wb["Public finances since 1900"].iter_rows(values_only=True))
    longrun = [
        {"year": r[1], "debtPct": round(r[5], 1), "forecast": int(r[1][:4]) >= FIRST_FORECAST_YEAR}
        for r in rows
        if isinstance(r[1], str) and re.fullmatch(r"\d{4}-\d{2}", r[1]) and isinstance(r[5], (int, float))
    ]
    return series, longrun


def dwp_tables():
    path = fetch(SOURCES["dwp_bec"]["file"], "dwp_outturn_and_forecast_spring_2026.xlsx")
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)

    def blocks(name):
        """Return list of (label, {year: value}) in sheet order."""
        rows = list(wb[name].iter_rows(values_only=True))
        hdr = next(
            {i: int(c.strip()[:4]) for i, c in enumerate(r) if isinstance(c, str) and re.fullmatch(r"\d{4}/\d{2}", c.strip())}
            for r in rows
            if sum(bool(isinstance(c, str) and re.fullmatch(r"\d{4}/\d{2}", c.strip())) for c in r) > 5
        )
        out = []
        for r in rows:
            labs = [c for c in r if isinstance(c, str) and not re.fullmatch(r"\d{4}/\d{2}", c.strip())]
            if not labs:
                continue
            vals = {y: r[i] for i, y in hdr.items() if i < len(r) and isinstance(r[i], (int, float))}
            out.append((labs[0].strip().replace("\n", " "), vals))
        return out

    def first(name, label, scale=1.0, start=None):
        """First row matching label (optionally after a heading containing `start`)."""
        seen = start is None
        for lab, vals in blocks(name):
            if not seen and start in lab:
                seen = True
                continue
            if seen and lab.startswith(label) and vals:
                return vals
        raise KeyError(f"{name}: {label}")

    years = range(2010, 2031)

    def pack(vals, scale=1.0):
        return [round(vals.get(y, 0) * scale, 2) for y in years]

    m = 1 / 1000  # £m -> £bn
    welfare_total = first("UK welfare ", "Total (consistent with OBR")
    welfare_real = first("UK welfare ", "Total (consistent with OBR", start="real terms")
    groups = {g: first("Benefit summary table", g, start="consistent with current DWP coverage") for g in ("Pensioners", "Working age", "Children")}
    groups_real = {g: first("Benefit summary table", g, start="real terms, 2026/27 prices") for g in ("Pensioners", "Working age", "Children")}

    detail = {
        "State Pension": first("State Pension", "Total"),
        "Pension Credit": first("Pension Credit", "Total Pension Credit & predecessors"),
        "Attendance Allowance": first("Disability benefits", "Attendance Allowance"),
        "PIP": first("Disability benefits", "Personal Independence Payment"),
        "PIP (working age)": first("Disability benefits", "of which working age", start="Personal Independence Payment"),
        "PIP (pensioners)": first("Disability benefits", "of which pensioners", start="Personal Independence Payment"),
        "DLA": first("Disability benefits", "Disability Living Allowance"),
        "Universal Credit": first("Universal Credit and equivalent", "Universal Credit"),
        "UC health element": first("Universal Credit and equivalent", "of which Health Element"),
        "UC housing element": first("Universal Credit and equivalent", "of which Housing Element"),
        "UC child element": first("Universal Credit and equivalent", "of which Child Element"),
        "UC standard allowance": first("Universal Credit and equivalent", "of which Standard Allowance"),
        "Incapacity-related benefits": first("Incapacity benefits", "Total incapacity-related"),
        "Housing support (total)": first("Housing benefits", "Total"),
        "Housing Benefit (pensioners)": first("Housing benefits", "Housing Benefit over Pension Credit"),
        "Housing Benefit (working age)": first("Housing benefits", "Housing Benefit under Pension Credit"),
        "ESA": first("Universal Credit and equivalent", "Employment and Support Allowance"),
        "Carer's Allowance": first("Carers Allowance", "Total"),
        "Jobseeker's Allowance": first("Universal Credit and equivalent", "Jobseeker's Allowance"),
        "Tax credits": first("Universal Credit and equivalent", "Personal Tax Credits"),
    }
    caseload = {
        "State Pension": first("State Pension", "Total State Pension Caseload"),
    }
    child_benefit = first("UK welfare ", "Child Benefit")
    ni = first("UK welfare ", "Northern Ireland Social Security")

    return {
        "years": [fy(y) for y in years],
        "firstForecast": fy(FIRST_FORECAST_YEAR),
        "welfareTotal": pack(welfare_total),
        "welfareTotalReal": pack(welfare_real),
        "groups": {g: pack(v) for g, v in groups.items()},
        "groupsReal": {g: pack(v) for g, v in groups_real.items()},
        "detail": {k: pack(v, m) for k, v in detail.items()},
        "childBenefit": pack(child_benefit),
        "northernIreland": pack(ni),
        "statePensionCaseloadThousands": pack(caseload["State Pension"]),
    }


def main():
    hf6w_meta, hf6w = ons_series("HF6W")
    _, hf6x = ons_series("HF6X")
    _, bkpx = ons_series("BKPX")
    fiscal, longrun = obr_databank()
    welfare = dwp_tables()
    latest_label, latest_debt = hf6w[-1]
    SOURCES["ons_psf"]["published"] = hf6w_meta.get("Release date")
    data = {
        "built": date.today().isoformat(),
        "sources": SOURCES,
        "latest": {
            "label": latest_label.title(),
            "debtBn": latest_debt,
            "debtPct": hf6x[-1][1],
            "released": hf6w_meta.get("Release date"),
            "nextRelease": hf6w_meta.get("Next release"),
        },
        "latestGross": {"label": bkpx[-1][0].title(), "debtBn": round(bkpx[-1][1] / 1000, 1)},
        "monthlyDebt": [{"month": k.title(), "debt": v} for k, v in hf6w[-37:]],
        "ytd": YTD_VS_OBR,
        "population": POPULATION_MID_2025,
        "households": HOUSEHOLDS_2025,
        "fiscal": fiscal,
        "longRun": longrun,
        "pesa": {"year": "2025-26", "items": {k: round(v / 1000, 1) for k, v in PESA_2025_26.items()}},
        "welfare": welfare,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("// Generated by scripts/build_data.py — do not edit by hand.\nwindow.DEBT_DATA = " + json.dumps(data, indent=1) + ";\n")
    print(f"Wrote {OUT} — latest PSND {latest_label}: £{latest_debt}bn")


if __name__ == "__main__":
    main()
