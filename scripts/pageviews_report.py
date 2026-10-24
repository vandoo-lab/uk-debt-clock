"""Daily page-view report for the UK Debt Clock, as a visual HTML page.

Reads a read-only Cloudflare API token (Account Analytics: Read) from the macOS Keychain,
queries Cloudflare Web Analytics and writes, in reports/:
  <date>.html   the visual report (also copied to latest.html)
  <date>.json   the figures behind it
  history.csv   one row per day

    python3 -I scripts/pageviews_report.py            # report on yesterday (UK time)
    python3 -I scripts/pageviews_report.py 2026-10-23 # report on a given day

The HTML contains a marker, <!-- ANALYST-NOTES -->, where the scheduled task adds its own
written recommendations after reading the JSON.
"""
import csv
import html
import json
import re
import shutil
import subprocess
import sys
import urllib.request
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ACCOUNT_ID = "9e898528f72cac98fbf0a901156256c0"
SITE_TAG = "df1d2609032d466fa1ac32249cbc7ffc"       # Web Analytics site: vandoo-lab.github.io
SITE_URL = "https://vandoo-lab.github.io/uk-debt-clock/"
KEYCHAIN_SERVICE = "uk-debt-clock-cf-analytics"
UK, UTC = ZoneInfo("Europe/London"), ZoneInfo("UTC")
ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "reports"
API = "https://api.cloudflare.com/client/v4/graphql"
TREND_DAYS = 14

# ---------------------------------------------------------------- Cloudflare


def token():
    out = subprocess.run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
                         capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"No Cloudflare token in Keychain (service '{KEYCHAIN_SERVICE}'). Run scripts/save_cf_key.sh.")
    return out.stdout.strip()


def iso(dt):
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def uk_bounds(first_day, last_day):
    return (datetime.combine(first_day, time.min, UK), datetime.combine(last_day + timedelta(days=1), time.min, UK))


