/* ============================================================
   STATE
   ============================================================ */
let DATA = null;
let currentPanel = 'overview';
let drill = { overview:{city:null,area:null}, vendorCoverage:{city:null,area:null,vendorId:null}, packDistribution:{city:null,area:null}, rating:{city:null}, coverageModel:{city:null}, kitchen:{city:null,area:null}, orderShare:{city:null}, impression:{city:null,area:null}, cpoBudget:{city:null,area:null}, delivery:{city:null,area:null,vendorId:null} };
let impressionConversionSort = 'totalImpression'; // 'totalImpression' | 'conversion'
let orderWindow = 'mtd';
let deliveryDate = null; // set to the latest available date on first render of the Delivery tab
let superTypeFilter = 'all'; // 'all' or a group key from SUPER_TYPE_GROUPS
const charts = {};

const BUCKET_ORDER = ['0-2','2-4','4-6','6-8','8-10'];
const DEAL_TYPES = ['Super','Good','Basic','Weak','Not Food'];
const DEAL_COLORS = { Super:'#3DDC97', Good:'#4C8CFF', Basic:'#F2B84B', Weak:'#E45A5A', 'Not Food':'#4A5266' };
const DEAL_CLASS = { Super:'Super', Good:'Good', Basic:'Basic', Weak:'Weak', 'Not Food':'Not' };
const STATUS_COLORS = { Elite:'#3DDC97', Healthy:'#4C8CFF', Moderate:'#F2B84B', Low:'#E45A5A' };

const SUPER_TYPE_LABELS = { 1: 'Restaurant', 2: 'Cafe', 3: 'Juice' };
function superTypeGroups(){
  const ids = DATA.meta.superTypeIds || [];
  const groups = [];
  [1,2,3].forEach(id => { if(ids.includes(id)) groups.push({ key:String(id), label:SUPER_TYPE_LABELS[id], ids:[id] }); });
  const otherIds = ids.filter(id => ![1,2,3].includes(id));
  if(otherIds.length) groups.push({ key:'other', label:'Non-Food', ids:otherIds });
  return groups;
}

function fmt(n){ return Number(n||0).toLocaleString('en-US'); }
function pct1(n){ return (Number(n||0)).toFixed(1)+'%'; }
function shareToPct(n){ return (Number(n||0)*100).toFixed(1)+'%'; }
function toman(n){ return fmt(Math.round(n||0)) + ' T'; }
// Compact K/M/B formatting for large numbers (budgets, impressions) — full
// precision under 1000, otherwise 1 decimal (0 decimals once 3 digits before it).
function fmtCompact(n){
  n = Number(n||0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if(abs < 1000) return sign + Math.round(abs).toLocaleString('en-US');
  const units = [[1e9,'B'],[1e6,'M'],[1e3,'K']];
  for(const [v, suffix] of units){
    if(abs >= v){
      const scaled = abs / v;
      const str = scaled >= 100 ? Math.round(scaled).toString() : scaled.toFixed(1).replace(/\.0$/,'');
      return sign + str + suffix;
    }
  }
  return sign + Math.round(abs).toLocaleString('en-US');
}
function tomanCompact(n){ return fmtCompact(n) + ' T'; }

/* ============================================================
   LOAD + DECRYPT DATA
   ============================================================
   The published file is dashboard_data.enc, written by encrypt.js. It's
   fetched as-is and only decrypted in-browser once the viewer enters a
   valid password. v2 files (JSON envelope): gzipped data encrypted with a
   random data key (AES-GCM), that key encrypted once per password under
   PBKDF2-SHA256. v1 files (older encrypt.js, CryptoJS passphrase format)
   are still read so a refresh made with an old checkout doesn't break
   the live page.
   ============================================================ */
const SESSION_KEY = 'm41_dash_key';
// Older versions cached the plaintext password here — drop it.
try { sessionStorage.removeItem('m41_dash_pw'); } catch(e){}

function b64ToBytes(b64){
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes){
  let s = '';
  for(let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

let encFilePromise = null;
function fetchEncFile(){
  // Cached so a mistyped password doesn't re-download the whole file.
  if(!encFilePromise){
    encFilePromise = fetch('./dashboard_data.enc?v=' + Date.now())
      .then(r => { if(!r.ok) throw new Error('HTTP '+r.status); return r.text(); })
      .then(t => t.trim())
      .catch(err => { encFilePromise = null; throw err; });
  }
  return encFilePromise;
}

async function gcmDecrypt(keyBytes, ivB64, ctB64){
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name:'AES-GCM', iv:b64ToBytes(ivB64) }, key, b64ToBytes(ctB64)));
}

async function unwrapDataKey(env, password){
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const kek = new Uint8Array(await crypto.subtle.deriveBits(
    { name:'PBKDF2', hash:env.kdf.hash, salt:b64ToBytes(env.kdf.salt), iterations:env.kdf.iterations }, baseKey, 256));
  for(const slot of env.slots){
    try { return await gcmDecrypt(kek, slot.iv, slot.ct); } catch(e){ /* not this person's slot */ }
  }
  throw new Error('WRONG_PASSWORD');
}

async function decryptPayload(env, dataKey){
  const gz = await gcmDecrypt(dataKey, env.iv, env.data);
  const text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}

function decryptLegacy(ciphertext, password){
  let plaintext = '';
  try { plaintext = CryptoJS.AES.decrypt(ciphertext, password).toString(CryptoJS.enc.Utf8); } catch(e){}
  if(!plaintext) throw new Error('WRONG_PASSWORD');
  return JSON.parse(plaintext);
}

async function unlockWithPassword(password){
  if(!window.crypto || !crypto.subtle) throw new Error('this page must be opened over https://');
  const text = await fetchEncFile();
  if(!text.startsWith('{')) return { json: decryptLegacy(text, password), dataKey: null };
  const env = JSON.parse(text);
  const dataKey = await unwrapDataKey(env, password);
  return { json: await decryptPayload(env, dataKey), dataKey };
}

async function unlockWithCachedKey(keyB64){
  const text = await fetchEncFile();
  if(!text.startsWith('{')) throw new Error('LEGACY_FORMAT');
  // Fails (and falls back to the password prompt) once the data is refreshed,
  // since each encryption run uses a fresh data key.
  return decryptPayload(JSON.parse(text), b64ToBytes(keyB64));
}

function unlockDashboard(json){
  DATA = json;
  document.getElementById('generatedAt').textContent =
    'Generated ' + new Date(json.generatedAt).toLocaleString('en-US', {dateStyle:'medium', timeStyle:'short'});
  document.body.classList.remove('locked');
  document.getElementById('lockScreen').style.display = 'none';
  renderFilterBar();
  render();
}

function attemptUnlock(password){
  const btn = document.getElementById('lockSubmit');
  const errEl = document.getElementById('lockError');
  btn.disabled = true;
  btn.textContent = 'Unlocking…';
  errEl.textContent = '';
  // Let the browser paint "Unlocking…" before the (partly synchronous)
  // decrypt/parse work starts, so the click never looks like it did nothing.
  setTimeout(() => {
    unlockWithPassword(password)
      .then(({ json, dataKey }) => {
        // Cache the per-file data key, never the password itself.
        if(dataKey){ try { sessionStorage.setItem(SESSION_KEY, bytesToB64(dataKey)); } catch(e){} }
        unlockDashboard(json);
      })
      .catch(err => {
        btn.disabled = false;
        btn.textContent = 'Unlock';
        errEl.textContent = err.message === 'WRONG_PASSWORD'
          ? 'Incorrect password — try again.'
          : 'Could not load dashboard data (' + err.message + ').';
      });
  }, 20);
}

document.getElementById('lockSubmit').addEventListener('click', () => {
  const pw = document.getElementById('lockPassword').value;
  if(pw) attemptUnlock(pw);
});
document.getElementById('lockPassword').addEventListener('keydown', (e) => {
  if(e.key === 'Enter'){
    const pw = document.getElementById('lockPassword').value;
    if(pw) attemptUnlock(pw);
  }
});

// If this browser already unlocked this exact data file this session, skip the prompt.
(function(){
  let cached = null;
  try { cached = sessionStorage.getItem(SESSION_KEY); } catch(e){}
  if(!cached) return;
  unlockWithCachedKey(cached)
    .then(unlockDashboard)
    .catch(() => { try { sessionStorage.removeItem(SESSION_KEY); } catch(e){} });
})();

/* ============================================================
   GLOBAL FILTER BAR (Vendor Type) — applies to all tabs except Coverage Model
   ============================================================ */
function renderFilterBar(){
  const groups = superTypeGroups();
  const host = document.getElementById('filterBarHost');
  if(!groups.length){ host.innerHTML = ''; return; }
  host.innerHTML = `
    <div class="filter-bar" id="superTypeFilterBar">
      <span class="flabel">Vendor Type</span>
      <span class="filter-chip ${superTypeFilter==='all'?'active':''}" data-super="all">All</span>
      ${groups.map(g => `<span class="filter-chip ${superTypeFilter===g.key?'active':''}" data-super="${g.key}">${g.label}</span>`).join('')}
    </div>`;
  host.querySelectorAll('.filter-chip').forEach(el => {
    el.addEventListener('click', () => {
      superTypeFilter = el.dataset.super;
      drill.vendorCoverage = {city:null, area:null, vendorId:null};
      drill.packDistribution = {city:null, area:null};
      drill.impression = {city:null, area:null};
      renderFilterBar();
      render();
    });
  });
}
function filterBarVisible(){
  document.getElementById('filterBarHost').style.display = (currentPanel === 'coverageModel' || currentPanel === 'kitchen' || currentPanel === 'cpoBudget') ? 'none' : '';
}
function matchesSuperType(item){
  if(superTypeFilter === 'all') return true;
  const groups = superTypeGroups();
  const g = groups.find(g => g.key === superTypeFilter);
  if(!g) return true;
  return g.ids.includes(Number(item.superTypeId));
}

/* ============================================================
   TABS
   ============================================================ */
document.getElementById('tabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if(!tab) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  currentPanel = tab.dataset.panel;
  render();
});

/* ============================================================
   RENDER DISPATCH
   ============================================================ */
function render(){
  if(!DATA) return;
  filterBarVisible();
  const root = document.getElementById('root');
  if(currentPanel === 'overview') root.innerHTML = renderOverview();
  else if(currentPanel === 'vendorCoverage') root.innerHTML = renderVendorCoverage();
  else if(currentPanel === 'packDistribution') root.innerHTML = renderPackDistribution();
  else if(currentPanel === 'impression') root.innerHTML = renderImpression();
  else if(currentPanel === 'rating') root.innerHTML = renderRating();
  else if(currentPanel === 'orderShare') root.innerHTML = renderOrderShare();
  else if(currentPanel === 'kitchen') root.innerHTML = renderKitchen();
  else if(currentPanel === 'cpoBudget') root.innerHTML = renderCpoBudget();
  else if(currentPanel === 'coverageModel') root.innerHTML = renderCoverageModel();
  else if(currentPanel === 'delivery') root.innerHTML = renderDelivery();
  attachHandlers();
}

/* ============================================================
   Recompute helpers for client-side SuperType filtering
   ============================================================ */
function recomputeVendorBlock(vendors){
  const total = vendors.length;
  const segA = vendors.filter(v=>v.segment==='A').length;
  const segB = vendors.filter(v=>v.segment==='B').length;
  const kitchen = vendors.filter(v=>v.kitchen).length;
  const discSub = vendors.filter(v=>v.discountSubsidy).length;
  const coupSub = vendors.filter(v=>v.couponSubsidy).length;
  const p = (n,d) => d ? Math.round(n/d*1000)/10 : 0;
  return {
    total, segmentA:segA, segmentA_pct:p(segA,total), segmentB:segB, segmentB_pct:p(segB,total),
    topCriticalInA: vendors.filter(v=>v.segment==='A'&&v.topCritical).length,
    kitchen, kitchen_pct:p(kitchen,total),
    discountSubsidy:discSub, discountSubsidy_pct:p(discSub,total),
    couponSubsidy:coupSub, couponSubsidy_pct:p(coupSub,total),
    vendors,
  };
}
function recomputePackBlock(packs){
  const total = packs.length;
  const p = (n,d) => d ? Math.round(n/d*1000)/10 : 0;
  const dealTypeCounts = {}, dealTypePcts = {};
  DEAL_TYPES.forEach(dt => { const c = packs.filter(x=>x.dealType===dt).length; dealTypeCounts[dt]=c; dealTypePcts[dt]=p(c,total); });
  const kitchen = packs.filter(x=>x.kitchen).length;
  const discSub = packs.filter(x=>x.discountSubsidy).length;
  const coupSub = packs.filter(x=>x.couponSubsidy).length;
  const k0 = packs.filter(x=>!x.kitchen);
  const avgDiscount = k0.length ? Math.round(k0.reduce((s,x)=>s+x.snappDiscountToman,0)/k0.length) : 0;
  const activePacks = packs.filter(x=>x.isActive);
  const activeWithImpression = activePacks.filter(x=>x.hasImpression).length;
  return {
    total, dealTypeCounts, dealTypePcts, kitchen, kitchen_pct:p(kitchen,total),
    discountSubsidy:discSub, discountSubsidy_pct:p(discSub,total),
    couponSubsidy:coupSub, couponSubsidy_pct:p(coupSub,total),
    avgSnappDiscountToman: avgDiscount,
    activePackCount: activePacks.length,
    availability_pct: p(activeWithImpression, activePacks.length),
    packs,
  };
}
function recomputeRatingBlock(rows){
  const p = (n,d) => d ? Math.round(n/d*1000)/10 : 0;
  const rated = rows.filter(r=>r.bucket!==null);
  const totalAll = rows.length;
  const noRating = totalAll - rated.length;
  const buckets = {}, bucketPcts = {};
  BUCKET_ORDER.forEach(b => { const c = rated.filter(r=>r.bucket===b).length; buckets[b]=c; bucketPcts[b]=p(c,rated.length); });
  return {
    avgRate: rated.length ? Math.round((rated.reduce((s,r)=>s+r.rate,0)/rated.length)*100)/100 : 0,
    ratedCount: rated.length, ratedCount_pct: p(rated.length,totalAll),
    noRatingCount: noRating, noRatingCount_pct: p(noRating,totalAll),
    buckets, bucketPcts,
  };
}

/* ============================================================
   MODULE 0: OVERVIEW (cross-module summary — City -> Marketing Area)
   ============================================================ */
function overviewCoverageStatus(city, area){
  const cm = DATA.coverageModel;
  if(!cm) return null;
  if(area == null){
    const scopes = cm.cityCoverage && cm.cityCoverage[city];
    return scopes && scopes['All Areas'] ? scopes['All Areas'].status : null;
  }
  const areas = cm.coverageResult && cm.coverageResult[city];
  return areas && areas[area] ? areas[area].status : null;
}
function overviewStatusBadge(status){
  return status ? `<span class="badge status-${escapeAttr(status)}">${escapeHtml(status)}</span>` : '<span class="dim">—</span>';
}

