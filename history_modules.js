/**
 * history_modules.js
 * ------------------
 * Pure builders for two dashboard modules, kept separate from
 * update_dashboard.js so they can be tested against exported .xlsx files:
 *
 *   buildCoverageHistory  — daily coverage snapshots (one tab per day,
 *                           YYYY-MM-DD) → per-area / per-city / All Cities trend.
 *   buildLeadsModule      — monthly lead pool → funnel (Jira issue → pack
 *                           built → pack active → M4O order) vs city targets.
 *   readDailyJiraFile     — the local Jira export ("Daily*.xlsx") the user
 *                           downloads every day; it is not on any sheet.
 *
 * Every builder takes plain row objects ({header: value}), the same shape
 * fetchSheetAsObjects() returns.
 */

const fs = require('fs');
const path = require('path');

function toNum(v, def = 0) {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
const round1 = (x) => Math.round(x * 10) / 10;
const pct1 = (num, den) => (den > 0 ? round1((num / den) * 100) : 0);
const clean = (v) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());

// ============================================================
// COVERAGE HISTORY
// ============================================================
const COVERAGE_STATUSES = ['Elite', 'Healthy', 'Moderate', 'Low'];

// Area row → compact array, to keep the encrypted payload small:
// [status, totalUsers, elitePct, healthyPct, moderatePct, lowPct]
function coverageAggregate(rows) {
  const t = { total: 0, elite: 0, healthy: 0, moderate: 0, low: 0 };
  const statusCounts = { Elite: 0, Healthy: 0, Moderate: 0, Low: 0 };
  for (const r of rows) {
    t.total += toNum(r.total_user_count);
    t.elite += toNum(r.Elite_users);
    t.healthy += toNum(r.Healthy_users);
    t.moderate += toNum(r.Moderate_users);
    t.low += toNum(r.Low_users);
    if (statusCounts[r.status] !== undefined) statusCounts[r.status]++;
  }
  return {
    users: t.total,
    pct: [pct1(t.elite, t.total), pct1(t.healthy, t.total), pct1(t.moderate, t.total), pct1(t.low, t.total)],
    areaStatus: COVERAGE_STATUSES.map((s) => statusCounts[s]),
  };
}

/**
 * rowsByDate: { 'YYYY-MM-DD': rows[] }. Empty tabs are dropped.
 * Output:
 *   dates: [...]                                   (ascending)
 *   cities: { city: { all:[agg|null per date], top:[...], areas: { area: { top, days:[arr|null per date] } } } }
 *   allCities: { all:[...], top:[...] }
 * where agg = { users, pct:[E,H,M,L], areaStatus:[#E,#H,#M,#L] }.
 */
function buildCoverageHistory(rowsByDate) {
  const dates = Object.keys(rowsByDate)
    .filter((d) => (rowsByDate[d] || []).some((r) => r && r.City && r.MarketingAreaName))
    .sort();
  if (dates.length === 0) return null;

  const cities = {};
  const allCities = { all: [], top: [] };
  dates.forEach((date, di) => {
    const rows = rowsByDate[date].filter((r) => r && r.City && r.MarketingAreaName);
    allCities.all.push(coverageAggregate(rows));
    const topRows = rows.filter((r) => toNum(r.TopAreas) === 1);
    allCities.top.push(topRows.length ? coverageAggregate(topRows) : null);

    const byCity = new Map();
    for (const r of rows) {
      const c = clean(r.City);
      if (!byCity.has(c)) byCity.set(c, []);
      byCity.get(c).push(r);
    }
    for (const [city, cRows] of byCity) {
      if (!cities[city]) cities[city] = { all: [], top: [], areas: {} };
      const entry = cities[city];
      while (entry.all.length < di) { entry.all.push(null); entry.top.push(null); }
      entry.all.push(coverageAggregate(cRows));
      const cTop = cRows.filter((r) => toNum(r.TopAreas) === 1);
      entry.top.push(cTop.length ? coverageAggregate(cTop) : null);
      for (const r of cRows) {
        const area = clean(r.MarketingAreaName);
        if (!entry.areas[area]) entry.areas[area] = { top: false, days: [] };
        const a = entry.areas[area];
        while (a.days.length < di) a.days.push(null);
        // The same area shouldn't appear twice in a day; if it does, last wins.
        if (a.days.length > di) a.days.pop();
        a.days.push([
          r.status || null,
          toNum(r.total_user_count),
          round1(toNum(r.Elite_pct)), round1(toNum(r.Healthy_pct)),
          round1(toNum(r.Moderate_pct)), round1(toNum(r.Low_pct)),
        ]);
        // "Top" follows the latest day the area appears on.
        a.top = toNum(r.TopAreas) === 1;
      }
    }
  });
  // Pad trailing gaps so every series has one slot per date.
  for (const entry of Object.values(cities)) {
    while (entry.all.length < dates.length) { entry.all.push(null); entry.top.push(null); }
    for (const a of Object.values(entry.areas)) while (a.days.length < dates.length) a.days.push(null);
  }
  return { dates, statuses: COVERAGE_STATUSES, allCities, cities };
}

