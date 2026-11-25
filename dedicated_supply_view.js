'use strict';

/* Dedicated Supply panel: no inferred sales or stock from catalog/vendor metrics. */
let dsCity='all', dsState='all', dsDate='latest';
PANEL_RENDERERS.dedicatedSupply = () => renderDedicatedSupply();

function dsNumber(v) { return v === null || v === undefined ? '—' : fmt(v); }
function dsMoney(v) { return v === null || v === undefined ? '—' : toman(Math.round(v)); }
function dsStatus(item) {
  if(item.matchStatus==='not_found') return ['Missing in MainData','warn'];
  if(item.matchStatus==='ambiguous') return ['Ambiguous ID','warn'];
  if(!item.active) return ['Inactive','warn'];
  if(!item.impressionsYesterday) return ['No impressions','warn'];
  return ['Seen yesterday','ok'];
}
function dsStatusStyle(status) {
  return status==='ok' ? 'color:var(--seg-a)' : 'color:var(--warn)';
}
function dsStat(title,value,detail='',color='') {
  return '<div class="stat-card"><div class="label">'+escapeHtml(title)+'</div><div class="value small"'+(color?' style="color:'+color+'"':'')+'>'+value+'</div>'+(detail?'<div class="sub">'+detail+'</div>':'')+'</div>';
}
function dsSelect(id,label,values,current) {
  return '<label class="flabel" for="'+id+'">'+escapeHtml(label)+'</label><select id="'+id+'" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:7px;padding:8px">'+
    values.map(([v,l])=>'<option value="'+escapeAttr(v)+'"'+(current===v?' selected':'')+'>'+escapeHtml(l)+'</option>').join('')+'</select>';
}
function dsDailySummary(rows) {
  const all = predicate => rows.length>0 && rows.every(predicate);
  const sum = key => rows.reduce((acc,r)=>acc+(r[key]||0),0);
  const purchased=sum('purchased'), sold=sum('sold');
  const available=all(r=>r.available!==null) ? sum('available') : null;
  return {
    purchased, sold,
    available,
    sellThrough:available!==null && available>0 ? sold/available*100 : null,
    closing:all(r=>r.closing!==null) ? sum('closing') : null,
    waste:all(r=>r.waste!==null) ? sum('waste') : null,
    returned:all(r=>r.returned!==null) ? sum('returned') : null,
    netSales:all(r=>r.netSales!==null) ? sum('netSales') : null,
    contribution:all(r=>r.estimatedContribution!==null) ? sum('estimatedContribution') : null,
  };
}
function renderDedicatedSupply(){
  const ds=DATA.dedicatedSupply;
  if(!ds) return '<div class="empty-state">Dedicated Supply was added to the dashboard code, but the encrypted data snapshot is older. Run the local dashboard refresh to populate this tab.</div>';
  const sourceIssue=ds.status==='not_configured'?'Set DEDICATED_SUPPLY_SPREADSHEET_ID in config.local.js and share the Sheet with the dashboard service account.':
    ds.status==='source_error'?'The dedicated Sheet could not be read during the latest refresh. Check access and tab structure.':
    ds.status==='empty_ids'?'The first tab has no readable Product IDs.':'';
  const items=ds.items||[], s=ds.summary||{};
  const validSource = ds.status==='ok' || ds.status==='empty_ids';
  const sourceKpi = value => validSource ? dsNumber(value) : '—';
  const cities=[...new Set(items.map(r=>r.city).filter(Boolean))].sort();
  const daily=ds.daily||{status:'missing',rows:[],days:[],latest:null,issues:[]};
  const selectedDate=dsDate==='latest'||!(daily.days||[]).includes(dsDate)?daily.latest:dsDate;
  const todayRows=(daily.rows||[]).filter(r=>r.date===selectedDate);
  const ops=dsDailySummary(todayRows);
  const cityItems=items.filter(r=>dsCity==='all'||r.city===dsCity);
  const shown=cityItems.filter(r=>{
    const st=dsStatus(r);
    return dsState==='all'||(dsState==='attention' ? st[1]==='warn' : dsState==='seen' ? st[1]==='ok' : r.matchStatus===dsState);
  });
  const mapped=items.filter(r=>r.matchStatus==='matched');
  const vendorMap=new Map();
  for(const r of mapped){
    if(!vendorMap.has(r.vendorId)) vendorMap.set(r.vendorId,{
      id:r.vendorId,name:r.vendorName,city:r.city,area:r.area,
      productCount:0,active:0,impressions:0,ordersYesterday:r.vendorM41OrdersYesterday,ordersMtd:r.vendorM41OrdersMtd
    });
    const v=vendorMap.get(r.vendorId);
    v.productCount++;
    v.active+=r.active?1:0;
    v.impressions+=r.impressionsYesterday||0;
  }
  const vendors=[...vendorMap.values()].sort((a,b)=>b.productCount-a.productCount);
  const byCity=new Map();
  for(const r of mapped){
    if(!byCity.has(r.city)) byCity.set(r.city,{name:r.city,count:0,active:0,seen:0,impressions:0,vendors:new Set()});
    const c=byCity.get(r.city);
    c.count++;c.active+=r.active?1:0;
    c.seen+=(r.impressionsYesterday||0)>0?1:0;
    c.impressions+=r.impressionsYesterday||0;c.vendors.add(r.vendorId);
  }
  const byCitySorted=[...byCity.values()].sort((a,b)=>b.count-a.count);
  const maxCity=Math.max(1,...byCitySorted.map(v=>v.count));
  let html='<div class="section-title" style="margin-top:0">Dedicated Supply — Prepaid Inventory</div>'+
    '<div class="section-note">Product IDs from the first tab of the dedicated Sheet. Catalog and visibility metrics come from MainData / Impression; purchase, sales and margin require a separate daily operations feed. This is not an attribution of vendor M41 orders to these products.</div>';
  if(sourceIssue) html+='<div class="detail-panel" style="border-color:var(--warn)"><b style="color:var(--warn)">Source setup required</b><div class="section-note" style="margin:8px 0 0">'+escapeHtml(sourceIssue)+'</div></div>';
  if(ds.status==='source_error'&&ds.sourceError) html+='<div class="section-note">Read error: '+escapeHtml(ds.sourceError)+'</div>';
  html+='<div class="stat-row">'+
    dsStat('Tracked IDs',sourceKpi(s.tracked),'Unique values in source tab')+
    dsStat('Matched to MainData',sourceKpi(s.matched),'ProductID or fallback PackID')+
    dsStat('Active in catalog',sourceKpi(s.active),'Of the matched products','var(--seg-a)')+
    dsStat('Seen yesterday',sourceKpi(s.productsSeenYesterday),'Products with impressions')+
    dsStat('Impressions · yesterday',sourceKpi(s.impressionsYesterday),'Not product sales')+
    dsStat('Vendors',sourceKpi(s.vendors),'Distinct matched Vendor IDs')+
    '</div>';
  if((s.packIdFallbacks||0)>0 || (s.notFound||0)>0 || (s.ambiguous||0)>0 || (ds.duplicates||0)>0)
    html+='<div class="section-note">Data quality: '+fmt(s.packIdFallbacks||0)+' IDs matched via PackID (verify ProductID = PackID), '+fmt(s.notFound||0)+' missing in MainData, '+fmt(s.ambiguous||0)+' ambiguous and '+fmt(ds.duplicates||0)+' duplicate IDs removed. Missing in MainData does not mean the product does not exist.</div>';
  html+='<div class="section-title">Daily procurement &amp; sell-through</div>';
  if(!validSource){
    html+='<div class="section-note">Daily metrics are unavailable until the source Sheet can be read and a new encrypted snapshot is published.</div>';
  } else if(daily.status==='missing'){
    html+='<div class="detail-panel"><div class="dname">Daily operational data not connected</div><div class="section-note" style="margin:0">Add an optional <code>DedicatedSupplyDaily</code> tab to the same Sheet. One row per Date × ProductID × VendorID with Date, ProductID, VendorID, PurchasedQty and SoldQty. Add OpeningStockQty, WasteQty, ReturnedQty, ClosingStockQty, UnitCostToman, NetSalesToman for stock reconciliation and estimated contribution. Without these fields, purchased units, sold units, stock, sell-through and profitability are unavailable—not zero.</div></div>';
  } else if(!daily.latest){
    html+='<div class="section-note">Daily ledger exists, but contains no valid date/product rows.</div>';
  } else {
    if(daily.status==='quality_warning') html+='<div class="section-note" style="color:var(--warn)">Partial / invalid daily feed: metrics below cover accepted rows only, not necessarily the complete day. Resolve quality warnings before relying on totals.</div>';
    html+='<div class="filter-bar">'+dsSelect('dsDate','Daily snapshot',(daily.days||[]).slice().reverse().map(d=>[d,d]),selectedDate)+'</div>';
    html+='<div class="stat-row">'+
      dsStat('Purchased qty',dsNumber(ops.purchased),'Latest selected day')+
      dsStat('Sold qty',dsNumber(ops.sold),'Reported product-level sales')+
      dsStat('Sell-through',ops.sellThrough===null?'—':pct1(ops.sellThrough),'Sold / (opening stock + purchased)')+
      dsStat('Closing stock',dsNumber(ops.closing),'Reported; reconciled where inputs permit')+
      dsStat('Waste qty',dsNumber(ops.waste),'Reported write-off')+
      dsStat('Net sales',dsMoney(ops.netSales),'Only when all rows report value')+
      dsStat('Est. contribution',dsMoney(ops.contribution),'Net sales − sold × unit cost; before other costs')+
      '</div>';
    const dailyGraph=(daily.days||[]).slice(-14).map(date=>({date,...dsDailySummary(daily.rows.filter(r=>r.date===date))}));
    const maxBar=Math.max(1,...dailyGraph.map(r=>Math.max(r.purchased,r.sold)));
    html+='<div class="chart-box" style="margin-bottom:18px"><h3>Daily units — reported, not inferred</h3>'+
      '<div style="display:grid;gap:10px">'+dailyGraph.map(r=>'<div style="display:grid;grid-template-columns:90px 1fr 95px;gap:10px;align-items:center;font-size:12px"><span class="dim">'+escapeHtml(r.date)+'</span><div style="display:grid;gap:3px"><div style="height:8px;width:'+((r.purchased/maxBar)*100).toFixed(2)+'%;background:var(--accent);border-radius:3px"></div><div style="height:8px;width:'+((r.sold/maxBar)*100).toFixed(2)+'%;background:var(--seg-a);border-radius:3px"></div></div><span>'+fmt(r.purchased)+' / '+fmt(r.sold)+'</span></div>').join('')+'</div><div class="section-note" style="margin:12px 0 0">Orange = purchased · Green = sold. Values show purchased / sold.</div></div>';
    html+='<div class="table-wrap" style="max-height:320px"><table><thead><tr><th>Product ID</th><th>Vendor ID</th><th>Purchased</th><th>Sold</th><th>Available</th><th>Closing</th><th>Waste</th><th>Returned</th><th>Net sales (T)</th><th>Est. contribution (T)</th></tr></thead><tbody>'+
      todayRows.map(r=>'<tr><td>'+escapeHtml(r.productId)+'</td><td>'+escapeHtml(r.vendorId||'—')+'</td><td>'+dsNumber(r.purchased)+'</td><td>'+dsNumber(r.sold)+'</td><td>'+dsNumber(r.available)+'</td><td>'+dsNumber(r.closing)+'</td><td>'+dsNumber(r.waste)+'</td><td>'+dsNumber(r.returned)+'</td><td>'+dsMoney(r.netSales)+'</td><td>'+dsMoney(r.estimatedContribution)+'</td></tr>').join('')+'</tbody></table></div>';
  }
  if(daily.issues&&daily.issues.length) html+='<div class="section-note" style="color:var(--warn);margin-top:12px">Daily ledger quality warnings ('+fmt(daily.issues.length)+' shown): '+escapeHtml(daily.issues.slice(0,5).join(' | '))+'</div>';
  html+='<div class="section-title">Coverage by city</div>';
  if(!byCitySorted.length) html+='<div class="section-note">No catalog matches yet.</div>';
  else html+='<div class="chart-box" style="margin-bottom:16px"><div style="display:grid;gap:12px">'+byCitySorted.map(c=>
    '<div style="display:grid;grid-template-columns:minmax(95px,130px) 1fr 110px;gap:12px;align-items:center;font-size:12px"><span>'+escapeHtml(c.name)+'</span><div style="background:var(--panel-2);height:12px;border-radius:4px;overflow:hidden"><div style="width:'+((c.count/maxCity)*100).toFixed(2)+'%;height:100%;background:var(--seg-b)"></div></div><span>'+fmt(c.count)+' products</span></div>'
  ).join('')+'</div></div>';
  html+='<div class="table-wrap" style="max-height:340px;margin-bottom:20px"><table><thead><tr><th>City</th><th>Vendors</th><th>Matched products</th><th>Active</th><th>Seen yesterday</th><th>Impressions</th></tr></thead><tbody>'+
    byCitySorted.map(c=>'<tr><td>'+escapeHtml(c.name)+'</td><td>'+fmt(c.vendors.size)+'</td><td>'+fmt(c.count)+'</td><td>'+fmt(c.active)+'</td><td>'+fmt(c.seen)+'</td><td>'+fmt(c.impressions)+'</td></tr>').join('')+'</tbody></table></div>';
  html+='<div class="section-title">Product monitoring &amp; exceptions</div>'+
    '<div class="filter-bar">'+dsSelect('dsCity','City',[['all','All cities'],...cities.map(c=>[c,c])],dsCity)+
    dsSelect('dsState','Status',[['all','All statuses'],['attention','Needs attention'],['seen','Seen yesterday'],['not_found','Missing in MainData'],['ambiguous','Ambiguous ID']],dsState)+
    '<input id="dsSearch" placeholder="Search Product ID, vendor or title…" style="min-width:180px;flex:1;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:7px;padding:9px"></div>'+
    '<div class="section-note">'+fmt(shown.length)+' of '+fmt(items.length)+' tracked Product IDs in the selected city/status.</div>';
  html+='<div class="table-wrap" style="max-height:550px;margin-bottom:20px"><table><thead><tr><th>Product ID</th><th>Product</th><th>Vendor / ID</th><th>City</th><th>Marketing Area</th><th>Status</th><th>Price (T)</th><th>SF Discount (T)</th><th>Impressions Y</th><th>Match key</th></tr></thead><tbody id="dsProductsBody">'+
    shown.map(r=>{const [status,kind]=dsStatus(r);return '<tr data-ds-search="'+escapeAttr([r.productId,r.title||'',r.vendorName||'',r.vendorId||'',r.city||''].join(' ').toLowerCase())+'"><td style="font-family:var(--mono)">'+escapeHtml(r.productId)+'</td><td>'+escapeHtml(r.title||'—')+'</td><td>'+escapeHtml((r.vendorName||'—')+(r.vendorId?' · '+r.vendorId:''))+'</td><td>'+escapeHtml(r.city||'—')+'</td><td>'+escapeHtml(r.area||'—')+'</td><td style="'+dsStatusStyle(kind)+'">'+escapeHtml(status)+'</td><td>'+dsMoney(r.price)+'</td><td>'+dsMoney(r.snappDiscountToman)+'</td><td>'+dsNumber(r.impressionsYesterday)+'</td><td>'+escapeHtml(r.matchedBy||'—')+'</td></tr>';}).join('')+
    '</tbody></table></div>';
  html+='<div class="section-title">Matched vendors — context only</div><div class="section-note">The M41 order counts below cover ALL products of each vendor, not just the Dedicated Supply items; do not sum them as Dedicated Supply sales.</div>'+
    '<div class="table-wrap" style="max-height:380px"><table><thead><tr><th>Vendor / ID</th><th>City</th><th>Area</th><th>Tracked products</th><th>Active</th><th>DS product impressions Y</th><th>All-product M41 orders Y</th><th>All-product M41 orders MTD</th></tr></thead><tbody>'+
    vendors.map(v=>'<tr><td>'+escapeHtml(v.name+' · '+v.id)+'</td><td>'+escapeHtml(v.city)+'</td><td>'+escapeHtml(v.area)+'</td><td>'+fmt(v.productCount)+'</td><td>'+fmt(v.active)+'</td><td>'+fmt(v.impressions)+'</td><td>'+dsNumber(v.ordersYesterday)+'</td><td>'+dsNumber(v.ordersMtd)+'</td></tr>').join('')+'</tbody></table></div>';
  return html;
}
document.getElementById('root').addEventListener('change',event=>{
  if(currentPanel!=='dedicatedSupply')return;
  if(event.target.id==='dsCity'){ dsCity=event.target.value; render(); }
  if(event.target.id==='dsState'){ dsState=event.target.value; render(); }
  if(event.target.id==='dsDate'){ dsDate=event.target.value; render(); }
});
document.getElementById('root').addEventListener('input',event=>{
  if(currentPanel!=='dedicatedSupply'||event.target.id!=='dsSearch')return;
  const q=event.target.value.trim().toLowerCase();
  document.querySelectorAll('#dsProductsBody tr').forEach(r=>{r.style.display=(r.dataset.dsSearch||'').includes(q)?'':'none';});
});