function renderOverview(){
  const d = drill.overview;
  const filtered = superTypeFilter !== 'all';
  const win = orderWindow;
  const vcAll = DATA.vendorCoverage, pdAll = DATA.packDistribution, rtAll = DATA.rating, osAll = DATA.orderShare, cpoAll = DATA.cpoBudget;

  function vendorPackRateForCity(city){
    const vcCity = vcAll[city];
    const pdCity = pdAll.byCity[city];
    const rtCity = rtAll.byCity[city];
    if(!filtered){
      return { vendors: vcCity ? vcCity.total : 0, packs: pdCity ? pdCity.total : 0, avgRate: rtCity ? rtCity.avgRate : 0 };
    }
    const vendors = vcCity ? recomputeVendorBlock(Object.values(vcCity.areas).flatMap(a=>a.vendors).filter(matchesSuperType)).total : 0;
    const packs = pdCity ? recomputePackBlock(Object.values(pdCity.areas).flatMap(a=>a.packs).filter(matchesSuperType)).total : 0;
    const avgRate = rtCity ? recomputeRatingBlock(Object.values(rtCity.areas).flatMap(a=>a.rows).filter(matchesSuperType)).avgRate : 0;
    return { vendors, packs, avgRate };
  }
  function ordersForCity(city){
    const cdata = osAll.byCity[city];
    if(!cdata) return { m41Orders:0, platformOrders:0, share:0, m4oCitiesShare:undefined };
    if(!filtered){
      const w = win==='yesterday' ? cdata.yesterday : cdata.mtd;
      return { m41Orders:w.m41Orders, platformOrders:w.platformOrders, share: w.platformOrders?w.m41Orders/w.platformOrders:0, m4oCitiesShare:w.m4oCitiesShare };
    }
    const field = win === 'yesterday' ? { m41:'m41Y', plat:'platY' } : { m41:'m41Mtd', plat:'platMtd' };
    const rows = Object.values(cdata.areas).flatMap(a=>a.rows).filter(matchesSuperType);
    const m41 = rows.reduce((s,r)=>s+r[field.m41],0);
    const plat = rows.reduce((s,r)=>s+r[field.plat],0);
    return { m41Orders:m41, platformOrders:plat, share: plat?m41/plat:0, m4oCitiesShare: undefined };
  }

  if(!d.city){
    const cities = DATA.meta.cities;
    const rows = cities.map(city => {
      const vpr = vendorPackRateForCity(city);
      const ord = ordersForCity(city);
      const cpo = cpoAll ? (cpoAll.byCity[city] || null) : null;
      const status = overviewCoverageStatus(city, null);
      return { city, ...vpr, ...ord, cpo, status };
    }).filter(r => r.vendors > 0 || r.packs > 0).sort((a,b)=> b.vendors - a.vendors);

    const totalVendors = rows.reduce((s,r)=>s+r.vendors,0);
    const totalPacks = rows.reduce((s,r)=>s+r.packs,0);
    const overallRate = !filtered ? rtAll.avgRate
      : recomputeRatingBlock(cities.flatMap(c => rtAll.byCity[c] ? Object.values(rtAll.byCity[c].areas).flatMap(a=>a.rows) : []).filter(matchesSuperType)).avgRate;
    const totalM41 = rows.reduce((s,r)=>s+r.m41Orders,0);
    const totalPlat = rows.reduce((s,r)=>s+r.platformOrders,0);
    const overallShare = totalPlat ? totalM41/totalPlat : 0;
    const overallAreaShare = !filtered ? (win==='yesterday'?osAll.overallYesterday.m4oCitiesShare:osAll.overallMtd.m4oCitiesShare) : undefined;
    const overallAllCitiesShare = !filtered ? (win==='yesterday'?osAll.overallYesterday.allCitiesShare:osAll.overallMtd.allCitiesShare) : undefined;
    const totalBudget = cpoAll ? cpoAll.overall.all.totalBudget : null;
    const overallCpo = cpoAll ? cpoAll.overall.all.cpo : null;

    return `
      ${breadcrumb(['All Cities'])}
      <div class="section-note">A cross-module summary — vendors, packs, rating, order share, budget and coverage together, per city and Marketing Area.${!filtered ? '' : ' Budget, CPO and Coverage figures are never affected by the Vendor Type filter — their source data has no per-row Vendor Type.'}</div>
      <div class="flex-between">
        <div class="section-title" style="margin:0">Overview</div>
        <div class="toggle-group">
          <div class="toggle-btn ${win==='yesterday'?'active':''}" data-window="yesterday">Yesterday</div>
          <div class="toggle-btn ${win==='mtd'?'active':''}" data-window="mtd">Month to Date</div>
        </div>
      </div>
      <div class="stat-row">
        <div class="stat-card"><div class="label">Total Vendors</div><div class="value">${fmt(totalVendors)}</div></div>
        <div class="stat-card"><div class="label">Total Packs</div><div class="value">${fmt(totalPacks)}</div></div>
        <div class="stat-card accent"><div class="label">Avg Rate</div><div class="value">${overallRate.toFixed(2)}</div></div>
        <div class="stat-card"><div class="label">M4O Orders</div><div class="value small">${fmt(totalM41)}</div></div>
        <div class="stat-card purple"><div class="label">Vendor Engagement</div><div class="value small">${shareToPct(overallShare)}</div></div>
        ${overallAreaShare !== undefined ? `<div class="stat-card seg-b"><div class="label">Order Share (M4O Cities)</div><div class="value small">${overallAreaShare!==null?shareToPct(overallAreaShare):'<span class="dim">—</span>'}</div></div>` : ''}
        ${overallAllCitiesShare !== undefined ? `<div class="stat-card"><div class="label">Order Share (All Cities)</div><div class="value small">${overallAllCitiesShare!==null?shareToPct(overallAllCitiesShare):'<span class="dim">—</span>'}</div></div>` : ''}
        ${totalBudget !== null ? `<div class="stat-card"><div class="label">Total Budget</div><div class="value small">${tomanCompact(totalBudget)}</div></div>` : ''}
        ${overallCpo !== null ? `<div class="stat-card accent"><div class="label">Overall CPO</div><div class="value small">${tomanCompact(overallCpo)}</div></div>` : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>City</th><th>Vendors</th><th>Packs</th><th>Avg Rate</th><th>M4O Orders</th><th>Vendor Engagement</th><th>Order Share (M4O Cities)</th><th>Total Budget</th><th>CPO</th><th>Coverage</th></tr></thead>
          <tbody>
            ${rows.map(r => `<tr class="clickable" data-action="ov-city" data-city="${escapeAttr(r.city)}">
              <td>${escapeHtml(r.city)}</td>
              <td style="font-family:var(--mono)">${fmt(r.vendors)}</td>
              <td style="font-family:var(--mono)">${fmt(r.packs)}</td>
              <td style="font-family:var(--mono); color:var(--accent)">${r.avgRate.toFixed(2)}</td>
              <td style="font-family:var(--mono)">${fmt(r.m41Orders)}</td>
              <td style="font-family:var(--mono); color:var(--purple)">${r.platformOrders?shareToPct(r.share):'<span class="dim">—</span>'}</td>
              <td style="font-family:var(--mono); color:var(--seg-b)">${r.m4oCitiesShare!==undefined && r.m4oCitiesShare!==null?shareToPct(r.m4oCitiesShare):'<span class="dim">—</span>'}</td>
              <td style="font-family:var(--mono)">${r.cpo?tomanCompact(r.cpo.totalBudget):'<span class="dim">—</span>'}</td>
              <td style="font-family:var(--mono); color:var(--accent)">${r.cpo&&r.cpo.cpo!==null?tomanCompact(r.cpo.cpo):'<span class="dim">—</span>'}</td>
              <td>${overviewStatusBadge(r.status)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // City drilled in — Marketing Areas
  const city = d.city;
  const vcCity = vcAll[city];
  const areaNames = vcCity ? Object.keys(vcCity.areas) : [];
  const rows = areaNames.map(area => {
    const vArea = vcCity.areas[area];
    const vendors = filtered ? recomputeVendorBlock(vArea.vendors.filter(matchesSuperType)).total : vArea.total;
    const pdCityData = pdAll.byCity[city];
    const pdArea = pdCityData && pdCityData.areas[area];
    const packs = pdArea ? (filtered ? recomputePackBlock(pdArea.packs.filter(matchesSuperType)).total : pdArea.total) : 0;
    const rtCityData = rtAll.byCity[city];
    const rtArea = rtCityData && rtCityData.areas[area];
    const avgRate = rtArea ? (filtered ? recomputeRatingBlock(rtArea.rows.filter(matchesSuperType)).avgRate : rtArea.avgRate) : 0;
    const osCityData = osAll.byCity[city];
    const osArea = osCityData && osCityData.areas[area];
    let m41Orders=0, platformOrders=0, share=0, areaM4OShare;
    if(osArea){
      if(!filtered){
        const w = win==='yesterday'?osArea.yesterday:osArea.mtd;
        m41Orders=w.m41Orders; platformOrders=w.platformOrders; share= platformOrders?m41Orders/platformOrders:0; areaM4OShare=w.areaM4OShare;
      } else {
        const field = win === 'yesterday' ? { m41:'m41Y', plat:'platY' } : { m41:'m41Mtd', plat:'platMtd' };
        const matched = osArea.rows.filter(matchesSuperType);
        m41Orders = matched.reduce((s,r)=>s+r[field.m41],0);
        platformOrders = matched.reduce((s,r)=>s+r[field.plat],0);
        share = platformOrders ? m41Orders/platformOrders : 0;
      }
    }
    const cpoCityData = cpoAll && cpoAll.byCity[city];
    const cpoArea = cpoCityData && cpoCityData.areas[area] ? cpoCityData.areas[area] : null;
    const status = overviewCoverageStatus(city, area);
    return { area, vendors, packs, avgRate, m41Orders, platformOrders, share, areaM4OShare, cpo: cpoArea, status };
  }).filter(r => r.vendors > 0 || r.packs > 0).sort((a,b)=> b.vendors - a.vendors);

  return `
    ${breadcrumb(['All Cities', city], ['ov-city-null'])}
    <div class="flex-between">
      <div class="section-title" style="margin:0">Marketing Areas (${rows.length})</div>
      <div class="toggle-group">
        <div class="toggle-btn ${win==='yesterday'?'active':''}" data-window="yesterday">Yesterday</div>
        <div class="toggle-btn ${win==='mtd'?'active':''}" data-window="mtd">Month to Date</div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Area</th><th>Vendors</th><th>Packs</th><th>Avg Rate</th><th>M4O Orders</th><th>Vendor Engagement</th><th>M4O Share of Total Platform Orders (Area)</th><th>Total Budget</th><th>CPO</th><th>Coverage</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td>${escapeHtml(r.area)}</td>
            <td style="font-family:var(--mono)">${fmt(r.vendors)}</td>
            <td style="font-family:var(--mono)">${fmt(r.packs)}</td>
            <td style="font-family:var(--mono); color:var(--accent)">${r.avgRate.toFixed(2)}</td>
            <td style="font-family:var(--mono)">${fmt(r.m41Orders)}</td>
            <td style="font-family:var(--mono); color:var(--purple)">${r.platformOrders?shareToPct(r.share):'<span class="dim">—</span>'}</td>
            <td style="font-family:var(--mono); color:var(--seg-b)">${r.areaM4OShare!==undefined?shareToPct(r.areaM4OShare):'<span class="dim">—</span>'}</td>
            <td style="font-family:var(--mono)">${r.cpo?tomanCompact(r.cpo.totalBudget):'<span class="dim">—</span>'}</td>
            <td style="font-family:var(--mono); color:var(--accent)">${r.cpo&&r.cpo.cpo!==null?tomanCompact(r.cpo.cpo):'<span class="dim">—</span>'}</td>
            <td>${overviewStatusBadge(r.status)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ============================================================
   MODULE 1: VENDOR COVERAGE
   ============================================================ */
function renderVendorCoverage(){
  const d = drill.vendorCoverage;
  const vc = DATA.vendorCoverage;
  const filtered = superTypeFilter !== 'all';

  if(d.vendorId){
    return renderVendorDetail(d);
  }

  if(!d.city){
    let cities;
    if(!filtered){
      cities = Object.entries(vc).sort((a,b)=>b[1].total-a[1].total);
    } else {
      cities = Object.entries(vc).map(([city, cdata]) => {
        const allVendors = Object.values(cdata.areas).flatMap(a=>a.vendors);
        const matched = allVendors.filter(matchesSuperType);
        return [city, recomputeVendorBlock(matched)];
      }).filter(([,v]) => v.total > 0).sort((a,b)=>b[1].total-a[1].total);
    }
    const totalVendors = cities.reduce((s,[,v])=>s+v.total,0);
    const totalA = cities.reduce((s,[,v])=>s+v.segmentA,0);
    const totalB = cities.reduce((s,[,v])=>s+v.segmentB,0);
    const totalTC = cities.reduce((s,[,v])=>s+v.topCriticalInA,0);
    const totalKitchen = cities.reduce((s,[,v])=>s+v.kitchen,0);
    const totalDiscSub = cities.reduce((s,[,v])=>s+v.discountSubsidy,0);
    const totalCoupSub = cities.reduce((s,[,v])=>s+v.couponSubsidy,0);

    return `
      ${breadcrumb(['All Cities'])}
      <div class="stat-row">
        <div class="stat-card"><div class="label">Total Vendors</div><div class="value">${fmt(totalVendors)}</div></div>
        <div class="stat-card seg-a"><div class="label">Segment A</div><div class="value">${fmt(totalA)}<span class="pct-tag">${pct1(totalVendors?totalA/totalVendors*100:0)}</span></div></div>
        <div class="stat-card seg-b"><div class="label">Segment B</div><div class="value">${fmt(totalB)}<span class="pct-tag">${pct1(totalVendors?totalB/totalVendors*100:0)}</span></div></div>
        <div class="stat-card accent"><div class="label">Top Critical (in A)</div><div class="value">${fmt(totalTC)}</div></div>
        <div class="stat-card purple"><div class="label">Kitchen Vendors</div><div class="value">${fmt(totalKitchen)}<span class="pct-tag">${pct1(totalVendors?totalKitchen/totalVendors*100:0)}</span></div></div>
        <div class="stat-card"><div class="label">Discount Subsidy</div><div class="value small">${fmt(totalDiscSub)}<span class="pct-tag">${pct1(totalVendors?totalDiscSub/totalVendors*100:0)}</span></div></div>
        <div class="stat-card"><div class="label">Coupon Subsidy</div><div class="value small">${fmt(totalCoupSub)}<span class="pct-tag">${pct1(totalVendors?totalCoupSub/totalVendors*100:0)}</span></div></div>
      </div>
      <div class="section-title">Cities</div>
      <div class="card-grid">
        ${cities.map(([city,v]) => cityCard(city,v)).join('')}
      </div>`;
  }

  if(d.city && !d.area){
    const cdata = vc[d.city];
    let areas;
    if(!filtered){
      areas = Object.entries(cdata.areas).sort((a,b)=>b[1].total-a[1].total);
    } else {
      areas = Object.entries(cdata.areas).map(([area, adata]) => {
        const matched = adata.vendors.filter(matchesSuperType);
        return [area, recomputeVendorBlock(matched)];
      }).filter(([,v]) => v.total > 0).sort((a,b)=>b[1].total-a[1].total);
    }
    const cBlock = filtered ? recomputeVendorBlock(areas.flatMap(([,v])=>v.vendors)) : cdata;
    return `
      ${breadcrumb(['All Cities', d.city], ['vc-city-null', null])}
      <div class="stat-row">
        <div class="stat-card"><div class="label">Total Vendors</div><div class="value">${fmt(cBlock.total)}</div></div>
        <div class="stat-card seg-a"><div class="label">Segment A</div><div class="value">${fmt(cBlock.segmentA)}<span class="pct-tag">${pct1(cBlock.segmentA_pct)}</span></div></div>
        <div class="stat-card seg-b"><div class="label">Segment B</div><div class="value">${fmt(cBlock.segmentB)}<span class="pct-tag">${pct1(cBlock.segmentB_pct)}</span></div></div>
        <div class="stat-card accent"><div class="label">Top Critical (in A)</div><div class="value">${fmt(cBlock.topCriticalInA)}</div></div>
        <div class="stat-card purple"><div class="label">Kitchen Vendors</div><div class="value">${fmt(cBlock.kitchen)}<span class="pct-tag">${pct1(cBlock.kitchen_pct)}</span></div></div>
        <div class="stat-card"><div class="label">Discount Subsidy</div><div class="value small">${fmt(cBlock.discountSubsidy)}<span class="pct-tag">${pct1(cBlock.discountSubsidy_pct)}</span></div></div>
        <div class="stat-card"><div class="label">Coupon Subsidy</div><div class="value small">${fmt(cBlock.couponSubsidy)}<span class="pct-tag">${pct1(cBlock.couponSubsidy_pct)}</span></div></div>
      </div>
      <div class="section-title">Marketing Areas (${areas.length})</div>
      <div class="card-grid">
        ${areas.map(([area,v]) => areaCard(area,v)).join('')}
      </div>`;
  }

  const rawArea = vc[d.city].areas[d.area];
  const adata = filtered ? recomputeVendorBlock(rawArea.vendors.filter(matchesSuperType)) : rawArea;
  const vendors = [...adata.vendors].sort((a,b)=> (b.topCritical - a.topCritical) || a.segment.localeCompare(b.segment));
  return `
    ${breadcrumb(['All Cities', d.city, d.area], ['vc-city-null', 'vc-area-null', null])}
    <div class="stat-row">
      <div class="stat-card"><div class="label">Vendors</div><div class="value">${fmt(adata.total)}</div></div>
      <div class="stat-card seg-a"><div class="label">Segment A</div><div class="value">${fmt(adata.segmentA)}<span class="pct-tag">${pct1(adata.segmentA_pct)}</span></div></div>
      <div class="stat-card seg-b"><div class="label">Segment B</div><div class="value">${fmt(adata.segmentB)}<span class="pct-tag">${pct1(adata.segmentB_pct)}</span></div></div>
      <div class="stat-card accent"><div class="label">Top Critical (in A)</div><div class="value">${fmt(adata.topCriticalInA)}</div></div>
      <div class="stat-card purple"><div class="label">Kitchen</div><div class="value">${fmt(adata.kitchen)}<span class="pct-tag">${pct1(adata.kitchen_pct)}</span></div></div>
      <div class="stat-card"><div class="label">Discount Subsidy</div><div class="value small">${fmt(adata.discountSubsidy)}<span class="pct-tag">${pct1(adata.discountSubsidy_pct)}</span></div></div>
      <div class="stat-card"><div class="label">Coupon Subsidy</div><div class="value small">${fmt(adata.couponSubsidy)}<span class="pct-tag">${pct1(adata.couponSubsidy_pct)}</span></div></div>
    </div>
    <div class="flex-between">
      <input class="search-box" id="vendorSearch" placeholder="Filter vendors by name…" style="margin-bottom:0">
      <div class="toggle-group">
        <div class="toggle-btn ${orderWindow==='yesterday'?'active':''}" data-window="yesterday">Yesterday</div>
        <div class="toggle-btn ${orderWindow==='mtd'?'active':''}" data-window="mtd">Month to Date</div>
      </div>
    </div>
    <div class="section-note">Entry Date is the vendor's earliest coupon start date. Market Share = vendor's share of all platform orders in its area. M4O Area Share = vendor's share of all Meal4One orders placed with vendors in its area.</div>
    <div class="table-wrap">
      <table id="vendorTable">
        <thead><tr><th>Vendor</th><th>Segment</th><th>Top Critical</th><th>Kitchen</th><th>Entry Date</th><th>M4O Orders</th><th>Platform Orders</th><th>M4O Share</th><th>Market Share</th><th>M4O Area Share</th></tr></thead>
        <tbody>
          ${vendors.map(v => {
            const orders = orderWindow === 'yesterday' ? v.ordersYesterday : v.ordersMtd;
            const platform = orderWindow === 'yesterday' ? v.platformOrdersYesterday : v.platformOrdersMtd;
            const marketShare = orderWindow === 'yesterday' ? v.vendorMarketShare : v.vendorMarketShareMtd;
            const areaShare = orderWindow === 'yesterday' ? v.m4oAreaShare : v.m4oAreaShareMtd;
            return `<tr class="clickable" data-action="vc-vendor" data-vendor-id="${v.id}" data-name="${escapeHtml(v.name.toLowerCase())}">
            <td>${escapeHtml(v.name)}</td>
            <td><span class="badge seg-${escapeAttr(v.segment)}">${escapeHtml(v.segment)}</span></td>
            <td>${v.topCritical ? '<span class="badge tc">TC</span>' : '<span class="dim">—</span>'}</td>
            <td>${v.kitchen ? '<span class="badge kit">Kitchen</span>' : '<span class="dim">—</span>'}</td>
            <td>${v.entryDate ? escapeHtml(v.entryDate) : '<span class="dim">—</span>'}</td>
            <td style="font-family:var(--mono)">${fmt(orders)}</td>
            <td style="font-family:var(--mono)">${fmt(platform)}</td>
            <td style="font-family:var(--mono); color:var(--accent)">${platform ? shareToPct(orders/platform) : '<span class="dim">—</span>'}</td>
            <td style="font-family:var(--mono); color:var(--purple)">${marketShare !== null ? shareToPct(marketShare) : '<span class="dim">—</span>'}</td>
            <td style="font-family:var(--mono); color:var(--seg-b)">${areaShare !== null ? shareToPct(areaShare) : '<span class="dim">—</span>'}</td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderVendorDetail(d){
  const vc = DATA.vendorCoverage;
  const area = vc[d.city].areas[d.area];
  const v = area.vendors.find(x => String(x.id) === String(d.vendorId));
  if(!v) return `<div class="empty-state">Vendor not found.</div>`;
  const orderWin = orderWindow === 'yesterday' ? { orders: v.ordersYesterday, platform: v.platformOrdersYesterday, marketShare: v.vendorMarketShare } : { orders: v.ordersMtd, platform: v.platformOrdersMtd, marketShare: v.vendorMarketShareMtd };
  return `
    ${breadcrumb(['All Cities', d.city, d.area, v.name], ['vc-city-null', 'vc-area-null', 'vc-vendor-null', null])}
    <div class="detail-panel">
      <div class="dname">${escapeHtml(v.name)}
        <span class="badge seg-${escapeAttr(v.segment)}" style="margin-left:8px">${escapeHtml(v.segment)}</span>
        ${v.topCritical ? '<span class="badge tc">Top Critical</span>' : ''}
        ${v.kitchen ? '<span class="badge kit">Kitchen</span>' : ''}
      </div>
      <div class="detail-grid">
        <div class="detail-item"><div class="dlabel">City / Area</div><div class="dvalue" style="font-size:13px">${escapeHtml(d.city)} — ${escapeHtml(d.area)}</div></div>
        <div class="detail-item"><div class="dlabel">Entry Date</div><div class="dvalue">${v.entryDate ? escapeHtml(v.entryDate) : '—'}</div></div>
        <div class="detail-item"><div class="dlabel">Discount Subsidy</div><div class="dvalue">${v.discountSubsidy ? 'Yes' : 'No'}</div></div>
        <div class="detail-item"><div class="dlabel">Coupon Subsidy</div><div class="dvalue">${v.couponSubsidy ? 'Yes' : 'No'}</div></div>
      </div>
    </div>
    <div class="flex-between">
      <div class="section-title" style="margin:0">Order Stats</div>
      <div class="toggle-group">
        <div class="toggle-btn ${orderWindow==='yesterday'?'active':''}" data-window="yesterday">Yesterday</div>
        <div class="toggle-btn ${orderWindow==='mtd'?'active':''}" data-window="mtd">Month to Date</div>
      </div>
    </div>
    <div class="stat-row">
      <div class="stat-card"><div class="label">M4O Orders</div><div class="value">${fmt(orderWin.orders)}</div></div>
      <div class="stat-card"><div class="label">Platform Orders</div><div class="value">${fmt(orderWin.platform)}</div></div>
      <div class="stat-card accent"><div class="label">M4O Share</div><div class="value">${orderWin.platform ? shareToPct(orderWin.orders/orderWin.platform) : '—'}</div></div>
      <div class="stat-card purple"><div class="label">Market Share (Area)</div><div class="value small">${orderWin.marketShare !== null ? shareToPct(orderWin.marketShare) : '—'}</div><div class="sub">Vendor's share of all platform orders in its area</div></div>
    </div>`;
}

function cityCard(city, v){
  const other = v.total - v.segmentA - v.segmentB;
  const pctA = v.total ? (v.segmentA/v.total*100) : 0;
  const pctB = v.total ? (v.segmentB/v.total*100) : 0;
  const pctO = v.total ? (other/v.total*100) : 0;
  return `<div class="list-card" data-action="vc-city" data-city="${escapeAttr(city)}">
    <div class="name">${escapeHtml(city)}</div>
    <div class="row"><span>Total vendors</span><b>${fmt(v.total)}</b></div>
    <div class="row"><span>Segment A</span><b>${fmt(v.segmentA)}<span class="pct">${pct1(v.segmentA_pct)}</span></b></div>
    <div class="row"><span>Segment B</span><b>${fmt(v.segmentB)}<span class="pct">${pct1(v.segmentB_pct)}</span></b></div>
    <div class="bar"><div class="a" style="width:${pctA}%"></div><div class="b" style="width:${pctB}%"></div><div class="o" style="width:${pctO}%"></div></div>
    <div class="row"><span>Top Critical in A</span><b style="color:var(--accent)">${fmt(v.topCriticalInA)}</b></div>
    <div class="row"><span>Kitchen</span><b>${fmt(v.kitchen)}<span class="pct">${pct1(v.kitchen_pct)}</span></b></div>
  </div>`;
}
function areaCard(area, v){
  const other = v.total - v.segmentA - v.segmentB;
  const pctA = v.total ? (v.segmentA/v.total*100) : 0;
  const pctB = v.total ? (v.segmentB/v.total*100) : 0;
  const pctO = v.total ? (other/v.total*100) : 0;
  return `<div class="list-card" data-action="vc-area" data-area="${escapeAttr(area)}">
    <div class="name">${escapeHtml(area)}</div>
    <div class="row"><span>Vendors</span><b>${fmt(v.total)}</b></div>
    <div class="row"><span>Segment A / B</span><b>${v.segmentA} / ${v.segmentB}</b></div>
    <div class="bar"><div class="a" style="width:${pctA}%"></div><div class="b" style="width:${pctB}%"></div><div class="o" style="width:${pctO}%"></div></div>
    <div class="row"><span>Top Critical in A</span><b style="color:var(--accent)">${fmt(v.topCriticalInA)}</b></div>
    <div class="row"><span>Kitchen</span><b>${fmt(v.kitchen)}<span class="pct">${pct1(v.kitchen_pct)}</span></b></div>
  </div>`;
}

/* ============================================================
   MODULE 2: PACK DISTRIBUTION
   ============================================================ */
function renderPackDistribution(){
  const d = drill.packDistribution;
  const pd = DATA.packDistribution;
  const filtered = superTypeFilter !== 'all';

  if(!d.city){
    let cities;
    if(!filtered){
      cities = Object.entries(pd.byCity).sort((a,b)=>b[1].total-a[1].total);
    } else {
      cities = Object.entries(pd.byCity).map(([city, cdata]) => {
        const allPacks = Object.values(cdata.areas).flatMap(a=>a.packs);
        const matched = allPacks.filter(matchesSuperType);
        return [city, recomputePackBlock(matched)];
      }).filter(([,v]) => v.total > 0).sort((a,b)=>b[1].total-a[1].total);
    }
    const overall = filtered ? recomputePackBlock(cities.flatMap(([,v])=>v.packs)) : pd;
    return `
      ${breadcrumb(['All Cities'])}
      <div class="stat-row">
        <div class="stat-card"><div class="label">Total Packs</div><div class="value">${fmt(overall.total)}</div></div>
        ${DEAL_TYPES.map(dt => `<div class="stat-card"><div class="label">${dt}</div><div class="value" style="color:${DEAL_COLORS[dt]}">${fmt(overall.dealTypeCounts[dt]||0)}<span class="pct-tag">${pct1(overall.dealTypePcts[dt]||0)}</span></div></div>`).join('')}
        <div class="stat-card purple"><div class="label">Kitchen Packs</div><div class="value small">${fmt(overall.kitchen)}<span class="pct-tag">${pct1(overall.kitchen_pct)}</span></div></div>
        <div class="stat-card"><div class="label">Discount Subsidy</div><div class="value small">${fmt(overall.discountSubsidy)}<span class="pct-tag">${pct1(overall.discountSubsidy_pct)}</span></div></div>
        <div class="stat-card"><div class="label">Coupon Subsidy</div><div class="value small">${fmt(overall.couponSubsidy)}<span class="pct-tag">${pct1(overall.couponSubsidy_pct)}</span></div></div>
        <div class="stat-card accent"><div class="label">Avg Snapp Discount (non-Kitchen)</div><div class="value small">${toman(overall.avgSnappDiscountToman)}</div></div>
        <div class="stat-card seg-a"><div class="label">Availability</div><div class="value small">${pct1(overall.availability_pct)}</div><div class="sub">Share of Activity==1 packs that got at least one impression</div></div>
      </div>
      <div class="chart-row">
        <div class="chart-box"><h3>Deal Type Distribution</h3><canvas id="dealTypeChart"></canvas></div>
        <div class="chart-box"><h3>Top Cities by Pack Count</h3><canvas id="cityPackChart"></canvas></div>
      </div>
      <div class="section-title">Cities</div>
      <div class="card-grid">
        ${cities.map(([city,v]) => packCityCard(city,v)).join('')}
      </div>`;
  }

  if(d.city && !d.area){
    const cdata = pd.byCity[d.city];
    let areas;
    if(!filtered){
      areas = Object.entries(cdata.areas).sort((a,b)=>b[1].total-a[1].total);
    } else {
      areas = Object.entries(cdata.areas).map(([area, adata]) => [area, recomputePackBlock(adata.packs.filter(matchesSuperType))]).filter(([,v]) => v.total > 0).sort((a,b)=>b[1].total-a[1].total);
    }
    const cBlock = filtered ? recomputePackBlock(areas.flatMap(([,v])=>v.packs)) : cdata;
    return `
      ${breadcrumb(['All Cities', d.city], ['pd-city-null', null])}
      <div class="stat-row">
        <div class="stat-card"><div class="label">Total Packs</div><div class="value">${fmt(cBlock.total)}</div></div>
        ${DEAL_TYPES.map(dt => `<div class="stat-card"><div class="label">${dt}</div><div class="value" style="color:${DEAL_COLORS[dt]}">${fmt(cBlock.dealTypeCounts[dt]||0)}<span class="pct-tag">${pct1(cBlock.dealTypePcts[dt]||0)}</span></div></div>`).join('')}
        <div class="stat-card purple"><div class="label">Kitchen</div><div class="value small">${fmt(cBlock.kitchen)}<span class="pct-tag">${pct1(cBlock.kitchen_pct)}</span></div></div>
        <div class="stat-card"><div class="label">Discount Subsidy</div><div class="value small">${fmt(cBlock.discountSubsidy)}<span class="pct-tag">${pct1(cBlock.discountSubsidy_pct)}</span></div></div>
        <div class="stat-card"><div class="label">Coupon Subsidy</div><div class="value small">${fmt(cBlock.couponSubsidy)}<span class="pct-tag">${pct1(cBlock.couponSubsidy_pct)}</span></div></div>
        <div class="stat-card accent"><div class="label">Avg Snapp Discount (non-Kitchen)</div><div class="value small">${toman(cBlock.avgSnappDiscountToman)}</div></div>
        <div class="stat-card seg-a"><div class="label">Availability</div><div class="value small">${pct1(cBlock.availability_pct)}</div></div>
      </div>
      <div class="section-title">Marketing Areas (${areas.length})</div>
      <div class="card-grid">
        ${areas.map(([area,v]) => packAreaCard(area,v)).join('')}
      </div>`;
  }

  const rawArea = pd.byCity[d.city].areas[d.area];
  const adata = filtered ? recomputePackBlock(rawArea.packs.filter(matchesSuperType)) : rawArea;
  const packs = [...adata.packs].sort((a,b)=> b.snappDiscountToman - a.snappDiscountToman);
  return `
    ${breadcrumb(['All Cities', d.city, d.area], ['pd-city-null', 'pd-area-null', null])}
    <div class="stat-row">
      <div class="stat-card"><div class="label">Packs</div><div class="value">${fmt(adata.total)}</div></div>
      ${DEAL_TYPES.map(dt => `<div class="stat-card"><div class="label">${dt}</div><div class="value small" style="color:${DEAL_COLORS[dt]}">${fmt(adata.dealTypeCounts[dt]||0)}<span class="pct-tag">${pct1(adata.dealTypePcts[dt]||0)}</span></div></div>`).join('')}
      <div class="stat-card purple"><div class="label">Kitchen</div><div class="value small">${fmt(adata.kitchen)}<span class="pct-tag">${pct1(adata.kitchen_pct)}</span></div></div>
      <div class="stat-card"><div class="label">Discount Subsidy</div><div class="value small">${fmt(adata.discountSubsidy)}<span class="pct-tag">${pct1(adata.discountSubsidy_pct)}</span></div></div>
      <div class="stat-card"><div class="label">Coupon Subsidy</div><div class="value small">${fmt(adata.couponSubsidy)}<span class="pct-tag">${pct1(adata.couponSubsidy_pct)}</span></div></div>
      <div class="stat-card accent"><div class="label">Avg Snapp Discount (non-Kitchen)</div><div class="value small">${toman(adata.avgSnappDiscountToman)}</div></div>
      <div class="stat-card seg-a"><div class="label">Availability</div><div class="value small">${pct1(adata.availability_pct)}</div></div>
    </div>
    <input class="search-box" id="packSearch" placeholder="Filter packs by title or vendor…">
    <div class="table-wrap">
      <table id="packTable">
        <thead><tr><th>Pack</th><th>Vendor</th><th>Kitchen</th><th>Deal Type</th><th>Discount Sub.</th><th>Coupon Sub.</th><th>Price</th><th>Snapp Discount</th></tr></thead>
        <tbody>
          ${packs.map(p => `<tr data-name="${escapeHtml((p.title+' '+p.vendorName).toLowerCase())}">
            <td>${escapeHtml(p.title||'—')}</td>
            <td>${escapeHtml(p.vendorName)}</td>
            <td>${p.kitchen ? '<span class="badge kit">Kitchen</span>' : '<span class="dim">—</span>'}</td>
            <td><span class="badge deal-${DEAL_CLASS[p.dealType]||'Not'}">${escapeHtml(p.dealType)}</span></td>
            <td>${p.discountSubsidy ? '<span class="badge sub-d">Yes</span>' : '<span class="dim">—</span>'}</td>
            <td>${p.couponSubsidy ? '<span class="badge sub-c">Yes</span>' : '<span class="dim">—</span>'}</td>
            <td style="font-family:var(--mono)">${toman(p.price)}</td>
            <td style="font-family:var(--mono); color:var(--accent)">${toman(p.snappDiscountToman)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function packCityCard(city, v){
  return `<div class="list-card" data-action="pd-city" data-city="${escapeAttr(city)}">
    <div class="name">${escapeHtml(city)}</div>
    <div class="row"><span>Total packs</span><b>${fmt(v.total)}</b></div>
    <div class="row"><span>Super</span><b style="color:${DEAL_COLORS.Super}">${fmt(v.dealTypeCounts.Super||0)}<span class="pct">${pct1(v.dealTypePcts.Super||0)}</span></b></div>
    <div class="row"><span>Good</span><b style="color:${DEAL_COLORS.Good}">${fmt(v.dealTypeCounts.Good||0)}<span class="pct">${pct1(v.dealTypePcts.Good||0)}</span></b></div>
    <div class="row"><span>Kitchen</span><b>${fmt(v.kitchen)}<span class="pct">${pct1(v.kitchen_pct)}</span></b></div>
    <div class="row"><span>Avg SF Discount</span><b style="color:var(--accent)">${toman(v.avgSnappDiscountToman)}</b></div>
  </div>`;
}
function packAreaCard(area, v){
  return `<div class="list-card" data-action="pd-area" data-area="${escapeAttr(area)}">
    <div class="name">${escapeHtml(area)}</div>
    <div class="row"><span>Packs</span><b>${fmt(v.total)}</b></div>
    <div class="row"><span>Super / Good</span><b>${v.dealTypeCounts.Super||0} / ${v.dealTypeCounts.Good||0}</b></div>
    <div class="row"><span>Basic / Weak</span><b>${v.dealTypeCounts.Basic||0} / ${v.dealTypeCounts.Weak||0}</b></div>
    <div class="row"><span>Kitchen</span><b>${fmt(v.kitchen)}<span class="pct">${pct1(v.kitchen_pct)}</span></b></div>
    <div class="row"><span>Avg SF Discount</span><b style="color:var(--accent)">${toman(v.avgSnappDiscountToman)}</b></div>
  </div>`;
}

/* ============================================================
   MODULE: IMPRESSION (yesterday, per pack, half-hour buckets)
   ============================================================ */
function recomputeImpressionBlock(packs){
  const total = packs.reduce((s,x)=>s+x.total,0);
  const bySlot = new Array(34).fill(0);
  packs.forEach(x => x.bySlot.forEach((v,i)=>{ bySlot[i]+=v; }));
  const vendorCount = new Set(packs.map(x=>x.vendorId)).size;
  const p = (n,d) => d ? Math.round(n/d*1000)/10 : 0;
  const kitchenTotal = packs.filter(x=>x.kitchen).reduce((s,x)=>s+x.total,0);
  const segATotal = packs.filter(x=>x.segment==='A').reduce((s,x)=>s+x.total,0);
  const segBTotal = packs.filter(x=>x.segment==='B').reduce((s,x)=>s+x.total,0);
  const dealTypeTotals = {}, dealTypePcts = {};
  DEAL_TYPES.forEach(dt => { const t = packs.filter(x=>x.dealType===dt).reduce((s,x)=>s+x.total,0); dealTypeTotals[dt]=t; dealTypePcts[dt]=p(t,total); });
  return {
    total, packCount: packs.length, vendorCount, avgPerPack: packs.length ? Math.round(total/packs.length) : 0,
    bySlot,
    kitchenTotal, kitchenTotal_pct: p(kitchenTotal,total),
    nonKitchenTotal: total-kitchenTotal, nonKitchenTotal_pct: p(total-kitchenTotal,total),
    segATotal, segATotal_pct: p(segATotal,total), segBTotal, segBTotal_pct: p(segBTotal,total),
    dealTypeTotals, dealTypePcts, packs,
  };
}

function renderImpression(){
  const d = drill.impression;
  const imp = DATA.impression;
  if(!imp){
    return `<div class="empty-state">No Impression data available. Re-run <code>node update_dashboard.js</code> to generate it.</div>`;
  }
  const filtered = superTypeFilter !== 'all';

  if(!d.city){
    let cities;
    if(!filtered){
      cities = Object.entries(imp.byCity).sort((a,b)=>b[1].total-a[1].total);
    } else {
      cities = Object.entries(imp.byCity).map(([city, cdata]) => {
        const allPacks = Object.values(cdata.areas).flatMap(a=>a.packs);
        return [city, recomputeImpressionBlock(allPacks.filter(matchesSuperType))];
      }).filter(([,v]) => v.total > 0).sort((a,b)=>b[1].total-a[1].total);
    }
    const overall = filtered ? recomputeImpressionBlock(cities.flatMap(([,v])=>v.packs)) : imp.overall;

    return `
      ${breadcrumb(['All Cities'])}
      <div class="stat-row">
        <div class="stat-card accent"><div class="label">Total Impressions</div><div class="value">${fmtCompact(overall.total)}</div></div>
        <div class="stat-card"><div class="label">Packs w/ Impressions</div><div class="value small">${fmt(overall.packCount)}</div></div>
        <div class="stat-card"><div class="label">Vendors w/ Impressions</div><div class="value small">${fmt(overall.vendorCount)}</div></div>
        <div class="stat-card"><div class="label">Avg / Pack</div><div class="value small">${fmtCompact(overall.avgPerPack)}</div></div>
        <div class="stat-card purple"><div class="label">Kitchen Share</div><div class="value small">${pct1(overall.kitchenTotal_pct)}</div></div>
        <div class="stat-card seg-a"><div class="label">Segment A Share</div><div class="value small">${pct1(overall.segATotal_pct)}</div></div>
        <div class="stat-card seg-b"><div class="label">Segment B Share</div><div class="value small">${pct1(overall.segBTotal_pct)}</div></div>
      </div>
      <div class="chart-box"><h3>Impressions by Time of Day (half-hour trend)</h3><canvas id="impTimeChart"></canvas></div>
      ${!filtered ? renderImpressionSegmentComparison() : ''}
      <div class="section-title">Impressions by Deal Type</div>
      <div class="stat-row">
        ${DEAL_TYPES.map(dt => `<div class="stat-card"><div class="label">${dt}</div><div class="value small" style="color:${DEAL_COLORS[dt]}">${fmtCompact(overall.dealTypeTotals[dt]||0)}<span class="pct-tag">${pct1(overall.dealTypePcts[dt]||0)}</span></div></div>`).join('')}
      </div>
      <div class="section-title">Cities</div>
      <div class="card-grid">
        ${cities.map(([city,v]) => impressionCityCard(city,v)).join('')}
      </div>
      ${!filtered ? renderImpressionConversion() : '<div class="section-note">Impression → Order Conversion is only available for the unfiltered (All) Vendor Type view.</div>'}`;
  }

  if(d.city && !d.area){
    const cdata = imp.byCity[d.city];
    let areas;
    if(!filtered){
      areas = Object.entries(cdata.areas).sort((a,b)=>b[1].total-a[1].total);
    } else {
      areas = Object.entries(cdata.areas).map(([area, adata]) => [area, recomputeImpressionBlock(adata.packs.filter(matchesSuperType))]).filter(([,v]) => v.total > 0).sort((a,b)=>b[1].total-a[1].total);
    }
    const cBlock = filtered ? recomputeImpressionBlock(areas.flatMap(([,v])=>v.packs)) : cdata;
    const areaConv = (!filtered && imp.conversion.byArea[d.city]) ? imp.conversion.byArea[d.city] : null;
    return `
      ${breadcrumb(['All Cities', d.city], ['imp-city-null', null])}
      <div class="stat-row">
        <div class="stat-card accent"><div class="label">Total Impressions</div><div class="value">${fmtCompact(cBlock.total)}</div></div>
        <div class="stat-card"><div class="label">Packs w/ Impressions</div><div class="value small">${fmt(cBlock.packCount)}</div></div>
        <div class="stat-card"><div class="label">Vendors w/ Impressions</div><div class="value small">${fmt(cBlock.vendorCount)}</div></div>
        <div class="stat-card"><div class="label">Avg / Pack</div><div class="value small">${fmtCompact(cBlock.avgPerPack)}</div></div>
        <div class="stat-card purple"><div class="label">Kitchen Share</div><div class="value small">${pct1(cBlock.kitchenTotal_pct)}</div></div>
      </div>
      <div class="chart-box"><h3>Impressions by Time of Day (half-hour trend)</h3><canvas id="impTimeChart"></canvas></div>
      <div class="section-title">Marketing Areas (${areas.length})</div>
      <div class="card-grid">
        ${areas.map(([area,v]) => impressionAreaCard(area,v)).join('')}
      </div>
      ${areaConv ? `
      <div class="section-title">Order-to-Impression by Marketing Area</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Area</th><th>Vendors</th><th>Impressions</th><th>M4O Orders</th><th>M4O Conversion</th></tr></thead>
          <tbody>
            ${Object.entries(areaConv).sort((a,b)=>b[1].totalImpression-a[1].totalImpression).map(([area,c]) => `<tr>
              <td>${escapeHtml(area)}</td>
              <td>${fmt(c.vendorCount)}</td>
              <td style="font-family:var(--mono)">${fmtCompact(c.totalImpression)}</td>
              <td style="font-family:var(--mono)">${fmt(c.ordersYesterday)}</td>
              <td style="font-family:var(--mono); color:var(--accent)">${c.conversion!==null?(c.conversion*100).toFixed(3)+'%':'<span class="dim">—</span>'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}`;
  }

  const rawArea = imp.byCity[d.city].areas[d.area];
  const adata = filtered ? recomputeImpressionBlock(rawArea.packs.filter(matchesSuperType)) : rawArea;
  const packs = [...adata.packs].sort((a,b)=> b.total - a.total);
  return `
    ${breadcrumb(['All Cities', d.city, d.area], ['imp-city-null', 'imp-area-null', null])}
    <div class="stat-row">
      <div class="stat-card accent"><div class="label">Total Impressions</div><div class="value">${fmtCompact(adata.total)}</div></div>
      <div class="stat-card"><div class="label">Packs w/ Impressions</div><div class="value small">${fmt(adata.packCount)}</div></div>
      <div class="stat-card"><div class="label">Vendors w/ Impressions</div><div class="value small">${fmt(adata.vendorCount)}</div></div>
      <div class="stat-card"><div class="label">Avg / Pack</div><div class="value small">${fmtCompact(adata.avgPerPack)}</div></div>
    </div>
    <div class="chart-box"><h3>Impressions by Time of Day (half-hour trend)</h3><canvas id="impTimeChart"></canvas></div>
    <input class="search-box" id="impPackSearch" placeholder="Filter packs by title or vendor…">
    <div class="table-wrap">
      <table id="impPackTable">
        <thead><tr><th>Pack</th><th>Vendor</th><th>Kitchen</th><th>Deal Type</th><th>Total Impressions</th></tr></thead>
        <tbody>
          ${packs.map(pk => `<tr data-name="${escapeHtml((pk.title+' '+pk.vendorName).toLowerCase())}">
            <td>${escapeHtml(pk.title||'—')}</td>
            <td>${escapeHtml(pk.vendorName)}</td>
            <td>${pk.kitchen ? '<span class="badge kit">Kitchen</span>' : '<span class="dim">—</span>'}</td>
            <td><span class="badge deal-${DEAL_CLASS[pk.dealType]||'Not'}">${escapeHtml(pk.dealType)}</span></td>
            <td style="font-family:var(--mono); color:var(--accent)">${fmtCompact(pk.total)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function impressionCityCard(city, v){
  return `<div class="list-card" data-action="imp-city" data-city="${escapeAttr(city)}">
    <div class="name">${escapeHtml(city)}</div>
    <div class="row"><span>Total impressions</span><b>${fmtCompact(v.total)}</b></div>
    <div class="row"><span>Packs w/ impressions</span><b>${fmt(v.packCount)}</b></div>
    <div class="row"><span>Vendors w/ impressions</span><b>${fmt(v.vendorCount)}</b></div>
    <div class="row"><span>Avg / pack</span><b>${fmtCompact(v.avgPerPack)}</b></div>
  </div>`;
}
function impressionAreaCard(area, v){
  return `<div class="list-card" data-action="imp-area" data-area="${escapeAttr(area)}">
    <div class="name">${escapeHtml(area)}</div>
    <div class="row"><span>Total impressions</span><b>${fmtCompact(v.total)}</b></div>
    <div class="row"><span>Packs w/ impressions</span><b>${fmt(v.packCount)}</b></div>
    <div class="row"><span>Vendors w/ impressions</span><b>${fmt(v.vendorCount)}</b></div>
  </div>`;
}

const IMPRESSION_CONVERSION_MIN_IMPRESSIONS = 100; // floor for conversion-ranked views, to avoid 1-2 packs of noise showing 500%+ "conversion"
const IMPRESSION_SEGMENT_ORDER = ['Kitchen','TopCritical','Critical','Other'];
const IMPRESSION_SEGMENT_LABELS = { Kitchen:'Kitchen', TopCritical:'Non-Kitchen — Top Critical', Critical:'Non-Kitchen — Critical', Other:'Non-Kitchen — Other (Important + Ordinary)' };

function renderImpressionSegmentComparison(){
  const bySegment = DATA.impression.conversion.bySegment;
  const total = DATA.impression.overall.total;
  return `
    <div class="section-title">Kitchen vs. Non-Kitchen (Top Critical / Critical / Other)</div>
    <div class="table-wrap" style="margin-bottom:22px">
      <table>
        <thead><tr><th>Segment</th><th>Vendors</th><th>Impressions</th><th>Share of Total</th><th>M4O Orders</th><th>M4O Conversion</th></tr></thead>
        <tbody>
          ${IMPRESSION_SEGMENT_ORDER.filter(k=>bySegment[k]).map(k => { const c = bySegment[k]; return `<tr>
            <td>${escapeHtml(IMPRESSION_SEGMENT_LABELS[k])}</td>
            <td>${fmt(c.vendorCount)}</td>
            <td style="font-family:var(--mono)">${fmtCompact(c.totalImpression)}</td>
            <td style="font-family:var(--mono); color:var(--purple)">${total?shareToPct(c.totalImpression/total):'<span class="dim">—</span>'}</td>
            <td style="font-family:var(--mono)">${fmt(c.ordersYesterday)}</td>
            <td style="font-family:var(--mono); color:var(--accent)">${c.conversion!==null?(c.conversion*100).toFixed(3)+'%':'<span class="dim">—</span>'}</td>
          </tr>`; }).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderImpressionConversion(){
  const vendors = DATA.impression.conversion.vendors;
  const byCity = DATA.impression.conversion.byCity;
  const sortKey = impressionConversionSort;
  const pool = sortKey === 'totalImpression' ? vendors : vendors.filter(v => v.totalImpression >= IMPRESSION_CONVERSION_MIN_IMPRESSIONS);
  const sorted = [...pool].sort((a,b) => (b[sortKey] ?? -1) - (a[sortKey] ?? -1));
  const top = sorted.slice(0, 50);
  return `
    <div class="section-title">Order-to-Impression by City</div>
    <div class="table-wrap" style="margin-bottom:22px">
      <table>
        <thead><tr><th>City</th><th>Vendors</th><th>Impressions</th><th>M4O Orders</th><th>M4O Conversion</th></tr></thead>
        <tbody>
          ${Object.entries(byCity).sort((a,b)=>b[1].totalImpression-a[1].totalImpression).map(([city,c]) => `<tr class="clickable" data-action="imp-city" data-city="${escapeAttr(city)}">
            <td>${escapeHtml(city)}</td>
            <td>${fmt(c.vendorCount)}</td>
            <td style="font-family:var(--mono)">${fmtCompact(c.totalImpression)}</td>
            <td style="font-family:var(--mono)">${fmt(c.ordersYesterday)}</td>
            <td style="font-family:var(--mono); color:var(--accent)">${c.conversion!==null?(c.conversion*100).toFixed(3)+'%':'<span class="dim">—</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="flex-between">
      <div class="section-title" style="margin:0">Order-to-Impression by Vendor (Yesterday)</div>
      <div class="toggle-group">
        <div class="toggle-btn ${sortKey==='totalImpression'?'active':''}" data-impsort="totalImpression">Most Seen</div>
        <div class="toggle-btn ${sortKey==='conversion'?'active':''}" data-impsort="conversion">Best M4O Conversion</div>
      </div>
    </div>
    <div class="section-note">Conversion = M4O Orders (yesterday) ÷ Total Impressions (yesterday). Platform-wide orders aren't shown here: impressions only cover the Meal4One carousel, so a platform-order ratio wouldn't mean anything. ${sortKey !== 'totalImpression' ? `Conversion rankings only include vendors with ≥ ${fmt(IMPRESSION_CONVERSION_MIN_IMPRESSIONS)} impressions (${fmt(pool.length)} of ${fmt(vendors.length)}), so a couple of stray orders on a barely-seen vendor can't fake a 500%+ "conversion rate". ` : ''}Top ${Math.min(50, sorted.length)} vendors by the selected sort, out of ${fmt(pool.length)}.</div>
    <input class="search-box" id="impConvSearch" placeholder="Filter vendors by name…">
    <div class="table-wrap">
      <table id="impConvTable">
        <thead><tr><th>Vendor</th><th>City</th><th>Area</th><th>Segment</th><th>Packs</th><th>Total Impressions</th><th>M4O Orders</th><th>M4O Conversion</th></tr></thead>
        <tbody>
          ${top.map(v => `<tr data-name="${escapeHtml(v.name.toLowerCase())}">
            <td>${escapeHtml(v.name)} ${v.kitchen ? '<span class="badge kit">Kitchen</span>' : ''}</td>
            <td>${escapeHtml(v.city)}</td>
            <td>${escapeHtml(v.area)}</td>
            <td><span class="badge seg-${escapeAttr(v.segment)}">${escapeHtml(v.segment)}</span></td>
            <td>${fmt(v.packCount)}</td>
            <td style="font-family:var(--mono)">${fmtCompact(v.totalImpression)}</td>
            <td style="font-family:var(--mono)">${fmt(v.ordersYesterday)}</td>
            <td style="font-family:var(--mono); color:var(--accent)">${v.conversion !== null ? (v.conversion*100).toFixed(3)+'%' : '<span class="dim">—</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ============================================================
   MODULE 3: RATING (per city AND per Marketing Area, SuperType-filterable)
   ============================================================ */
function renderRating(){
  const d = drill.rating;
  const r = DATA.rating;
  const filtered = superTypeFilter !== 'all';

  if(!d.city){
    let cities;
    if(!filtered){
      cities = Object.entries(r.byCity).sort((a,b)=>b[1].avgRate-a[1].avgRate);
    } else {
      cities = Object.entries(r.byCity).map(([city, cdata]) => {
        const allRows = Object.values(cdata.areas).flatMap(a=>a.rows);
        const matched = allRows.filter(matchesSuperType);
        return [city, recomputeRatingBlock(matched)];
      }).filter(([,v]) => (v.ratedCount + v.noRatingCount) > 0).sort((a,b)=>b[1].avgRate-a[1].avgRate);
    }
    const overall = filtered ? recomputeRatingBlock(cities.flatMap(([city])=>r.byCity[city].rows.filter(matchesSuperType))) : r;

    return `
      ${breadcrumb(['All Cities'])}
      <div class="stat-row">
        <div class="stat-card accent"><div class="label">Overall Avg Rate</div><div class="value">${overall.avgRate.toFixed(2)}</div></div>
        <div class="stat-card"><div class="label">Rated Packs</div><div class="value small">${fmt(overall.ratedCount)}<span class="pct-tag">${pct1(overall.ratedCount_pct)}</span></div></div>
        <div class="stat-card warn"><div class="label">No Rating</div><div class="value small">${fmt(overall.noRatingCount)}<span class="pct-tag">${pct1(overall.noRatingCount_pct)}</span></div></div>
        ${BUCKET_ORDER.map(b => `<div class="stat-card"><div class="label">${b}</div><div class="value small">${fmt(overall.buckets[b]||0)}<span class="pct-tag">${pct1(overall.bucketPcts[b]||0)}</span></div></div>`).join('')}
      </div>
      <div class="section-note">Percentages for 0-2…8-10 are of rated packs only; No Rating packs (Rate=0) are excluded from the average and bucket %s.</div>
      <div class="chart-row">
        <div class="chart-box"><h3>Rate Distribution (all cities, rated only)</h3><canvas id="ratingBucketChart"></canvas></div>
        <div class="chart-box"><h3>Avg Rate by City</h3><canvas id="cityRateChart"></canvas></div>
      </div>
      <div class="section-title">Cities</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>City</th><th>Avg Rate</th><th>Rated</th><th>No Rating</th><th>0-2</th><th>2-4</th><th>4-6</th><th>6-8</th><th>8-10</th></tr></thead>
          <tbody>
            ${cities.map(([city,v]) => `<tr class="clickable" data-action="rt-city" data-city="${escapeAttr(city)}">
              <td>${escapeHtml(city)}</td>
              <td style="font-family:var(--mono); color:var(--accent); font-weight:600">${v.avgRate.toFixed(2)}</td>
              <td>${fmt(v.ratedCount)} <span class="dim">(${pct1(v.ratedCount_pct)})</span></td>
              <td style="color:var(--warn)">${fmt(v.noRatingCount)} <span class="dim">(${pct1(v.noRatingCount_pct)})</span></td>
              ${BUCKET_ORDER.map(b => `<td>${fmt(v.buckets[b]||0)} <span class="dim">(${pct1(v.bucketPcts[b]||0)})</span></td>`).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // City drilled in — show per Marketing Area
  const cdata = r.byCity[d.city];
  let areas;
  if(!filtered){
    areas = Object.entries(cdata.areas).sort((a,b)=>b[1].avgRate-a[1].avgRate);
  } else {
    areas = Object.entries(cdata.areas).map(([area, adata]) => [area, recomputeRatingBlock(adata.rows.filter(matchesSuperType))]).filter(([,v]) => (v.ratedCount+v.noRatingCount) > 0).sort((a,b)=>b[1].avgRate-a[1].avgRate);
  }
  const cBlock = filtered ? recomputeRatingBlock(areas.flatMap(([area])=>cdata.areas[area].rows.filter(matchesSuperType))) : cdata;

  return `
    ${breadcrumb(['All Cities', d.city], ['rt-city-null'])}
    <div class="stat-row">
      <div class="stat-card accent"><div class="label">Avg Rate</div><div class="value">${cBlock.avgRate.toFixed(2)}</div></div>
      <div class="stat-card"><div class="label">Rated Packs</div><div class="value small">${fmt(cBlock.ratedCount)}<span class="pct-tag">${pct1(cBlock.ratedCount_pct)}</span></div></div>
      <div class="stat-card warn"><div class="label">No Rating</div><div class="value small">${fmt(cBlock.noRatingCount)}<span class="pct-tag">${pct1(cBlock.noRatingCount_pct)}</span></div></div>
      ${BUCKET_ORDER.map(b => `<div class="stat-card"><div class="label">${b}</div><div class="value small">${fmt(cBlock.buckets[b]||0)}<span class="pct-tag">${pct1(cBlock.bucketPcts[b]||0)}</span></div></div>`).join('')}
    </div>
    <div class="section-title">Marketing Areas (${areas.length})</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Area</th><th>Avg Rate</th><th>Rated</th><th>No Rating</th><th>0-2</th><th>2-4</th><th>4-6</th><th>6-8</th><th>8-10</th></tr></thead>
        <tbody>
          ${areas.map(([area,v]) => `<tr>
            <td>${escapeHtml(area)}</td>
            <td style="font-family:var(--mono); color:var(--accent); font-weight:600">${v.avgRate.toFixed(2)}</td>
            <td>${fmt(v.ratedCount)} <span class="dim">(${pct1(v.ratedCount_pct)})</span></td>
            <td style="color:var(--warn)">${fmt(v.noRatingCount)} <span class="dim">(${pct1(v.noRatingCount_pct)})</span></td>
            ${BUCKET_ORDER.map(b => `<td>${fmt(v.buckets[b]||0)} <span class="dim">(${pct1(v.bucketPcts[b]||0)})</span></td>`).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ============================================================
   MODULE 4: ORDER SHARE & ENGAGEMENT
   ============================================================ */
function renderOrderShareByVendorTypeOnly(label){
  const os = DATA.orderShare;
  const vt = os.byVendorType && os.byVendorType[label];
  if(!vt){
    return `<div class="empty-state">No order data available for ${escapeHtml(label)} vendors. Re-run <code>node update_dashboard.js</code> to generate it.</div>`;
  }
  const orders = orderWindow === 'yesterday' ? 'ordersYesterday' : 'ordersMtd';
  const cities = Object.entries(vt.byCity || {}).sort((a,b)=> b[1][orders] - a[1][orders]);
  return `
    <div class="flex-between">
      <div class="breadcrumb" style="margin-bottom:0">Order share window</div>
      <div class="toggle-group">
        <div class="toggle-btn ${orderWindow==='yesterday'?'active':''}" data-window="yesterday">Yesterday</div>
        <div class="toggle-btn ${orderWindow==='mtd'?'active':''}" data-window="mtd">Month to Date</div>
      </div>
    </div>
    <div class="section-note">The Order sheet that powers the rest of this tab (platform-order totals, market share) only covers Restaurant vendors. For ${escapeHtml(label)}, the M4O order counts below come from the main data sheet instead — there's no platform-order total for this type there, so a market-share % isn't available (not a bug — the source sheet just doesn't have it yet).</div>
    <div class="stat-row">
      <div class="stat-card"><div class="label">${escapeHtml(label)} Vendors</div><div class="value">${fmt(vt.vendorCount)}</div></div>
      <div class="stat-card seg-a"><div class="label">Ordered This Month</div><div class="value small">${fmt(vt.orderedVendorCount)}<span class="pct-tag">${pct1(vt.vendorCount ? vt.orderedVendorCount/vt.vendorCount*100 : 0)}</span></div></div>
      <div class="stat-card"><div class="label">M4O Orders (Yesterday)</div><div class="value">${fmt(vt.ordersYesterday)}</div></div>
      <div class="stat-card accent"><div class="label">M4O Orders (MTD)</div><div class="value">${fmt(vt.ordersMtd)}</div></div>
    </div>
    <div class="section-title">Cities (${orderWindow === 'yesterday' ? 'Yesterday' : 'Month to Date'})</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>City</th><th>Vendors</th><th>M4O Orders</th></tr></thead>
        <tbody>
          ${cities.map(([city,v]) => `<tr>
            <td>${escapeHtml(city)}</td>
            <td style="font-family:var(--mono)">${fmt(v.vendorCount)}</td>
            <td style="font-family:var(--mono); font-weight:600">${fmt(v[orders])}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderOrderShare(){
  const os = DATA.orderShare;
  const filtered = superTypeFilter !== 'all';
  const tc = DATA.topCriticalEngagement;
  const orderedV = os.orderedVendorsPct[orderWindow];
  const orderedP = os.orderedPacksPct[orderWindow];
  const d = drill.orderShare;

  // The Order sheet backing this tab's stats/cities table below only has
  // Restaurant (SuperTypeID 1) rows — filtering to Cafe/Juice/Non-Food would
  // otherwise show real-looking zeros instead of "no data here". Route those
  // filters to the MainData-sourced M4O Orders by Vendor Type breakdown,
  // which is the only order-count source covering every vendor type.
  const activeGroup = filtered ? superTypeGroups().find(g => g.key === superTypeFilter) : null;
  if(activeGroup && !activeGroup.ids.includes(1)){
    return renderOrderShareByVendorTypeOnly(activeGroup.label);
  }

  let overall, cities;
  if(!filtered){
    overall = orderWindow === 'yesterday' ? os.overallYesterday : os.overallMtd;
    cities = Object.entries(os.byCity)
      .map(([city,v]) => [city, orderWindow==='yesterday' ? v.yesterday : v.mtd, v.vendorCount])
      .sort((a,b)=> b[1].m41Orders - a[1].m41Orders);
  } else {
    const field = orderWindow === 'yesterday' ? { m41:'m41Y', plat:'platY' } : { m41:'m41Mtd', plat:'platMtd' };
    cities = Object.entries(os.byCity).map(([city, cdata]) => {
      const allRows = Object.values(cdata.areas).flatMap(a=>a.rows);
      const matched = allRows.filter(matchesSuperType);
      const m41 = matched.reduce((s,r)=>s+r[field.m41],0);
      const plat = matched.reduce((s,r)=>s+r[field.plat],0);
      const vendorCount = matched.length;
      return [city, { m41Orders:m41, platformOrders:plat }, vendorCount];
    }).filter(([,v,vc]) => vc > 0).sort((a,b)=>b[1].m41Orders-a[1].m41Orders);
    const totalM41 = cities.reduce((s,[,v])=>s+v.m41Orders,0);
    const totalPlat = cities.reduce((s,[,v])=>s+v.platformOrders,0);
    overall = { m41Orders: totalM41, platformOrders: totalPlat, share: totalPlat ? totalM41/totalPlat : 0 };
  }

  if(d.city){
    return renderOrderShareCityDrill(d.city);
  }

  return `
    <div class="flex-between">
      <div class="breadcrumb" style="margin-bottom:0">Order share window</div>
      <div class="toggle-group">
        <div class="toggle-btn ${orderWindow==='yesterday'?'active':''}" data-window="yesterday">Yesterday</div>
        <div class="toggle-btn ${orderWindow==='mtd'?'active':''}" data-window="mtd">Month to Date</div>
      </div>
    </div>
    <div class="section-note">Three definitions, narrowest to widest denominator — "Vendor Engagement" is M4O orders ÷ platform orders of only the vendors that carry Meal4One packs; "Order Share (M4O Cities)" is M4O orders ÷ every Restaurant order in the cities M4O operates in (from "All Order"); "Order Share (All Cities)" is the same but across every city on Snapp Food, M4O or not — overall only, since dividing one city by a project-wide total wouldn't mean anything.</div>
    <div class="stat-row">
      <div class="stat-card"><div class="label">M4O Orders</div><div class="value">${fmt(overall.m41Orders)}</div></div>
      <div class="stat-card"><div class="label">Platform Orders (M4O vendors only)</div><div class="value">${fmt(overall.platformOrders)}</div></div>
      <div class="stat-card accent"><div class="label">Vendor Engagement</div><div class="value">${shareToPct(overall.share)}</div><div class="sub">M4O orders ÷ all orders placed with M4O vendors</div></div>
      ${overall.m4oCitiesShare !== undefined ? `<div class="stat-card seg-b"><div class="label">Order Share (M4O Cities)</div><div class="value">${overall.m4oCitiesShare!==null?shareToPct(overall.m4oCitiesShare):'<span class="dim">—</span>'}</div><div class="sub">M4O orders ÷ all Restaurant orders in M4O's own cities</div></div>` : ''}
      ${overall.allCitiesShare !== undefined ? `<div class="stat-card purple"><div class="label">Order Share (All Cities)</div><div class="value">${overall.allCitiesShare!==null?shareToPct(overall.allCitiesShare):'<span class="dim">—</span>'}</div><div class="sub">M4O orders ÷ all Restaurant orders on Snapp Food, every city</div></div>` : ''}
      <div class="stat-card"><div class="label">Top Critical Engagement</div><div class="value">${shareToPct(tc.rate)}</div><div class="sub">${tc.numerator} / ${tc.denominator} TopCritical vendors ordered M4O</div></div>
      ${overall.ordersPerOrderedVendor !== undefined ? `<div class="stat-card"><div class="label">Orders / Ordered Vendor (O/V)</div><div class="value small">${overall.ordersPerOrderedVendor.toFixed(1)}</div><div class="sub">${fmt(overall.orderedVendorCount)} vendors placed at least 1 order</div></div>` : ''}
    </div>
    ${overall.allCitiesShare === undefined ? '<div class="section-note">"Order Share (M4O/All Cities)" and O/V are only available for the unfiltered (All) Vendor Type view.</div>' : ''}
    ${tc.bySegment ? `<div class="section-note">Top Critical breakdown: ${fmt(tc.bySegment['Highly Engaged']||0)} Highly Engaged, ${fmt(tc.bySegment['Moderate Engaged']||0)} Moderate, ${fmt(tc.bySegment['Low Engaged']||0)} Low, ${fmt(tc.bySegment['No Order']||0)} No Order.</div>` : ''}
    <div class="section-title">Ordered vs. Unordered</div>
    <div class="stat-row">
      <div class="stat-card seg-a"><div class="label">Vendors Ordered</div><div class="value small">${fmt(orderedV.ordered)}<span class="pct-tag">${pct1(orderedV.ordered_pct)}</span></div></div>
      <div class="stat-card"><div class="label">Vendors Unordered</div><div class="value small">${fmt(orderedV.unordered)}<span class="pct-tag">${pct1(orderedV.unordered_pct)}</span></div></div>
      <div class="stat-card seg-a"><div class="label">Packs Ordered</div><div class="value small">${fmt(orderedP.ordered)}<span class="pct-tag">${pct1(orderedP.ordered_pct)}</span></div></div>
      <div class="stat-card"><div class="label">Packs Unordered</div><div class="value small">${fmt(orderedP.unordered)}<span class="pct-tag">${pct1(orderedP.unordered_pct)}</span></div></div>
    </div>
    <div class="section-note">A pack is "ordered" if its vendor received at least one Meal4One order in the selected window. (Ordered/Unordered totals are not affected by the Vendor Type filter.)</div>
    ${os.byVendorType ? `
    <div class="section-title">M4O Orders by Vendor Type</div>
    <div class="section-note">Source: the main data sheet's per-vendor order columns, which cover every vendor type — unlike the Order sheet above (Restaurant only), which is why the rest of this tab has no Cafe/Juice/Non-Food breakdown. There's no platform order total for these types here, so only M4O order counts are shown, not a market-share %.</div>
    <div class="table-wrap" style="margin-bottom:22px">
      <table>
        <thead><tr><th>Vendor Type</th><th>Vendors</th><th>Ordered Vendors (MTD)</th><th>M4O Orders (Yesterday)</th><th>M4O Orders (MTD)</th></tr></thead>
        <tbody>
          ${['Restaurant','Cafe','Juice','Non-Food'].filter(t => os.byVendorType[t]).map(t => {
            const v = os.byVendorType[t];
            return `<tr>
            <td>${escapeHtml(t)}</td>
            <td style="font-family:var(--mono)">${fmt(v.vendorCount)}</td>
            <td style="font-family:var(--mono)">${fmt(v.orderedVendorCount)}</td>
            <td style="font-family:var(--mono)">${fmt(v.ordersYesterday)}</td>
            <td style="font-family:var(--mono); font-weight:600">${fmt(v.ordersMtd)}</td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : ''}
    <div class="chart-row">
      <div class="chart-box"><h3>M4O Orders by City</h3><canvas id="m41ByCityChart"></canvas></div>
      <div class="chart-box"><h3>Vendor Engagement, by City</h3><canvas id="shareByCityChart"></canvas></div>
    </div>
    <div class="section-title">Cities (${orderWindow === 'yesterday' ? 'Yesterday' : 'Month to Date'})</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>City</th><th>Vendors</th><th>M4O Orders</th><th>Platform Orders (M4O vendors)</th><th>O/V</th><th>Order Share (M4O Cities)</th><th>Vendor Engagement</th></tr></thead>
        <tbody>
          ${cities.map(([city,v,vendorCount]) => {
            const cdata = os.byCity[city];
            const win = orderWindow === 'yesterday' ? cdata.yesterday : cdata.mtd;
            return `<tr class="clickable" data-action="os-city" data-city="${escapeAttr(city)}">
            <td>${escapeHtml(city)}</td>
            <td>${fmt(vendorCount)}</td>
            <td style="font-family:var(--mono)">${fmt(v.m41Orders)}</td>
            <td style="font-family:var(--mono)">${fmt(v.platformOrders)}</td>
            <td style="font-family:var(--mono)">${win.ordersPerOrderedVendor !== undefined ? win.ordersPerOrderedVendor.toFixed(1) : '—'}</td>
            <td style="font-family:var(--mono); color:var(--seg-b)">${win.m4oCitiesShare !== null && win.m4oCitiesShare !== undefined ? shareToPct(win.m4oCitiesShare) : '<span class="dim">—</span>'}</td>
            <td style="font-family:var(--mono); color:var(--accent); font-weight:600">${v.platformOrders ? shareToPct(v.m41Orders/v.platformOrders) : '—'}</td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${DATA.topCriticalEngagementByCity ? `
    <div class="section-title">Top Critical Engagement by City</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>City</th><th>Total TC</th><th>Highly Engaged</th><th>Moderate</th><th>Low</th><th>No Order</th><th>Highly Engaged %</th></tr></thead>
        <tbody>
          ${Object.entries(DATA.topCriticalEngagementByCity).sort((a,b)=>b[1].total-a[1].total).map(([city,v]) => `<tr>
            <td>${escapeHtml(city)}</td>
            <td style="font-family:var(--mono)">${fmt(v.total)}</td>
            <td style="font-family:var(--mono); color:var(--seg-a)">${fmt(v.highlyEngaged)}</td>
            <td style="font-family:var(--mono)">${fmt(v.moderateEngaged)}</td>
            <td style="font-family:var(--mono)">${fmt(v.lowEngaged)}</td>
            <td style="font-family:var(--mono); color:var(--text-faint)">${fmt(v.noOrder)}</td>
            <td style="font-family:var(--mono); color:var(--accent); font-weight:600">${pct1(v.highlyEngaged_pct)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}`;
}

function renderOrderShareCityDrill(city){
  const os = DATA.orderShare;
  const cdata = os.byCity[city];
  const win = orderWindow;
  const filtered = superTypeFilter !== 'all';

  let cityWin, areas;
  if(!filtered){
    cityWin = win === 'yesterday' ? cdata.yesterday : cdata.mtd;
    areas = Object.entries(cdata.areas)
      .map(([area, adata]) => [area, win === 'yesterday' ? adata.yesterday : adata.mtd, adata.vendorCount])
      .sort((a,b)=> b[1].m41Orders - a[1].m41Orders);
  } else {
    const field = win === 'yesterday' ? { m41:'m41Y', plat:'platY' } : { m41:'m41Mtd', plat:'platMtd' };
    areas = Object.entries(cdata.areas).map(([area, adata]) => {
      const matched = adata.rows.filter(matchesSuperType);
      const m41 = matched.reduce((s,r)=>s+r[field.m41],0);
      const plat = matched.reduce((s,r)=>s+r[field.plat],0);
      return [area, { m41Orders:m41, platformOrders:plat }, matched.length];
    }).filter(([,,vc]) => vc > 0).sort((a,b)=> b[1].m41Orders - a[1].m41Orders);
    const totalM41 = areas.reduce((s,[,v])=>s+v.m41Orders,0);
    const totalPlat = areas.reduce((s,[,v])=>s+v.platformOrders,0);
    cityWin = { m41Orders: totalM41, platformOrders: totalPlat };
  }

  return `
    ${breadcrumb(['All Cities', city], ['os-city-null'])}
    <div class="flex-between">
      <div class="breadcrumb" style="margin-bottom:0">Order share window</div>
      <div class="toggle-group">
        <div class="toggle-btn ${win==='yesterday'?'active':''}" data-window="yesterday">Yesterday</div>
        <div class="toggle-btn ${win==='mtd'?'active':''}" data-window="mtd">Month to Date</div>
      </div>
    </div>
    <div class="stat-row">
      <div class="stat-card"><div class="label">M4O Orders</div><div class="value">${fmt(cityWin.m41Orders)}</div></div>
      <div class="stat-card"><div class="label">Platform Orders (M4O vendors)</div><div class="value">${fmt(cityWin.platformOrders)}</div></div>
      <div class="stat-card accent"><div class="label">Vendor Engagement</div><div class="value">${cityWin.platformOrders ? shareToPct(cityWin.m41Orders/cityWin.platformOrders) : '—'}</div></div>
      ${cityWin.m4oCitiesShare !== undefined ? `<div class="stat-card seg-b"><div class="label">Order Share (M4O Cities)</div><div class="value">${cityWin.m4oCitiesShare!==null?shareToPct(cityWin.m4oCitiesShare):'<span class="dim">—</span>'}</div></div>` : ''}
      ${cityWin.ordersPerOrderedVendor !== undefined ? `<div class="stat-card"><div class="label">Orders / Ordered Vendor (O/V)</div><div class="value small">${cityWin.ordersPerOrderedVendor.toFixed(1)}</div><div class="sub">${fmt(cityWin.orderedVendorCount)} vendors ordered</div></div>` : ''}
    </div>
    ${cityWin.m4oCitiesShare === undefined ? '<div class="section-note">"Order Share (M4O Cities)" and O/V are only available for the unfiltered (All) Vendor Type view.</div>' : ''}
    <div class="section-title">Marketing Areas (${areas.length})</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Area</th><th>Vendors</th><th>M4O Orders</th><th>Platform Orders (M4O vendors)</th><th>O/V</th><th>Share of City's M4O Orders</th><th>M4O Share of Total Platform Orders (Area)</th></tr></thead>
        <tbody>
          ${areas.map(([area,v,vendorCount]) => `<tr>
            <td>${escapeHtml(area)}</td>
            <td>${fmt(vendorCount)}</td>
            <td style="font-family:var(--mono)">${fmt(v.m41Orders)}</td>
            <td style="font-family:var(--mono)">${fmt(v.platformOrders)}</td>
            <td style="font-family:var(--mono)">${v.ordersPerOrderedVendor !== undefined ? v.ordersPerOrderedVendor.toFixed(1) : '—'}</td>
            <td style="font-family:var(--mono); color:var(--seg-b)">${cityWin.m41Orders ? shareToPct(v.m41Orders/cityWin.m41Orders) : '—'}</td>
            <td style="font-family:var(--mono); color:var(--purple)">${v.areaM4OShare !== undefined ? shareToPct(v.areaM4OShare) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="section-note">"Share of City's M4O Orders" = this area's Meal4One orders ÷ the city's total Meal4One orders. "M4O Share of Total Platform Orders (Area)" = this area's Meal4One orders ÷ all platform orders in that area (M4O and non-M4O vendors combined).</div>`;
}

/* ============================================================
   MODULE 5: COVERAGE MODEL (live, includes "All Cities")
   ============================================================ */
/* ============================================================
   MODULE: KITCHEN (dedicated view of Kitchen==1 vendors/packs)
   ============================================================ */
function renderKitchen(){
  const k = DATA.kitchen;
  if(!k){
    return `<div class="empty-state">No Kitchen data available. Re-run <code>node update_dashboard.js</code> to generate it.</div>`;
  }
  const d = drill.kitchen;
  const o = k.overall;
  const nk = k.nonKitchenOverall;
  const win = orderWindow;

  if(!d.city){
    const cities = Object.entries(k.byCity).sort((a,b)=>b[1].vendorCount-a[1].vendorCount);
    const orders = win==='yesterday' ? 'ordersYesterday' : 'ordersMtd';
    const platform = win==='yesterday' ? 'platformOrdersYesterday' : 'platformOrdersMtd';
    const m4oShare = win==='yesterday' ? 'm4oShareYesterday' : 'm4oShareMtd';
    const shareOfAll = win==='yesterday' ? 'shareOfAllM4OYesterday' : 'shareOfAllM4OMtd';
    const totalVendors = o.vendorCount + nk.vendorCount;
    const totalPacks = o.packCount + nk.packCount;
    return `
      ${breadcrumb(['All Cities'])}
      <div class="section-note">Kitchen vendors (Kitchen == 1) have a structurally different cost/discount model from regular vendors — this tab compares them directly against Non-Kitchen vendors.</div>
      <div class="flex-between">
        <div class="section-title" style="margin:0">Kitchen vs. Non-Kitchen</div>
        <div class="toggle-group">
          <div class="toggle-btn ${win==='yesterday'?'active':''}" data-window="yesterday">Yesterday</div>
          <div class="toggle-btn ${win==='mtd'?'active':''}" data-window="mtd">Month to Date</div>
        </div>
      </div>
      <div class="table-wrap" style="margin-bottom:22px">
        <table>
          <thead><tr><th>Metric</th><th style="color:var(--purple)">Kitchen</th><th>Non-Kitchen</th></tr></thead>
          <tbody>
            <tr><td>Vendors</td><td style="font-family:var(--mono)">${fmt(o.vendorCount)} <span class="dim">(${pct1(o.vendorCount/totalVendors*100)})</span></td><td style="font-family:var(--mono)">${fmt(nk.vendorCount)} <span class="dim">(${pct1(nk.vendorCount/totalVendors*100)})</span></td></tr>
            <tr><td>Packs</td><td style="font-family:var(--mono)">${fmt(o.packCount)} <span class="dim">(${pct1(o.packCount/totalPacks*100)})</span></td><td style="font-family:var(--mono)">${fmt(nk.packCount)} <span class="dim">(${pct1(nk.packCount/totalPacks*100)})</span></td></tr>
            <tr><td>Avg Rate</td><td style="font-family:var(--mono); color:var(--accent)">${o.avgRate.toFixed(2)}</td><td style="font-family:var(--mono); color:var(--accent)">${nk.avgRate.toFixed(2)}</td></tr>
            <tr><td>Rated Packs</td><td style="font-family:var(--mono)">${fmt(o.ratedPackCount)}</td><td style="font-family:var(--mono)">${fmt(nk.ratedPackCount)}</td></tr>
            <tr><td>Avg Snapp Discount</td><td>${o.avgSnappDiscountToman !== null ? toman(o.avgSnappDiscountToman) : '<span class="dim">N/A — see note below</span>'}</td><td style="font-family:var(--mono); color:var(--accent)">${toman(nk.avgSnappDiscountToman)}</td></tr>
            <tr><td>M4O Orders (${win==='yesterday'?'Yesterday':'MTD'})</td><td style="font-family:var(--mono)">${fmt(o[orders])}</td><td style="font-family:var(--mono)">${fmt(nk[orders])}</td></tr>
            <tr><td>Platform Orders (${win==='yesterday'?'Yesterday':'MTD'})</td><td style="font-family:var(--mono)">${fmt(o[platform])}</td><td style="font-family:var(--mono)">${fmt(nk[platform])}</td></tr>
            <tr><td>Vendor Engagement</td><td style="font-family:var(--mono); color:var(--purple)">${shareToPct(o[m4oShare])}</td><td style="font-family:var(--mono); color:var(--purple)">${shareToPct(nk[m4oShare])}</td></tr>
            <tr><td>Share of ALL M4O Orders (project-wide)</td><td style="font-family:var(--mono); color:var(--seg-b)">${shareToPct(o[shareOfAll])}</td><td style="font-family:var(--mono); color:var(--seg-b)">${shareToPct(nk[shareOfAll])}</td></tr>
            ${DATA.impression ? `<tr><td>Share of Total Impressions (yesterday)</td><td style="font-family:var(--mono); color:var(--purple)">${pct1(DATA.impression.overall.kitchenTotal_pct)}</td><td style="font-family:var(--mono); color:var(--purple)">${pct1(DATA.impression.overall.nonKitchenTotal_pct)}</td></tr>` : ''}
            ${DATA.cpoBudget ? `<tr><td>Total Budget (MTD)</td><td style="font-family:var(--mono)">${tomanCompact(DATA.cpoBudget.overall.kitchen.total.totalBudget)} <span class="dim">(${pct1(DATA.cpoBudget.overall.kitchen.total.totalBudget_pct)})</span></td><td style="font-family:var(--mono)">${tomanCompact(DATA.cpoBudget.overall.nonKitchen.total.totalBudget)} <span class="dim">(${pct1(DATA.cpoBudget.overall.nonKitchen.total.totalBudget_pct)})</span></td></tr>
            <tr><td>CPO (MTD)</td><td style="font-family:var(--mono); color:var(--accent)">${DATA.cpoBudget.overall.kitchen.total.cpo!==null?tomanCompact(DATA.cpoBudget.overall.kitchen.total.cpo):'<span class="dim">—</span>'}</td><td style="font-family:var(--mono); color:var(--accent)">${DATA.cpoBudget.overall.nonKitchen.total.cpo!==null?tomanCompact(DATA.cpoBudget.overall.nonKitchen.total.cpo):'<span class="dim">—</span>'}</td></tr>` : ''}
          </tbody>
        </table>
      </div>
      <div class="section-note">"Avg Snapp Discount" for Kitchen is N/A here because Kitchen packs use a structurally different pricing/discount model than regular packs — averaging them together (or even as a separate like-for-like average) isn't a meaningful comparison. See the README for details.${!DATA.impression || !DATA.cpoBudget ? ' Impression/Budget rows above need node update_dashboard.js re-run to appear.' : ''}</div>
      <div class="section-title">Kitchen Cities</div>
      <div class="card-grid">
        ${cities.map(([city,v]) => `<div class="list-card" data-action="kt-city" data-city="${escapeAttr(city)}">
          <div class="name">${escapeHtml(city)}</div>
          <div class="row"><span>Kitchen vendors</span><b>${fmt(v.vendorCount)}</b></div>
          <div class="row"><span>Kitchen packs</span><b>${fmt(v.packCount)}</b></div>
        </div>`).join('')}
      </div>`;
  }

  if(d.city && !d.area){
    const cdata = k.byCity[d.city];
    const areas = Object.entries(cdata.areas).sort((a,b)=>b[1].vendorCount-a[1].vendorCount);
    return `
      ${breadcrumb(['All Cities', d.city], ['kt-city-null'])}
      <div class="stat-row">
        <div class="stat-card purple"><div class="label">Kitchen Vendors</div><div class="value">${fmt(cdata.vendorCount)}</div></div>
        <div class="stat-card purple"><div class="label">Kitchen Packs</div><div class="value">${fmt(cdata.packCount)}</div></div>
      </div>
      <div class="section-title">Marketing Areas (${areas.length})</div>
      <div class="card-grid">
        ${areas.map(([area,v]) => `<div class="list-card" data-action="kt-area" data-area="${escapeAttr(area)}">
          <div class="name">${escapeHtml(area)}</div>
          <div class="row"><span>Kitchen vendors</span><b>${fmt(v.vendorCount)}</b></div>
          <div class="row"><span>Kitchen packs</span><b>${fmt(v.packCount)}</b></div>
        </div>`).join('')}
      </div>`;
  }

  const adata = k.byCity[d.city].areas[d.area];
  const vendors = [...adata.vendors].sort((a,b)=> (win==='yesterday'?b.ordersYesterday-a.ordersYesterday:b.ordersMtd-a.ordersMtd));
  return `
    ${breadcrumb(['All Cities', d.city, d.area], ['kt-city-null', 'kt-area-null'])}
    <div class="flex-between">
      <div class="section-title" style="margin:0">Vendors (${adata.vendorCount})</div>
      <div class="toggle-group">
        <div class="toggle-btn ${win==='yesterday'?'active':''}" data-window="yesterday">Yesterday</div>
        <div class="toggle-btn ${win==='mtd'?'active':''}" data-window="mtd">Month to Date</div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Vendor</th><th>Segment</th><th>Packs</th><th>Avg Rate</th><th>M4O Orders</th><th>Platform Orders</th><th>M4O Share</th></tr></thead>
        <tbody>
          ${vendors.map(v => {
            const orders = win==='yesterday' ? v.ordersYesterday : v.ordersMtd;
            const platform = win==='yesterday' ? v.platformOrdersYesterday : v.platformOrdersMtd;
            const share = win==='yesterday' ? v.m4oShareYesterday : v.m4oShareMtd;
            return `<tr>
            <td>${escapeHtml(v.name)}</td>
            <td><span class="badge seg-${escapeAttr(v.segment)}">${escapeHtml(v.segment)}</span></td>
            <td>${fmt(v.packCount)}</td>
            <td>${v.avgRate !== null ? v.avgRate.toFixed(2) : '<span class="dim">No rating</span>'}</td>
            <td style="font-family:var(--mono)">${fmt(orders)}</td>
            <td style="font-family:var(--mono)">${fmt(platform)}</td>
            <td style="font-family:var(--mono); color:var(--accent)">${share !== null ? shareToPct(share) : '<span class="dim">—</span>'}</td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ============================================================
   MODULE: CPO BUDGET (month-to-date, Gregorian month, updated daily)
   ============================================================ */
const CPO_SEGMENT_COLORS = { Kitchen:'#B389F2', TopCritical:'#FF5A36', Critical:'#F2B84B', Other:'#4C8CFF' };

function cpoRow(label, m){
  return `<tr>
    <td>${escapeHtml(label)}</td>
    <td style="font-family:var(--mono)">${fmt(m.vendorCount)}</td>
    <td style="font-family:var(--mono)">${tomanCompact(m.subsidyBudget)}<span class="pct-tag">${pct1(m.subsidyBudget_pct)}</span></td>
    <td style="font-family:var(--mono)">${tomanCompact(m.freeDeliveryBudget)}<span class="pct-tag">${pct1(m.freeDeliveryBudget_pct)}</span></td>
    <td style="font-family:var(--mono); font-weight:600">${tomanCompact(m.totalBudget)}<span class="pct-tag">${pct1(m.totalBudget_pct)}</span></td>
    <td style="font-family:var(--mono)">${fmt(m.m4oOrders)}<span class="pct-tag">${pct1(m.m4oOrders_pct)}</span></td>
    <td style="font-family:var(--mono)">${fmt(m.totalSold)}</td>
    <td style="font-family:var(--mono); color:var(--accent)">${m.cpo!==null ? tomanCompact(m.cpo) : '<span class="dim">—</span>'}</td>
    <td style="font-family:var(--mono); color:var(--seg-b)">${m.freeDeliveryCpo!==null ? tomanCompact(m.freeDeliveryCpo) : '<span class="dim">—</span>'}</td>
    <td style="font-family:var(--mono); color:var(--purple)">${m.subsidyCps!==null ? tomanCompact(m.subsidyCps) : '<span class="dim">—</span>'}</td>
  </tr>`;
}

function renderCpoBudget(){
  const cpo = DATA.cpoBudget;
  if(!cpo){
    return `<div class="empty-state">No CPO Budget data available. Re-run <code>node update_dashboard.js</code> to generate it.</div>`;
  }
  const d = drill.cpoBudget;

  if(!d.city){
    const nk = cpo.overall.nonKitchen;
    const kAll = cpo.overall.kitchen.total;
    const seg = nk.bySegment;
    const cities = Object.entries(cpo.byCity).sort((a,b)=>b[1].totalBudget-a[1].totalBudget);
    return `
      ${breadcrumb(['All Cities'])}
      <div class="section-note">Month-to-date (Gregorian calendar month, updated daily) — same MTD convention as the rest of the dashboard. Every budget figure below shows its share of the total budget next to it.</div>
      <div class="stat-row">
        <div class="stat-card accent"><div class="label">Total Budget</div><div class="value">${tomanCompact(cpo.overall.all.totalBudget)}</div></div>
        <div class="stat-card"><div class="label">Subsidy Budget</div><div class="value small">${tomanCompact(cpo.overall.all.subsidyBudget)}<span class="pct-tag">${pct1(cpo.overall.all.subsidyBudget_pct)}</span></div></div>
        <div class="stat-card"><div class="label">Free Delivery Budget</div><div class="value small">${tomanCompact(cpo.overall.all.freeDeliveryBudget)}<span class="pct-tag">${pct1(cpo.overall.all.freeDeliveryBudget_pct)}</span></div></div>
        <div class="stat-card"><div class="label">CPO</div><div class="value small">${cpo.overall.all.cpo!==null?tomanCompact(cpo.overall.all.cpo):'—'}</div></div>
        <div class="stat-card seg-b"><div class="label">Free Delivery CPO</div><div class="value small">${cpo.overall.all.freeDeliveryCpo!==null?tomanCompact(cpo.overall.all.freeDeliveryCpo):'—'}</div></div>
        <div class="stat-card purple"><div class="label">Subsidy Cost / Sold</div><div class="value small">${cpo.overall.all.subsidyCps!==null?tomanCompact(cpo.overall.all.subsidyCps):'—'}</div></div>
      </div>
      <div class="section-note">CPO = Total Budget ÷ M4O Orders. Free Delivery CPO = Free Delivery Budget ÷ M4O Orders. Subsidy Cost/Sold = Subsidy Budget ÷ Total Sold (product subsidy is spent per sold unit, not per order, so it isn't a "CPO").</div>
      <div class="chart-row">
        <div class="chart-box"><h3>Total Budget by Segment</h3><canvas id="cpoSegmentChart"></canvas></div>
        <div class="chart-box"><h3>Total Budget by City</h3><canvas id="cpoCityChart"></canvas></div>
      </div>
      <div class="chart-row">
        <div class="chart-box"><h3>M4O Order Share by Segment</h3><canvas id="cpoSegmentOrdersChart"></canvas></div>
        <div class="chart-box"><h3>M4O Order Share by City</h3><canvas id="cpoCityOrdersChart"></canvas></div>
      </div>
      <div class="section-title">By Segment</div>
      <div class="section-note">Kitchen vendors have a structurally different cost model, so they're kept as their own line rather than mixed into the Non-Kitchen segments. Non-Kitchen collapses to three buckets: Top Critical, Critical, and Other (Important + Ordinary).</div>
      <div class="table-wrap" style="margin-bottom:22px">
        <table>
          <thead><tr><th>Segment</th><th>Vendors</th><th>Subsidy Budget</th><th>Free Delivery Budget</th><th>Total Budget</th><th>M4O Orders</th><th>Total Sold</th><th>CPO</th><th>Free Delivery CPO</th><th>Subsidy Cost/Sold</th></tr></thead>
          <tbody>
            ${cpoRow('Top Critical', seg.TopCritical || {vendorCount:0,subsidyBudget:0,freeDeliveryBudget:0,totalBudget:0,m4oOrders:0,totalSold:0,subsidyBudget_pct:0,freeDeliveryBudget_pct:0,totalBudget_pct:0,m4oOrders_pct:0,cpo:null,freeDeliveryCpo:null,subsidyCps:null})}
            ${cpoRow('Critical', seg.Critical || {vendorCount:0,subsidyBudget:0,freeDeliveryBudget:0,totalBudget:0,m4oOrders:0,totalSold:0,subsidyBudget_pct:0,freeDeliveryBudget_pct:0,totalBudget_pct:0,m4oOrders_pct:0,cpo:null,freeDeliveryCpo:null,subsidyCps:null})}
            ${cpoRow('Other (Important + Ordinary)', seg.Other || {vendorCount:0,subsidyBudget:0,freeDeliveryBudget:0,totalBudget:0,m4oOrders:0,totalSold:0,subsidyBudget_pct:0,freeDeliveryBudget_pct:0,totalBudget_pct:0,m4oOrders_pct:0,cpo:null,freeDeliveryCpo:null,subsidyCps:null})}
            ${cpoRow('Non-Kitchen (all)', nk.total)}
            ${cpoRow('Kitchen', kAll)}
          </tbody>
        </table>
      </div>
      <div class="section-title">Cities &amp; Marketing Areas</div>
      <div class="card-grid">
        ${cities.map(([city,v]) => cpoCityCard(city,v)).join('')}
      </div>`;
  }

  if(d.city && !d.area){
    const cdata = cpo.byCity[d.city];
    const areas = Object.entries(cdata.areas).sort((a,b)=>b[1].totalBudget-a[1].totalBudget);
    return `
      ${breadcrumb(['All Cities', d.city], ['cpo-city-null', null])}
      <div class="stat-row">
        <div class="stat-card accent"><div class="label">Total Budget</div><div class="value">${tomanCompact(cdata.totalBudget)}<span class="pct-tag">${pct1(cdata.totalBudget_pct)}</span></div></div>
        <div class="stat-card"><div class="label">Subsidy Budget</div><div class="value small">${tomanCompact(cdata.subsidyBudget)}<span class="pct-tag">${pct1(cdata.subsidyBudget_pct)}</span></div></div>
        <div class="stat-card"><div class="label">Free Delivery Budget</div><div class="value small">${tomanCompact(cdata.freeDeliveryBudget)}<span class="pct-tag">${pct1(cdata.freeDeliveryBudget_pct)}</span></div></div>
        <div class="stat-card"><div class="label">CPO</div><div class="value small">${cdata.cpo!==null?tomanCompact(cdata.cpo):'—'}</div></div>
        <div class="stat-card seg-b"><div class="label">Free Delivery CPO</div><div class="value small">${cdata.freeDeliveryCpo!==null?tomanCompact(cdata.freeDeliveryCpo):'—'}</div></div>
        <div class="stat-card purple"><div class="label">Subsidy Cost / Sold</div><div class="value small">${cdata.subsidyCps!==null?tomanCompact(cdata.subsidyCps):'—'}</div></div>
      </div>
      <div class="section-title">Marketing Areas (${areas.length})</div>
      <div class="card-grid">
        ${areas.map(([area,v]) => cpoAreaCard(area,v)).join('')}
      </div>`;
  }

  const adata = cpo.byCity[d.city].areas[d.area];
  const vendors = [...adata.vendors].sort((a,b)=> b.totalBudget - a.totalBudget);
  return `
    ${breadcrumb(['All Cities', d.city, d.area], ['cpo-city-null', 'cpo-area-null', null])}
    <div class="stat-row">
      <div class="stat-card accent"><div class="label">Total Budget</div><div class="value">${tomanCompact(adata.totalBudget)}<span class="pct-tag">${pct1(adata.totalBudget_pct)}</span></div></div>
      <div class="stat-card"><div class="label">Subsidy Budget</div><div class="value small">${tomanCompact(adata.subsidyBudget)}<span class="pct-tag">${pct1(adata.subsidyBudget_pct)}</span></div></div>
      <div class="stat-card"><div class="label">Free Delivery Budget</div><div class="value small">${tomanCompact(adata.freeDeliveryBudget)}<span class="pct-tag">${pct1(adata.freeDeliveryBudget_pct)}</span></div></div>
      <div class="stat-card"><div class="label">CPO</div><div class="value small">${adata.cpo!==null?tomanCompact(adata.cpo):'—'}</div></div>
    </div>
    <input class="search-box" id="cpoVendorSearch" placeholder="Filter vendors by name…">
    <div class="table-wrap">
      <table id="cpoVendorTable">
        <thead><tr><th>Vendor</th><th>Vendor Class</th><th>Tier</th><th>New Class</th><th>Kitchen</th><th>M4O Orders</th><th>Total Sold</th><th>Total Budget</th><th>CPO</th><th>Free Delivery CPO</th><th>Subsidy Cost/Sold</th></tr></thead>
        <tbody>
          ${vendors.map(v => `<tr data-name="${escapeHtml(v.name.toLowerCase())}">
            <td>${escapeHtml(v.name)}</td>
            <td><span class="badge vc-${escapeAttr((v.vendorClass||'Unknown').replace(' ',''))}">${escapeHtml(v.vendorClass)}</span></td>
            <td><span class="badge seg-${escapeAttr(v.vendorTier)}">${escapeHtml(v.vendorTier)}</span></td>
            <td>${escapeHtml(v.newVendorClass)}</td>
            <td>${v.kitchen ? '<span class="badge kit">Kitchen</span>' : '<span class="dim">—</span>'}</td>
            <td style="font-family:var(--mono)">${fmt(v.m4oOrders)}</td>
            <td style="font-family:var(--mono)">${fmt(v.totalSold)}</td>
            <td style="font-family:var(--mono); font-weight:600">${tomanCompact(v.totalBudget)}</td>
            <td style="font-family:var(--mono); color:var(--accent)">${v.cpo!==null?tomanCompact(v.cpo):'<span class="dim">—</span>'}</td>
            <td style="font-family:var(--mono); color:var(--seg-b)">${v.freeDeliveryCpo!==null?tomanCompact(v.freeDeliveryCpo):'<span class="dim">—</span>'}</td>
            <td style="font-family:var(--mono); color:var(--purple)">${v.subsidyCps!==null?tomanCompact(v.subsidyCps):'<span class="dim">—</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function cpoCityCard(city, v){
  return `<div class="list-card" data-action="cpo-city" data-city="${escapeAttr(city)}">
    <div class="name">${escapeHtml(city)}</div>
    <div class="row"><span>Total budget</span><b>${tomanCompact(v.totalBudget)}<span class="pct">${pct1(v.totalBudget_pct)}</span></b></div>
    <div class="row"><span>M4O orders</span><b>${fmt(v.m4oOrders)}<span class="pct">${pct1(v.m4oOrders_pct)}</span></b></div>
    <div class="row"><span>CPO</span><b style="color:var(--accent)">${v.cpo!==null?tomanCompact(v.cpo):'—'}</b></div>
    <div class="row"><span>Vendors</span><b>${fmt(v.vendorCount)}</b></div>
  </div>`;
}
function cpoAreaCard(area, v){
  return `<div class="list-card" data-action="cpo-area" data-area="${escapeAttr(area)}">
    <div class="name">${escapeHtml(area)}</div>
    <div class="row"><span>Total budget</span><b>${tomanCompact(v.totalBudget)}<span class="pct">${pct1(v.totalBudget_pct)}</span></b></div>
    <div class="row"><span>M4O orders</span><b>${fmt(v.m4oOrders)}<span class="pct">${pct1(v.m4oOrders_pct)}</span></b></div>
    <div class="row"><span>CPO</span><b style="color:var(--accent)">${v.cpo!==null?tomanCompact(v.cpo):'—'}</b></div>
  </div>`;
}

function renderCoverageModel(){
  const cm = DATA.coverageModel || { cityCoverage:{}, coverageResult:{} };
  const cityNames = Object.keys(cm.cityCoverage || {});
  if(!cityNames.length){
    return `<div class="empty-state">No Coverage Model data available.<br>Check that COVERAGE_SPREADSHEET_ID is set in update_dashboard.js.</div>`;
  }
  const d = drill.coverageModel;

  // Sort with "All Cities" first
  const sortedCities = [...cityNames].sort((a,b) => a === 'All Cities' ? -1 : b === 'All Cities' ? 1 : 0);

  if(!d.city){
    return `
      ${breadcrumb(['All Cities'])}
      <div class="section-note">Coverage model scores are read live from a separate Google Sheet, alongside the main data sheet.</div>
      <div class="section-title">Cities</div>
      <div class="card-grid">
        ${sortedCities.map(city => coverageCityCard(city, cm.cityCoverage[city])).join('')}
      </div>`;
  }

  const cityData = cm.cityCoverage[d.city];
  const areaData = (cm.coverageResult && cm.coverageResult[d.city]) || {};
  const allScope = cityData['All Areas'];
  const topScope = cityData['Top Areas'];
  const areas = Object.entries(areaData).sort((a,b)=> (b[1].totalUsers||0) - (a[1].totalUsers||0));

  return `
    ${breadcrumb(['All Cities', d.city], ['cm-city-null'])}
    <div class="chart-row">
      ${coverageScopeCard('All Marketing Areas', allScope)}
      ${coverageScopeCard('Top Marketing Areas', topScope)}
    </div>
    ${areas.length ? `
    <div class="section-title">Coverage by Marketing Area (${areas.length})</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Area</th><th>Status</th><th>Total Users</th><th>Elite</th><th>Healthy</th><th>Moderate</th><th>Low</th><th>Clusters</th><th>Avg Products/Cluster</th><th>Avg Super/Cluster</th></tr></thead>
        <tbody>
          ${areas.map(([area,v]) => `<tr>
            <td>${escapeHtml(area)}</td>
            <td><span class="badge status-${escapeAttr(v.status)}">${escapeHtml(v.status)}</span></td>
            <td style="font-family:var(--mono)">${fmt(v.totalUsers)}</td>
            <td>${fmt(v.elite.users)} <span class="dim">(${v.elite.pct}%)</span></td>
            <td>${fmt(v.healthy.users)} <span class="dim">(${v.healthy.pct}%)</span></td>
            <td>${fmt(v.moderate.users)} <span class="dim">(${v.moderate.pct}%)</span></td>
            <td>${fmt(v.low.users)} <span class="dim">(${v.low.pct}%)</span></td>
            <td>${fmt(v.totalClusters)}</td>
            <td>${v.avgProductsPerCluster.toFixed(1)}</td>
            <td>${v.avgSuperPerCluster.toFixed(1)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `<div class="section-note">No per-area breakdown available for this selection.</div>`}`;
}

function coverageCityCard(city, scopes){
  const all = scopes['All Areas'];
  if(!all) return '';
  return `<div class="list-card" data-action="cm-city" data-city="${escapeAttr(city)}">
    <div class="name">${escapeHtml(city)} ${all.status ? `<span class="badge status-${escapeAttr(all.status)}" style="margin-left:6px">${escapeHtml(all.status)}</span>` : ''}</div>
    <div class="row"><span>Total users</span><b>${fmt(all.totalUsers)}</b></div>
    <div class="row"><span>Elite</span><b style="color:${STATUS_COLORS.Elite}">${all.elite.pct}%</b></div>
    <div class="row"><span>Healthy</span><b style="color:${STATUS_COLORS.Healthy}">${all.healthy.pct}%</b></div>
    <div class="row"><span>Moderate</span><b style="color:${STATUS_COLORS.Moderate}">${all.moderate.pct}%</b></div>
  </div>`;
}
function coverageScopeCard(title, scope){
  if(!scope) return `<div class="chart-box"><h3>${title}</h3><div class="empty-state" style="padding:20px">No data</div></div>`;
  return `<div class="chart-box">
    <h3>${escapeHtml(title)} ${scope.status ? `<span class="badge status-${escapeAttr(scope.status)}" style="margin-left:6px">${escapeHtml(scope.status)}</span>` : ''}</h3>
    <div style="font-size:12px; color:var(--text-faint); margin-bottom:14px">Total users: <b style="color:var(--text); font-family:var(--mono)">${fmt(scope.totalUsers)}</b></div>
    ${progressRow('Elite', scope.elite.pct, STATUS_COLORS.Elite)}
    ${progressRow('Healthy', scope.healthy.pct, STATUS_COLORS.Healthy)}
    ${progressRow('Moderate', scope.moderate.pct, STATUS_COLORS.Moderate)}
  </div>`;
}
function progressRow(label, value, color){
  return `<div class="progress-row">
    <div class="plabel">${label}</div>
    <div class="ptrack"><div class="pfill" style="width:${value}%; background:${color}"></div></div>
    <div class="pval">${value}%</div>
  </div>`;
}

/* ============================================================
   MODULE: DELIVERY (avg. M4O visibility radius by hour, per day)
   ============================================================ */
function deliveryDateSelector(dlAll){
  return `<select id="deliveryDateSelect" style="padding:8px 12px; background:var(--panel-2); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:13px; font-family:var(--mono)">
    ${[...dlAll.dates].reverse().map(dt => `<option value="${escapeAttr(dt)}" ${dt===deliveryDate?'selected':''}>${escapeHtml(dt)}</option>`).join('')}
  </select>`;
}

function renderDelivery(){
  const dlAll = DATA.delivery;
  if(!dlAll || !dlAll.dates || !dlAll.dates.length){
    return `<div class="empty-state">No Delivery data available. Set DELIVERY_SPREADSHEET_ID in config.local.js, share the sheet with the service account, then re-run <code>node update_dashboard.js</code>.</div>`;
  }
  if(!deliveryDate || !dlAll.byDate[deliveryDate]) deliveryDate = dlAll.dates[dlAll.dates.length - 1];
  const dl = dlAll.byDate[deliveryDate];
  const d = drill.delivery;

  const dateBar = `<div class="flex-between">
    <div class="section-note" style="margin:0">Maximum radius (km) M4O vendors were shown at, snapshotted through the day. Hover the chart for the value at each time. Pick a day:</div>
    ${deliveryDateSelector(dlAll)}
  </div>`;

  if(!d.city){
    const cities = Object.entries(dl.byCity).sort((a,b)=> b[1].vendorCount - a[1].vendorCount);
    return `
      ${breadcrumb(['All Cities'])}
      ${dateBar}
      <div class="chart-box"><h3>Average Radius by Hour — All Cities (${escapeHtml(deliveryDate)})</h3><canvas id="deliveryTimeChart"></canvas></div>
      <div class="section-title">Cities (${cities.length})</div>
      <div class="card-grid">
        ${cities.map(([city,v]) => `<div class="list-card" data-action="dl-city" data-city="${escapeAttr(city)}">
          <div class="name">${escapeHtml(city)}</div>
          <div class="row"><span>Vendors tracked</span><b>${fmt(v.vendorCount)}</b></div>
        </div>`).join('')}
      </div>`;
  }

  const cdata = dl.byCity[d.city];
  if(!cdata){
    return `<div class="empty-state">No Delivery data for ${escapeHtml(d.city)} on ${escapeHtml(deliveryDate)}.</div>`;
  }

  if(!d.area){
    const areas = Object.entries(cdata.areas).sort((a,b)=> b[1].vendorCount - a[1].vendorCount);
    return `
      ${breadcrumb(['All Cities', d.city], ['dl-city-null'])}
      ${dateBar}
      <div class="chart-box"><h3>Average Radius by Hour — ${escapeHtml(d.city)} (${escapeHtml(deliveryDate)})</h3><canvas id="deliveryTimeChart"></canvas></div>
      <div class="section-title">Marketing Areas (${areas.length})</div>
      <div class="card-grid">
        ${areas.map(([area,v]) => `<div class="list-card" data-action="dl-area" data-area="${escapeAttr(area)}">
          <div class="name">${escapeHtml(area)}</div>
          <div class="row"><span>Vendors tracked</span><b>${fmt(v.vendorCount)}</b></div>
        </div>`).join('')}
      </div>`;
  }

  const adata = cdata.areas[d.area];
  if(!adata){
    return `<div class="empty-state">No Delivery data for ${escapeHtml(d.area)} on ${escapeHtml(deliveryDate)}.</div>`;
  }

  if(!d.vendorId){
    const vendors = [...adata.vendors].sort((a,b)=> (a.name||'').localeCompare(b.name||''));
    return `
      ${breadcrumb(['All Cities', d.city, d.area], ['dl-city-null', 'dl-area-null'])}
      ${dateBar}
      <div class="chart-box"><h3>Average Radius by Hour — ${escapeHtml(d.area)} (${escapeHtml(deliveryDate)})</h3><canvas id="deliveryTimeChart"></canvas></div>
      <input class="search-box" id="deliveryVendorSearch" placeholder="Filter vendors by name…">
      <div class="table-wrap">
        <table id="deliveryVendorTable">
          <thead><tr><th>Vendor</th></tr></thead>
          <tbody>
            ${vendors.map(v => `<tr class="clickable" data-name="${escapeHtml((v.name||'').toLowerCase())}" data-action="dl-vendor" data-vendor-id="${escapeAttr(v.id)}">
              <td>${escapeHtml(v.name || 'Unknown')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  const vendor = adata.vendors.find(v => String(v.id) === String(d.vendorId));
  if(!vendor){
    return `<div class="empty-state">Vendor not found.</div>`;
  }
  return `
    ${breadcrumb(['All Cities', d.city, d.area, vendor.name || 'Vendor'], ['dl-city-null', 'dl-area-null', 'dl-vendor-null'])}
    ${dateBar}
    <div class="chart-box"><h3>Average Radius by Hour — ${escapeHtml(vendor.name || 'Vendor')} (${escapeHtml(deliveryDate)})</h3><canvas id="deliveryTimeChart"></canvas></div>`;
}

/* ============================================================
   HANDLERS + BREADCRUMB
   ============================================================ */
function breadcrumb(labels, actions){
  return `<div class="breadcrumb">
    ${labels.map((l,i) => {
      const isLast = i === labels.length-1;
      const action = actions ? actions[i] : null;
      return (i>0 ? '<span class="crumb-sep">/</span>' : '') +
        `<span class="crumb ${isLast?'current':''}" ${action ? `data-crumb="${action}"` : ''}>${escapeHtml(l)}</span>`;
    }).join('')}
  </div>`;
}

function attachHandlers(){
  document.querySelectorAll('[data-action="ov-city"]').forEach(el => {
    el.addEventListener('click', () => { drill.overview.city = el.dataset.city; render(); });
  });
  document.querySelectorAll('[data-action="vc-city"]').forEach(el => {
    el.addEventListener('click', () => { drill.vendorCoverage.city = el.dataset.city; render(); });
  });
  document.querySelectorAll('[data-action="vc-area"]').forEach(el => {
    el.addEventListener('click', () => { drill.vendorCoverage.area = el.dataset.area; render(); });
  });
  document.querySelectorAll('[data-action="vc-vendor"]').forEach(el => {
    el.addEventListener('click', () => { drill.vendorCoverage.vendorId = el.dataset.vendorId; render(); });
  });
  document.querySelectorAll('[data-action="pd-city"]').forEach(el => {
    el.addEventListener('click', () => { drill.packDistribution.city = el.dataset.city; render(); });
  });
  document.querySelectorAll('[data-action="pd-area"]').forEach(el => {
    el.addEventListener('click', () => { drill.packDistribution.area = el.dataset.area; render(); });
  });
  document.querySelectorAll('[data-action="rt-city"]').forEach(el => {
    el.addEventListener('click', () => { drill.rating.city = el.dataset.city; render(); });
  });
  document.querySelectorAll('[data-action="cm-city"]').forEach(el => {
    el.addEventListener('click', () => { drill.coverageModel.city = el.dataset.city; render(); });
  });
  document.querySelectorAll('[data-action="kt-city"]').forEach(el => {
    el.addEventListener('click', () => { drill.kitchen.city = el.dataset.city; render(); });
  });
  document.querySelectorAll('[data-action="kt-area"]').forEach(el => {
    el.addEventListener('click', () => { drill.kitchen.area = el.dataset.area; render(); });
  });
  document.querySelectorAll('[data-action="os-city"]').forEach(el => {
    el.addEventListener('click', () => { drill.orderShare.city = el.dataset.city; render(); });
  });
  document.querySelectorAll('[data-action="imp-city"]').forEach(el => {
    el.addEventListener('click', () => { drill.impression.city = el.dataset.city; render(); });
  });
  document.querySelectorAll('[data-action="imp-area"]').forEach(el => {
    el.addEventListener('click', () => { drill.impression.area = el.dataset.area; render(); });
  });
  document.querySelectorAll('[data-impsort]').forEach(el => {
    el.addEventListener('click', () => { impressionConversionSort = el.dataset.impsort; render(); });
  });
  document.querySelectorAll('[data-action="cpo-city"]').forEach(el => {
    el.addEventListener('click', () => { drill.cpoBudget.city = el.dataset.city; render(); });
  });
  document.querySelectorAll('[data-action="cpo-area"]').forEach(el => {
    el.addEventListener('click', () => { drill.cpoBudget.area = el.dataset.area; render(); });
  });
  document.querySelectorAll('[data-action="dl-city"]').forEach(el => {
    el.addEventListener('click', () => { drill.delivery.city = el.dataset.city; render(); });
  });
  document.querySelectorAll('[data-action="dl-area"]').forEach(el => {
    el.addEventListener('click', () => { drill.delivery.area = el.dataset.area; render(); });
  });
  document.querySelectorAll('[data-action="dl-vendor"]').forEach(el => {
    el.addEventListener('click', () => { drill.delivery.vendorId = el.dataset.vendorId; render(); });
  });
  const deliveryDateSelect = document.getElementById('deliveryDateSelect');
  if(deliveryDateSelect) deliveryDateSelect.addEventListener('change', () => { deliveryDate = deliveryDateSelect.value; render(); });
  document.querySelectorAll('[data-crumb]').forEach(el => {
    el.addEventListener('click', () => {
      const [module, level] = el.dataset.crumb.split('-');
      if(module === 'ov'){ if(level==='city') { drill.overview.city=null; } }
      if(module === 'vc'){
        if(level==='city') { drill.vendorCoverage.city=null; drill.vendorCoverage.area=null; drill.vendorCoverage.vendorId=null; }
        if(level==='area'){ drill.vendorCoverage.area=null; drill.vendorCoverage.vendorId=null; }
        if(level==='vendor'){ drill.vendorCoverage.vendorId=null; }
      }
      if(module === 'pd'){ if(level==='city') { drill.packDistribution.city=null; drill.packDistribution.area=null; } if(level==='area'){ drill.packDistribution.area=null; } }
      if(module === 'rt'){ if(level==='city') { drill.rating.city=null; } }
      if(module === 'cm'){ if(level==='city') { drill.coverageModel.city=null; } }
      if(module === 'kt'){ if(level==='city') { drill.kitchen.city=null; drill.kitchen.area=null; } if(level==='area'){ drill.kitchen.area=null; } }
      if(module === 'os'){ if(level==='city') { drill.orderShare.city=null; } }
      if(module === 'imp'){ if(level==='city') { drill.impression.city=null; drill.impression.area=null; } if(level==='area'){ drill.impression.area=null; } }
      if(module === 'cpo'){ if(level==='city') { drill.cpoBudget.city=null; drill.cpoBudget.area=null; } if(level==='area'){ drill.cpoBudget.area=null; } }
      if(module === 'dl'){
        if(level==='city') { drill.delivery.city=null; drill.delivery.area=null; drill.delivery.vendorId=null; }
        if(level==='area'){ drill.delivery.area=null; drill.delivery.vendorId=null; }
        if(level==='vendor'){ drill.delivery.vendorId=null; }
      }
      render();
    });
  });
  document.querySelectorAll('[data-window]').forEach(el => {
    el.addEventListener('click', () => { orderWindow = el.dataset.window; render(); });
  });

  const vendorSearch = document.getElementById('vendorSearch');
  if(vendorSearch) vendorSearch.addEventListener('input', () => filterTable('vendorTable', vendorSearch.value));
  const packSearch = document.getElementById('packSearch');
  if(packSearch) packSearch.addEventListener('input', () => filterTable('packTable', packSearch.value));
  const impPackSearch = document.getElementById('impPackSearch');
  if(impPackSearch) impPackSearch.addEventListener('input', () => filterTable('impPackTable', impPackSearch.value));
  const impConvSearch = document.getElementById('impConvSearch');
  if(impConvSearch) impConvSearch.addEventListener('input', () => filterTable('impConvTable', impConvSearch.value));
  const cpoVendorSearch = document.getElementById('cpoVendorSearch');
  if(cpoVendorSearch) cpoVendorSearch.addEventListener('input', () => filterTable('cpoVendorTable', cpoVendorSearch.value));
  const deliveryVendorSearch = document.getElementById('deliveryVendorSearch');
  if(deliveryVendorSearch) deliveryVendorSearch.addEventListener('input', () => filterTable('deliveryVendorTable', deliveryVendorSearch.value));

  drawCharts();
}

function filterTable(tableId, query){
  const q = query.toLowerCase().trim();
  document.querySelectorAll(`#${tableId} tbody tr`).forEach(tr => {
    tr.style.display = tr.dataset.name.includes(q) ? '' : 'none';
  });
}

/* ============================================================
   CHARTS
   ============================================================ */
function destroyChart(id){ if(charts[id]){ charts[id].destroy(); delete charts[id]; } }

function drawCharts(){
  Object.keys(charts).forEach(destroyChart);

  const gridColor = '#262E3A';
  const textColor = '#8B96A8';
  Chart.defaults.color = textColor;
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto";
  Chart.defaults.font.size = 11;

  if(currentPanel === 'packDistribution' && !drill.packDistribution.city){
    const filtered = superTypeFilter !== 'all';
    let overall, cityTotals;
    if(!filtered){
      overall = DATA.packDistribution;
      cityTotals = Object.entries(DATA.packDistribution.byCity).map(([c,v])=>[c,v.total]);
    } else {
      const cities = Object.entries(DATA.packDistribution.byCity).map(([city, cdata]) => {
        const allPacks = Object.values(cdata.areas).flatMap(a=>a.packs);
        return [city, allPacks.filter(matchesSuperType)];
      });
      overall = recomputePackBlock(cities.flatMap(([,p])=>p));
      cityTotals = cities.map(([c,p])=>[c,p.length]);
    }
    const ctx1 = document.getElementById('dealTypeChart');
    if(ctx1){
      charts.dealTypeChart = new Chart(ctx1, {
        type:'doughnut',
        data:{ labels: DEAL_TYPES, datasets:[{ data: DEAL_TYPES.map(t=>overall.dealTypeCounts[t]||0), backgroundColor: DEAL_TYPES.map(t=>DEAL_COLORS[t]), borderWidth:0 }]},
        options:{ plugins:{ legend:{ position:'right', labels:{ boxWidth:10, padding:12 } } } }
      });
    }
    const ctx2 = document.getElementById('cityPackChart');
    if(ctx2){
      const top = cityTotals.sort((a,b)=>b[1]-a[1]).slice(0,8);
      charts.cityPackChart = new Chart(ctx2, {
        type:'bar',
        data:{ labels: top.map(([c])=>c), datasets:[{ data: top.map(([,t])=>t), backgroundColor:'#FF5A36', borderRadius:4 }]},
        options:{ indexAxis:'y', plugins:{legend:{display:false}}, scales:{ x:{grid:{color:gridColor}}, y:{grid:{display:false}} } }
      });
    }
  }

  if(currentPanel === 'rating' && !drill.rating.city){
    const filtered = superTypeFilter !== 'all';
    let overallBuckets;
    let cityRates;
    if(!filtered){
      overallBuckets = DATA.rating.buckets;
      cityRates = Object.entries(DATA.rating.byCity).map(([c,v])=>[c,v.avgRate]);
    } else {
      const cities = Object.entries(DATA.rating.byCity).map(([city, cdata]) => {
        const allRows = Object.values(cdata.areas).flatMap(a=>a.rows);
        return [city, recomputeRatingBlock(allRows.filter(matchesSuperType))];
      }).filter(([,v]) => (v.ratedCount+v.noRatingCount) > 0);
      overallBuckets = {};
      BUCKET_ORDER.forEach(b => { overallBuckets[b] = cities.reduce((s,[,v])=>s+(v.buckets[b]||0),0); });
      cityRates = cities.map(([c,v])=>[c,v.avgRate]);
    }
    const ctx1 = document.getElementById('ratingBucketChart');
    if(ctx1){
      charts.ratingBucketChart = new Chart(ctx1, {
        type:'bar',
        data:{ labels: BUCKET_ORDER, datasets:[{ data: BUCKET_ORDER.map(k=>overallBuckets[k]||0), backgroundColor:'#4C8CFF', borderRadius:4 }]},
        options:{ plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false}}, y:{grid:{color:gridColor}} } }
      });
    }
    const ctx2 = document.getElementById('cityRateChart');
    if(ctx2){
      const top = cityRates.sort((a,b)=>b[1]-a[1]);
      charts.cityRateChart = new Chart(ctx2, {
        type:'bar',
        data:{ labels: top.map(([c])=>c), datasets:[{ data: top.map(([,v])=>v), backgroundColor:'#3DDC97', borderRadius:4 }]},
        options:{ indexAxis:'y', plugins:{legend:{display:false}}, scales:{ x:{grid:{color:gridColor}, min:0, max:10}, y:{grid:{display:false}} } }
      });
    }
  }

  if(currentPanel === 'impression'){
    const imp = DATA.impression;
    if(imp){
      const d = drill.impression;
      const filtered = superTypeFilter !== 'all';
      let block;
      if(!d.city){
        block = filtered ? recomputeImpressionBlock(Object.values(imp.byCity).flatMap(c=>Object.values(c.areas)).flatMap(a=>a.packs).filter(matchesSuperType)) : imp.overall;
      } else if(d.city && !d.area){
        const cdata = imp.byCity[d.city];
        const allPacks = Object.values(cdata.areas).flatMap(a=>a.packs);
        block = filtered ? recomputeImpressionBlock(allPacks.filter(matchesSuperType)) : cdata;
      } else {
        const rawArea = imp.byCity[d.city].areas[d.area];
        block = filtered ? recomputeImpressionBlock(rawArea.packs.filter(matchesSuperType)) : rawArea;
      }
      const ctx1 = document.getElementById('impTimeChart');
      if(ctx1){
        charts.impTimeChart = new Chart(ctx1, {
          type:'line',
          data:{ labels: imp.timeSlots, datasets:[{ data: block.bySlot, borderColor:'#FF5A36', backgroundColor:'rgba(255,90,54,.12)', fill:true, tension:.3, pointRadius:0 }]},
          options:{ plugins:{legend:{display:false}}, scales:{ x:{ grid:{display:false}, ticks:{ maxTicksLimit:8 } }, y:{grid:{color:gridColor}} } }
        });
      }
    }
  }

  if(currentPanel === 'delivery'){
    const dlAll = DATA.delivery;
    const dl = dlAll && dlAll.byDate ? dlAll.byDate[deliveryDate] : null;
    if(dl){
      const d = drill.delivery;
      let series;
      if(!d.city){
        series = dl.overall.avgByTime;
      } else if(d.city && !d.area){
        const cdata = dl.byCity[d.city];
        series = cdata ? cdata.avgByTime : [];
      } else if(d.area && !d.vendorId){
        const adata = dl.byCity[d.city] && dl.byCity[d.city].areas[d.area];
        series = adata ? adata.avgByTime : [];
      } else {
        const adata = dl.byCity[d.city] && dl.byCity[d.city].areas[d.area];
        const vendor = adata && adata.vendors.find(v => String(v.id) === String(d.vendorId));
        series = vendor ? vendor.byTime : [];
      }
      const ctx1 = document.getElementById('deliveryTimeChart');
      if(ctx1){
        charts.deliveryTimeChart = new Chart(ctx1, {
          type:'line',
          data:{ labels: dl.timeSlots, datasets:[{ data: series, borderColor:'#4C8CFF', backgroundColor:'rgba(76,140,255,.12)', fill:true, tension:.3, pointRadius:2, spanGaps:true }]},
          options:{ plugins:{legend:{display:false}}, scales:{ x:{ grid:{display:false} }, y:{grid:{color:gridColor}, title:{display:true,text:'km'}} } }
        });
      }
    }
  }

  if(currentPanel === 'cpoBudget' && !drill.cpoBudget.city){
    const cpo = DATA.cpoBudget;
    if(cpo){
      const nk = cpo.overall.nonKitchen;
      const seg = nk.bySegment;
      const ctx1 = document.getElementById('cpoSegmentChart');
      if(ctx1){
        const labels = ['Top Critical','Critical','Other','Kitchen'];
        const values = [seg.TopCritical, seg.Critical, seg.Other, cpo.overall.kitchen.total].map(m => m ? m.totalBudget : 0);
        const colors = [CPO_SEGMENT_COLORS.TopCritical, CPO_SEGMENT_COLORS.Critical, CPO_SEGMENT_COLORS.Other, CPO_SEGMENT_COLORS.Kitchen];
        const segTotal = values.reduce((a,b)=>a+b,0);
        charts.cpoSegmentChart = new Chart(ctx1, {
          type:'doughnut',
          data:{ labels, datasets:[{ data: values, backgroundColor: colors, borderWidth:0 }]},
          options:{ plugins:{
            legend:{ position:'right', labels:{ boxWidth:10, padding:12,
              generateLabels:(chart)=> chart.data.labels.map((label,i)=>({
                text:`${label} (${segTotal?pct1(values[i]/segTotal*100):'0.0%'})`,
                fillStyle: colors[i], strokeStyle: colors[i], index:i,
              })),
            } },
            tooltip:{ callbacks:{ label:(c)=>`${c.label}: ${segTotal?pct1(values[c.dataIndex]/segTotal*100):'0.0%'}` } },
          } }
        });
      }
      const ctx2 = document.getElementById('cpoCityChart');
      if(ctx2){
        const top = Object.entries(cpo.byCity).map(([c,v])=>[c,v.totalBudget]).sort((a,b)=>b[1]-a[1]).slice(0,8);
        charts.cpoCityChart = new Chart(ctx2, {
          type:'bar',
          data:{ labels: top.map(([c])=>c), datasets:[{ data: top.map(([,t])=>t), backgroundColor:'#FF5A36', borderRadius:4 }]},
          options:{ indexAxis:'y', plugins:{legend:{display:false}}, scales:{ x:{grid:{color:gridColor}, ticks:{ callback:(v)=>fmtCompact(v) }}, y:{grid:{display:false}} } }
        });
      }
      const ctx3 = document.getElementById('cpoSegmentOrdersChart');
      if(ctx3){
        const labels = ['Top Critical','Critical','Other','Kitchen'];
        const values = [seg.TopCritical, seg.Critical, seg.Other, cpo.overall.kitchen.total].map(m => m ? m.m4oOrders : 0);
        const colors = [CPO_SEGMENT_COLORS.TopCritical, CPO_SEGMENT_COLORS.Critical, CPO_SEGMENT_COLORS.Other, CPO_SEGMENT_COLORS.Kitchen];
        const ordersTotal = values.reduce((a,b)=>a+b,0);
        charts.cpoSegmentOrdersChart = new Chart(ctx3, {
          type:'doughnut',
          data:{ labels, datasets:[{ data: values, backgroundColor: colors, borderWidth:0 }]},
          options:{ plugins:{
            legend:{ position:'right', labels:{ boxWidth:10, padding:12,
              generateLabels:(chart)=> chart.data.labels.map((label,i)=>({
                text:`${label} (${ordersTotal?pct1(values[i]/ordersTotal*100):'0.0%'})`,
                fillStyle: colors[i], strokeStyle: colors[i], index:i,
              })),
            } },
            tooltip:{ callbacks:{ label:(c)=>`${c.label}: ${ordersTotal?pct1(values[c.dataIndex]/ordersTotal*100):'0.0%'}` } },
          } }
        });
      }
      const ctx4 = document.getElementById('cpoCityOrdersChart');
      if(ctx4){
        const top = Object.entries(cpo.byCity).map(([c,v])=>[c,v.m4oOrders]).sort((a,b)=>b[1]-a[1]).slice(0,8);
        charts.cpoCityOrdersChart = new Chart(ctx4, {
          type:'bar',
          data:{ labels: top.map(([c])=>c), datasets:[{ data: top.map(([,t])=>t), backgroundColor:'#4C8CFF', borderRadius:4 }]},
          options:{ indexAxis:'y', plugins:{legend:{display:false}}, scales:{ x:{grid:{color:gridColor}, ticks:{ callback:(v)=>fmtCompact(v) }}, y:{grid:{display:false}} } }
        });
      }
    }
  }

  if(currentPanel === 'orderShare' && !drill.orderShare.city){
    const os = DATA.orderShare;
    const cities = Object.entries(os.byCity)
      .map(([city,v]) => [city, orderWindow==='yesterday'?v.yesterday:v.mtd])
      .sort((a,b)=> b[1].m41Orders - a[1].m41Orders).slice(0,10);

    const ctx1 = document.getElementById('m41ByCityChart');
    if(ctx1){
      charts.m41ByCityChart = new Chart(ctx1, {
        type:'bar',
        data:{ labels: cities.map(([c])=>c), datasets:[{ data: cities.map(([,v])=>v.m41Orders), backgroundColor:'#FF5A36', borderRadius:4 }]},
        options:{ indexAxis:'y', plugins:{legend:{display:false}}, scales:{ x:{grid:{color:gridColor}}, y:{grid:{display:false}} } }
      });
    }
    const ctx2 = document.getElementById('shareByCityChart');
    if(ctx2){
      const shares = cities.map(([c,v]) => [c, v.platformOrders ? v.m41Orders/v.platformOrders : 0]).sort((a,b)=>b[1]-a[1]);
      charts.shareByCityChart = new Chart(ctx2, {
        type:'bar',
        data:{ labels: shares.map(([c])=>c), datasets:[{ data: shares.map(([,s])=>(s*100).toFixed(1)), backgroundColor:'#4C8CFF', borderRadius:4 }]},
        options:{ indexAxis:'y', plugins:{legend:{display:false}}, scales:{ x:{grid:{color:gridColor}, title:{display:true,text:'%'}}, y:{grid:{display:false}} } }
      });
    }
  }
}

/* ============================================================
   UTIL
   ============================================================ */
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s){ return escapeHtml(s).replace(/"/g,'&quot;'); }
