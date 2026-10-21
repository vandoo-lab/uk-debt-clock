"""Daily page-view report for the UK Debt Clock, from Cloudflare Web Analytics.

Reads a read-only Cloudflare API token (Account Analytics: Read) from the macOS Keychain,
queries the GraphQL Analytics API, and writes reports/<date>.md plus reports/history.csv.

    python3 -I scripts/pageviews_report.py            # report on yesterday (UK time)
    python3 -I scripts/pageviews_report.py 2026-10-21 # report on a given day
"""
import csv
import json
import subprocess
import sys
import urllib.request
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ACCOUNT_ID = "9e898528f72cac98fbf0a901156256c0"
SITE_TAG = "df1d2609032d466fa1ac32249cbc7ffc"       # Web Analytics site: vandoo-lab.github.io
SITE_URL = "https://vandoo-lab.github.io/uk-debt-clock/"
KEYCHAIN_SERVICE = "uk-debt-clock-cf-analytics"
UK = ZoneInfo("Europe/London")
ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "reports"
API = "https://api.cloudflare.com/client/v4/graphql"


def token():
    out = subprocess.run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
                         capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"No Cloudflare token in Keychain (service '{KEYCHAIN_SERVICE}').")
    return out.stdout.strip()


def utc_bounds(day):
    start = datetime.combine(day, time.min, UK)
    end = datetime.combine(day + timedelta(days=1), time.min, UK)
    fmt = lambda d: d.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")
    return fmt(start), fmt(end)


QUERY = """
query ($account: String!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
  viewer { accounts(filter: {accountTag: $account}) {
    rumPageloadEventsAdaptiveGroups(filter: $filter, limit: %(limit)d%(order)s) { %(fields)s }
  } }
}
"""
# One request per breakdown: Cloudflare silently drops some aliased parts when they share a request.
PARTS = {
    "total": (1, "", "count sum { visits }"),
    "referers": (10, ", orderBy: [count_DESC]", "count dimensions { refererHost }"),
    "countries": (10, ", orderBy: [count_DESC]", "count dimensions { countryName }"),
    "devices": (5, ", orderBy: [count_DESC]", "count dimensions { deviceType }"),
    "browsers": (5, ", orderBy: [count_DESC]", "count dimensions { userAgentBrowser }"),
}


def gql(tok, text, variables):
    req = urllib.request.Request(API, data=json.dumps({"query": text, "variables": variables}).encode(),
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = json.load(r)
    if body.get("errors"):
        sys.exit("Cloudflare API error: " + "; ".join(e.get("message", "?") for e in body["errors"]))
    return body["data"]["viewer"]["accounts"][0]["rumPageloadEventsAdaptiveGroups"]


def query(tok, day, parts=PARTS):
    start, end = utc_bounds(day)
    variables = {
        "account": ACCOUNT_ID,
        "filter": {"siteTag": SITE_TAG, "bot": 0, "datetime_geq": start, "datetime_lt": end},  # flat form: an AND list with bot returns nothing
    }
    acc = {k: gql(tok, QUERY % {"limit": lim, "order": order, "fields": fields}, variables)
           for k, (lim, order, fields) in parts.items()}
    total = acc["total"][0] if acc.get("total") else {"count": 0, "sum": {"visits": 0}}

    def rows(key, dim, blank):
        return [((g["dimensions"][dim] or blank), g["count"]) for g in acc.get(key, [])]

    return {
        "views": total["count"],
        "visits": total["sum"]["visits"],
        "referers": rows("referers", "refererHost", "Direct / none"),
        "countries": rows("countries", "countryName", "Unknown"),
        "devices": rows("devices", "deviceType", "Unknown"),
        "browsers": rows("browsers", "userAgentBrowser", "Unknown"),
    }


def change(now, before):
    if before == 0:
        return "no views the day before" if now else "same as the day before"
    pct = (now - before) / before * 100
    return f"{'up' if pct >= 0 else 'down'} {abs(pct):.0f}% on the day before ({before:,})"


def table(title, rows, total):
    if not rows:
        return f"### {title}\n\nNo data.\n"
    lines = [f"### {title}", "", "| | Views | Share |", "|---|---:|---:|"]
    lines += [f"| {name} | {n:,} | {n / total * 100:.0f}% |" if total else f"| {name} | {n:,} | – |" for name, n in rows]
    return "\n".join(lines) + "\n"


def main():
    day = date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else datetime.now(UK).date() - timedelta(days=1)
    tok = token()
    today = query(tok, day)
    week = [(day - timedelta(days=i), query(tok, day - timedelta(days=i), {"total": PARTS["total"]})["views"]) for i in range(1, 8)]
    prev = week[0][1]
    avg7 = sum(v for _, v in week) / 7

    REPORTS.mkdir(exist_ok=True)
    trend = " · ".join(f"{d.strftime('%a %d')}: {v:,}" for d, v in reversed(week)) + f" · **{day.strftime('%a %d')}: {today['views']:,}**"
    md = f"""# UK Debt Clock: page views for {day.strftime('%A %d %B %Y')}

{SITE_URL}

| | |
|---|---|
| **Page views** | **{today['views']:,}** ({change(today['views'], prev)}) |
| Visits | {today['visits']:,} |
| 7-day average | {avg7:,.0f} views a day |

**Last 8 days:** {trend}

{table('Where visitors came from', today['referers'], today['views'])}
{table('Countries (country code)', today['countries'], today['views'])}
{table('Devices', today['devices'], today['views'])}
{table('Browsers', today['browsers'], today['views'])}
_Source: Cloudflare Web Analytics, bots excluded. The day runs midnight to midnight UK time. Visitors with ad blockers may not be counted._
"""
    path = REPORTS / f"{day.isoformat()}.md"
    path.write_text(md)

    hist = REPORTS / "history.csv"
    rows = {}
    if hist.exists():
        rows = {r["date"]: r for r in csv.DictReader(open(hist))}
    rows[day.isoformat()] = {"date": day.isoformat(), "views": today["views"], "visits": today["visits"]}
    with open(hist, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["date", "views", "visits"])
        w.writeheader()
        w.writerows(rows[k] for k in sorted(rows))

    top_ref = next((n for n, _ in today["referers"] if n != "Direct / none"), None)
    print(f"{day.strftime('%a %d %b')}: {today['views']:,} page views, {today['visits']:,} visits "
          f"({change(today['views'], prev)}; 7-day average {avg7:,.0f})"
          + (f". Top referrer: {top_ref}" if top_ref else "") + f". Report: {path}")


if __name__ == "__main__":
    main()
