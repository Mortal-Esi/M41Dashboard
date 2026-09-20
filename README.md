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
   - The main data sheet (MainData / Order / TopCritical / BI / Impression)
   - The Coverage Model sheet (CityCoverage / CoverageResult)

4. Open `update_dashboard.js` and set both IDs near the top —
   copy each from its sheet's URL:
   ```
   https://docs.google.com/spreadsheets/d/[SPREADSHEET_ID]/edit
   ```
   - `SPREADSHEET_ID` → the main data sheet
   - `COVERAGE_SPREADSHEET_ID` → the Coverage Model sheet

## Every time you want to refresh the dashboard

Easiest: double-click **`refresh-dashboard.bat`**. It pulls fresh data,
encrypts it, and pushes the update to GitHub Pages automatically.

Or manually:
```
node update_dashboard.js
```
This reads all seven tabs across both sheets (MainData, Order, TopCritical, BI, Impression, CityCoverage, CoverageResult), re-runs all the aggregations,
writes `dashboard_data.json`, and then **automatically encrypts it** into
`dashboard_data.enc` (see Password Protection below).

Then just open (or refresh) `dashboard.html` in your browser.

## Password protection

The live dashboard is public on GitHub Pages, so it's protected with a
password:

- `dashboard_data.json` (the plaintext data) is **never** committed to
  git — it's listed in `.gitignore` and stays only on your computer.
- Every time `update_dashboard.js` runs, it also encrypts that JSON
  (AES, via `encrypt.js`) into `dashboard_data.enc`. **Only this
  encrypted file is committed and published.**
- `dashboard.html` fetches `dashboard_data.enc` and shows a password
  screen. It decrypts the data in-browser only after the correct
  password is entered — nobody can read the data via "View Source" or
  the browser's dev tools without the password, unlike a simple
  show/hide overlay.
- The password itself lives in `password.local.js` — **not** in this
  README, not in `encrypt.js`, and not anywhere else that gets
  committed. That file is listed in `.gitignore` on purpose: the whole
  point of encrypting the data is defeated if the password sits in
  plain text in the same public repo as the ciphertext. Ask whoever
  set up the dashboard for the current password out of band (chat,
  in person, etc.), not through this file.
- First-time setup: copy `password.local.js.example` to
  `password.local.js` and put the real password in it:
  ```
  cp password.local.js.example password.local.js
  ```
