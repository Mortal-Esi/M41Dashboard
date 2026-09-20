/**
 * Meal4One Dashboard — Sync Script
 * ---------------------------------
 * Reads two Google Sheets using a service account:
 *   1. The main data sheet — MainData, Order, TopCritical, BI, Impression tabs
 *   2. The Coverage Model sheet — CityCoverage, CoverageResult tabs
 * Applies the processing rules described in README.md, and writes
 * dashboard_data.json next to this file.
 *
 * Usage:
 *   node update_dashboard.js
 *
 * Requires:
 *   npm install googleapis
 *
 * Setup (one-time):
 *   1. Place your service-account key file in this folder, e.g. service-account.json
 *      (NEVER commit this file — add it to .gitignore)
 *   2. Share BOTH Google Sheets with the service account's client_email as Viewer
 *   3. Set SPREADSHEET_ID and COVERAGE_SPREADSHEET_ID below (from each sheet's URL)
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ============================================================
// CONFIG — edit these lines
// ============================================================
const SERVICE_ACCOUNT_KEY_PATH = path.join(__dirname, 'service-account.json');
const SPREADSHEET_ID = 'PASTE_YOUR_SPREADSHEET_ID_HERE'; // main data sheet (MainData/Order/TopCritical/BI)
const COVERAGE_SPREADSHEET_ID = 'PASTE_YOUR_COVERAGE_SPREADSHEET_ID_HERE'; // Coverage_Radius sheet (CityCoverage/CoverageResult)

const SHEET_NAMES = {
  mainData: 'MainData',
  order: 'Order',
  topCritical: 'TopCritical',
  bi: 'BI',
  impression: 'Impression',
  cpoBudget: 'CPO_Budget_MTD',
};

const COVERAGE_SHEET_NAMES = {
  cityCoverage: 'CityCoverage',
  coverageResult: 'CoverageResult',
};

const OUTPUT_PATH = path.join(__dirname, 'dashboard_data.json');

// ============================================================
// GOOGLE SHEETS FETCH
// ============================================================
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function fetchSheetAsObjects(sheets, spreadsheetId, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetName,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] === undefined ? null : row[i]; });
    return obj;
  });
}

// ============================================================
// IMPRESSION SHEET — fetched by column POSITION, not header name.
// The 34 half-hour header cells (07:00 .. 23:30) are time-of-day values;
// read with UNFORMATTED_VALUE they come back as raw day-fraction numbers,
// not clean "07:00" strings, so they're unsafe to use as object keys.
// Fixed layout: 0 City, 1 CityID, 2 VendorID, 3 Title, 4 PackID, 5 full_title,
// 6 Activity, 7..40 the 34 half-hour buckets, 41 total_impression.
// ============================================================
const TIME_SLOTS = [];
for (let h = 7; h <= 23; h++) {
  TIME_SLOTS.push(`${String(h).padStart(2, '0')}:00`);
  TIME_SLOTS.push(`${String(h).padStart(2, '0')}:30`);
}

async function fetchImpressionRows(sheets, spreadsheetId, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetName,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  if (rows.length <= 1) return [];
  return rows.slice(1).map((row) => ({
    City: row[0],
    CityID: row[1],
    VendorID: row[2],
    Title: row[3],
    PackID: row[4],
    full_title: row[5],
    Activity: row[6],
    bySlot: TIME_SLOTS.map((_, i) => toNum(row[7 + i], 0)),
    total_impression: toNum(row[41], 0),
  }));
}

// ============================================================
// HELPERS
// ============================================================
function toNum(v, def = 0) {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isNaN(n) ? def : n;
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10; // 1 decimal
}

function rateBucket(r) {
  const rate = toNum(r, null);
  if (rate === null || rate === 0) return null; // "No Rating" — excluded
  if (rate < 2) return '0-2';
  if (rate < 4) return '2-4';
  if (rate < 6) return '4-6';
  if (rate < 8) return '6-8';
  return '8-10';
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// Excel serial date (if the Sheets API returns a number) or a date-like string → 'YYYY-MM-DD'
function normalizeDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    // Excel/Sheets serial date: days since 1899-12-30
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 10);
}

const BUCKET_ORDER = ['0-2', '2-4', '4-6', '6-8', '8-10'];
const DEAL_TYPES = ['Super', 'Good', 'Basic', 'Weak', 'Not Food'];

function avgDiscountKitchenOnly(rows) {
  const k0 = rows.filter((r) => toNum(r.Kitchen, null) === 0);
  if (k0.length === 0) return 0;
  return Math.round(k0.reduce((s, r) => s + r._SnappDiscountToman, 0) / k0.length);
}

// Shared 3-bucket segmentation for Non-Kitchen vendors, used by both the
// Impression and CPO Budget modules: TopCritical, Critical, and Other
// (Important + Ordinary + anything uncategorized).
function vendorSegmentClass(vendorClass) {
  if (vendorClass === 'TopCritical') return 'TopCritical';
  if (vendorClass === 'Critical') return 'Critical';
  return 'Other';
}

function vendorStatsBlock(rows) {
  const total = rows.length;
  const segA = rows.filter((r) => r.VendorTier === 'A').length;
  const segB = rows.filter((r) => r.VendorTier === 'B').length;
  const kitchen = rows.filter((r) => r._IsKitchen).length;
  const discSub = rows.filter((r) => r._HasDiscountSubsidy).length;
  const coupSub = rows.filter((r) => r._HasCouponSubsidy).length;
  return {
    total,
    segmentA: segA, segmentA_pct: pct(segA, total),
    segmentB: segB, segmentB_pct: pct(segB, total),
    topCriticalInA: rows.filter((r) => r.VendorTier === 'A' && r._IsTopCritical).length,
    kitchen, kitchen_pct: pct(kitchen, total),
    discountSubsidy: discSub, discountSubsidy_pct: pct(discSub, total),
    couponSubsidy: coupSub, couponSubsidy_pct: pct(coupSub, total),
  };
}

function packStatsBlock(rows) {
  const total = rows.length;
  const dealTypeCounts = {};
  const dealTypePcts = {};
  DEAL_TYPES.forEach((dt) => {
    const c = rows.filter((r) => r.DealType === dt).length;
    dealTypeCounts[dt] = c;
    dealTypePcts[dt] = pct(c, total);
  });
  const discSub = rows.filter((r) => r._IsDiscountSubsidy).length;
  const coupSub = rows.filter((r) => r._IsCouponSubsidy).length;
  const kitchen = rows.filter((r) => r._IsKitchen).length;
  // Availability: of the packs that are Activity==1 right now, what share were
  // actually shown to a user at least once (i.e. picked up an impression)?
  // A low number here means "marked active" isn't the same as "actually surfaced".
  const activeRows = rows.filter((r) => r._IsActive);
  const activeWithImpression = activeRows.filter((r) => r._HasImpression).length;
  return {
    total,
    dealTypeCounts, dealTypePcts,
    kitchen, kitchen_pct: pct(kitchen, total),
    discountSubsidy: discSub, discountSubsidy_pct: pct(discSub, total),
    couponSubsidy: coupSub, couponSubsidy_pct: pct(coupSub, total),
    avgSnappDiscountToman: avgDiscountKitchenOnly(rows),
    activePackCount: activeRows.length,
    availability_pct: pct(activeWithImpression, activeRows.length),
  };
}

// ============================================================
// MAIN PIPELINE
// ============================================================
async function main() {
  console.log('Connecting to Google Sheets…');
  const sheets = await getSheetsClient();

  console.log('Fetching MainData, Order, TopCritical, BI…');
  const [mainRaw, orderRaw, topcRaw, biRaw] = await Promise.all([
    fetchSheetAsObjects(sheets, SPREADSHEET_ID, SHEET_NAMES.mainData),
    fetchSheetAsObjects(sheets, SPREADSHEET_ID, SHEET_NAMES.order),
    fetchSheetAsObjects(sheets, SPREADSHEET_ID, SHEET_NAMES.topCritical),
    fetchSheetAsObjects(sheets, SPREADSHEET_ID, SHEET_NAMES.bi),
  ]);
  console.log(`  MainData: ${mainRaw.length} rows`);
  console.log(`  Order: ${orderRaw.length} rows`);
  console.log(`  TopCritical: ${topcRaw.length} rows`);
  console.log(`  BI: ${biRaw.length} rows`);

  console.log('Fetching Impression…');
  const impressionRawRows = await fetchImpressionRows(sheets, SPREADSHEET_ID, SHEET_NAMES.impression);
  console.log(`  Impression: ${impressionRawRows.length} rows`);

  console.log('Fetching CPO_Budget_MTD…');
  const cpoBudgetRaw = await fetchSheetAsObjects(sheets, SPREADSHEET_ID, SHEET_NAMES.cpoBudget);
  // The sheet has ~1900 fully blank trailing rows — keep only real vendor rows.
  const cpoRows = cpoBudgetRaw.filter((r) => r.VendorID !== null && r.VendorID !== undefined && r.VendorID !== '');
  // Built early so MODULE 7 (Impression) can also segment vendors by
  // TopCritical / Critical / Other, the same categorization CPO Budget uses.
  const vendorClassByVendorId = new Map(cpoRows.map((r) => [String(r.VendorID), r.VendorClass || 'Unknown']));
  console.log(`  CPO_Budget_MTD: ${cpoBudgetRaw.length} rows (${cpoRows.length} real)`);

  // Dedupe by PackID (a handful of packs appear twice in the source sheet) — sum both.
  const impressionByPackId = new Map();
  for (const r of impressionRawRows) {
    const pid = String(r.PackID);
    if (!impressionByPackId.has(pid)) {
      impressionByPackId.set(pid, { ...r, bySlot: [...r.bySlot] });
    } else {
      const existing = impressionByPackId.get(pid);
      existing.total_impression += r.total_impression;
      for (let i = 0; i < r.bySlot.length; i++) existing.bySlot[i] += r.bySlot[i];
    }
  }
  const impressionRows = [...impressionByPackId.values()];
  const impressionPackIds = new Set(impressionRows.map((r) => String(r.PackID)));

  console.log('Fetching CityCoverage, CoverageResult (Coverage Model sheet)…');
  const [cityCoverageRaw, coverageResultRaw] = await Promise.all([
    fetchSheetAsObjects(sheets, COVERAGE_SPREADSHEET_ID, COVERAGE_SHEET_NAMES.cityCoverage),
    fetchSheetAsObjects(sheets, COVERAGE_SPREADSHEET_ID, COVERAGE_SHEET_NAMES.coverageResult),
  ]);
  console.log(`  CityCoverage: ${cityCoverageRaw.length} rows`);
  console.log(`  CoverageResult: ${coverageResultRaw.length} rows`);

  // ---- FILTER RULE: Activity==1, OR PO>0, OR the pack has impressions ----
  // (Activity==0/PO==0 packs that still got impressions were seen by users —
  // not truly dead — so they're rescued into the dataset. See README.)
  for (const r of mainRaw) {
    r._IsActive = toNum(r.Activity, 0) === 1;
    r._HasImpression = impressionPackIds.has(String(r.PackID));
  }
  const df = mainRaw.filter((r) => {
    const po = toNum(r.PO, 0);
    return r._IsActive || po > 0 || r._HasImpression;
  });
  console.log(`  MainData after filter: ${df.length} rows`);

  // ---- JOIN Marketing Area: Order sheet first, BI sheet as fallback ----
  const areaLookup = new Map();
  const orderRowByVendor = new Map(); // for pulling VendorTier/SuperTypeID consistency checks + entry date fallback
  for (const r of orderRaw) {
    const vid = String(r.VendorID);
    if (!areaLookup.has(vid) && r.MarketingAreaName) areaLookup.set(vid, r.MarketingAreaName);
    if (!orderRowByVendor.has(vid)) orderRowByVendor.set(vid, r);
  }
  const biAreaLookup = new Map();
  for (const r of biRaw) {
    const vid = String(r['Vendor ID']);
    if (!biAreaLookup.has(vid) && r.Area) biAreaLookup.set(vid, r.Area);
  }
  for (const r of df) {
    const vid = String(r.VendorID);
    r._MarketingAreaName = areaLookup.get(vid) || biAreaLookup.get(vid) || 'Unknown';
  }

  // ---- TopCritical universe ----
  const topcIds = new Set(topcRaw.map((r) => String(r.VendorID)));
  for (const r of df) r._IsTopCritical = topcIds.has(String(r.VendorID));

  // ---- Snapp discount toman ----
  for (const r of df) r._SnappDiscountToman = toNum(r.price, 0) * (toNum(r.DiscountSFRatio, 0) / 100);

  // ---- Rate bucket ----
  for (const r of df) r._RateBucket = rateBucket(r.Rate);

  // ---- Kitchen tag ----
  for (const r of df) r._IsKitchen = toNum(r.Kitchen, null) === 1;

  // ---- Subsidy flags (pack-level) ----
  for (const r of df) {
    r._IsDiscountSubsidy = toNum(r.DiscountSFRatio, 0) > 0;
    r._IsCouponSubsidy = toNum(r.CouponSFShare, 0) > 0;
  }

  // ---- Vendor-level subsidy = ANY active pack of that vendor has subsidy ----
  const vendorDiscSubMap = new Map();
  const vendorCoupSubMap = new Map();
  for (const r of df) {
    const vid = r.VendorID;
    if (r._IsDiscountSubsidy) vendorDiscSubMap.set(vid, true);
    if (r._IsCouponSubsidy) vendorCoupSubMap.set(vid, true);
  }
  for (const r of df) {
    r._HasDiscountSubsidy = vendorDiscSubMap.get(r.VendorID) || false;
    r._HasCouponSubsidy = vendorCoupSubMap.get(r.VendorID) || false;
  }

  // ---- Vendor entry date = earliest CouponDateFrom seen for that vendor ----
  const vendorEntryDateMap = new Map();
  for (const r of df) {
    const d = normalizeDate(r.CouponDateFrom);
    if (!d) continue;
    const existing = vendorEntryDateMap.get(r.VendorID);
    if (!existing || d < existing) vendorEntryDateMap.set(r.VendorID, d);
  }

  // ---- SuperTypeIDs present (for the UI filter) ----
  const superTypeIds = [...new Set(df.map((r) => toNum(r.SuperTypeID, null)).filter((v) => v !== null))].sort((a, b) => a - b);

  // ============================================================
  // MODULE 1: VENDOR COVERAGE (City -> Marketing Area -> Vendor)
  // ============================================================
  const vendorSeen = new Map();
  for (const r of df) {
    if (!vendorSeen.has(r.VendorID)) vendorSeen.set(r.VendorID, r);
  }
  const vendorLevel = [...vendorSeen.values()];

  // Total M4O orders per Marketing Area (yesterday & MTD) — denominator for each
  // vendor's "M4O Area Share": this vendor's M4O orders as a fraction of ALL
  // M4O orders placed with vendors in the same area (not the area's total platform orders).
  const areaM41TotalsY = new Map(); // key: `${City}|${MarketingAreaName}` -> sum(M41VO)
  const areaM41TotalsMtd = new Map();
  for (const r of orderRaw) {
    const key = `${r.City}|${r.MarketingAreaName}`;
    areaM41TotalsY.set(key, (areaM41TotalsY.get(key) || 0) + toNum(r.M41VO, 0));
    areaM41TotalsMtd.set(key, (areaM41TotalsMtd.get(key) || 0) + toNum(r.NewMonthM41VO, 0));
  }

  const vendorCoverage = {};
  const byCity = groupBy(vendorLevel, (r) => r.City);
  for (const [city, cRows] of byCity) {
    const areas = {};
    const byArea = groupBy(cRows, (r) => r._MarketingAreaName);
    for (const [area, aRows] of byArea) {
      const vendors = aRows.map((v) => {
        const orderRow = orderRowByVendor.get(String(v.VendorID));
        const ordersY = orderRow ? toNum(orderRow.M41VO, 0) : 0;
        const ordersMtd = orderRow ? toNum(orderRow.NewMonthM41VO, 0) : 0;
        const areaKey = `${v.City}|${orderRow ? orderRow.MarketingAreaName : area}`;
        const areaM41TotalY = areaM41TotalsY.get(areaKey) || 0;
        const areaM41TotalMtd = areaM41TotalsMtd.get(areaKey) || 0;
        return {
          id: v.VendorID,
          name: v.Title,
          segment: v.VendorTier || 'Unknown',
          topCritical: v._IsTopCritical,
          kitchen: v._IsKitchen,
          discountSubsidy: v._HasDiscountSubsidy,
          couponSubsidy: v._HasCouponSubsidy,
          superTypeId: toNum(v.SuperTypeID, null),
          entryDate: vendorEntryDateMap.get(v.VendorID) || null,
          vendorMarketShare: orderRow ? toNum(orderRow.V_Pl_OS, null) : null,
          vendorMarketShareMtd: orderRow ? toNum(orderRow.NewMonth_V_Pl_OS, null) : null,
          ordersYesterday: ordersY,
          ordersMtd: ordersMtd,
          platformOrdersYesterday: orderRow ? toNum(orderRow.VPFO, 0) : 0,
          platformOrdersMtd: orderRow ? toNum(orderRow.NewMonthVPFO, 0) : 0,
          m4oAreaShare: areaM41TotalY ? ordersY / areaM41TotalY : null,
          m4oAreaShareMtd: areaM41TotalMtd ? ordersMtd / areaM41TotalMtd : null,
        };
      });
      areas[area] = { ...vendorStatsBlock(aRows), vendors };
    }
    vendorCoverage[city] = { ...vendorStatsBlock(cRows), areas };
  }

  // ============================================================
  // MODULE 2: PACK DISTRIBUTION (City -> Area -> Pack)
  // ============================================================
  const packDistByCity = {};
  const byCityPack = groupBy(df, (r) => r.City);
  for (const [city, cRows] of byCityPack) {
    const areas = {};
    const byArea = groupBy(cRows, (r) => r._MarketingAreaName);
    for (const [area, aRows] of byArea) {
      const packs = aRows.map((p) => ({
        packId: p.PackID || null,
        title: p.full_title,
        vendorName: p.Title,
        dealType: p.DealType || 'Unknown',
        kitchen: p._IsKitchen,
        discountSubsidy: p._IsDiscountSubsidy,
        couponSubsidy: p._IsCouponSubsidy,
        price: toNum(p.price, 0),
        snappDiscountToman: Math.round(p._SnappDiscountToman),
        superTypeId: toNum(p.SuperTypeID, null),
        isActive: p._IsActive,
        hasImpression: p._HasImpression,
      }));
      areas[area] = { ...packStatsBlock(aRows), packs };
    }
    packDistByCity[city] = { ...packStatsBlock(cRows), areas };
  }
  const overallPackBlock = packStatsBlock(df);

  // ============================================================
  // MODULE 3: RATING (per city AND per Marketing Area, SuperType-filterable client-side)
  // ============================================================
  function ratingBlock(rowsAll) {
    const rated = rowsAll.filter((r) => r._RateBucket !== null);
    const totalAll = rowsAll.length;
    const noRating = totalAll - rated.length;
    const buckets = {};
    const bucketPcts = {};
    BUCKET_ORDER.forEach((b) => {
      const c = rated.filter((r) => r._RateBucket === b).length;
      buckets[b] = c;
      bucketPcts[b] = pct(c, rated.length);
    });
    return {
      avgRate: rated.length ? Math.round((rated.reduce((s, r) => s + toNum(r.Rate, 0), 0) / rated.length) * 100) / 100 : 0,
      ratedCount: rated.length, ratedCount_pct: pct(rated.length, totalAll),
      noRatingCount: noRating, noRatingCount_pct: pct(noRating, totalAll),
      buckets, bucketPcts,
      // raw per-row data for client-side SuperType filtering
      rows: rowsAll.map((r) => ({ rate: toNum(r.Rate, 0), bucket: r._RateBucket, superTypeId: toNum(r.SuperTypeID, null) })),
    };
  }

  const ratingByCity = {};
  const byCityAllRating = groupBy(df, (r) => r.City);
  for (const [city, cAllRows] of byCityAllRating) {
    const areas = {};
    const byAreaRating = groupBy(cAllRows, (r) => r._MarketingAreaName);
    for (const [area, aRows] of byAreaRating) {
      areas[area] = ratingBlock(aRows);
    }
    ratingByCity[city] = { ...ratingBlock(cAllRows), areas };
  }
  const overallRatingBlock = ratingBlock(df);

  // ============================================================
  // MODULE 4: ORDER SHARE & ENGAGEMENT (from Order sheet)
  // ============================================================
  const orderShareByCity = {};
  const byCityOrder = groupBy(orderRaw, (r) => r.City);

  function windowStats(rows) {
    const m41 = rows.reduce((s, r) => s + toNum(r.M41VO, 0), 0);
    const plat = rows.reduce((s, r) => s + toNum(r.VPFO, 0), 0);
    const shares = rows.map((r) => toNum(r.M41_V_OS, null)).filter((v) => v !== null);
    const marketShares = rows.map((r) => toNum(r.V_Pl_OS, null)).filter((v) => v !== null);
    const orderedVendorCount = new Set(rows.filter((r) => toNum(r.M41VO, 0) > 0).map((r) => r.VendorID)).size;
    return {
      m41Orders: m41, platformOrders: plat,
      avgVendorM41Share: shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0,
      avgVendorMarketShare: marketShares.length ? marketShares.reduce((a, b) => a + b, 0) / marketShares.length : 0,
      orderedVendorCount,
      ordersPerOrderedVendor: orderedVendorCount ? m41 / orderedVendorCount : 0,
    };
  }
  function windowStatsMtd(rows) {
    const m41 = rows.reduce((s, r) => s + toNum(r.NewMonthM41VO, 0), 0);
    const plat = rows.reduce((s, r) => s + toNum(r.NewMonthVPFO, 0), 0);
    const shares = rows.map((r) => toNum(r.NewMonth_M41_V_OS, null)).filter((v) => v !== null);
    const marketShares = rows.map((r) => toNum(r.NewMonth_V_Pl_OS, null)).filter((v) => v !== null);
    const orderedVendorCount = new Set(rows.filter((r) => toNum(r.NewMonthM41VO, 0) > 0).map((r) => r.VendorID)).size;
    return {
      m41Orders: m41, platformOrders: plat,
      avgVendorM41Share: shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0,
      avgVendorMarketShare: marketShares.length ? marketShares.reduce((a, b) => a + b, 0) / marketShares.length : 0,
      orderedVendorCount,
      ordersPerOrderedVendor: orderedVendorCount ? m41 / orderedVendorCount : 0,
    };
  }

  // Area-level "M4O share of total platform orders" = sum(M41VO) / sum(AreaPlatformOrders per UNIQUE area)
  // AreaPlatformOrders repeats per vendor row within an area, so we take it once per area.
  function areaPlatformTotal(rows, field) {
    const seenAreas = new Map();
    for (const r of rows) {
      const key = r.MarketingAreaName;
      if (!seenAreas.has(key)) seenAreas.set(key, toNum(r[field], 0));
    }
    return [...seenAreas.values()].reduce((a, b) => a + b, 0);
  }

  for (const [city, cRows] of byCityOrder) {
    const areas = {};
    const byArea = groupBy(cRows, (r) => r.MarketingAreaName);
    for (const [area, aRows] of byArea) {
      const areaPlatformY = areaPlatformTotal(aRows, 'AreaPlatformOrders');
      const areaPlatformMtd = areaPlatformTotal(aRows, 'NewMonthAreaPlatformOrders');
      const wsY = windowStats(aRows);
      const wsMtd = windowStatsMtd(aRows);
      areas[area] = {
        vendorCount: new Set(aRows.map((r) => r.VendorID)).size,
        yesterday: { ...wsY, areaPlatformOrders: areaPlatformY, areaM4OShare: areaPlatformY ? wsY.m41Orders / areaPlatformY : 0 },
        mtd: { ...wsMtd, areaPlatformOrders: areaPlatformMtd, areaM4OShare: areaPlatformMtd ? wsMtd.m41Orders / areaPlatformMtd : 0 },
        rows: aRows.map((r) => ({ superTypeId: toNum(r.SuperTypeID, null), m41Y: toNum(r.M41VO, 0), platY: toNum(r.VPFO, 0), m41Mtd: toNum(r.NewMonthM41VO, 0), platMtd: toNum(r.NewMonthVPFO, 0) })),
      };
    }
    const areaPlatformYCity = areaPlatformTotal(cRows, 'AreaPlatformOrders');
    const areaPlatformMtdCity = areaPlatformTotal(cRows, 'NewMonthAreaPlatformOrders');
    const wsYCity = windowStats(cRows);
    const wsMtdCity = windowStatsMtd(cRows);
    orderShareByCity[city] = {
      vendorCount: new Set(cRows.map((r) => r.VendorID)).size,
      yesterday: { ...wsYCity, areaPlatformOrders: areaPlatformYCity, areaM4OShare: areaPlatformYCity ? wsYCity.m41Orders / areaPlatformYCity : 0 },
      mtd: { ...wsMtdCity, areaPlatformOrders: areaPlatformMtdCity, areaM4OShare: areaPlatformMtdCity ? wsMtdCity.m41Orders / areaPlatformMtdCity : 0 },
      areas,
    };
  }

  const overallYesterday = windowStats(orderRaw);
  overallYesterday.share = overallYesterday.platformOrders ? overallYesterday.m41Orders / overallYesterday.platformOrders : 0;
  const overallMtd = windowStatsMtd(orderRaw);
  overallMtd.share = overallMtd.platformOrders ? overallMtd.m41Orders / overallMtd.platformOrders : 0;

  // ---- Project-wide "M4O share of TOTAL platform orders" (not just M4O vendors) ----
  // Uses AreaPlatformOrders per UNIQUE (City, MarketingAreaName) pair, summed across the whole project.
  function projectAreaPlatformTotal(field) {
    const seen = new Map();
    for (const r of orderRaw) {
      const key = `${r.City}|${r.MarketingAreaName}`;
      if (!seen.has(key)) seen.set(key, toNum(r[field], 0));
    }
    return [...seen.values()].reduce((a, b) => a + b, 0);
  }
  const projectAreaPlatformY = projectAreaPlatformTotal('AreaPlatformOrders');
  const projectAreaPlatformMtd = projectAreaPlatformTotal('NewMonthAreaPlatformOrders');
  overallYesterday.areaPlatformOrders = projectAreaPlatformY;
  overallYesterday.areaM4OShare = projectAreaPlatformY ? overallYesterday.m41Orders / projectAreaPlatformY : 0;
  overallMtd.areaPlatformOrders = projectAreaPlatformMtd;
  overallMtd.areaM4OShare = projectAreaPlatformMtd ? overallMtd.m41Orders / projectAreaPlatformMtd : 0;

  // ---- Ordered / unordered vendor % (both windows) ----
  const totalVendorsInOrder = new Set(orderRaw.map((r) => r.VendorID)).size;
  const vendorOrderedYIds = new Set(orderRaw.filter((r) => toNum(r.M41VO, 0) > 0).map((r) => r.VendorID));
  const vendorOrderedMtdIds = new Set(orderRaw.filter((r) => toNum(r.NewMonthM41VO, 0) > 0).map((r) => r.VendorID));
  const orderedVendorsPct = {
    yesterday: {
      ordered: vendorOrderedYIds.size, ordered_pct: pct(vendorOrderedYIds.size, totalVendorsInOrder),
      unordered: totalVendorsInOrder - vendorOrderedYIds.size, unordered_pct: pct(totalVendorsInOrder - vendorOrderedYIds.size, totalVendorsInOrder),
    },
    mtd: {
      ordered: vendorOrderedMtdIds.size, ordered_pct: pct(vendorOrderedMtdIds.size, totalVendorsInOrder),
      unordered: totalVendorsInOrder - vendorOrderedMtdIds.size, unordered_pct: pct(totalVendorsInOrder - vendorOrderedMtdIds.size, totalVendorsInOrder),
    },
  };

  const packsOrderedY = df.filter((r) => vendorOrderedYIds.has(r.VendorID)).length;
  const packsOrderedMtd = df.filter((r) => vendorOrderedMtdIds.has(r.VendorID)).length;
  const totalPacks = df.length;
  const orderedPacksPct = {
    yesterday: {
      ordered: packsOrderedY, ordered_pct: pct(packsOrderedY, totalPacks),
      unordered: totalPacks - packsOrderedY, unordered_pct: pct(totalPacks - packsOrderedY, totalPacks),
    },
    mtd: {
      ordered: packsOrderedMtd, ordered_pct: pct(packsOrderedMtd, totalPacks),
      unordered: totalPacks - packsOrderedMtd, unordered_pct: pct(totalPacks - packsOrderedMtd, totalPacks),
    },
  };

  // ---- TopCritical engagement: numerator = TopCritical vendors with NewMonthM41VO>0 (MTD) ----
  const topcMatched = orderRaw.filter((r) => topcIds.has(String(r.VendorID)));
  const engagedIds = new Set(topcMatched.filter((r) => toNum(r.NewMonthM41VO, 0) > 0).map((r) => String(r.VendorID)));
  const topCriticalEngagement = {
    denominator: topcIds.size,
    numerator: engagedIds.size,
    rate: topcIds.size ? engagedIds.size / topcIds.size : 0,
  };

  // ============================================================
  // MODULE 5: KITCHEN (dedicated view of Kitchen==1 vendors/packs)
  // ============================================================
  const kitchenPacks = df.filter((r) => r._IsKitchen);
  const kitchenVendorSeen = new Map();
  for (const r of kitchenPacks) {
    if (!kitchenVendorSeen.has(r.VendorID)) kitchenVendorSeen.set(r.VendorID, r);
  }
  const kitchenVendorRows = [...kitchenVendorSeen.values()];

  function kitchenVendorEntry(v) {
    const orderRow = orderRowByVendor.get(String(v.VendorID));
    const packsForVendor = kitchenPacks.filter((p) => p.VendorID === v.VendorID);
    const ratedPacks = packsForVendor.filter((p) => p._RateBucket !== null);
    return {
      id: v.VendorID,
      name: v.Title,
      city: v.City,
      area: v._MarketingAreaName,
      segment: v.VendorTier || 'Unknown',
      topCritical: v._IsTopCritical,
      packCount: packsForVendor.length,
      avgRate: ratedPacks.length ? Math.round((ratedPacks.reduce((s, p) => s + toNum(p.Rate, 0), 0) / ratedPacks.length) * 100) / 100 : null,
      ratedPackCount: ratedPacks.length,
      ordersYesterday: orderRow ? toNum(orderRow.M41VO, 0) : 0,
      ordersMtd: orderRow ? toNum(orderRow.NewMonthM41VO, 0) : 0,
      platformOrdersYesterday: orderRow ? toNum(orderRow.VPFO, 0) : 0,
      platformOrdersMtd: orderRow ? toNum(orderRow.NewMonthVPFO, 0) : 0,
      m4oShareYesterday: orderRow && toNum(orderRow.VPFO, 0) ? toNum(orderRow.M41VO, 0) / toNum(orderRow.VPFO, 0) : null,
      m4oShareMtd: orderRow && toNum(orderRow.NewMonthVPFO, 0) ? toNum(orderRow.NewMonthM41VO, 0) / toNum(orderRow.NewMonthVPFO, 0) : null,
    };
  }

  const kitchenVendors = kitchenVendorRows.map(kitchenVendorEntry);
  const kitchenByCity = groupBy(kitchenVendors, (v) => v.city);
  const kitchenCityBlocks = {};
  for (const [city, vendors] of kitchenByCity) {
    const areas = {};
    const byArea = groupBy(vendors, (v) => v.area);
    for (const [area, aVendors] of byArea) {
      const areaPacks = kitchenPacks.filter((p) => aVendors.some((v) => v.id === p.VendorID));
      areas[area] = {
        vendorCount: aVendors.length,
        packCount: areaPacks.length,
        vendors: aVendors,
      };
    }
    const cityPacks = kitchenPacks.filter((p) => vendors.some((v) => v.id === p.VendorID));
    kitchenCityBlocks[city] = {
      vendorCount: vendors.length,
      packCount: cityPacks.length,
      areas,
    };
  }

  const kitchenRatedPacks = kitchenPacks.filter((r) => r._RateBucket !== null);
  const kitchenOverall = {
    vendorCount: kitchenVendorRows.length,
    packCount: kitchenPacks.length,
    avgRate: kitchenRatedPacks.length ? Math.round((kitchenRatedPacks.reduce((s, r) => s + toNum(r.Rate, 0), 0) / kitchenRatedPacks.length) * 100) / 100 : 0,
    ratedPackCount: kitchenRatedPacks.length,
    ordersYesterday: kitchenVendors.reduce((s, v) => s + v.ordersYesterday, 0),
    ordersMtd: kitchenVendors.reduce((s, v) => s + v.ordersMtd, 0),
    platformOrdersYesterday: kitchenVendors.reduce((s, v) => s + v.platformOrdersYesterday, 0),
    platformOrdersMtd: kitchenVendors.reduce((s, v) => s + v.platformOrdersMtd, 0),
  };
  kitchenOverall.m4oShareYesterday = kitchenOverall.platformOrdersYesterday ? kitchenOverall.ordersYesterday / kitchenOverall.platformOrdersYesterday : 0;
  kitchenOverall.m4oShareMtd = kitchenOverall.platformOrdersMtd ? kitchenOverall.ordersMtd / kitchenOverall.platformOrdersMtd : 0;

  // Kitchen vendors' share of ALL M4O orders (project-wide) — how much of total M4O volume comes from Kitchen vendors
  const totalM41Y = orderRaw.reduce((s, r) => s + toNum(r.M41VO, 0), 0);
  const totalM41Mtd = orderRaw.reduce((s, r) => s + toNum(r.NewMonthM41VO, 0), 0);
  kitchenOverall.shareOfAllM4OYesterday = totalM41Y ? kitchenOverall.ordersYesterday / totalM41Y : 0;
  kitchenOverall.shareOfAllM4OMtd = totalM41Mtd ? kitchenOverall.ordersMtd / totalM41Mtd : 0;

  // ---- Non-Kitchen comparison block (same shape as kitchenOverall) ----
  const nonKitchenPacks = df.filter((r) => !r._IsKitchen);
  const nonKitchenVendorSeen = new Map();
  for (const r of nonKitchenPacks) {
    if (!nonKitchenVendorSeen.has(r.VendorID)) nonKitchenVendorSeen.set(r.VendorID, r);
  }
  const nonKitchenVendorRows = [...nonKitchenVendorSeen.values()];
  const nonKitchenVendors = nonKitchenVendorRows.map((v) => {
    const orderRow = orderRowByVendor.get(String(v.VendorID));
    return {
      ordersYesterday: orderRow ? toNum(orderRow.M41VO, 0) : 0,
      ordersMtd: orderRow ? toNum(orderRow.NewMonthM41VO, 0) : 0,
      platformOrdersYesterday: orderRow ? toNum(orderRow.VPFO, 0) : 0,
      platformOrdersMtd: orderRow ? toNum(orderRow.NewMonthVPFO, 0) : 0,
    };
  });
  const nonKitchenRatedPacks = nonKitchenPacks.filter((r) => r._RateBucket !== null);
  const nonKitchenOverall = {
    vendorCount: nonKitchenVendorRows.length,
    packCount: nonKitchenPacks.length,
    avgRate: nonKitchenRatedPacks.length ? Math.round((nonKitchenRatedPacks.reduce((s, r) => s + toNum(r.Rate, 0), 0) / nonKitchenRatedPacks.length) * 100) / 100 : 0,
    ratedPackCount: nonKitchenRatedPacks.length,
    ordersYesterday: nonKitchenVendors.reduce((s, v) => s + v.ordersYesterday, 0),
    ordersMtd: nonKitchenVendors.reduce((s, v) => s + v.ordersMtd, 0),
    platformOrdersYesterday: nonKitchenVendors.reduce((s, v) => s + v.platformOrdersYesterday, 0),
    platformOrdersMtd: nonKitchenVendors.reduce((s, v) => s + v.platformOrdersMtd, 0),
  };
  nonKitchenOverall.m4oShareYesterday = nonKitchenOverall.platformOrdersYesterday ? nonKitchenOverall.ordersYesterday / nonKitchenOverall.platformOrdersYesterday : 0;
  nonKitchenOverall.m4oShareMtd = nonKitchenOverall.platformOrdersMtd ? nonKitchenOverall.ordersMtd / nonKitchenOverall.platformOrdersMtd : 0;
  nonKitchenOverall.shareOfAllM4OYesterday = totalM41Y ? nonKitchenOverall.ordersYesterday / totalM41Y : 0;
  nonKitchenOverall.shareOfAllM4OMtd = totalM41Mtd ? nonKitchenOverall.ordersMtd / totalM41Mtd : 0;
  // avg discount (Kitchen packs are always excluded from this metric anyway — here it's just the non-Kitchen average, same number as packDistribution.avgSnappDiscountToman)
  nonKitchenOverall.avgSnappDiscountToman = avgDiscountKitchenOnly(nonKitchenPacks);
  kitchenOverall.avgSnappDiscountToman = null; // not meaningful for Kitchen packs at this scale — see README

  const kitchenModule = { overall: kitchenOverall, nonKitchenOverall, byCity: kitchenCityBlocks };

  // ============================================================
  // MODULE 6: COVERAGE MODEL (live from the Coverage_Radius sheet, + All Cities aggregate)
  // ============================================================
  const cityCoverage = {};

  const byCoverageCity = groupBy(cityCoverageRaw, (r) => r.City);
  for (const [city, cRows] of byCoverageCity) {
    const scopes = {};
    for (const row of cRows) {
      scopes[row.scope] = {
        status: row.city_status,
        totalUsers: toNum(row.total_users),
        elite: { users: toNum(row.Elite_users), pct: toNum(row.Elite_pct) },
        healthy: { users: toNum(row.Healthy_users), pct: toNum(row.Healthy_pct) },
        moderate: { users: toNum(row.Moderate_users), pct: toNum(row.Moderate_pct) },
        eliteCumulative: toNum(row.Elite_cumulative),
        healthyCumulative: toNum(row.Healthy_cumulative),
        moderateCumulative: toNum(row.Moderate_cumulative),
      };
    }
    cityCoverage[city] = scopes;
  }

  // "All Cities" aggregate — weighted by total_users, recomputed per scope
  const scopesPresent = [...new Set(cityCoverageRaw.map((r) => r.scope))];
  const allCitiesScopes = {};
  for (const scope of scopesPresent) {
    const rowsForScope = cityCoverageRaw.filter((r) => r.scope === scope);
    const totalUsers = rowsForScope.reduce((s, r) => s + toNum(r.total_users), 0);
    const eliteUsers = rowsForScope.reduce((s, r) => s + toNum(r.Elite_users), 0);
    const healthyUsers = rowsForScope.reduce((s, r) => s + toNum(r.Healthy_users), 0);
    const moderateUsers = rowsForScope.reduce((s, r) => s + toNum(r.Moderate_users), 0);
    allCitiesScopes[scope] = {
      status: null, // no single status makes sense for an aggregate
      totalUsers,
      elite: { users: eliteUsers, pct: pct(eliteUsers, totalUsers) },
      healthy: { users: healthyUsers, pct: pct(healthyUsers, totalUsers) },
      moderate: { users: moderateUsers, pct: pct(moderateUsers, totalUsers) },
      eliteCumulative: pct(eliteUsers, totalUsers),
      healthyCumulative: pct(eliteUsers + healthyUsers, totalUsers),
      moderateCumulative: pct(eliteUsers + healthyUsers + moderateUsers, totalUsers),
    };
  }
  cityCoverage['All Cities'] = allCitiesScopes;

  const coverageResult = {};
  const byCoverageResultCity = groupBy(coverageResultRaw, (r) => r.City);
  for (const [city, cRows] of byCoverageResultCity) {
    const areas = {};
    for (const row of cRows) {
      areas[row.MarketingAreaName] = {
        status: row.status,
        totalUsers: toNum(row.total_user_count),
        elite: { users: toNum(row.Elite_users), pct: toNum(row.Elite_pct) },
        healthy: { users: toNum(row.Healthy_users), pct: toNum(row.Healthy_pct) },
        moderate: { users: toNum(row.Moderate_users), pct: toNum(row.Moderate_pct) },
        low: { users: toNum(row.Low_users), pct: toNum(row.Low_pct) },
        totalClusters: toNum(row.total_clusters),
        avgProductsPerCluster: toNum(row.avg_products_per_cluster),
        avgSuperPerCluster: toNum(row.avg_super_per_cluster),
      };
    }
    coverageResult[city] = areas;
  }

  const coverageModel = { cityCoverage, coverageResult };
  console.log(`  Coverage Model processed (${Object.keys(cityCoverage).length} cities incl. "All Cities")`);

  // ============================================================
  // MODULE 7: IMPRESSION (yesterday, per pack, half-hour buckets)
  // ============================================================
  const mainByPackId = new Map();
  for (const r of df) mainByPackId.set(String(r.PackID), r);

  // Only packs that actually picked up at least one impression count as
  // "seen" — a sheet row with total_impression==0 isn't a pack a user saw.
  const impressionPacks = impressionRows.map((r) => {
    const main = mainByPackId.get(String(r.PackID));
    return {
      packId: r.PackID,
      title: main ? main.full_title : r.full_title,
      vendorId: r.VendorID,
      vendorName: main ? main.Title : r.Title,
      city: r.City,
      area: main ? main._MarketingAreaName : 'Unknown',
      dealType: main ? (main.DealType || 'Unknown') : 'Unknown',
      kitchen: main ? !!main._IsKitchen : false,
      segment: main ? (main.VendorTier || 'Unknown') : 'Unknown',
      topCritical: main ? !!main._IsTopCritical : false,
      vendorClass: vendorClassByVendorId.get(String(r.VendorID)) || 'Unknown',
      superTypeId: main ? toNum(main.SuperTypeID, null) : null,
      total: r.total_impression,
      bySlot: r.bySlot,
    };
  }).filter((p) => p.total > 0);

  function impressionAgg(packs) {
    const total = packs.reduce((s, p) => s + p.total, 0);
    const bySlot = new Array(34).fill(0);
    packs.forEach((p) => p.bySlot.forEach((v, i) => { bySlot[i] += v; }));
    const vendorCount = new Set(packs.map((p) => p.vendorId)).size;
    const kitchenTotal = packs.filter((p) => p.kitchen).reduce((s, p) => s + p.total, 0);
    const segATotal = packs.filter((p) => p.segment === 'A').reduce((s, p) => s + p.total, 0);
    const segBTotal = packs.filter((p) => p.segment === 'B').reduce((s, p) => s + p.total, 0);
    const dealTypeTotals = {};
    const dealTypePcts = {};
    DEAL_TYPES.forEach((dt) => {
      const t = packs.filter((p) => p.dealType === dt).reduce((s, p) => s + p.total, 0);
      dealTypeTotals[dt] = t;
      dealTypePcts[dt] = pct(t, total);
    });
    return {
      total, packCount: packs.length, vendorCount,
      avgPerPack: packs.length ? Math.round(total / packs.length) : 0,
      bySlot,
      kitchenTotal, kitchenTotal_pct: pct(kitchenTotal, total),
      nonKitchenTotal: total - kitchenTotal, nonKitchenTotal_pct: pct(total - kitchenTotal, total),
      segATotal, segATotal_pct: pct(segATotal, total),
      segBTotal, segBTotal_pct: pct(segBTotal, total),
      dealTypeTotals, dealTypePcts,
    };
  }

  const impressionByCity = {};
  const byCityImp = groupBy(impressionPacks, (p) => p.city);
  for (const [city, cPacks] of byCityImp) {
    const areas = {};
    const byAreaImp = groupBy(cPacks, (p) => p.area);
    for (const [area, aPacks] of byAreaImp) {
      areas[area] = { ...impressionAgg(aPacks), packs: aPacks };
    }
    impressionByCity[city] = { ...impressionAgg(cPacks), areas };
  }
  const overallImpression = impressionAgg(impressionPacks);

  // ---- Vendor-level Impression → M4O Order conversion ----
  // Impressions only cover the Meal4One carousel, so only M4O orders (not
  // total platform orders) are a meaningful numerator here. The Order sheet
  // has no per-pack order breakdown, so conversion can't go below vendor level.
  const impByVendor = groupBy(impressionPacks, (p) => p.vendorId);
  const conversionVendors = [...impByVendor.entries()].map(([vendorId, vPacks]) => {
    const totalImpression = vPacks.reduce((s, p) => s + p.total, 0);
    const orderRow = orderRowByVendor.get(String(vendorId));
    const ordersYesterday = orderRow ? toNum(orderRow.M41VO, 0) : 0;
    return {
      id: vendorId,
      name: vPacks[0].vendorName,
      city: vPacks[0].city,
      area: vPacks[0].area,
      segment: vPacks[0].segment,
      kitchen: vPacks.some((p) => p.kitchen),
      topCritical: vPacks.some((p) => p.topCritical),
      vendorClass: vPacks[0].vendorClass,
      packCount: vPacks.length,
      totalImpression,
      ordersYesterday,
      conversion: totalImpression ? ordersYesterday / totalImpression : null,
    };
  }).sort((a, b) => b.totalImpression - a.totalImpression);

  // ---- Order-to-Impression conversion rolled up by geography & vendor segment ----
  function conversionAgg(vendors) {
    const totalImpression = vendors.reduce((s, v) => s + v.totalImpression, 0);
    const ordersYesterday = vendors.reduce((s, v) => s + v.ordersYesterday, 0);
    return {
      vendorCount: vendors.length,
      totalImpression, ordersYesterday,
      conversion: totalImpression ? ordersYesterday / totalImpression : null,
    };
  }
  const conversionByCity = {};
  for (const [city, vs] of groupBy(conversionVendors, (v) => v.city)) conversionByCity[city] = conversionAgg(vs);
  const conversionByArea = {};
  for (const [, vs] of groupBy(conversionVendors, (v) => `${v.city}|${v.area}`)) {
    conversionByArea[vs[0].city] = conversionByArea[vs[0].city] || {};
    conversionByArea[vs[0].city][vs[0].area] = conversionAgg(vs);
  }
  const conversionBySegment = { Kitchen: conversionAgg(conversionVendors.filter((v) => v.kitchen)) };
  for (const [seg, vs] of groupBy(conversionVendors.filter((v) => !v.kitchen), (v) => vendorSegmentClass(v.vendorClass))) {
    conversionBySegment[seg] = conversionAgg(vs);
  }

  const impressionModule = {
    timeSlots: TIME_SLOTS,
    overall: overallImpression,
    byCity: impressionByCity,
    conversion: {
      vendors: conversionVendors,
      byCity: conversionByCity,
      byArea: conversionByArea,
      bySegment: conversionBySegment,
    },
  };
  console.log(`  Impression processed: ${impressionPacks.length} packs, ${overallImpression.total} total impressions`);

  // ============================================================
  // MODULE 8: CPO BUDGET (month-to-date, Gregorian month, updated daily)
  // ============================================================
  const cpoVendors = cpoRows.map((r) => ({
    id: r.VendorID,
    name: r.VendorTitle,
    city: r.City,
    area: r.MarketingAreaName,
    vendorClass: r.VendorClass || 'Unknown',
    vendorTier: r.VendorTier || 'Unknown',
    newVendorClass: r.new_VendorClass || 'Unknown',
    kitchen: toNum(r.Kitchen, 0) === 1,
    decile: toNum(r.Decile, null),
    segment: r.Segment || 'Unknown',
    subsidyBudget: toNum(r.Product_Subsidy_Budget_new, 0),
    freeDeliveryBudget: toNum(r.Free_Delivery_Budget_new, 0),
    totalBudget: toNum(r.new_total_budget, 0),
    m4oOrders: toNum(r.M41_Orders, 0),
    totalSold: toNum(r.TotalSold, 0),
  }));

  // Every budget figure also carries its % of the project-wide grand total for
  // that same metric (totalBudget_pct, subsidyBudget_pct, freeDeliveryBudget_pct)
  // — a raw Toman number alone doesn't say whether a city/segment is 2% or 40%
  // of spend, so refs (the grand totals) are threaded through every breakdown.
  function cpoMetrics(rows, refs) {
    const subsidyBudget = rows.reduce((s, r) => s + r.subsidyBudget, 0);
    const freeDeliveryBudget = rows.reduce((s, r) => s + r.freeDeliveryBudget, 0);
    const totalBudget = rows.reduce((s, r) => s + r.totalBudget, 0);
    const m4oOrders = rows.reduce((s, r) => s + r.m4oOrders, 0);
    const totalSold = rows.reduce((s, r) => s + r.totalSold, 0);
    const ref = refs || { totalBudget, subsidyBudget, freeDeliveryBudget };
    return {
      vendorCount: rows.length,
      subsidyBudget, freeDeliveryBudget, totalBudget, m4oOrders, totalSold,
      subsidyBudget_pct: pct(subsidyBudget, ref.subsidyBudget),
      freeDeliveryBudget_pct: pct(freeDeliveryBudget, ref.freeDeliveryBudget),
      totalBudget_pct: pct(totalBudget, ref.totalBudget),
      cpo: m4oOrders ? totalBudget / m4oOrders : null,
      freeDeliveryCpo: m4oOrders ? freeDeliveryBudget / m4oOrders : null,
      subsidyCps: totalSold ? subsidyBudget / totalSold : null,
    };
  }
  function vendorCpoFields(v) {
    return {
      cpo: v.m4oOrders ? v.totalBudget / v.m4oOrders : null,
      freeDeliveryCpo: v.m4oOrders ? v.freeDeliveryBudget / v.m4oOrders : null,
      subsidyCps: v.totalSold ? v.subsidyBudget / v.totalSold : null,
    };
  }
  const grandTotalRefs = cpoMetrics(cpoVendors); // self-referential: 100% of itself
  const cpoRefs = { totalBudget: grandTotalRefs.totalBudget, subsidyBudget: grandTotalRefs.subsidyBudget, freeDeliveryBudget: grandTotalRefs.freeDeliveryBudget };

  const nonKitchenCpoVendors = cpoVendors.filter((v) => !v.kitchen);
  const kitchenCpoVendors = cpoVendors.filter((v) => v.kitchen);

  const cpoByCity = {};
  const byCityCpo = groupBy(cpoVendors, (v) => v.city);
  for (const [city, cVendors] of byCityCpo) {
    const areas = {};
    const byAreaCpo = groupBy(cVendors, (v) => v.area);
    for (const [area, aVendors] of byAreaCpo) {
      areas[area] = {
        ...cpoMetrics(aVendors, cpoRefs),
        vendors: aVendors.map((v) => ({ ...v, ...vendorCpoFields(v) })),
      };
    }
    cpoByCity[city] = { ...cpoMetrics(cVendors, cpoRefs), areas };
  }

  const nonKitchenBySegment = {};
  for (const [seg, rows] of groupBy(nonKitchenCpoVendors, (v) => vendorSegmentClass(v.vendorClass))) {
    nonKitchenBySegment[seg] = cpoMetrics(rows, cpoRefs);
  }

  const cpoBudgetModule = {
    overall: {
      all: grandTotalRefs,
      nonKitchen: {
        total: cpoMetrics(nonKitchenCpoVendors, cpoRefs),
        bySegment: nonKitchenBySegment,
      },
      kitchen: { total: cpoMetrics(kitchenCpoVendors, cpoRefs) },
    },
    byCity: cpoByCity,
  };
  console.log(`  CPO Budget processed: ${cpoVendors.length} vendors, total budget ${Math.round(cpoBudgetModule.overall.all.totalBudget)} T`);

  // ============================================================
  // ASSEMBLE + WRITE
  // ============================================================
  const output = {
    generatedAt: new Date().toISOString(),
    meta: {
      totalVendorsFiltered: vendorLevel.length,
      totalPacksFiltered: df.length,
      cities: [...byCity.keys()].sort(),
      superTypeIds,
    },
    vendorCoverage,
    packDistribution: { ...overallPackBlock, byCity: packDistByCity },
    rating: { ...overallRatingBlock, byCity: ratingByCity },
    orderShare: {
      overallYesterday,
      overallMtd,
      orderedVendorsPct,
      orderedPacksPct,
      byCity: orderShareByCity,
    },
    topCriticalEngagement,
    kitchen: kitchenModule,
    coverageModel,
    impression: impressionModule,
    cpoBudget: cpoBudgetModule,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nWrote ${OUTPUT_PATH}`);
  console.log(`  Vendors: ${output.meta.totalVendorsFiltered}, Packs: ${output.meta.totalPacksFiltered}, Cities: ${output.meta.cities.length}`);
  console.log(`  SuperTypeIDs: ${superTypeIds.join(', ')}`);
  console.log(`  Top Critical engagement: ${topCriticalEngagement.numerator}/${topCriticalEngagement.denominator} (${(topCriticalEngagement.rate * 100).toFixed(1)}%)`);

  // Encrypt the freshly-written JSON into dashboard_data.enc.
  // Only the .enc file should ever be committed/pushed — the plaintext
  // dashboard_data.json stays local (see .gitignore).
  const { encryptDashboardData } = require('./encrypt');
  encryptDashboardData();

  console.log('\nOpen dashboard.html in your browser to view the updated dashboard.');
}

main().catch((err) => {
  console.error('Failed to update dashboard:', err.message);
  if (err.message.includes('ENOENT') && err.message.includes('service-account')) {
    console.error('\n→ Place your service-account JSON key file at:', SERVICE_ACCOUNT_KEY_PATH);
  }
  if (SPREADSHEET_ID === 'PASTE_YOUR_SPREADSHEET_ID_HERE') {
    console.error('\n→ Set SPREADSHEET_ID at the top of this file to your main data Google Sheet ID.');
  }
  if (COVERAGE_SPREADSHEET_ID === 'PASTE_YOUR_COVERAGE_SPREADSHEET_ID_HERE') {
    console.error('\n→ Set COVERAGE_SPREADSHEET_ID at the top of this file to your Coverage_Radius Google Sheet ID.');
  }
  if (err.message.includes('not found') || err.message.includes('404')) {
    console.error('\n→ "Requested entity was not found" usually means: the SPREADSHEET_ID is wrong/placeholder, OR the sheet has not been shared with the service account email as Viewer.');
  }
  process.exit(1);
});
