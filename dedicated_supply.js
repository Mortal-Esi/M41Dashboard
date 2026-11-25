'use strict';

/**
 * Dedicated Supply source contract.
 *
 * Tab 1 of DEDICATED_SUPPLY_SPREADSHEET_ID lists Product IDs.
 * Optional tab DedicatedSupplyDaily supplies audited operational facts;
 * no purchases, sales or margins are inferred from vendor-level M41 orders.
 * All results go into dashboard_data.enc via the existing encrypt pipeline.
 */
function idOf(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim().replace(/^['’]/, '');
}
function textOf(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function numberOf(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function field(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  const normalize = s => String(s).trim().toLowerCase().replace(/[\s_\-]/g, '');
  const wanted = new Set(names.map(normalize));
  const key = Object.keys(row).find(k => wanted.has(normalize(k)));
  return key === undefined ? undefined : row[key];
}
const ID_FIELDS = ['ProductID','Product ID','Product Id','Product IDs','product_id','PackID','Pack ID','ItemID','Item ID','شناسه محصول','آیدی محصول'];
function readProductIds(grid) {
  if (!Array.isArray(grid) || grid.length === 0) return {ids:[], duplicates:0, header:'', invalidRows:0, records:[], missingStock:0};
  const normalize = s => textOf(s).toLowerCase().replace(/[\s_\-]/g, '');
  const fields = new Set(ID_FIELDS.map(normalize));
  const first = grid[0] || [];
  const headIndex = first.findIndex(v => fields.has(normalize(v)));
  const header = headIndex >= 0 ? textOf(first[headIndex]) : '';
  const col = headIndex >= 0 ? headIndex : 0;
  const values = headIndex >= 0 ? grid.slice(1) : grid;
  const headerIndex = name => first.findIndex(h => normalize(h) === normalize(name));
  const vendorCol = headIndex >= 0 ? headerIndex('Vendor') : -1;
  const vendorIdCol = headIndex >= 0 ? headerIndex('VendorID') : -1;
  const titleCol = headIndex >= 0 ? headerIndex('full_title') : -1;
  const stockCol = headIndex >= 0 ? headerIndex('DailyStock') : -1;
  const ids = [], records = [];
  let missingStock = 0;
  const seen = new Set();
  let duplicates = 0;
  let invalidRows = 0;
  for (const row of values) {
    const id = idOf((row || [])[col]);
    if (!id) continue;
    if (/^#(N\/A|REF!|VALUE!|ERROR!)/i.test(id)) { invalidRows++; continue; }
    if (seen.has(id)) { duplicates++; continue; }
    ids.push(id); seen.add(id);
    const dailyStock = stockCol >= 0 ? numberOf((row || [])[stockCol]) : null;
    if (dailyStock === null) missingStock++;
    records.push({id, vendorId:vendorIdCol>=0 ? idOf(row[vendorIdCol]) : '',
      vendorName:vendorCol>=0 ? textOf(row[vendorCol]) : '',
      title:titleCol>=0 ? textOf(row[titleCol]) : '', dailyStock});
  }
  return {ids, duplicates, header, invalidRows, records, missingStock};
}
function ymd(v) {
  const s = textOf(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function mapDaily(raw, ids) {
  if (raw === null) return {status:'missing', rows:[], days:[], issues:[], latest:null};
  const idSet = new Set(ids);
  const issues = [], rows = [], seen = new Set();
  for (let i=0; i<raw.length; i++) {
    const r = raw[i];
    if (!Object.values(r).some(v => v !== null && textOf(v))) continue;
    const date = ymd(field(r,['Date','OrderDate','Day']));
    const id = idOf(field(r,ID_FIELDS));
    if (!date || !id) { issues.push('Row '+(i+2)+': Date (YYYY-MM-DD) or ProductID missing'); continue; }
    if (!idSet.has(id)) { issues.push('Row '+(i+2)+': ProductID not in first tab'); continue; }
    const vendorId = idOf(field(r,['VendorID','Vendor ID']));
    const grain = date+'|'+id+'|'+vendorId;
    if (seen.has(grain)) { issues.push('Row '+(i+2)+': duplicate Date × ProductID × VendorID'); continue; }
    seen.add(grain);
    const purchased = numberOf(field(r,['PurchasedQty']));
    const sold = numberOf(field(r,['SoldQty']));
    if (purchased === null || sold === null || !Number.isInteger(purchased) || !Number.isInteger(sold)) {
      issues.push('Row '+(i+2)+': PurchasedQty / SoldQty must be non-negative integers');
      continue;
    }
    const opening = numberOf(field(r,['OpeningStockQty']));
    const waste = numberOf(field(r,['WasteQty']));
    const returned = numberOf(field(r,['ReturnedQty']));
    const closingReported = numberOf(field(r,['ClosingStockQty']));
    const unitCost = numberOf(field(r,['UnitCostToman']));
    const netSales = numberOf(field(r,['NetSalesToman']));
    const fullyReconciled = opening !== null && waste !== null && returned !== null;
    const closingExpected = fullyReconciled ? opening+purchased-sold-waste-returned : null;
    if (closingExpected !== null && closingExpected < 0)
      issues.push('Row '+(i+2)+': negative expected closing stock');
    if (closingReported !== null && closingExpected !== null && Math.abs(closingExpected-closingReported)>0.001)
      issues.push('Row '+(i+2)+': closing stock does not reconcile');
    rows.push({
      date, productId:id, vendorId, purchased, sold, opening, waste, returned,
      closing: closingReported !== null ? closingReported : closingExpected,
      available: opening !== null ? opening+purchased : null,
      unitCost, netSales,
      estimatedContribution: unitCost !== null && netSales !== null ? netSales - sold*unitCost : null,
    });
  }
  const days = [...new Set(rows.map(r=>r.date))].sort();
  return {status: issues.length ? 'quality_warning' : 'ok', rows, days, latest:days[days.length-1] || null, issues:issues.slice(0,80)};
}
function buildDedicatedSupply({idGrid, mainRows, impressionRows, orderRows, biRows, dailyRaw=null, sourceTab=''}) {
  const parsed = readProductIds(idGrid);
  const productMap = new Map(), packMap = new Map();
  for (const r of mainRows || []) {
    const productId = idOf(field(r,['ProductID','Product ID','product_id']));
    const packId = idOf(field(r,['PackID','Pack ID']));
    if (productId) { if (!productMap.has(productId)) productMap.set(productId,[]); productMap.get(productId).push(r); }
    if (packId) { if (!packMap.has(packId)) packMap.set(packId,[]); packMap.get(packId).push(r); }
  }
  const areaByVendor = new Map(), orderByVendor = new Map();
  for (const r of orderRows || []) {
    const id=idOf(r.VendorID);
    if (!id) continue;
    if (!orderByVendor.has(id)) orderByVendor.set(id,r);
    if (!areaByVendor.has(id) && textOf(r.MarketingAreaName)) areaByVendor.set(id,textOf(r.MarketingAreaName));
  }
  for (const r of biRows || []) {
    const id=idOf(field(r,['Vendor ID','VendorID']));
    if (id && !areaByVendor.has(id) && textOf(r.Area)) areaByVendor.set(id,textOf(r.Area));
  }
  const impressionByPack = new Map();
  for (const r of impressionRows || []) {
    const id=idOf(r.PackID);
    if (!id) continue;
    impressionByPack.set(id,(impressionByPack.get(id)||0)+(numberOf(r.total_impression)||0));
  }
  const items = parsed.records.map(source => {
    const id = source.id;
    let matchedBy = 'ProductID';
    let matches = productMap.get(id) || [];
    if (!matches.length) { matches=packMap.get(id)||[]; matchedBy='PackID (unverified equivalence)'; }
    if (source.vendorId) matches = matches.filter(r => idOf(r.VendorID) === source.vendorId);
    const vendorIds = new Set(matches.map(r=>idOf(r.VendorID)));
    if (vendorIds.size>1 || matches.some(r=>idOf(r.VendorID)==='')) {
      return {productId:id, matchStatus:'ambiguous', matchedBy, vendorId:source.vendorId||null, title:source.title||null, vendorName:source.vendorName||null, dailyStock:source.dailyStock};
    }
    if (!matches.length) return {productId:id, matchStatus:'not_found', matchedBy:null, vendorId:source.vendorId||null, title:source.title||null, vendorName:source.vendorName||null, dailyStock:source.dailyStock};
    const r=matches[0], vendorId=idOf(r.VendorID), packId=idOf(r.PackID);
    const isActive = Number(r.Activity)===1 && Number(r.Deleted || 0)===0;
    const price=numberOf(r.price), discountRatio=numberOf(r.DiscountSFRatio);
    const rate=numberOf(r.Rate);
    const ord=orderByVendor.get(vendorId);
    return {
      productId:id, packId, matchStatus:'matched', matchedBy, dailyStock:source.dailyStock,
      vendorId, vendorName:textOf(r.Title), title:textOf(r.full_title), city:textOf(r.City),
      area:areaByVendor.get(vendorId)||'Unknown', tier:textOf(r.VendorTier),
      kitchen:Number(r.Kitchen)===1, active:isActive, price, rate,
      snappDiscountToman:price!==null && discountRatio!==null ? price*discountRatio/100 : null,
      impressionsYesterday:packId ? (impressionByPack.get(packId)||0) : null,
      vendorM41OrdersYesterday:ord ? numberOf(ord.M41VO) : null,
      vendorM41OrdersMtd:ord ? numberOf(ord.NewMonthM41VO) : null,
    };
  });
  const matched=items.filter(r=>r.matchStatus==='matched');
  const daily=mapDaily(dailyRaw,parsed.ids);
  return {
    status:parsed.ids.length ? 'ok' : 'empty_ids',
    sourceTab, idHeader:parsed.header, duplicates:parsed.duplicates, invalidIds:parsed.invalidRows,
    missingStock:parsed.missingStock,
    idMappingNote:'ProductID joined to MainData.ProductID if present; fallback to MainData.PackID is unverified.',
    items, daily,
    summary:{
      tracked:items.length, matched:matched.length,
      dailyStockCapacity:items.every(r=>r.dailyStock!==null) ? items.reduce((a,r)=>a+r.dailyStock,0) : null,
      ambiguous:items.filter(r=>r.matchStatus==='ambiguous').length,
      notFound:items.filter(r=>r.matchStatus==='not_found').length,
      active:matched.filter(r=>r.active).length,
      inactive:matched.filter(r=>!r.active).length,
      vendors:new Set(matched.map(r=>r.vendorId)).size,
      impressionsYesterday:matched.reduce((s,r)=>s+(r.impressionsYesterday||0),0),
      productsSeenYesterday:matched.filter(r=>(r.impressionsYesterday||0)>0).length,
      packIdFallbacks:matched.filter(r=>r.matchedBy.startsWith('PackID')).length,
    }
  };
}
module.exports = {readProductIds, mapDaily, buildDedicatedSupply};
