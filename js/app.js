/* UK Debt Clock — renders data/data.js (built by scripts/build_data.py). */
(() => {
  const D = window.DEBT_DATA;
  // The whole page uses gross debt (general government, Maastricht) so every figure matches the clock.
  const F = D.fiscal.map(r => ({ ...r, netDebt: r.debt, netDebtPct: r.debtPct, debt: r.grossDebt, debtPct: r.grossDebtPct }));
  const W = D.welfare;
  const byYear = Object.fromEntries(F.map(r => [r.year, r]));
  const LAST_OUTTURN = F.filter(r => !r.forecast).at(-1);
  const FIRST_FC = F.find(r => r.forecast);
  const LAST_FC = F.at(-1);
  const POP = D.population;
  const HH = D.households;

  // ---------- formatting ----------
  const gbp = (n, dp = 0) => '£' + n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const bn = (n, dp = 1) => '£' + n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp }) + 'bn';
  const tn = (n, dp = 2) => '£' + (n / 1000).toFixed(dp) + 'tn';
  const pct = (n, dp = 1) => n.toFixed(dp) + '%';
  const sbn = n => (n < 0 ? '−' : '+') + bn(Math.abs(n), 0);
  const $ = id => document.getElementById(id);
  // Colours come from the band (black or white section) the chart sits in.
  let scopeEl = document.documentElement;
  const css = name => getComputedStyle(scopeEl).getPropertyValue(name).trim();
  const inBand = (canvasId, fn) => (...args) => {
    const prev = scopeEl;
    scopeEl = document.getElementById(canvasId)?.closest('section') || document.documentElement;
    try { return fn(...args); } finally { scopeEl = prev; }
  };
  const alpha = (hex, a) => {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    return `rgba(${r},${g},${b},${a})`;
  };
  const real = (value, year, base = '2026-27') => value * byYear[base].deflator / byYear[year].deflator;

  function table(el, headers, rows) {
    $(el).innerHTML = '<div class="tbl-wrap"><table><thead><tr>' +
      headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') +
      '</tbody></table></div>';
  }

  // ---------- projections: OBR forecast plus extra borrowing ----------
  // Adds extra borrowing to the OBR path and charges interest on it at the OBR's effective rate.
  function project(extraFor) {
    let prevDebt = LAST_OUTTURN.debt, E = 0;
    return F.filter(r => r.forecast).map(r => {
      const extra = extraFor(r.year);
      const rate = r.interest / prevDebt;
      const extraInt = rate * (E + extra / 2);
      E += extra + extraInt;
      prevDebt = r.debt;
      return { year: r.year, extra, extraInt, E, debt: r.debt + E, debtPct: r.debtPct * (r.debt + E) / r.debt, interest: r.interest + extraInt, borrowing: r.borrowing + extra + extraInt, obr: r };
    });
  }

  // Recent trend: this year's overspend scaled to a full year, then welfare at its 2019-20 to latest-outturn real growth rate.
  const Y = D.ytd;
  const overspendFY = (Y.borrowing - Y.obrProfile) * 12 / Y.months;
  const TREND_FROM = '2019-20', TREND_TO = LAST_OUTTURN.year;
  const wi = y => W.years.indexOf(y);
  // Three groups that do not overlap: health and disability benefits are taken out of the other two.
  const dt = (k, y) => W.detail[k][wi(y)];
  const healthDisability = y => dt('PIP', y) + dt('Incapacity-related benefits', y);
  const WELFARE_GROUPS = {
    Pensioners: y => W.groups.Pensioners[wi(y)] - dt('PIP (pensioners)', y),
    'Health and disability': healthDisability,
    'Other working age': y => W.groups['Working age'][wi(y)] + Math.max(0, dt('Tax credits', y)) - dt('PIP (working age)', y) - dt('Incapacity-related benefits', y),
  };
  const GROUP_INFO = {
    Pensioners: { id: 'c-risk-pens', title: 'Pensioner benefits', note: 'State Pension, Pension Credit, Attendance Allowance and other pensioner benefits, excluding PIP' },
    'Health and disability': { id: 'c-risk-hd', title: 'Health and disability benefits', note: 'PIP for all ages plus incapacity-related benefits (Universal Credit health-related awards and ESA)' },
    'Other working age': { id: 'c-risk-wa', title: 'Other working-age benefits', note: 'Universal Credit and other working-age benefits, including tax credits, excluding health and disability benefits' },
  };
  const trendYears = +TREND_TO.slice(0, 4) - +TREND_FROM.slice(0, 4);
  const welfareTrend = Object.fromEntries(Object.entries(WELFARE_GROUPS).map(([g, f]) => {
    const rate = Math.pow(real(f(TREND_TO), TREND_TO) / real(f(TREND_FROM), TREND_FROM), 1 / trendYears) - 1;
    const obrRate = Math.pow(real(f(W.years.at(-1)), W.years.at(-1)) / real(f(TREND_TO), TREND_TO), 1 / (+W.years.at(-1).slice(0, 4) - +TREND_TO.slice(0, 4))) - 1;
    const trend = y => f(TREND_TO) * Math.pow(1 + rate, +y.slice(0, 4) - +TREND_TO.slice(0, 4)) * byYear[y].deflator / byYear[TREND_TO].deflator;
    return [g, { rate, obrRate, obr: f, trend, gap: y => trend(y) - f(y) }];
  }));
  const welfareGap = y => Object.values(welfareTrend).reduce((s, g) => s + g.gap(y), 0);
  const TREND = project(y => (y === FIRST_FC.year ? overspendFY : welfareGap(y)));

  // ---------- 1. debt clock ----------
  const [yy, mon] = D.latest.label.split(' ');
  const monthIdx = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(mon);
  const baseTime = new Date(+yy, monthIdx + 1, 1).getTime(); // end of reference month
  const YEAR_MS = 365.25 * 864e5;
  const monthName = new Date(+yy, monthIdx, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  // Live debt-to-GDP: GDP implied by the latest ONS net debt ratio, growing at the OBR's nominal GDP forecast for this year.
  const gdpGrowth = FIRST_FC.gdp / LAST_OUTTURN.gdp - 1;
  const gdpBase = D.latest.debtBn / (D.latest.debtPct / 100) * 1e9;
  const gdpNow = () => gdpBase * Math.pow(1 + gdpGrowth, (Date.now() - baseTime) / YEAR_MS);
  const overspendRise = TREND[0].debt - FIRST_FC.debt;          // this year's overspend so far, scaled to a full year

  // Two measures share one clock. Each rises at its OBR forecast rise for this year plus the overspend so far.
  const MEASURES = {
    net: {
      eyebrow: 'UK public sector net debt, estimated now',
      explain: 'Net debt is the ONS headline measure. It covers the whole public sector, including the Bank of England, and subtracts the cash and other liquid assets it holds.',
      name: 'net debt', baseBn: D.latest.debtBn, basePct: D.latest.debtPct, label: D.latest.label,
      obrRise: FIRST_FC.netDebt - LAST_OUTTURN.netDebt, yearEndPct: LAST_OUTTURN.netDebtPct,
    },
    gross: {
      eyebrow: 'UK general government gross debt, estimated now',
      explain: 'This is gross debt: everything central and local government owes, with no assets subtracted. It is the measure used for international comparisons by the EU and IMF. Every debt figure on this page uses it. The ONS headline measure, net debt, subtracts cash and other liquid assets and is about 94% of GDP.',
      name: 'gross debt', baseBn: D.latestGross.debtBn, basePct: D.latestGross.debtBn * 1e9 / gdpBase * 100, label: D.latestGross.label,
      obrRise: FIRST_FC.grossDebt - LAST_OUTTURN.grossDebt, yearEndPct: LAST_OUTTURN.grossDebtPct,
    },
  };
  Object.values(MEASURES).forEach(m => {
    m.rate = m.obrRise + overspendRise;
    m.perMs = m.rate * 1e9 / YEAR_MS;
    m.now = () => m.baseBn * 1e9 + (Date.now() - baseTime) * m.perMs;
  });
  const measure = MEASURES.gross;   // the clock and every debt figure on the page use gross debt
  const debtNow = () => measure.now();
  // British English number words, e.g. "three trillion, two hundred and forty-two billion ... pounds".
  const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];
  function under1000(n) {
    const h = Math.floor(n / 100), r = n % 100;
    const rest = r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? '-' + ONES[r % 10] : '');
    return [h ? ONES[h] + ' hundred' : '', rest].filter(Boolean).join(' and ');
  }
  function poundsInWords(n) {
    const groups = [];
    for (let i = 0; n > 0; i++, n = Math.floor(n / 1000)) groups.unshift([n % 1000, i]);
    const parts = groups.filter(([g]) => g).map(([g, i]) => under1000(g) + (SCALES[i] ? ' ' + SCALES[i] : ''));
    const last = groups.at(-1);
    if (parts.length > 1 && last[0] && last[0] < 100) parts[parts.length - 1] = 'and ' + parts.at(-1);
    const text = parts.join(', ') + ' pounds';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  const pp = n => `${n >= 0 ? '▲ +' : '▼ −'}${Math.abs(n).toFixed(3)} pts`;

  function describeMeasure() {
    const m = measure;
    $('clock-eyebrow').textContent = m.eyebrow;
    $('measure-explain').textContent = m.explain;
    $('clock-note').textContent =
      `The ONS put ${m.name} at ${tn(m.baseBn, 3)} at the end of ${monthName} (${pct(m.basePct)} of GDP${m === MEASURES.gross ? ', measured against the same GDP as the net figure' : ''}). ` +
      `The clock adds ${bn(m.rate)} a year (about ${gbp(m.perMs * 1000)} every second). That is the OBR's forecast rise of ${bn(m.obrRise)} for ${FIRST_FC.year}, plus this year's overspend against the forecast so far, scaled up to a full year. ` +
      `Next official update: ${D.latest.nextRelease}.`;
    $('gdp-race').textContent =
      `Debt is growing by about ${gbp(m.perMs * 1000)} a second. The economy is growing by about ${gbp(gdpBase * gdpGrowth / YEAR_MS * 1000)} a second ` +
      `(OBR forecast of ${(gdpGrowth * 100).toFixed(1)}% cash GDP growth in ${FIRST_FC.year}). Debt is growing faster than the economy, so the share keeps rising.`;
  }

  const tick = () => {
    const m = measure;
    const now = m.now();
    const r = now / gdpNow() * 100;
    $('clock').textContent = gbp(Math.round(now));
    $('clock-words').textContent = 'Over ' + poundsInWords(Math.floor(now / 1e9) * 1e9).replace(/^./, c => c.toLowerCase());  // whole billions, so it stays steady
    $('clock-gdp').textContent = r.toFixed(0) + '%';
    $('chip-month').innerHTML = `<b>${pp(r - m.basePct)}</b> since ONS ${monthName} figure (${pct(m.basePct)})`;
    $('chip-year').innerHTML = `<b>${pp(r - m.yearEndPct)}</b> since end of ${LAST_OUTTURN.year} (${pct(m.yearEndPct)})`;
    $('t-person').textContent = gbp(Math.round(now / POP));
    $('t-household').textContent = gbp(Math.round(now / HH));
    $('t-gdp').textContent = pct(r, 0);
  };
  describeMeasure();
  tick();
  setInterval(tick, 100);

  const interestNow = LAST_OUTTURN.interest;
  $('t-person-sub').textContent = `Debt ÷ ${(POP / 1e6).toFixed(2)}m people (ONS mid-2025)`;
  $('t-household-sub').textContent = `Debt ÷ ${(HH / 1e6).toFixed(1)}m households (ONS 2025)`;
  $('t-week').textContent = gbp(interestNow * 1e9 / HH / 52.18);
  $('t-week-sub').textContent = `${bn(interestNow)} interest in ${LAST_OUTTURN.year} = ${gbp(interestNow * 1e9 / HH)} a year`;
  $('t-gdp-sub').textContent = `Gross debt was ${pct(byYear['2007-08'].grossDebtPct)} before the 2008 financial crisis`;

  // ---------- household calculator ----------
  const hh = () => {
    const n = Math.max(1, Math.min(12, +$('hh-size').value || 1));
    const debt = debtNow() / POP * n;
    const intYr = interestNow * 1e9 / POP * n;
    $('hh-debt').textContent = gbp(Math.round(debt / 100) * 100);
    $('hh-int').textContent = gbp(Math.round(intYr));
    $('hh-month').textContent = gbp(Math.round(intYr / 12));
  };
  $('hh-size').addEventListener('input', hh);
  hh();

  // ---------- text that depends on data ----------
  const surplusYears = F.filter(r => !r.forecast && r.year >= '1990-91' && r.borrowing < 0).map(r => r.year);
  const welfare26 = W.welfareTotal[W.years.indexOf('2026-27')];
  const tme26 = byYear['2026-27'].spending;
  $('drivers-lede').textContent =
    `Debt rises whenever the government spends more than it raises. Since 1990-91 that has happened every year except ${surplusYears.join(' and ')}. ` +
    `Welfare is the largest single area of spending: ${bn(welfare26)} in 2026-27, about ${Math.round(welfare26 / tme26 * 100)}p of every £1 the state spends. More than half of it goes to pensioners.`;

  $('interest-sub').textContent =
    `Central government debt interest. In ${LAST_OUTTURN.year} it was ${bn(interestNow)}, or ${(interestNow / LAST_OUTTURN.receipts * 100).toFixed(1)}p of every £1 the government raised. ` +
    `Some of the 2022-23 spike came from high inflation pushing up payments on index-linked gilts. The OBR forecasts ${bn(LAST_FC.interest)} by ${LAST_FC.year}.`;

  // ---------- charts ----------
  Chart.defaults.font.family = css('--font') || 'system-ui';
  Chart.defaults.animation = false;
  const charts = {};
  const state = { debtUnit: 'bn', welfareUnit: 'nominal' };

  function baseOpts(fmt, extra = {}) {
    const ink2 = css('--ink-2'), grid = css('--grid'), axis = css('--axis'), muted = css('--muted');
    return Object.assign({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${c.dataset.label ? c.dataset.label + ': ' : ''}${fmt(c.parsed.y ?? c.parsed)}` } },
      },
      scales: {
        x: { grid: { display: false }, border: { color: axis }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12 } },
        y: { grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: v => fmt(v) }, beginAtZero: true },
      },
      color: ink2,
    }, extra);
  }
  const make = (id, cfg) => { charts[id]?.destroy(); charts[id] = new Chart($(id), cfg); };
  const fcColors = (rows, color) => rows.map(r => (r.forecast ? alpha(color, 0.35) : color));
  const short = y => y.slice(2, 5) + y.slice(5);  // 2025-26 -> 25-26

  function drawDebt() {
    const rows = F.filter(r => r.year >= '1990-91');
    const pctMode = state.debtUnit === 'pct';
    const s1 = css('--s1');
    make('c-debt', {
      type: 'bar',
      data: { labels: rows.map(r => r.year), datasets: [{ label: 'Gross debt', data: rows.map(r => (pctMode ? r.debtPct : r.debt)), backgroundColor: fcColors(rows, s1), borderRadius: 4, maxBarThickness: 22 }] },
      options: baseOpts(pctMode ? v => pct(v, 0) : v => (v >= 1000 ? tn(v, 1) : '£' + v + 'bn'), {
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          label: c => (pctMode ? pct(c.parsed.y) + ' of GDP' : tn(c.parsed.y)) + (rows[c.dataIndex].forecast ? ' (OBR forecast)' : ''),
        } } },
      }),
    });
  }

  function drawEras() {
    const eras = [
      ['Before the financial crisis', '1990-91', '2007-08'],
      ['Financial crisis and austerity', '2008-09', '2015-16'],
      ['Pre-Covid', '2016-17', '2019-20'],
      ['Covid', '2020-21', '2021-22'],
      ['Energy crisis to now', '2022-23', LAST_OUTTURN.year],
    ].map(([name, a, b]) => {
      const rs = F.filter(r => r.year >= a && r.year <= b);
      const total = rs.reduce((s, r) => s + r.borrowing, 0);
      return { name, range: `${a} to ${b}`, total, years: rs.length, perYear: total / rs.length };
    });
    // Stack today's debt: debt already owed before 1990-91, each period's borrowing, and other changes
    // (loans, asset sales, valuation effects) that make the total match the ONS debt figure.
    const first = byYear['1990-91'];
    const before = first.debt - first.borrowing;
    const borrowed = eras.reduce((s, e) => s + e.total, 0);
    const other = LAST_OUTTURN.debt - before - borrowed;
    const segs = [
      { name: 'Already owed', range: 'by March 1990', end: 'March 1990', value: before, note: 'gross debt at the end of March 1990' },
      ...eras.map(e => ({ name: e.name, range: e.range, end: e.range.split(' to ')[1], value: e.total, note: `borrowed ${e.range}, ${bn(e.perYear, 0)} a year` })),
      { name: 'Other changes', range: `to end of ${LAST_OUTTURN.year}`, end: LAST_OUTTURN.year, value: other, note: 'cash the government holds, loans, asset sales and other adjustments' },
    ].map(s => ({ ...s, kind: s.name === 'Already owed' || s.name === 'Other changes' ? 'other' : 'borrowed' }));
    // Waterfall: each period appears once, as a bar that starts where the previous one ended.
    let run = 0;
    const steps = segs.map(s => { const from = run; run += s.value; return { ...s, from, to: run }; });
    const total = { name: `Debt at end of ${LAST_OUTTURN.year}`, range: 'total', value: run, from: 0, to: run, kind: 'total', note: 'gross debt, ONS/OBR' };
    const rows = [...steps, total];
    const COLORS = { borrowed: css('--s2'), other: css('--muted'), total: css('--s1') };
    const ink = css('--ink');
    const valueLabels = {
      id: 'valueLabels',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        ctx.save();
        ctx.fillStyle = ink;
        ctx.font = `600 12px ${Chart.defaults.font.family}`;
        ctx.textBaseline = 'middle';
        chart.getDatasetMeta(0).data.forEach((bar, i) => {
          const r = rows[i];
          ctx.fillText(r.kind === 'total' ? tn(r.value) : (i === 0 ? '' : '+') + bn(r.value, 0), bar.x + 6, bar.y);
        });
        ctx.restore();
      },
    };
    make('c-eras', {
      type: 'bar',
      data: {
        labels: rows.map(r => (r.kind === 'total' ? [r.name] : [r.name, r.range])),
        datasets: [{ label: 'Debt', data: rows.map(r => [r.from, r.to]), backgroundColor: rows.map(r => COLORS[r.kind]), borderRadius: 4, borderSkipped: false, maxBarThickness: 26 }],
      },
      options: baseOpts(v => '£' + Math.round(v) + 'bn', {
        indexAxis: 'y',
        layout: { padding: { right: 8 } },
        interaction: { mode: 'nearest', intersect: true, axis: 'y' },
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: c => rows[c[0].dataIndex].name + (rows[c[0].dataIndex].kind === 'total' ? '' : ` (${rows[c[0].dataIndex].range})`),
          label: c => { const r = rows[c.dataIndex]; return r.kind === 'total' ? `${tn(r.value)} in total` : `Adds ${bn(r.value, 0)}, taking debt to ${tn(r.to)}`; },
          afterLabel: c => rows[c.dataIndex].note,
        } } },
        scales: {
          y: { grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--ink-2') } },
          x: { max: Math.ceil(run * 1.15 / 500) * 500, grid: { color: css('--grid') }, border: { display: false }, ticks: { color: css('--muted'), maxRotation: 0, autoSkipPadding: 10, callback: v => (v >= 1000 ? tn(v, 1) : '£' + v + 'bn') }, beginAtZero: true },
        },
      }),
      plugins: [valueLabels],
    });
    $('lg-eras').innerHTML = [['Borrowing in each period', COLORS.borrowed], ['Debt already owed, and other changes', COLORS.other], ['Total debt today', COLORS.total]]
      .map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('');
    $('eras-total').textContent = `Total: ${tn(LAST_OUTTURN.debt)} at the end of ${LAST_OUTTURN.year}. Borrowing since 1990-91 makes up ${Math.round(borrowed / LAST_OUTTURN.debt * 100)}% of it.`;
    table('tbl-eras', ['Part of today\'s debt', 'Years', '£bn', 'Share', 'Average per year'],
      segs.map((s, i) => {
        const e = eras[i - 1];
        return [`${s.name} (${s.range})`, e ? e.years : '–', s.value.toFixed(0), Math.round(s.value / LAST_OUTTURN.debt * 100) + '%', e ? bn(e.perYear, 0) : '–'];
      }));
  }

  function drawInterest() {
    const rows = F.filter(r => r.year >= '1990-91');
    make('c-interest', {
      type: 'bar',
      data: { labels: rows.map(r => r.year), datasets: [{ label: 'Debt interest', data: rows.map(r => r.interest), backgroundColor: fcColors(rows, css('--accent')), borderRadius: 4, maxBarThickness: 22 }] },
      options: baseOpts(v => '£' + v + 'bn', {
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          label: c => `${bn(c.parsed.y)} (${gbp(c.parsed.y * 1e9 / HH)} per household)` + (rows[c.dataIndex].forecast ? ', OBR forecast' : ''),
        } } },
      }),
    });
  }

  const PESA_NOTES = {
    'Welfare and social care': 'benefits, State Pension and adult and children\'s social care',
    'Health': 'NHS and other health services',
    'Education': 'nursery, schools, colleges and universities',
    'Transport and economy': 'roads, rail, energy, business support and R&D',
    'Defence': 'armed forces, military aid and defence R&D',
    'Police, courts and prisons': 'police, fire, courts and prisons',
    'Running government': 'tax collection, Parliament, foreign aid and admin',
    'Housing and communities': 'social housing, water and street lighting',
    'Environment': 'waste, pollution control and nature',
    'Culture and sport': 'museums, broadcasting, sport and libraries',
  };
  function drawOpp() {
    const P = D.pesa.items;
    const ints = byYear[D.pesa.year].interest;
    const all = [['Debt interest', ints], ...Object.entries(P)].sort((a, b) => b[1] - a[1]);
    const s1 = css('--s1'), acc = css('--accent');
    make('c-opp', {
      type: 'bar',
      data: { labels: all.map(a => a[0]), datasets: [{ label: D.pesa.year, data: all.map(a => a[1]), backgroundColor: all.map(a => (a[0] === 'Debt interest' ? acc : alpha(s1, 0.75))), borderRadius: 4, maxBarThickness: 26 }] },
      options: baseOpts(v => '£' + v + 'bn', {
        indexAxis: 'y',
        interaction: { mode: 'nearest', intersect: true, axis: 'y' },
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          label: c => all[c.dataIndex][0] === 'Debt interest' ? `${bn(c.parsed.x)} in ${D.pesa.year}` : `${bn(c.parsed.x)} in ${D.pesa.year}, ${(c.parsed.x / ints).toFixed(1)}× the interest bill`,
          afterLabel: c => PESA_NOTES[all[c.dataIndex][0]] || 'central government debt interest (OBR)',
        } } },
        scales: {
          y: { grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--ink-2') } },
          x: { grid: { color: css('--grid') }, border: { display: false }, ticks: { color: css('--muted'), maxRotation: 0, autoSkipPadding: 10, callback: v => '£' + v + 'bn' }, beginAtZero: true },
        },
      }),
    });
    const bigger = all.filter(a => a[1] > ints).map(a => a[0].toLowerCase());
    const list = bigger.length > 1 ? bigger.slice(0, -1).join(', ') + ' and ' + bigger.at(-1) : bigger[0];
    $('opp-sub').textContent =
      `Debt interest in ${D.pesa.year} (${bn(ints)}) compared with every main area of UK public spending that year, across all levels of government. ` +
      `Only ${list} cost more. Hover over a bar to see what it covers.`;
    $('opp-callouts').innerHTML = [
      [(ints / P['Defence']).toFixed(1) + '×', 'the entire defence budget'],
      [(ints / P['Police, courts and prisons']).toFixed(1) + '×', 'all spending on police, courts and prisons'],
      [Math.round(ints / P['Education'] * 100) + '%', 'of all education spending, from nursery to university'],
    ].map(([a, b]) => `<div><strong>${a}</strong><span>${b}</span></div>`).join('');
    table('tbl-opp', ['Area', 'What it covers', `${D.pesa.year} (£bn)`, 'vs interest'],
      all.map(([k, v]) => [k, PESA_NOTES[k] || 'central government debt interest (OBR)', v.toFixed(1), k === 'Debt interest' ? '–' : (v / ints).toFixed(1) + '×']));
  }

  function drawGap() {
    const rows = F.filter(r => r.year >= '1990-91');
    const dashFc = { borderDash: ctx => (rows[ctx.p1DataIndex]?.forecast ? [6, 4] : undefined) };
    const ds = (label, key, color) => ({ label, data: rows.map(r => r[key]), borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, segment: dashFc, tension: 0.2 });
    make('c-gap', {
      type: 'line',
      data: { labels: rows.map(r => r.year), datasets: [ds('Spending', 'spendingPct', css('--s2')), ds('Receipts', 'receiptsPct', css('--s1'))] },
      options: baseOpts(v => pct(v, 0), {
        plugins: { legend: { display: true, position: 'top', align: 'start', labels: { boxWidth: 12, boxHeight: 12, color: css('--ink-2') } },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${pct(c.parsed.y)} of GDP`, afterBody: it => `Borrowing: ${bn(rows[it[0].dataIndex].borrowing)}` } } },
        scales: { x: { grid: { display: false }, ticks: { color: css('--muted'), maxRotation: 0, autoSkipPadding: 12 } }, y: { min: 30, grid: { color: css('--grid') }, border: { display: false }, ticks: { color: css('--muted'), callback: v => v + '%' } } },
      }),
    });
    table('tbl-gap', ['Year', 'Spending £bn', 'Receipts £bn', 'Borrowing £bn', 'Spending % GDP', 'Receipts % GDP'],
      rows.map(r => [r.year + (r.forecast ? ' (f)' : ''), r.spending.toFixed(1), r.receipts.toFixed(1), r.borrowing.toFixed(1), pct(r.spendingPct), pct(r.receiptsPct)]));
  }

  const GROUPS = [['Pensioners', '--s1'], ['Working age', '--s2'], ['Children', '--s3'], ['Other UK welfare', '--s4']];
  function welfareSeries(realTerms) {
    const g = realTerms ? W.groupsReal : W.groups;
    const tot = realTerms ? W.welfareTotalReal : W.welfareTotal;
    const other = tot.map((t, i) => +(t - g.Pensioners[i] - g['Working age'][i] - g.Children[i]).toFixed(2));
    return { Pensioners: g.Pensioners, 'Working age': g['Working age'], Children: g.Children, 'Other UK welfare': other, total: tot };
  }
  function drawWelfare() {
    const realTerms = state.welfareUnit === 'real';
    const s = welfareSeries(realTerms);
    const idx = W.years.map((y, i) => i).filter(i => W.years[i] >= '2019-20' || s.total[i] > 0).filter(i => s.total[i] > 0);
    const fc = i => W.years[i] >= W.firstForecast;
    const surface = css('--surface');
    make('c-welfare', {
      type: 'bar',
      data: {
        labels: idx.map(i => W.years[i]),
        datasets: GROUPS.map(([name, v]) => ({
          label: name, data: idx.map(i => s[name][i]),
          backgroundColor: idx.map(i => (fc(i) ? alpha(css(v), 0.4) : css(v))),
          borderColor: surface, borderWidth: { top: 2 }, borderSkipped: false, maxBarThickness: 34,
        })),
      },
      options: baseOpts(v => '£' + v + 'bn', {
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          label: c => `${c.dataset.label}: ${bn(c.parsed.y)}`,
          footer: it => `Total: ${bn(s.total[idx[it[0].dataIndex]])}` + (fc(idx[it[0].dataIndex]) ? ' (forecast)' : '') + (realTerms ? ', 2026-27 prices' : ''),
        } } },
        scales: { x: { stacked: true, grid: { display: false }, ticks: { color: css('--muted'), maxRotation: 0, autoSkipPadding: 10 } }, y: { stacked: true, grid: { color: css('--grid') }, border: { display: false }, ticks: { color: css('--muted'), callback: v => '£' + v + 'bn' } } },
      }),
    });
    $('lg-welfare').innerHTML = GROUPS.map(([n, v]) => `<span><i style="background:${css(v)}"></i>${n}</span>`).join('') + '<span><i style="background:' + alpha(css('--ink-2'), 0.3) + '"></i>Forecast</span>';
    table('tbl-welfare', ['Year', ...GROUPS.map(g => g[0] + ' £bn'), 'Total £bn'],
      idx.map(i => [W.years[i] + (fc(i) ? ' (f)' : ''), ...GROUPS.map(([n]) => s[n][i].toFixed(1)), s.total[i].toFixed(1)]));
  }

  function breakdownChart(id, items, color, tblId) {
    make(id, {
      type: 'bar',
      data: { labels: items.map(i => i[0]), datasets: [{ label: '2026-27', data: items.map(i => +i[1].toFixed(1)), backgroundColor: color, borderRadius: 4, maxBarThickness: 26 }] },
      options: baseOpts(v => '£' + v + 'bn', {
        indexAxis: 'y',
        interaction: { mode: 'nearest', intersect: true, axis: 'y' },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${bn(c.parsed.x)} (${gbp(c.parsed.x * 1e9 / HH)} per household)` } } },
        scales: {
          y: { grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--ink-2') } },
          x: { grid: { color: css('--grid') }, border: { display: false }, ticks: { color: css('--muted'), maxRotation: 0, autoSkipPadding: 10, callback: v => '£' + v + 'bn' }, beginAtZero: true },
        },
      }),
    });
    table(tblId, ['Benefit', '2026-27 £bn'], items.map(([k, v]) => [k, v.toFixed(2)]));
  }

  function drawBreakdowns() {
    const i = W.years.indexOf('2026-27');
    const d = k => W.detail[k][i];
    const pensTotal = W.groups.Pensioners[i];
    const pens = [['State Pension', d('State Pension')], ['Attendance Allowance', d('Attendance Allowance')], ['Housing Benefit', d('Housing Benefit (pensioners)')], ['Pension Credit', d('Pension Credit')], ['PIP', d('PIP (pensioners)')]];
    pens.push(['Other pensioner benefits', pensTotal - pens.reduce((s, x) => s + x[1], 0)]);
    breakdownChart('c-pens', pens, css('--s1'), 'tbl-pens');
    const sp19 = W.detail['State Pension'][W.years.indexOf('2019-20')];
    const cl = W.statePensionCaseloadThousands;
    $('pens-sub').textContent =
      `${bn(pensTotal)} in 2026-27, ${gbp(pensTotal * 1e9 / HH)} per household. The State Pension alone is ${bn(d('State Pension'))}, up from ${bn(sp19)} in 2019-20. ` +
      `That is driven mainly by the triple lock uprating, with ${(cl[i] / 1000).toFixed(1)}m recipients.`;

    const waTotal = W.groups['Working age'][i] + W.groups.Children[i];
    const wa = [['Universal Credit', d('Universal Credit')], ['PIP', d('PIP (working age)')], ['ESA', d('ESA')], ['Housing Benefit', d('Housing Benefit (working age)')], ["Carer's Allowance", d("Carer's Allowance")]];
    wa.push(['Other (incl. child DLA)', waTotal - wa.reduce((s, x) => s + x[1], 0)]);
    breakdownChart('c-wa', wa, css('--s2'), 'tbl-wa');
    $('wa-sub').textContent =
      `${bn(waTotal)} in 2026-27. Universal Credit (${bn(d('Universal Credit'))}) is made up of the standard allowance ${bn(d('UC standard allowance'))}, housing ${bn(d('UC housing element'))}, ` +
      `children ${bn(d('UC child element'))} and health ${bn(d('UC health element'))}. Total incapacity-related support is ${bn(d('Incapacity-related benefits'))}.`;

    // welfare tiles
    $('welfare-tiles').innerHTML = [
      ['Welfare per household, 2026-27', gbp(W.welfareTotal[i] * 1e9 / HH), `${bn(W.welfareTotal[i])} in total`],
      ['Pensioner share of DWP benefits', Math.round(pensTotal / (pensTotal + waTotal) * 100) + '%', `${bn(pensTotal)} to pensioners`],
      ['Forecast welfare bill, ' + W.years.at(-1), bn(W.welfareTotal.at(-1), 0), `Up ${bn(W.welfareTotal.at(-1) - W.welfareTotal[i], 0)} from 2026-27`],
    ].map(([a, b, c]) => `<div class="tile"><span class="tile-label">${a}</span><span class="tile-value">${b}</span><span class="tile-sub">${c}</span></div>`).join('');
  }

  function drawGrowth() {
    const a = '2019-20', b = '2026-27';
    const ia = W.years.indexOf(a), ib = W.years.indexOf(b);
    const det = k => [W.detail[k][ia], W.detail[k][ib]];
    const rows = [
      ['Total UK welfare', [W.welfareTotal[ia], W.welfareTotal[ib]]],
      ['Pensioner benefits', [W.groups.Pensioners[ia], W.groups.Pensioners[ib]]],
      ['  State Pension', det('State Pension')],
      ['Working-age benefits', [W.groups['Working age'][ia], W.groups['Working age'][ib]]],
      ['  PIP (disability, all ages)', det('PIP')],
      ['  Incapacity-related benefits', det('Incapacity-related benefits')],
      ['  Housing support', det('Housing support (total)')],
      ['Debt interest', [byYear[a].interest, byYear[b].interest]],
      ['All public spending (TME)', [byYear[a].spending, byYear[b].spending]],
    ].map(([k, [x, y]]) => {
      const rx = real(x, a), g = (y / rx - 1) * 100;
      return { k, rx, y, g };
    });
    $('growth-table').innerHTML = '<div class="tbl-wrap"><table><thead><tr><th>Area</th><th>2019-20 (£bn, today\'s prices)</th><th>2026-27 (£bn)</th><th>Real growth</th></tr></thead><tbody>' +
      rows.map(r => `<tr><td>${r.k.replace(/^ {2}/, '&nbsp;&nbsp;↳ ')}</td><td>${r.rx.toFixed(1)}</td><td>${r.y.toFixed(1)}</td><td class="${r.g > 15 ? 'up' : ''}">${r.g >= 0 ? '+' : ''}${r.g.toFixed(0)}%</td></tr>`).join('') +
      '</tbody></table></div>';
    $('growth-note').textContent = `2026-27 figures are forecasts. Real growth uses the OBR GDP deflator (${a} = ${byYear[a].deflator}, ${b} = ${byYear[b].deflator}). ` +
      'Universal Credit is not shown separately because it replaced older benefits over this period. Its growth mostly reflects people moving across, not new spending.';
  }

  function drawForecast() {
    const rows = F.filter(r => r.year >= '2015-16');
    const ink = css('--ink-2'), obrC = css('--s1'), trC = css('--s2');
    const tByYear = Object.fromEntries(TREND.map(p => [p.year, p]));
    const line = (label, color, data, dash) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, borderDash: dash, pointRadius: 0, pointHoverRadius: 4, tension: 0.2, spanGaps: false });
    make('c-fc', {
      type: 'line',
      data: { labels: rows.map(r => r.year), datasets: [
        line('Outturn', ink, rows.map(r => (r.forecast ? null : r.debtPct))),
        line('OBR forecast', obrC, rows.map(r => (r.year === LAST_OUTTURN.year ? r.debtPct : r.forecast ? r.debtPct : null)), [6, 4]),
        line('Recent trend', trC, rows.map(r => (r.year === LAST_OUTTURN.year ? r.debtPct : tByYear[r.year] ? tByYear[r.year].debtPct : null)), [3, 3]),
      ] },
      options: baseOpts(v => pct(v, 0), { scales: { x: { grid: { display: false }, ticks: { color: css('--muted'), maxRotation: 0, autoSkipPadding: 10 } }, y: { beginAtZero: false, grid: { color: css('--grid') }, border: { display: false }, ticks: { color: css('--muted'), callback: v => pct(v, 0) } } },
        plugins: { legend: { display: false }, tooltip: { filter: c => c.parsed.y !== null, callbacks: {
        label: c => {
          const y = rows[c.dataIndex].year, t = tByYear[y];
          const debt = c.datasetIndex === 2 && t ? t.debt : rows[c.dataIndex].debt;
          return `${c.dataset.label}: ${pct(c.parsed.y)} of GDP (${tn(debt)})`;
        },
      } } } }),
    });
    $('lg-fc').innerHTML = [['Outturn', ink, ''], ['OBR forecast', obrC, 'dash'], ['Recent trend', trC, 'dash']]
      .map(([n, c, d]) => `<span><i class="line ${d}" style="border-color:${c}"></i>${n}</span>`).join('');
    const fcRows = F.filter(r => r.year >= '2019-20');
    const tRow = Object.fromEntries(TREND.map(p => [p.year, p]));
    table('tbl-fc', ['Year', 'Gross debt £bn', '% GDP', 'Borrowing £bn', 'Interest £bn', 'Trend: debt £bn', 'Trend: % GDP', 'Trend: interest £bn'],
      fcRows.map(r => { const t = tRow[r.year]; return [r.year + (r.forecast ? ' (f)' : ''), r.debt.toFixed(1), pct(r.debtPct), r.borrowing.toFixed(1), r.interest.toFixed(1), t ? t.debt.toFixed(1) : '–', t ? pct(t.debtPct) : '–', t ? t.interest.toFixed(1) : '–']; }));
    table('tbl-debt', ['Year', 'Gross debt £bn', '% of GDP', 'Per person', 'Per household'],
      F.filter(r => r.year >= '1990-91').map(r => [r.year + (r.forecast ? ' (f)' : ''), r.debt.toFixed(1), pct(r.debtPct), gbp(r.debt * 1e9 / POP), gbp(r.debt * 1e9 / HH)]));
    table('tbl-interest', ['Year', 'Interest £bn', '% of GDP', 'Per household', 'Pence per £1 of receipts'],
      F.filter(r => r.year >= '1990-91').map(r => [r.year + (r.forecast ? ' (f)' : ''), r.interest.toFixed(1), pct(r.interestPct, 2), gbp(r.interest * 1e9 / HH), (r.interest / r.receipts * 100).toFixed(1) + 'p']));

    $('fc-lede').textContent =
      `The OBR's March 2026 forecast is based on the government's current tax and spending plans. It has borrowing falling from ${bn(LAST_OUTTURN.borrowing)} in ${LAST_OUTTURN.year} to ${bn(LAST_FC.borrowing)} in ${LAST_FC.year}. ` +
      `But borrowing stays above zero, so the debt keeps growing in cash terms, to ${tn(LAST_FC.debt)}. And the interest bill rises to ${bn(LAST_FC.interest)} a year.`;
    const peak = F.filter(r => r.forecast).reduce((m, r) => (r.debtPct > m.debtPct ? r : m));
    $('fc-tiles').innerHTML = [
      [`Debt in ${LAST_FC.year}`, tn(LAST_FC.debt), `+${bn(LAST_FC.debt - LAST_OUTTURN.debt, 0)} on ${LAST_OUTTURN.year}`],
      ['Debt-to-GDP peak', pct(peak.debtPct), `in ${peak.year}, then ${pct(LAST_FC.debtPct)} by ${LAST_FC.year}`],
      [`Interest in ${LAST_FC.year}`, bn(LAST_FC.interest, 0), `${gbp(LAST_FC.interest * 1e9 / HH)} per household*`],
      [`Debt per household, ${LAST_FC.year}`, gbp(Math.round(LAST_FC.debt * 1e9 / HH / 100) * 100), '*at today\'s household count'],
    ].map(([a, b, c]) => `<div class="tile"><span class="tile-label">${a}</span><span class="tile-value">${b}</span><span class="tile-sub">${c}</span></div>`).join('');

  }

  function drawRisks() {
    const end = TREND.at(-1), last = W.years.at(-1);
    const G = welfareTrend;
    const hd = G['Health and disability'];
    const rateTxt = g => `${(G[g].obrRate * 100).toFixed(1)}% a year in the OBR forecast, against ${(G[g].rate * 100).toFixed(1)}% a year from ${TREND_FROM} to ${TREND_TO}`;
    $('risk-sub').textContent =
      `The OBR forecast already includes welfare. The question is whether it grows as slowly as the OBR assumes. ` +
      `Growth above inflation: pensioner benefits ${rateTxt('Pensioners')}. Other working-age benefits ${rateTxt('Other working age')}. ` +
      `Health and disability benefits ${rateTxt('Health and disability')}, which is the biggest gap.`;
    $('risk-tiles').innerHTML = [
      ['Borrowing so far this year', bn(Y.borrowing), `${Y.label}, ${bn(Y.borrowing - Y.obrProfile)} above the OBR forecast`],
      ["Benefits' share of the overspend", bn(Y.benefitsOvershoot), `benefit spending up ${Y.benefitsGrowthPct}% on a year earlier`],
      [`Health and disability in ${last}`, bn(hd.trend(last), 0), `on trend, against ${bn(hd.obr(last), 0)} in the OBR forecast (${sbn(hd.gap(last))})`],
      [`Debt in ${end.year} on trend`, tn(end.debt), `${bn(end.E, 0)} more than the OBR; interest ${bn(end.interest, 0)}`],
    ].map(([a, b, c]) => `<div class="tile"><span class="tile-label">${a}</span><span class="tile-value">${b}</span><span class="tile-sub">${c}</span></div>`).join('');

    const yrs = W.years.filter(y => y >= TREND_FROM);
    const ink = css('--ink-2'), obrC = css('--s1'), trC = css('--s2');
    const series = g => [
      { label: 'Outturn', data: yrs.map(y => (y <= TREND_TO ? G[g].obr(y) : null)), borderColor: ink, backgroundColor: ink },
      { label: 'OBR forecast', data: yrs.map(y => (y >= TREND_TO ? G[g].obr(y) : null)), borderColor: obrC, backgroundColor: obrC, borderDash: [6, 4] },
      { label: 'Recent trend', data: yrs.map(y => (y === TREND_TO ? G[g].obr(y) : y > TREND_TO ? G[g].trend(y) : null)), borderColor: trC, backgroundColor: trC, borderDash: [3, 3] },
    ].map(d => ({ ...d, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 }));
    const opts = () => baseOpts(v => '£' + v + 'bn', {
      plugins: { legend: { display: false }, tooltip: { filter: c => c.parsed.y !== null, callbacks: { label: c => `${c.dataset.label}: ${bn(c.parsed.y)}` } } },
      scales: { x: { grid: { display: false }, ticks: { color: css('--muted'), maxRotation: 0, autoSkipPadding: 10 } }, y: { beginAtZero: false, grid: { color: css('--grid') }, border: { display: false }, ticks: { color: css('--muted'), callback: v => '£' + v + 'bn' } } },
    });
    Object.entries(GROUP_INFO).forEach(([g, info]) => make(info.id, { type: 'line', data: { labels: yrs, datasets: series(g) }, options: opts() }));
    $('lg-risk').innerHTML = [['Outturn', ink, ''], ['OBR forecast', obrC, 'dash'], ['Recent trend', trC, 'dash']]
      .map(([n, c, d]) => `<span><i class="line ${d}" style="border-color:${c}"></i>${n}</span>`).join('');
    const groups = Object.keys(GROUP_INFO);
    table('tbl-risk', ['Year', ...groups.flatMap(g => [`${GROUP_INFO[g].title}: OBR £bn`, 'Trend £bn']), 'Extra borrowing on trend £bn'],
      TREND.map(p => [p.year, ...groups.flatMap(g => [G[g].obr(p.year).toFixed(1), G[g].trend(p.year).toFixed(1)]),
        p.extra.toFixed(1) + (p.year === FIRST_FC.year ? ' (this year\'s overspend)' : '')]));
    $('risk-method').textContent =
      `How the recent trend is calculated: for ${FIRST_FC.year}, the ${bn(Y.borrowing - Y.obrProfile)} overspend in ${Y.label} is scaled to a full year (${bn(overspendFY)}). ` +
      `From ${TREND[1].year}, each of the three benefit groups grows at its ${TREND_FROM} to ${TREND_TO} rate above inflation, and the difference from the OBR forecast is added to borrowing. ` +
      `The groups do not overlap. ${groups.map(g => `${GROUP_INFO[g].title}: ${GROUP_INFO[g].note}.`).join(' ')} ` +
      `Interest on the extra debt uses the OBR forecast's effective interest rate. Taxes, other spending and interest rates follow the OBR forecast. ` +
      `This is an illustration, not an official forecast. The ${TREND_FROM} start point includes the Covid years. Benefit figures are for Great Britain (DWP).`;
  }

  // ---------- the storyline: step headlines, takeaways, roadmap and conclusion ----------
  function drawStory() {
    const debtBn = measure.now() / 1e9;
    const ratio = measure.now() / gdpNow() * 100;
    const perHH = measure.now() / HH;
    const intWeek = interestNow * 1e9 / HH / 52.18;
    const P = D.pesa.items;
    const bigger = Object.entries(P).filter(([, v]) => v > interestNow).length;
    const ordinal = ['largest', 'second-largest', 'third-largest', 'fourth-largest', 'fifth-largest'][bigger];
    const borrowYears = F.filter(r => !r.forecast && r.year >= '1990-91').length - surplusYears.length;
    const i26 = W.years.indexOf('2026-27');
    const pens = W.groups.Pensioners[i26], dwpTotal = W.groups.Pensioners[i26] + W.groups['Working age'][i26] + W.groups.Children[i26];
    const hd = welfareTrend['Health and disability'];
    const peak = F.filter(r => r.forecast).reduce((m, r) => (r.debtPct > m.debtPct ? r : m));
    const trendEnd = TREND.at(-1);
    const defenceX = (interestNow / P['Defence']).toFixed(1);

    const steps = [
      { id: 'step-debt', label: 'The debt', q: 'How big is the debt?',
        head: `Debt is ${tn(debtBn)}, now bigger than the whole economy`,
        lede: `That is ${gbp(Math.round(perHH / 100) * 100)} for every household in the UK. It has been built up over decades: the government has borrowed in ${borrowYears} of the last ${borrowYears + surplusYears.length} years.`,
        take: `Debt is ${ratio.toFixed(0)}% of GDP and still rising. The financial crisis and Covid caused the biggest jumps, but borrowing never stopped in between, so the debt has kept growing.` },
      { id: 'step-cost', label: 'The cost', q: 'What does the debt cost us?',
        head: `Interest alone costs ${bn(interestNow, 0)} a year`,
        lede: `That is about ${gbp(intWeek)} a week for every household, money that pays for past borrowing rather than for services today.`,
        take: `Debt interest is now the ${ordinal} call on public money after ${Object.entries(P).filter(([, v]) => v > interestNow).map(([k]) => k.toLowerCase()).join(', ').replace(/, ([^,]*)$/, ' and $1')}. It costs ${defenceX} times the defence budget. Every pound spent on interest is a pound not spent on services or tax cuts.` },
      { id: 'step-drivers', label: 'The drivers', q: 'Why does the government keep borrowing?',
        head: `Spending keeps outrunning income, and welfare is the biggest bill`,
        lede: null,
        take: `Welfare costs ${bn(welfare26, 0)} in 2026-27, about ${Math.round(welfare26 / tme26 * 100)}p of every £1 the state spends. ${Math.round(pens / dwpTotal * 100)}% of DWP benefit spending goes to pensioners, mostly the State Pension. The fastest-growing part is health and disability benefits, up ${(hd.rate * 100).toFixed(1)}% a year above inflation since ${TREND_FROM}.` },
      { id: 'step-outlook', label: 'The outlook', q: 'Where is it heading?',
        head: `Under current plans, debt keeps rising to ${tn(LAST_FC.debt)}`,
        lede: null,
        take: `Even on the OBR's central forecast, debt peaks at ${pct(peak.debtPct)} of GDP in ${peak.year} and interest climbs to ${bn(LAST_FC.interest, 0)} a year. That forecast assumes health and disability spending grows about half as fast as it has recently. If the recent trend continues, debt reaches ${tn(trendEnd.debt)} by ${trendEnd.year}.` },
    ];
    steps.forEach((st, i) => {
      $('h-' + st.id).textContent = st.head;
      if (st.lede && $('lede-' + st.id)) $('lede-' + st.id).textContent = st.lede;
      $('take-' + st.id).textContent = st.take;
    });
    $('interest-lede').textContent = steps[1].lede;

    $('roadmap').innerHTML = steps.map((st, i) =>
      `<li><a href="#${st.id}"><span class="rm-num">${i + 1}</span><span class="rm-q">${st.q}</span><span class="rm-a">${st.head}</span></a></li>`).join('') +
      `<li class="rm-end"><a href="#conclusion"><span class="rm-num">=</span><span class="rm-q">So what?</span><span class="rm-a">What it all adds up to</span></a></li>`;

    $('chain').innerHTML = [
      ['The debt', `${tn(debtBn)}, about ${ratio.toFixed(0)}% of GDP and ${gbp(Math.round(perHH / 100) * 100)} per household. The government has borrowed in ${borrowYears} of the last ${borrowYears + surplusYears.length} years.`],
      ['The cost', `${bn(interestNow, 0)} a year in interest, about ${gbp(intWeek)} a week per household and ${defenceX} times the defence budget.`],
      ['The drivers', `Spending has been higher than income in almost every year. Welfare is the largest bill at ${bn(welfare26, 0)}, ${Math.round(pens / dwpTotal * 100)}% of DWP benefits go to pensioners, and health and disability benefits are growing fastest.`],
      ['The outlook', `On current plans debt rises to ${tn(LAST_FC.debt)} by ${LAST_FC.year} and interest to ${bn(LAST_FC.interest, 0)}. On the recent trend it is higher still.`],
    ].map(([k, v], i) => `<li><a href="#${steps[i].id}"><strong>${k}</strong></a><span>${v}</span></li>`).join('');
    $('bottom-line').textContent =
      `The debt is not falling under current plans. Each year of borrowing adds to an interest bill that already costs more than most public services. ` +
      `Whether debt stops rising depends mainly on two things the official forecast takes for granted: that this year's overspend does not continue, and that welfare growth, especially health and disability benefits, slows to about half its recent pace. If either does not happen, the debt and the interest bill will be larger than forecast.`;
  }

  // Highlight the step in view in the header.
  const navLinks = [...document.querySelectorAll('.site-header nav a')];
  const watch = navLinks.map(a => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) navLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
    }), { rootMargin: '-45% 0px -50% 0px' });
    watch.forEach(el => io.observe(el));
  }

  drawDebt = inBand('c-debt', drawDebt);
  drawEras = inBand('c-eras', drawEras);
  drawInterest = inBand('c-interest', drawInterest);
  drawOpp = inBand('c-opp', drawOpp);
  drawGap = inBand('c-gap', drawGap);
  drawWelfare = inBand('c-welfare', drawWelfare);
  drawBreakdowns = inBand('c-pens', drawBreakdowns);
  drawForecast = inBand('c-fc', drawForecast);
  drawRisks = inBand('c-risk-pens', drawRisks);

  function drawAll() {
    drawDebt(); drawEras(); drawInterest(); drawOpp(); drawGap(); drawWelfare(); drawBreakdowns(); drawGrowth(); drawForecast(); drawRisks();
  }
  drawAll();
  drawStory();

  // ---------- controls ----------
  document.querySelectorAll('[data-debt-unit]').forEach(b => b.addEventListener('click', () => {
    state.debtUnit = b.dataset.debtUnit;
    document.querySelectorAll('[data-debt-unit]').forEach(x => x.setAttribute('aria-pressed', x === b));
    drawDebt();
  }));
  document.querySelectorAll('[data-welfare-unit]').forEach(b => b.addEventListener('click', () => {
    state.welfareUnit = b.dataset.welfareUnit;
    document.querySelectorAll('[data-welfare-unit]').forEach(x => x.setAttribute('aria-pressed', x === b));
    drawWelfare();
  }));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawAll);

  // ---------- sources ----------
  $('source-list').innerHTML = Object.values(D.sources).map(s =>
    `<li><a href="${s.url}" target="_blank" rel="noopener">${s.name}</a>${s.published ? ` <small>published ${s.published}</small>` : ''}${s.file ? ` · <a href="${s.file}" target="_blank" rel="noopener">data file</a>` : ''}</li>`).join('');
  $('built-note').textContent = `Data file built ${D.built}. Latest ONS debt figure released ${D.latest.released}. OBR forecasts are from the March 2026 Economic and Fiscal Outlook.`;
})();
