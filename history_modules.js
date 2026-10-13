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
// Finds the newest Daily*.xlsx / Daily*.csv in `dir` — Jira's export gets
// names like "Daily.xlsx" or "Daily (36).xlsx" depending on the browser.
function findDailyFile(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const candidates = names
    .filter((n) => /^daily.*\.(xlsx|xls|csv)$/i.test(n) && !n.startsWith('~$'))
    .map((n) => ({ file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates.length ? candidates[0] : null;
}

// Jira headers carry stray double spaces ("Current Assignee:  Username"),
// so columns are matched on a normalized form.
const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function readDailyJiraFile(dir) {
  const found = findDailyFile(dir);
  if (!found) return null;
  let XLSX;
  try { XLSX = require('xlsx'); } catch (e) {
    throw new Error('the "xlsx" package is missing — run: npm install');
  }
  const wb = XLSX.readFile(found.file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
  const rows = raw.map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[normHeader(k)] = v;
    return o;
  });
  return { file: path.basename(found.file), modifiedAt: new Date(found.mtime).toISOString(), rows };
}

// Latest issue (by Created, then issue number) per vendor.
function latestIssueByVendor(dailyRows) {
  const issueNum = (k) => toNum(String(k || '').replace(/^\D+/, ''), 0);
  const map = new Map();
  for (const r of dailyRows || []) {
    const vid = clean(r.vendorid);
    if (!vid || vid === '-') continue;
    const issue = {
      key: clean(r.issuekey) || null,
      status: clean(r.currentstatus) || 'Unknown',
      resolution: clean(r.resolution) && clean(r.resolution) !== '-' ? clean(r.resolution) : null,
      agent: clean(r.m41negotiationagentusername).toLowerCase(),
      assignee: clean(r.currentassigneeusername).toLowerCase(),
      leadType: clean(r.m41leadtype) && clean(r.m41leadtype) !== '-' ? clean(r.m41leadtype) : null,
      created: toNum(r.created, 0),
      negotiationDate: toNum(r.m41negotiationdate, 0) || null,
      issueCount: 1,
    };
    if (issue.agent === '-') issue.agent = '';
    if (issue.assignee === '-') issue.assignee = '';
    const prev = map.get(vid);
    if (!prev) { map.set(vid, issue); continue; }
    issue.issueCount = prev.issueCount + 1;
    const newer = issue.created > prev.created || (issue.created === prev.created && issueNum(issue.key) > issueNum(prev.key));
    if (newer) map.set(vid, issue);
    else prev.issueCount = issue.issueCount;
  }
  return map;
}

// ============================================================
// LEADS
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
  const label = `${MONTHS[mi][0].toUpperCase()}${MONTHS[mi].slice(1)} ${year}`;
  return {
    key: `${year}-${String(mi + 1).padStart(2, '0')}`,
    label,
    start: excelSerialOfUtc(year, mi),
    end: excelSerialOfUtc(mi === 11 ? year + 1 : year, (mi + 1) % 12),
  };
}

// Overview tab → { city: { leadPool, vendorTarget, packTarget, aVendorTarget, bVendorTarget, tcVendorTarget } }
function parseTargets(overviewRows) {
  const out = {};
  for (const r of overviewRows || []) {
    const city = clean(r.City);
    if (!city) continue;
    out[city === 'Total' ? '__total__' : city] = {
      leadPool: toNum(r['Total Lead Pool']),
      vendorTarget: toNum(r['Total Vendor Target']),
      packTarget: toNum(r['Total Pack Target']),
      aVendorTarget: toNum(r['A Vendor Target']),
      bVendorTarget: toNum(r['B Vendor Target']),
      tcVendorTarget: toNum(r['Top Critical Vendor Target']),
    };
  }
  return out;
}

/**
 * leadPools: [{ title, rows }] — one per "Lead Pool (<Month>)" tab.
 * overviewRows: city targets (Overview tab — applies to the current month).
 * donePacksRows: every M4O pack ever built (Done_Packs tab).
 * daily: readDailyJiraFile() result, or null.
 */
function buildLeadsModule({ leadPools, overviewRows, donePacksRows, daily, now = new Date() }) {
  const months = leadPools
    .map((lp) => ({ ...lp, month: parseLeadPoolTab(lp.title, now) }))
    .filter((lp) => lp.month)
    .sort((a, b) => a.month.key.localeCompare(b.month.key));
  if (months.length === 0) return null;

  const packsByVendor = new Map();
  for (const p of donePacksRows || []) {
    const vid = clean(p.VendorID);
    if (!vid) continue;
    if (!packsByVendor.has(vid)) packsByVendor.set(vid, []);
    packsByVendor.get(vid).push(p);
  }
  const jira = daily ? latestIssueByVendor(daily.rows) : new Map();
  const targets = parseTargets(overviewRows);
  const latestKey = months[months.length - 1].month.key;

  const byMonth = {};
  for (const { rows, month } of months) {
    const seen = new Set();
    const vendors = [];
    for (const r of rows) {
      const vid = clean(r.VendorID);
      if (!vid || seen.has(vid)) continue;
      seen.add(vid);
      const packs = packsByVendor.get(vid) || [];
      // Deduped by PackID — the sheet repeats a few packs.
      const uniq = new Map();
      for (const p of packs) uniq.set(clean(p.PackID), p);
      const packList = [...uniq.values()];
      const live = packList.filter((p) => toNum(p.Deleted) === 0);
      const builtInMonth = packList.filter((p) => { const c = toNum(p.created_at); return c >= month.start && c < month.end; });
      const active = packList.filter((p) => toNum(p.Activity) === 1 && toNum(p.Deleted) === 0);
      const orders = Math.max(
        toNum(r.vendor_m41_Orders_MTD),
        ...packList.map((p) => toNum(p.vendor_m41_Orders_MTD)),
        0
      );
      const j = jira.get(vid) || null;
      const assigned = clean(r.Assigned).toLowerCase() || (j && (j.agent || j.assignee)) || '';
      vendors.push({
        id: vid,
        name: clean(r.Title),
        city: clean(r.City),
        area: clean(r.MarketingAreaName),
        tier: clean(r.VendorTier) || '—',
        cls: clean(r.VendorClass) || '—',
        pro: clean(r.IsPro) === 'Yes' || toNum(r.IsPro) === 1 ? 1 : 0,
        type: clean(r.VendorType),
        assignee: assigned || '(unassigned)',
        leadType: (j && j.leadType) || null,
        jira: j ? { key: j.key, status: j.status, resolution: j.resolution, agent: j.agent, created: j.created, issues: j.issueCount } : null,
        packs: live.length,
        packsInMonth: builtInMonth.length,
        activePacks: active.length,
        firstPackInMonth: builtInMonth.length > 0 && packList.every((p) => toNum(p.created_at) >= month.start),
        orders,
      });
    }
    byMonth[month.key] = {
      label: month.label,
      // Overview has no month in its name, so its targets belong to the
      // latest month only — older months show no target rather than a wrong one.
      targets: month.key === latestKey ? targets : null,
      vendors,
    };
  }

  return {
    months: months.map((m) => m.month.key),
    byMonth,
    jiraSource: daily ? { file: daily.file, modifiedAt: daily.modifiedAt, issues: daily.rows.length } : null,
  };
}

module.exports = { buildCoverageHistory, buildLeadsModule, readDailyJiraFile, parseLeadPoolTab, latestIssueByVendor };