- To change the password: edit the value in your local
  `password.local.js`, then run `node update_dashboard.js` again (or
  `node encrypt.js` on its own if the data hasn't changed) and push.
  Anyone with the old password will no longer be able to unlock the
  dashboard after you republish. Share the new password with people
  who need it the same way you shared the old one — never by
  committing it anywhere.
- Once someone enters the correct password, their browser remembers it
  for that browsing session (`sessionStorage`), so they won't be asked
  again until they close the tab/browser.

**Honest caveat:** this is meaningfully stronger than a cosmetic
JS gate (the raw published file is genuine ciphertext, not just hidden
HTML), but it's still a single shared password handled client-side —
anyone who has it can share it, and a determined attacker could
brute-force a weak password offline. Treat it as "keeps casual/unauthorized
viewers out," not as enterprise access control. For real per-user access
control, the earlier-discussed Cloudflare Access + Google login option
is the stronger route.

## Filtering & calculation rules baked into the script

- **Pack filter**: keep a pack if `Activity == 1`, OR `PO > 0` (it had a
  platform order yesterday despite being inactive now), OR the pack has
  impressions (its PackID appears in the Impression sheet — someone saw
  it yesterday, so it isn't truly dead even if Activity/PO both read 0).
  Everything else is dropped. This third condition rescued 143 packs in
  the original snapshot.
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
  the *entire* project's M4O order volume. The comparison table also
  adds Kitchen vs. Non-Kitchen's share of total impressions (from the
  Impression tab) and Total Budget / CPO (from the CPO Budget tab),
  when that data is available. Not affected by the Vendor Type filter
  (Kitchen vendors are a separate slice).
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
- **Impression tab**: per-pack impressions for **yesterday only** (the
  Impression sheet has no historical/MTD window), read from the
  `Impression` tab of the main data sheet. The 34 half-hour header
  cells (07:00–23:30) are read by **column position**, not by header
  name — Sheets API returns time-of-day headers as raw day-fraction
  numbers under `UNFORMATTED_VALUE`, which aren't safe to use as
  object keys, so the 34-slot layout is hardcoded in
  `update_dashboard.js`. A handful of PackIDs appear twice in the
  source sheet; those are summed. Each pack is joined to MainData by
  PackID to pick up Deal Type, Kitchen, Segment, Top Critical, Vendor
  Class (from the CPO sheet — see below) and Marketing Area. Only
  packs with at least one impression are counted ("Packs w/
  Impressions" / "Vendors w/ Impressions"); a sheet row with
  `total_impression == 0` isn't a pack anyone actually saw. There's
  no meal-period breakdown (Breakfast/Lunch/…) anymore — just one
  time-of-day trend chart over the 34 half-hour slots.
  - **Impression → Order Conversion**: since impressions only cover
    the Meal4One carousel, only **M4O orders** are a meaningful
    numerator here — a platform-wide-orders ratio isn't shown at all.
    The Order sheet has no per-pack breakdown, so conversion
    (M4O Orders ÷ Impressions, yesterday) is computed at the
    **vendor** level and rolled up from there by City, Marketing
    Area, and vendor segment (Kitchen / Top Critical / Critical /
    Other) — never at the pack level, which isn't computable from the
    source data. Vendors with fewer than 100 impressions are excluded
    from the conversion rankings (but not from "Most Seen") — below
    that, a couple of stray orders can make a barely-seen vendor look
    like it has a 500%+ conversion rate.
  - Respects the Vendor Type filter like Pack Distribution; the
    conversion tables are only shown on the unfiltered (All) view.
  - Large numbers (impressions) are shown compact (e.g. `1.2M`), same
    as CPO Budget below.
  - **Known open issue**: in the original snapshot, the sum of the 34
    half-hour buckets was consistently about half of the sheet's own
    `total_impression` column. The dashboard currently trusts
    `total_impression` (the raw column) as the source of truth for
    every "Total Impressions" figure; the 34-slot chart is shown as
    the time-of-day *shape*, not guaranteed to sum to the total until
    that discrepancy is resolved at the source. Worth asking the
    data/BI team why the two don't match.

- **CPO Budget tab**: month-to-date (Gregorian calendar month, updated
  daily — same MTD convention as the rest of the dashboard), read
  from the `CPO_Budget_MTD` tab. The `CPO_Budget_Aug` and
  `CPO_Budget_sep` tabs are **not** read — their data isn't
  considered valid. The sheet has ~1,900 fully blank trailing rows
  (padding); only rows with a `VendorID` are kept. Only four of the
  sheet's numeric columns are trusted: `Product_Subsidy_Budget_new`,
  `Free_Delivery_Budget_new`, `new_total_budget` and `new_cpo`; the
  dashboard drops the "new" from their labels (Subsidy Budget, Free
  Delivery Budget, Total Budget, CPO).
  - **CPO** = Total Budget ÷ M4O Orders (the sheet's own `new_cpo`).
  - **Free Delivery CPO** = Free Delivery Budget ÷ M4O Orders.
  - **Subsidy Cost / Sold** = Subsidy Budget ÷ `TotalSold` — product
    subsidy is spent per sold unit, not per order, so it isn't a
    "CPO" in the usual sense.
  - **Every budget figure carries its % of the project-wide grand
    total for that same metric** next to the Toman amount (e.g.
    "12.3M T (18%)") — a raw amount alone doesn't say whether a city
    or segment is 2% or 40% of spend. Large amounts are shown compact
    (`K`/`M`/`B`) instead of full Toman digits.
  - **Just two breakdowns** instead of the old four: geography
    (City → Marketing Area → Vendor, unchanged) and segment. The
    segment breakdown is **Kitchen vs. Non-Kitchen**, with Non-Kitchen
    further split into **Top Critical / Critical / Other** (Other =
    Important + Ordinary + anything uncategorized) — using the CPO
    sheet's own `VendorClass` column. The old separate By Vendor Tier
    and By New Vendor Class tables were dropped; `VendorTier` and
    `new_VendorClass` are still shown per-vendor in the drill-down
    table for context.
  - **Kitchen is kept fully separate** in that segment breakdown —
    Kitchen vendors can also be Critical/TopCritical/etc., so mixing
    them in would double-count them. The City → Marketing Area →
    Vendor drill-down is unaffected by this and includes Kitchen
    vendors normally (tagged with the Kitchen badge), since that's a
    geography view, not a segment view.
  - Doesn't respect the Vendor Type filter (hidden on this tab, like
    Kitchen) — it has its own segmentation already.
  - The same Kitchen/Top Critical/Critical/Other segmentation is
    reused by the Impression tab's conversion breakdown (via a shared
    `vendorSegmentClass()` helper), so the two tabs use one consistent
    vendor segmentation.

- **Availability** (Pack Distribution tab, all levels): of the packs
  that are `Activity == 1` right now, what share actually picked up
  at least one impression yesterday? A low number means "marked
  active in the sheet" isn't the same as "actually being shown to
  users." This directly answers whether Activity, Order (`PO`), and
  Impression are all pulling weight: they already are — a pack enters
  the dataset at all if `Activity==1` OR `PO>0` (had a platform order
  yesterday) OR it has an impression (rescued even if Activity/PO
  both read 0, see the Pack filter rule above); a vendor counts as
  "in the dataset" if it has at least one such surviving pack, i.e.
  vendor-level activity is derived from pack-level activity, not
  computed independently. Availability then adds a second, narrower
  question on top of that inclusion rule: among packs the sheet
  currently calls active, how many were actually surfaced to a user?

The whole UI is English-only (including the Vendor Type filter
labels); city and area names stay as they appear in the source data.

## Files

- `update_dashboard.js` — pulls from both Google Sheets, regenerates the JSON, then encrypts it
- `dashboard_data.json` — the processed plaintext data (regenerated each run, gitignored, never committed)
- `dashboard_data.enc` — the encrypted data actually published to GitHub Pages
- `encrypt.js` — encrypts `dashboard_data.json` into `dashboard_data.enc`
- `password.local.js` — the real dashboard password (you create this from the `.example` file below, gitignored, never committed)
- `password.local.js.example` — template for `password.local.js`
- `dashboard.html` — the dashboard itself, open this in a browser
- `service-account.json` — your credentials (you provide this, keep it private, gitignored)