def gql(tok, dataset, start, end, fields, limit=10, order=""):
    """One request per breakdown: Cloudflare silently drops parts that share a request.
    Filters stay flat: an AND list that includes bot:0 returns nothing."""
    q = ('query ($a: String!, $f: %sFilter_InputObject!) { viewer { accounts(filter: {accountTag: $a}) {'
         ' %s(filter: $f, limit: %d%s) { %s } } } }') % (
        "Account" + dataset[0].upper() + dataset[1:], dataset, limit, order, fields)
    variables = {"a": ACCOUNT_ID, "f": {"siteTag": SITE_TAG, "bot": 0, "datetime_geq": iso(start), "datetime_lt": iso(end)}}
    req = urllib.request.Request(API, data=json.dumps({"query": q, "variables": variables}).encode(),
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = json.load(r)
    if body.get("errors"):
        sys.exit("Cloudflare API error: " + "; ".join(e.get("message", "?") for e in body["errors"]))
    return body["data"]["viewer"]["accounts"][0][dataset]


def collect(tok, day):
    first = day - timedelta(days=TREND_DAYS - 1)
    t_start, t_end = uk_bounds(first, day)
    d_start, d_end = uk_bounds(day, day)
    w_start, _ = uk_bounds(day - timedelta(days=6), day)
    PL, PERF, WV = "rumPageloadEventsAdaptiveGroups", "rumPerformanceEventsAdaptiveGroups", "rumWebVitalsEventsAdaptiveGroups"
    top = ", orderBy: [count_DESC]"

    # Query one UK day at a time: over longer windows Cloudflare samples low traffic and
    # returns rough counts (multiples of 10), while single days come back exact.
    days = [first + timedelta(days=i) for i in range(TREND_DAYS)]
    trend = {d: {"views": 0, "visits": 0, "mobile": 0, "load_sum": 0.0, "load_n": 0} for d in days}
    hours = defaultdict(int)
    week_refs, week_countries = defaultdict(int), defaultdict(int)
    for d in days:
        s0, e0 = uk_bounds(d, d)
        for g in gql(tok, PL, s0, e0, "count sum { visits } dimensions { datetimeHour deviceType }", 1000):
            trend[d]["views"] += g["count"]
            trend[d]["visits"] += g["sum"]["visits"]
            if g["dimensions"]["deviceType"] == "mobile":
                trend[d]["mobile"] += g["count"]
            if d >= w_start.date():
                ts = datetime.fromisoformat(g["dimensions"]["datetimeHour"].replace("Z", "+00:00")).astimezone(UK)
                hours[ts.hour] += g["count"]
        if not trend[d]["views"]:
            continue
        for g in gql(tok, PERF, s0, e0, "count avg { pageLoadTime }", 1):
            if g["avg"]["pageLoadTime"]:
                trend[d]["load_sum"] += g["avg"]["pageLoadTime"] * g["count"]
                trend[d]["load_n"] += g["count"]
        if d >= w_start.date():
            for g in gql(tok, PL, s0, e0, "count dimensions { refererHost }", 50):
                week_refs[g["dimensions"]["refererHost"] or "Direct / no referrer"] += g["count"]
            for g in gql(tok, PL, s0, e0, "count dimensions { countryName }", 50):
                week_countries[g["dimensions"]["countryName"] or "Unknown"] += g["count"]
    top8 = lambda dd: sorted(dd.items(), key=lambda kv: -kv[1])[:8]

    def breakdown(dim, start, blank, limit=8):
        return [((g["dimensions"][dim] or blank), g["count"])
                for g in gql(tok, PL, start, d_end, f"count dimensions {{ {dim} }}", limit, top)]

    def vitals(start, end):
        rows = gql(tok, WV, start, end, "count quantiles { largestContentfulPaintP75 cumulativeLayoutShiftP75 interactionToNextPaintP75 }", 1)
        if not rows or not rows[0]["count"]:
            return None
        q = rows[0]["quantiles"]
        pos = lambda x: x is not None and x > 0
        return {"lcp_s": q["largestContentfulPaintP75"] / 1e6 if pos(q["largestContentfulPaintP75"]) else None,
                "cls": q["cumulativeLayoutShiftP75"] if q["cumulativeLayoutShiftP75"] is not None and q["cumulativeLayoutShiftP75"] >= 0 else None,
                "inp_ms": q["interactionToNextPaintP75"] / 1000 if pos(q["interactionToNextPaintP75"]) else None,
                "samples": rows[0]["count"]}

    return {
        "day": day.isoformat(),
        "trend": [{"date": d.isoformat(), "views": t["views"], "visits": t["visits"],
                   "mobile_pct": round(t["mobile"] / t["views"] * 100) if t["views"] else None,
                   "load_s": round(t["load_sum"] / t["load_n"] / 1e6, 2) if t["load_n"] else None} for d, t in trend.items()],
        "hours_7d": [hours.get(h, 0) for h in range(24)],
        "yesterday": {
            "referrers": breakdown("refererHost", d_start, "Direct / no referrer"),
            "countries": breakdown("countryName", d_start, "Unknown"),
            "devices": breakdown("deviceType", d_start, "Unknown", 5),
            "browsers": breakdown("userAgentBrowser", d_start, "Unknown", 6),
            "os": breakdown("userAgentOS", d_start, "Unknown", 6),
            "vitals": vitals(d_start, d_end),
        },
        "week": {
            "referrers": top8(week_refs),
            "countries": top8(week_countries),
            "vitals": vitals(w_start, d_end),
        },
    }

# ---------------------------------------------------------------- analysis


def summarise(data):
    tr = data["trend"]
    today, prev = tr[-1], tr[-2]
    s7 = sum(t["views"] for t in tr[-7:])
    sp7 = sum(t["views"] for t in tr[-14:-7])
    return {
        "views": today["views"], "visits": today["visits"], "prev_views": prev["views"],
        "avg7": s7 / 7, "week_views": s7, "prev_week_views": sp7,
        "week_change_pct": None if sp7 == 0 else (s7 - sp7) / sp7 * 100,
        "mobile_pct": today["mobile_pct"], "load_s": today["load_s"],
        "best_day": max(tr, key=lambda t: t["views"]),
        "peak_hour": max(range(24), key=lambda h: data["hours_7d"][h]) if any(data["hours_7d"]) else None,
    }


def next_events():
    """Upcoming dates worth timing promotion around, read from the site's data file."""
    m = re.search(r'"nextRelease":\s*"([^"]+)"', (ROOT / "data" / "data.js").read_text())
    return [("ONS public sector finances release", m.group(1))] if m else []


def recommendations(data, s):
    """Data-driven suggestions for growing the site's visibility and use."""
    recs = []
    refs = [r for r, _ in data["week"]["referrers"] if r != "Direct / no referrer"]
    if not refs:
        recs.append(("No other website sent visitors this week",
                     "Every visit came from people typing or opening the link directly. Publishing the launch drafts in notes/launch-drafts.md (Reddit, LinkedIn, Show HN) is the quickest way to get referral traffic you can measure here."))
    else:
        recs.append((f"{refs[0]} is your best source of visitors",
                     "Post there again with a fresh chart on the next data release, and reply to comments. Sites that already send traffic tend to send more."))
    if s["peak_hour"] is not None:
        h = s["peak_hour"]
        recs.append((f"Visitors arrive most around {h:02d}:00",
                     f"Over the last 7 days the busiest hour was {h:02d}:00–{(h + 1) % 24:02d}:00 UK time. Post or share about 30–60 minutes before then."))
    if s["mobile_pct"] is not None and s["mobile_pct"] >= 50:
        recs.append((f"{s['mobile_pct']}% of yesterday's views were on mobile",
                     "Most people read on a phone. Share to WhatsApp and social apps, and check the clock and charts read well on a small screen."))
    v = data["week"]["vitals"] or {}
    if v.get("lcp_s") and v["lcp_s"] > 2.5:
        recs.append((f"Main content takes {v['lcp_s']:.1f}s to appear for 1 in 4 visitors",
                     "Google treats over 2.5s as needing improvement, which can lower search ranking. Lighter charts, or loading them after the clock, would help."))
    if v.get("cls") and v["cls"] > 0.1:
        recs.append((f"The page shifts while loading (CLS {v['cls']:.2f})",
                     "Above 0.1 counts against the page in Google's ranking. Reserving space for live numbers fixes this."))
    if s["week_change_pct"] is not None and s["week_change_pct"] < -20:
        recs.append(("Traffic fell this week",
                     f"Views were down {abs(s['week_change_pct']):.0f}% on the week before. Re-share the most-viewed chart, or post a short update on the latest figures."))
    for name, when in next_events():
        recs.append((f"Next news hook: {name}, {when}",
                     "Interest in the national debt peaks on release days. The site updates itself then, so prepare a short post with the new headline figure for that morning."))
    recs.append(("Put the site in front of people who teach and explain this",
                 "A-level economics teachers (tutor2u, EBEA) and BBC More or Less are listed in notes/promotion-plan.md. One mention from them can bring steady traffic for months."))
    return recs

# ---------------------------------------------------------------- charts (inline SVG, no libraries)

BLUE, ORANGE, AQUA, VIOLET = "var(--s1)", "var(--s2)", "var(--s3)", "var(--s7)"


def esc(x):
    return html.escape(str(x))


def plural(n, word):
    return f"{n:,} {word}" + ("" if n == 1 else "s")


def bar_line_chart(trend, w=760, h=230):
    pad_l, pad_r, pad_t, pad_b = 40, 12, 18, 34
    n = len(trend)
    vals = [t["views"] for t in trend]
    avg = [sum(vals[max(0, i - 6):i + 1]) / len(vals[max(0, i - 6):i + 1]) for i in range(n)]
    top = max(max(vals), 1)
    step = 5 if top <= 25 else 10 if top <= 60 else 25 if top <= 150 else 50 if top <= 300 else 100
    ymax = ((top // step) + 1) * step
    cw = (w - pad_l - pad_r) / n
    y = lambda v: pad_t + (h - pad_t - pad_b) * (1 - v / ymax)
    out = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="Page views per day for the last {n} days">']
    for k in range(0, ymax + 1, step):
        out.append(f'<line x1="{pad_l}" x2="{w - pad_r}" y1="{y(k):.1f}" y2="{y(k):.1f}" class="grid"/>'
                   f'<text x="{pad_l - 6}" y="{y(k) + 4:.1f}" class="tick" text-anchor="end">{k}</text>')
    for i, t in enumerate(trend):
        x = pad_l + i * cw + cw * 0.18
        bw = cw * 0.64
        d = date.fromisoformat(t["date"])
        last = i == n - 1
        hh = max(y(0) - y(t["views"]), 0)
        out.append(f'<g><title>{d.strftime("%a %d %b")}: {t["views"]:,} views, {t["visits"]:,} visits</title>'
                   f'<rect x="{pad_l + i * cw:.1f}" y="{pad_t}" width="{cw:.1f}" height="{h - pad_t - pad_b}" fill="transparent"/>'
                   f'<rect x="{x:.1f}" y="{y(t["views"]):.1f}" width="{bw:.1f}" height="{hh:.1f}" rx="3" '
                   f'fill="{BLUE}" opacity="{1 if last else 0.55}"/></g>')
        if i % 2 == (n - 1) % 2:
            out.append(f'<text x="{x + bw / 2:.1f}" y="{h - 14}" class="tick" text-anchor="middle">{d.strftime("%d %b")}</text>')
        if last and t["views"]:
            out.append(f'<text x="{x + bw / 2:.1f}" y="{y(t["views"]) - 6:.1f}" class="val" text-anchor="middle">{t["views"]:,}</text>')
    pts = " ".join(f"{pad_l + i * cw + cw / 2:.1f},{y(a):.1f}" for i, a in enumerate(avg))
    out.append(f'<polyline points="{pts}" fill="none" stroke="{ORANGE}" stroke-width="2.5" stroke-linejoin="round" pointer-events="none"/>')
    out.append("</svg>")
    return "".join(out)


def line_chart(trend, key, label, unit, color, w=360, h=160, fmt="{:.1f}", cap=None):
    pts = [(i, t[key]) for i, t in enumerate(trend) if t[key] is not None]
    if not pts:
        return f'<p class="empty">No {label.lower()} data yet.</p>'
    pad_l, pad_r, pad_t, pad_b = 36, 10, 12, 26
    n = len(trend)
    hi = max(v for _, v in pts)
    ymax = cap if cap else (hi * 1.2 if hi else 1)
    x = lambda i: pad_l + (w - pad_l - pad_r) * (i / max(n - 1, 1))
    y = lambda v: pad_t + (h - pad_t - pad_b) * (1 - v / ymax)
    out = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="{esc(label)} per day">']
    for k in (0, ymax / 2, ymax):
        out.append(f'<line x1="{pad_l}" x2="{w - pad_r}" y1="{y(k):.1f}" y2="{y(k):.1f}" class="grid"/>'
                   f'<text x="{pad_l - 5}" y="{y(k) + 4:.1f}" class="tick" text-anchor="end">{fmt.format(k)}</text>')
    out.append(f'<polyline points="{" ".join(f"{x(i):.1f},{y(v):.1f}" for i, v in pts)}" fill="none" stroke="{color}" stroke-width="2.5" stroke-linejoin="round"/>')
    for i, v in pts:
        d = date.fromisoformat(trend[i]["date"]).strftime("%a %d %b")
        r = 5 if i == n - 1 else 3.5
        out.append(f'<circle cx="{x(i):.1f}" cy="{y(v):.1f}" r="{r}" fill="{color}" stroke="var(--surface)" stroke-width="2"><title>{d}: {fmt.format(v)}{unit}</title></circle>')
    first, last = date.fromisoformat(trend[0]["date"]), date.fromisoformat(trend[-1]["date"])
    out.append(f'<text x="{pad_l}" y="{h - 6}" class="tick">{first.strftime("%d %b")}</text>'
               f'<text x="{w - pad_r}" y="{h - 6}" class="tick" text-anchor="end">{last.strftime("%d %b")}</text></svg>')
    return "".join(out)


def hour_chart(hours, w=760, h=150):
    pad_l, pad_r, pad_t, pad_b = 12, 12, 12, 26
    top = max(max(hours), 1)
    cw = (w - pad_l - pad_r) / 24
    out = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="Page views by hour of day, last 7 days">']
    peak = hours.index(max(hours)) if any(hours) else -1
    for hr, v in enumerate(hours):
        bh = (h - pad_t - pad_b) * v / top
        out.append(f'<g><title>{hr:02d}:00–{(hr + 1) % 24:02d}:00: {v} views</title>'
                   f'<rect x="{pad_l + hr * cw:.1f}" y="{pad_t}" width="{cw:.1f}" height="{h - pad_t - pad_b}" fill="transparent"/>'
                   f'<rect x="{pad_l + hr * cw + 2:.1f}" y="{h - pad_b - bh:.1f}" width="{cw - 4:.1f}" height="{bh:.1f}" rx="2" fill="{AQUA}" opacity="{1 if hr == peak else 0.55}"/></g>')
        if hr % 3 == 0:
            out.append(f'<text x="{pad_l + hr * cw + cw / 2:.1f}" y="{h - 8}" class="tick" text-anchor="middle">{hr:02d}</text>')
    out.append("</svg>")
    return "".join(out)


def bars(rows, total, color=BLUE):
    if not rows:
        return '<p class="empty">No data.</p>'
    top = max(n for _, n in rows)
    li = []
    for name, n in rows:
        pct = f"{n / total * 100:.0f}%" if total else ""
        li.append(f'<li><span class="lbl" title="{esc(name)}">{esc(name)}</span><span class="track"><span class="fill" style="width:{n / top * 100:.0f}%;background:{color}"></span></span>'
                  f'<span class="num">{n:,}<small>{pct}</small></span></li>')
    return '<ul class="bars">' + "".join(li) + "</ul>"


def delta(now, before, better="up"):
    if before in (None, 0) or now is None:
        return '<span class="delta flat">no comparison yet</span>'
    pct = (now - before) / before * 100
    if round(pct) == 0:
        return '<span class="delta flat">● no change</span>'
    good = (pct > 0) == (better == "up")
    arrow = "▲" if pct > 0 else "▼"
    return f'<span class="delta {"good" if good else "bad"}">{arrow} {abs(pct):.0f}%</span>'


def sparkline(values, color, w=120, h=30):
    pts = [(i, v) for i, v in enumerate(values) if v is not None]
    if len(pts) < 2:
        return ""
    vals = [v for _, v in pts]
    lo, hi = min(vals), max(vals)
    rng = (hi - lo) or 1
    n = len(values)
    path = " ".join(f"{i / (n - 1) * (w - 4) + 2:.1f},{h - 3 - (v - lo) / rng * (h - 6):.1f}" for i, v in pts)
    return f'<svg class="spark" viewBox="0 0 {w} {h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="{path}" fill="none" stroke="{color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>'

# ---------------------------------------------------------------- page

CSS = """
:root{--bg:#f6f6f3;--surface:#fff;--ink:#0b0b0b;--ink2:#52514e;--muted:#6b6965;--grid:#e6e5df;--border:rgba(11,11,11,.1);
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s7:#6250d6;--good:#006300;--bad:#c13434;--accent:#d03b3b;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#9a988f;--grid:#2c2c2a;
--border:rgba(255,255,255,.1);--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s7:#9085e9;--good:#0ca30c;--bad:#ef6b6b;--accent:#ef6b6b;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:880px;margin:0 auto;padding-block:28px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
header{background:#000;color:#f5f5f3}header .wrap{padding-block:28px 56px}
.eyebrow{font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:#a8a6a0;font-weight:600;margin:0 0 6px}
h1{font-size:clamp(1.5rem,4vw,2.1rem);margin:0 0 4px;text-wrap:balance}header p{margin:0;color:#c3c2b7}header a{color:#ef6b6b}
h2{font-size:1.08rem;margin:0 0 4px;text-wrap:balance}.sub{color:var(--ink2);font-size:.88rem;margin:0 0 14px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:-64px 0 18px}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;min-width:0;display:flex;flex-direction:column;gap:2px}
.kpi .l{font-size:.78rem;color:var(--ink2)}.kpi .v{font-size:1.75rem;font-weight:750;line-height:1.15;font-variant-numeric:tabular-nums}
.kpi .spark{width:100%;height:28px;margin-top:6px}.kpi .vs{font-size:.75rem;color:var(--muted)}
.delta{font-size:.8rem;font-weight:650}.delta.good{color:var(--good)}.delta.bad{color:var(--bad)}.delta.flat{color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:16px;min-width:0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}.grid2 .card{margin:0}
svg{width:100%;height:auto;display:block}svg .grid{stroke:var(--grid);stroke-width:1}
svg .tick{font-size:11px;fill:var(--muted)}svg .val{font-size:12px;font-weight:700;fill:var(--ink)}
svg g:hover rect[fill^="var"],svg circle:hover{opacity:1!important;filter:brightness(1.1)}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:.82rem;color:var(--ink2);margin-bottom:6px}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.legend i.line{height:3px;border-radius:2px;vertical-align:3px}
ul.bars{list-style:none;margin:0;padding:0;display:grid;gap:8px}
ul.bars li{display:grid;grid-template-columns:minmax(80px,36%) 1fr auto;gap:10px;align-items:center;font-size:.86rem}
.lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track{height:10px;background:var(--grid);border-radius:5px;overflow:hidden}
.fill{display:block;height:100%;border-radius:5px}.num{font-variant-numeric:tabular-nums;font-weight:650;text-align:right;min-width:56px}
.num small{color:var(--muted);font-weight:400;margin-left:5px}
.vitals{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.vital{border-radius:10px;padding:12px;background:var(--bg);display:flex;flex-direction:column;gap:2px}
.vital b{font-size:1.3rem}.vital span{font-size:.8rem;color:var(--ink2)}
.pill{display:inline-block;font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:999px;margin-left:6px;vertical-align:3px}
.pill.ok{background:#0ca30c22;color:var(--good)}.pill.warn{background:#fab21933;color:#8a5f00}.pill.poor{background:#d03b3b22;color:var(--bad)}
@media (prefers-color-scheme:dark){.pill.warn{color:#fab219}}
ol.recs{margin:0;padding:0;list-style:none;counter-reset:r;display:grid;gap:12px}
ol.recs li{counter-increment:r;display:grid;grid-template-columns:28px 1fr;gap:12px}
ol.recs li::before{content:counter(r);width:26px;height:26px;border-radius:50%;background:var(--ink);color:var(--surface);display:grid;place-items:center;font-weight:700;font-size:.8rem}
ol.recs b{display:block}ol.recs span{color:var(--ink2);font-size:.9rem}
.notes{border-left:3px solid var(--accent);padding-left:14px;margin-top:18px}.notes:not(:has(*)){display:none}
.notes h3{font-size:.95rem;margin:0 0 6px}.notes ul{margin:0;padding-left:18px;color:var(--ink2);font-size:.9rem}
.empty{color:var(--muted);font-size:.9rem}footer{color:var(--muted);font-size:.8rem;padding-bottom:40px}
@media (max-width:720px){.kpis{grid-template-columns:repeat(2,1fr)}.grid2,.vitals{grid-template-columns:1fr}}
"""


def vital_cell(name, value, unit, good, poor, fmt):
    if value is None:
        return f'<div class="vital"><span>{name}</span><b>–</b><span>not enough data yet</span></div>'
    cls, word = ("ok", "Good") if value <= good else ("warn", "Needs work") if value <= poor else ("poor", "Poor")
    return (f'<div class="vital"><span>{name}</span><b>{fmt.format(value)}{unit}<span class="pill {cls}">{word}</span></b>'
            f'<span>Google’s target: {fmt.format(good)}{unit} or less</span></div>')


def render(data, s, recs):
    day = date.fromisoformat(data["day"])
    tr = data["trend"]
    y, wk = data["yesterday"], data["week"]
    v = wk["vitals"] or {}
    kpis = [
        ("Page views", f"{s['views']:,}", delta(s["views"], s["prev_views"]), "vs the day before", sparkline([t["views"] for t in tr[-7:]], BLUE)),
        ("Visits", f"{s['visits']:,}", delta(s["visits"], tr[-2]["visits"]), "vs the day before", sparkline([t["visits"] for t in tr[-7:]], ORANGE)),
        ("Last 7 days", f"{s['week_views']:,}", delta(s["week_views"], s["prev_week_views"]), "vs the 7 days before", sparkline([t["views"] for t in tr], BLUE)),
        ("Avg load time", f"{s['load_s']:.1f}s" if s["load_s"] else "–", delta(s["load_s"], tr[-2]["load_s"], better="down"),
         "vs the day before", sparkline([t["load_s"] for t in tr[-7:]], AQUA)),
    ]
    kpi_html = "".join(f'<div class="kpi"><span class="l">{l}</span><span class="v">{val}</span><span>{d} <span class="vs">{vs}</span></span>{sp}</div>'
                       for l, val, d, vs, sp in kpis)
    rec_html = "".join(f"<li><div><b>{esc(t)}</b><span>{esc(b)}</span></div></li>" for t, b in recs)
    best = s["best_day"]
    peak = f": {s['peak_hour']:02d}:00" if s["peak_hour"] is not None else ""
    samples = f" ({v['samples']} measurements)" if v.get("samples") else ""
    return f"""<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>UK Debt Clock report – {day.strftime('%d %b %Y')}</title><style>{CSS}</style></head>
<body>
<header><div class="wrap">
<p class="eyebrow">UK Debt Clock · daily visitor report</p>
<h1>{day.strftime('%A %d %B %Y')}</h1>
<p>{plural(s['views'], 'page view')} from {plural(s['visits'], 'visit')} · <a href="{SITE_URL}">{SITE_URL.replace('https://', '').rstrip('/')}</a></p>
</div></header>
<main class="wrap">
<div class="kpis">{kpi_html}</div>

<section class="card">
<h2>Page views, last {TREND_DAYS} days</h2>
<p class="sub">Yesterday is the solid bar. Best day in this period: {date.fromisoformat(best['date']).strftime('%a %d %b')}, with {best['views']:,} views. Hover over a bar for the figures.</p>
<div class="legend"><span><i style="background:var(--s1)"></i>Page views</span><span><i class="line" style="background:var(--s2)"></i>7-day average</span></div>
{bar_line_chart(tr)}
</section>

<div class="grid2">
<section class="card"><h2>Average load time</h2><p class="sub">Seconds for the page to finish loading, by day</p>
{line_chart(tr, 'load_s', 'Load time', 's', AQUA)}</section>
<section class="card"><h2>Mobile share</h2><p class="sub">Share of page views on phones, by day</p>
{line_chart(tr, 'mobile_pct', 'Mobile share', '%', VIOLET, fmt='{:.0f}', cap=100)}</section>
</div>

<section class="card"><h2>When people visit</h2>
<p class="sub">Page views by hour of day (UK time), last 7 days. The solid bar is the busiest hour{peak}.</p>
{hour_chart(data['hours_7d'])}</section>

<div class="grid2">
<section class="card"><h2>Where visitors came from</h2><p class="sub">Last 7 days</p>{bars(wk['referrers'], s['week_views'], ORANGE)}</section>
<section class="card"><h2>Countries</h2><p class="sub">Last 7 days, by country code</p>{bars(wk['countries'], s['week_views'])}</section>
<section class="card"><h2>Devices</h2><p class="sub">Yesterday</p>{bars(y['devices'], s['views'], VIOLET)}</section>
<section class="card"><h2>Operating systems</h2><p class="sub">Yesterday</p>{bars(y['os'], s['views'], AQUA)}</section>
</div>

<section class="card"><h2>Page experience (Core Web Vitals)</h2>
<p class="sub">What 3 in 4 visitors experienced over the last 7 days{samples}. Google uses these in search ranking.</p>
<div class="vitals">
{vital_cell('Main content appears (LCP)', v.get('lcp_s'), 's', 2.5, 4.0, '{:.1f}')}
{vital_cell('Layout stability (CLS)', v.get('cls'), '', 0.1, 0.25, '{:.2f}')}
{vital_cell('Response to taps (INP)', v.get('inp_ms'), 'ms', 200, 500, '{:.0f}')}
</div></section>

<section class="card" id="recs"><h2>How to grow the site's visibility and use</h2>
<p class="sub">Suggestions based on this data.</p>
<ol class="recs">{rec_html}</ol>
<div class="notes"><!-- ANALYST-NOTES --></div>
</section>

<footer>Source: Cloudflare Web Analytics, bots excluded. Days run midnight to midnight UK time. Visitors with ad blockers may not be counted. Generated {datetime.now(UK).strftime('%d %b %Y, %H:%M')}.</footer>
</main></body></html>"""


def main():
    day = date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else datetime.now(UK).date() - timedelta(days=1)
    data = collect(token(), day)
    s = summarise(data)
    recs = recommendations(data, s)
    data["summary"] = {k: v for k, v in s.items() if k != "best_day"}
    data["recommendations"] = [{"title": t, "detail": b} for t, b in recs]

    REPORTS.mkdir(exist_ok=True)
    page = REPORTS / f"{day.isoformat()}.html"
    page.write_text(render(data, s, recs))
    shutil.copyfile(page, REPORTS / "latest.html")
    (REPORTS / f"{day.isoformat()}.json").write_text(json.dumps(data, indent=1, default=str))

    hist = REPORTS / "history.csv"
    rows = {r["date"]: r for r in csv.DictReader(open(hist))} if hist.exists() else {}
    for t in data["trend"]:
        rows[t["date"]] = {"date": t["date"], "views": t["views"], "visits": t["visits"],
                           "mobile_pct": "" if t["mobile_pct"] is None else t["mobile_pct"],
                           "load_s": "" if t["load_s"] is None else t["load_s"]}
    with open(hist, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["date", "views", "visits", "mobile_pct", "load_s"])
        w.writeheader()
        w.writerows({k: r.get(k, "") for k in w.fieldnames} for _, r in sorted(rows.items()))

    ch = "no comparison yet" if not s["prev_views"] else f"{(s['views'] - s['prev_views']) / s['prev_views'] * 100:+.0f}% on the day before"
    print(f"{day.strftime('%a %d %b')}: {plural(s['views'], 'page view')}, {plural(s['visits'], 'visit')} ({ch}; "
          f"{s['week_views']:,} in the last 7 days). Report: {page}")


if __name__ == "__main__":
    main()