// ============================================================
// DAILY JIRA FILE (local, not on a sheet)
// ============================================================
// Jira headers carry stray double spaces ("Current Assignee:  Username"),
// so columns are matched on a normalized form.
const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const SHEET_FILE_RE = /\.(xlsx|xls|csv)$/i;

function loadXlsx() {
  try { return require('xlsx'); } catch (e) { /* not installed yet */ }
  // package.json has listed xlsx for a long time, but a folder whose
  // node_modules predates it never got it — install it once, quietly.
  console.log('  The "xlsx" package is missing — running npm install once…');
  require('child_process').execSync('npm install --no-audit --no-fund', { cwd: __dirname, stdio: 'inherit' });
  return require('xlsx');
}

function readRows(XLSX, file) {
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: null, raw: true }).map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[normHeader(k)] = v;
    return o;
  });
}
const isJiraExport = (rows) => rows.length > 0 && 'vendorid' in rows[0] && 'currentstatus' in rows[0];

/**
 * Finds the Jira export next to the scripts and reads it. Prefers files named
 * Daily*.xlsx/.xls/.csv (newest first); if none of those works, any other
 * spreadsheet in the folder whose columns include "Vendor ID" and
 * "Current Status" is used — so the exact file name doesn't matter.
 * Returns { file, modifiedAt, rows } on success, or { error } explaining
 * exactly what was (not) found, so the dashboard can show the real reason.
 */
