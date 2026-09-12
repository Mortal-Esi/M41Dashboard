# Meal4One Dashboard

## Setup (one time)

1. Install dependencies:
   ```
   npm install
   ```

2. Place your Google service-account key file in this folder, named:
   ```
   service-account.json
   ```
   (Already have one from earlier — just copy it here and rename it.)

3. Share **both** Google Sheets with the service account's email
   (found in the `client_email` field of the key file) as **Viewer**:
   - The main data sheet (MainData / Order / TopCritical / BI)
   - The Coverage Model sheet (CityCoverage / CoverageResult)

4. Open `update_dashboard.js` and set both IDs near the top —
   copy each from its sheet's URL:
   ```
   https://docs.google.com/spreadsheets/d/[SPREADSHEET_ID]/edit
   ```
   - `SPREADSHEET_ID` → the main data sheet
   - `COVERAGE_SPREADSHEET_ID` → the Coverage Model sheet

## Every time you want to refresh the dashboard

```
node update_dashboard.js
```

This reads all six tabs across both sheets, re-runs all the
aggregations, and overwrites `dashboard_data.json`.

Then just open (or refresh) `dashboard.html` in your browser.

## Filtering & calculation rules baked into the script

- **Pack filter**: keep a pack if `Activity == 1`, OR if `Activity == 0`
  AND `PO > 0` (it had a platform order yesterday despite being inactive
  now). Everything else is dropped.
- **Marketing Area**: joined onto MainData by VendorID — first from
  the Order sheet, and for vendors not found there, from the BI sheet
  as a fallback (BI has exactly one Area per vendor, no ambiguity).
  Vendors matched in neither are labeled "Unknown" (only ~2 vendors
  in the original snapshot).
- **Segment A/B**: MainData's own `VendorTier` column.
- **Top Critical universe**: the full TopCritical sheet (217 vendors in
  the original snapshot) is the denominator for engagement. The
  numerator is how many of those vendors have `NewMonthM41VO > 0` in
  the Order sheet (i.e. had a Meal4One order this month).
- **Kitchen tag**: `Kitchen == 1` on a pack or vendor (MainData column
  F). Shown as a badge in Vendor Coverage and Pack Distribution.
- **Snapp discount (Toman)**: `price × (DiscountSFRatio / 100)`, but
  the **average** (`avgSnappDiscountToman`, shown as "Avg Snapp
  Discount (non-Kitchen)") is computed from `Kitchen == 0` packs only.
  Kitchen==1 vendors have a structurally different cost/discount model,
  so mixing them in would skew the number. Pack counts and DealType
  breakdowns still include both Kitchen values — only the discount
  average excludes Kitchen==1.
- **Subsidy metrics** (two separate, independent measures):
  - *Discount subsidy*: `DiscountSFRatio > 0`
  - *Coupon subsidy*: `CouponSFShare > 0`
  At the pack level, each pack is checked directly. At the vendor
  level, a vendor counts as "has discount/coupon subsidy" if **any**
  one of its active packs has it.
- **Vendor Type filter** (labeled "Vendor Type" in the UI, shown as
  Restaurant / Cafe / Juice / Non-Food): a global filter applied to
  every tab except Coverage Model, based on MainData's `SuperTypeID`
  column (`1`=Restaurant, `2`=Cafe, `3`=Juice, everything else grouped
  as Non-Food). All stat blocks recompute live in the browser when a
  type is selected. Ordered/Unordered totals on the Order Share tab
  are not affected by this filter (that split has no per-row
  SuperTypeID in the source data).
- **Area-level M4O share of total platform orders**: for each
  Marketing Area (and rolled up per city), `sum(M41VO) /
  sum(AreaPlatformOrders)` — using each area's `AreaPlatformOrders`
  once (it's a repeated per-vendor-row stat, not a per-vendor value).
  Same for the MTD window with `NewMonthM41VO` /
  `NewMonthAreaPlatformOrders`. Shown as its own column in the Order
  Share city table, clearly separate from the M4O-vendors-only share.
- **M4O Area Share** (vendor level): a vendor's Meal4One orders as a
  fraction of ALL Meal4One orders placed with vendors in the same
  Marketing Area — distinct from Market Share (`V_Pl_OS`, this
  vendor's share of the area's *total platform* orders). Both are
  shown inline in the vendor table on Vendor Coverage, with a
  Yesterday/MTD toggle — no need to open the vendor detail page.
- **Project-wide "M4O Share of Total Platform Orders"**: shown as a
  card on the Order Share tab (Vendor Type filter = All only), using
  the same `AreaPlatformOrders`-per-unique-area logic as the
  per-city breakdown, rolled up across the whole project.
- **Kitchen tab**: a dedicated view of `Kitchen == 1` vendors/packs —
  vendor and pack counts per city/Marketing Area, order volume,
  M4O share, and average rating, plus each Kitchen vendor's share of
  the *entire* project's M4O order volume. Not affected by the
  Vendor Type filter (Kitchen vendors are a separate slice).
- **Rating buckets**: 0-2, 2-4, 4-6, 6-8, 8-10. `Rate == 0` is treated
  as "No Rating" and excluded from both the average and the bucket
  distribution — but its count and % (of all packs, not just rated
  ones) is shown explicitly. Rating is broken down per city AND per
  Marketing Area (drill into a city to see its areas).
- **Order share windows**: the Order sheet's bare columns (`VPFO`,
  `M41VO`, ...) are **yesterday only** (updated daily); the
  `NewMonth*` columns are **month-to-date**. The dashboard lets you
  toggle between the two. "Platform Orders" always means platform
  orders of Meal4One vendors specifically, not Snapp Food's total
  order volume — the dashboard labels this explicitly.
- **Ordered vs. unordered %**: computed per window (Yesterday / MTD).
  A vendor is "ordered" if `M41VO`/`NewMonthM41VO` > 0. A pack
  inherits its vendor's ordered/unordered status (MainData has no
  per-pack order field).
- **Coverage Model tab**: read live from a **second** Google Sheet
  (`COVERAGE_SPREADSHEET_ID`), tabs `CityCoverage` (per-city user
  coverage in two scopes — "All Areas" and "Top Areas") and
  `CoverageResult` (the same coverage broken down per Marketing
  Area). This sheet must also be shared with the service account.
  An "All Cities" aggregate is computed on the fly (weighted by
  `total_users` across all cities, per scope) — it's not a row that
  exists in the source sheet.

The whole UI is English-only (including the Vendor Type filter
labels); city and area names stay as they appear in the source data.

## Files

- `update_dashboard.js` — pulls from both Google Sheets, regenerates the JSON
- `dashboard_data.json` — the processed data the dashboard reads (regenerated each run)
- `dashboard.html` — the dashboard itself, open this in a browser
- `service-account.json` — your credentials (you provide this, keep it private)