function readDailyJiraFile(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return { error: `could not list ${dir}: ${e.message}` }; }
  const sheetsInDir = names
    .filter((n) => SHEET_FILE_RE.test(n) && !n.startsWith('~$'))
    .map((n) => ({ name: n, file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (sheetsInDir.length === 0) {
    return { error: `no .xlsx/.xls/.csv file in ${dir}` };
  }
  let XLSX;
  try { XLSX = loadXlsx(); } catch (e) { return { error: `the "xlsx" package is missing and npm install failed (${e.message}) — run "npm install" in ${dir}` }; }

  const daily = sheetsInDir.filter((f) => /^daily/i.test(f.name));
  const others = sheetsInDir.filter((f) => !/^daily/i.test(f.name));
  const problems = [];
  for (const f of [...daily, ...others]) {
    let rows;
    try { rows = readRows(XLSX, f.file); } catch (e) {
      problems.push(`${f.name}: ${e.code === 'EBUSY' ? 'locked (close it in Excel)' : e.message}`);
      continue;
    }
    if (isJiraExport(rows)) {
      return { file: f.name, modifiedAt: new Date(f.mtime).toISOString(), rows };
    }
    if (/^daily/i.test(f.name)) problems.push(`${f.name}: no "Vendor ID" / "Current Status" columns on its first sheet`);
  }
  return {
    error: `no Jira export found in ${dir}. Spreadsheets seen: ${sheetsInDir.map((f) => f.name).join(', ')}` +
      (problems.length ? `. Problems: ${problems.join('; ')}` : ''),
  };
}

// ============================================================
// LEADS — how many of each month's lead pool got a Done Jira issue
// ============================================================
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const excelSerialOfUtc = (y, m) => Date.UTC(y, m, 1) / 86400000 + 25569;

// "Lead Pool (October)" → { key:'2026-10', label:'October 2026', start, end } —
// the year is the most recent one in which that month has already started.
function parseLeadPoolTab(title, now = new Date()) {
  const m = /^lead pool\s*\(\s*([a-z]+)\s*(\d{4})?\s*\)$/i.exec(String(title).trim());
  if (!m) return null;
  const mi = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
  if (mi < 0) return null;
  let year = m[2] ? Number(m[2]) : now.getUTCFullYear();
  if (!m[2] && mi > now.getUTCMonth()) year -= 1;
  return {
    key: `${year}-${String(mi + 1).padStart(2, '0')}`,
    label: `${MONTHS[mi][0].toUpperCase()}${MONTHS[mi].slice(1)} ${year}`,
    start: excelSerialOfUtc(year, mi),
    end: excelSerialOfUtc(mi === 11 ? year + 1 : year, (mi + 1) % 12),
  };
}

/**
 * leadPools: [{ title, rows }] — one per "Lead Pool (<Month>)" tab.
 * daily: readDailyJiraFile() result ({rows} or {error}).
 *
 * mainRows: MainData rows (pack level, unfiltered).
 *
 * A lead counts as Done for a month when EITHER
 *   - Jira: the vendor has an issue created on/after that month's 1st whose
 *     Current Status is Done, or a later stage than negotiation (Content QC,
 *     Discount & Coupon, Pack Freezing & Upload to Carousel); OR
 *   - MainData: the vendor has an active pack (Activity 1, not deleted) or
 *     M4O orders this month (vendor_m41_Orders_MTD > 0).
 * Done-stage issues created before the month only (an earlier deal) are
 * reported as doneBefore, not as Done.
 */
const DONE_STAGE_RE = /^(done|content ?qc|discount ?(&|and)? ?coupon|pack freezing.*)$/i;

function buildLeadsModule({ leadPools, daily, mainRows = [], now = new Date() }) {
  const months = leadPools
    .map((lp) => ({ ...lp, month: parseLeadPoolTab(lp.title, now) }))
    .filter((lp) => lp.month)
    .sort((a, b) => a.month.key.localeCompare(b.month.key));
  if (months.length === 0) return null;

  const doneIssuesByVendor = new Map();
  const vendorsInJira = new Set();
  const rows = daily && daily.rows ? daily.rows : [];
  for (const r of rows) {
    const vid = clean(r.vendorid);
    if (!vid || vid === '-') continue;
    vendorsInJira.add(vid);
    if (!DONE_STAGE_RE.test(clean(r.currentstatus))) continue;
    if (!doneIssuesByVendor.has(vid)) doneIssuesByVendor.set(vid, []);
    doneIssuesByVendor.get(vid).push({ key: clean(r.issuekey) || null, created: toNum(r.created, 0) });
  }

  // MainData only reflects the current state, so it's the same for every month.
  const liveInMainData = new Set();
  for (const r of mainRows) {
    const vid = clean(r.VendorID);
    if (!vid) continue;
    const active = toNum(r.Activity) === 1 && toNum(r.Deleted) === 0;
    if (active || toNum(r.vendor_m41_Orders_MTD) > 0) liveInMainData.add(vid);
  }

  const byMonth = {};
  for (const { rows: poolRows, month } of months) {
    const seen = new Set();
    const vendors = [];
    for (const r of poolRows) {
      const vid = clean(r.VendorID);
      if (!vid || seen.has(vid)) continue;
      seen.add(vid);
      const done = (doneIssuesByVendor.get(vid) || []);
      const doneIn = done.filter((i) => i.created >= month.start).sort((a, b) => a.created - b.created);
      const jiraDone = doneIn.length > 0;
      const mainDone = liveInMainData.has(vid);
      vendors.push({
        id: vid,
        name: clean(r.Title),
        city: clean(r.City) || '—',
        inJira: vendorsInJira.has(vid) ? 1 : 0,
        done: jiraDone || mainDone ? 1 : 0,
        jiraDone: jiraDone ? 1 : 0,
        mainDone: mainDone ? 1 : 0,
        doneKey: jiraDone ? doneIn[0].key : null,
        doneBefore: !jiraDone && !mainDone && done.length ? 1 : 0,
      });
    }
    byMonth[month.key] = { label: month.label, vendors };
  }

  return {
    months: months.map((m) => m.month.key),
    byMonth,
    jiraSource: daily && daily.rows ? { file: daily.file, modifiedAt: daily.modifiedAt, issues: daily.rows.length } : null,
    jiraError: daily && daily.error ? daily.error : null,
  };
}

module.exports = { buildCoverageHistory, buildLeadsModule, readDailyJiraFile, parseLeadPoolTab };
