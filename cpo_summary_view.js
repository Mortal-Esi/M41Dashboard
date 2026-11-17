'use strict';

// UI for CPO_Budget_MTD's new city × vendor-group NON-KITCHEN schema.
// This file is loaded after dashboard.js, preserving the legacy encrypted
// snapshot until the owner regenerates dashboard_data.enc locally.
function cpoSummaryMoney(n) {
  return n === null || n === undefined ? '<span class="dim">—</span>' : tomanCompact(n);
}
function cpoSummaryRate(n) {
  return n === null || n === undefined ? '<span class="dim">—</span>' : pct1(n);
}
function cpoSummaryStats(m) {
  return '<div class="stat-row">' +
    '<div class="stat-card"><div class="label">M41 Orders (MTD)</div><div class="value">' + fmt(m.m4oOrders) + '</div></div>' +
    '<div class="stat-card accent"><div class="label">CPO Total</div><div class="value">' + cpoSummaryMoney(m.cpo) + '</div></div>' +
    '<div class="stat-card"><div class="label">Product Subsidy / Order</div><div class="value small">' + cpoSummaryMoney(m.subsidyCpo) + '</div></div>' +
    '<div class="stat-card seg-b"><div class="label">Free Delivery / Order</div><div class="value small">' + cpoSummaryMoney(m.freeDeliveryCpo) + '</div></div>' +
    '<div class="stat-card"><div class="label">AOV</div><div class="value small">' + cpoSummaryMoney(m.aov) + '</div></div>' +
    '<div class="stat-card purple"><div class="label">CPO / AOV</div><div class="value small">' + cpoSummaryRate(m.cpoPctAov) + '</div></div>' +
    '<div class="stat-card"><div class="label">Estimated Total Cost</div><div class="value small">≈' + cpoSummaryMoney(m.estimatedTotalCost) + '</div></div>' +
    '</div>';
}
function cpoSummaryTableRow(label, m, share) {
  const shareText = share === undefined ? m.shareOfOrdersPct : share;
  return '<tr>' +
    '<td>' + escapeHtml(label) + '</td>' +
    '<td style="font-family:var(--mono)">' + fmt(m.m4oOrders) + '</td>' +
    '<td>' + cpoSummaryRate(shareText) + '</td>' +
    '<td style="color:var(--accent)">' + cpoSummaryMoney(m.cpo) + '</td>' +
    '<td>' + cpoSummaryMoney(m.subsidyCpo) + '</td>' +
    '<td>' + cpoSummaryMoney(m.freeDeliveryCpo) + '</td>' +
    '<td>' + cpoSummaryMoney(m.aov) + '</td>' +
    '<td>' + cpoSummaryRate(m.cpoPctAov) + '</td>' +
    '<td>' + cpoSummaryRate(m.subsidyPctAov) + '</td>' +
    '<td>' + cpoSummaryRate(m.deliveryPctAov) + '</td>' +
    '<td>≈' + cpoSummaryMoney(m.estimatedTotalCost) + '</td>' +
    '</tr>';
}
function cpoSummaryTable(rows, shareTitle) {
  return '<div class="table-wrap"><table><thead><tr>' +
    '<th>City / Group</th><th>M41 Orders</th><th>' + escapeHtml(shareTitle) + '</th>' +
    '<th>CPO Total</th><th>Product Subsidy / Order</th><th>Free Delivery / Order</th>' +
    '<th>AOV</th><th>CPO / AOV</th><th>Subsidy / AOV</th><th>Delivery / AOV</th><th>Est. Total Cost</th>' +
    '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
}
function cpoSummaryGroupRows(c) {
  return [
    cpoSummaryTableRow('Top Critical', c.bySegment.TopCritical),
    cpoSummaryTableRow('Critical', c.bySegment.Critical),
    cpoSummaryTableRow('Others', c.bySegment.Other),
    cpoSummaryTableRow('Total Non-Kitchen', c),
  ];
}
function renderCpoBudgetSummary(cpo) {
  const d = drill.cpoBudget;
  const note = '<div class="section-note">' +
    'Source: All_Done / CPO_Budget_MTD. MTD, Non-Kitchen only. CPO and component costs are Toman per M41 order; AOV is Toman per order. ' +
    'The source has city and vendor-group totals, NOT vendor or Marketing Area rows. ' +
    'Estimated Total Cost ≈ M41 Orders × reported (rounded) CPO; it is not a booked budget. ' +
    'Rates and totals come directly from the source summary, avoiding unweighted averaging or double-counting.' +
    '</div>';
  if (!d.city) {
    const total = cpo.overall.nonKitchen.total;
    const cities = Object.entries(cpo.byCity).sort((a,b) => b[1].m4oOrders - a[1].m4oOrders);
    const tableRows = cities.map(([city,m]) =>
      '<tr class="clickable" data-action="cpo-city" data-city="' + escapeAttr(city) + '">' +
      cpoSummaryTableRow(city, m, m.projectOrderSharePct).replace(/^<tr>/, '').replace(/<\/tr>$/, '') +
      '</tr>');
    return breadcrumb(['All Cities']) + note + cpoSummaryStats(total) +
      '<div class="chart-row">' +
      '<div class="chart-box"><h3>CPO by Vendor Group</h3><canvas id="cpoSummaryGroupChart"></canvas></div>' +
      '<div class="chart-box"><h3>CPO — 10 Largest Cities by M41 Orders</h3><canvas id="cpoSummaryCityChart"></canvas></div>' +
      '</div>' +
      '<div class="section-title">By Vendor Group</div>' +
      cpoSummaryTable(cpoSummaryGroupRows(total), 'Share of Group Orders') +
      '<div class="section-title">Cities (' + cities.length + ')</div>' +
      '<div class="section-note">City shares use all Non-Kitchen M41 orders as the denominator. Select a city for its group breakdown.</div>' +
      cpoSummaryTable(tableRows, 'Share of All Orders');
  }
  const city = cpo.byCity[d.city];
  if (!city) {
    return breadcrumb(['All Cities']) + '<div class="empty-state">No CPO data for the selected city.</div>';
  }
  return breadcrumb(['All Cities',d.city],['cpo-city-null',null]) +
    note + cpoSummaryStats(city) +
    '<div class="section-title">By Vendor Group — ' + escapeHtml(d.city) + '</div>' +
    cpoSummaryTable(cpoSummaryGroupRows(city), 'Share of City Orders');
}
function drawCpoSummaryCharts(cpo) {
  const groupCtx = document.getElementById('cpoSummaryGroupChart');
  const cityCtx = document.getElementById('cpoSummaryCityChart');
  if (groupCtx) {
    const m = cpo.overall.nonKitchen.bySegment;
    const labels = ['Top Critical','Critical','Others'];
    const values = [m.TopCritical, m.Critical, m.Other].map(x => x.cpo);
    charts.cpoSummaryGroups = new Chart(groupCtx, {
      type:'bar',
      data:{ labels, datasets:[{data:values, backgroundColor:['#FF5A36','#F2B84B','#4C8CFF'], borderRadius:4}] },
      options:{ indexAxis:'y', plugins:{legend:{display:false},tooltip:{callbacks:{label:x=>x.raw===null?'No orders':tomanCompact(x.raw)}}},
        scales:{ x:{beginAtZero:true, ticks:{callback:v=>fmtCompact(v)}}, y:{grid:{display:false}}} }
    });
  }
  if (cityCtx) {
    const cities = Object.entries(cpo.byCity).filter(([,m])=>m.m4oOrders>0)
      .sort((a,b)=>b[1].m4oOrders-a[1].m4oOrders).slice(0,10);
    charts.cpoSummaryCities = new Chart(cityCtx, {
      type:'bar',
      data:{ labels:cities.map(([c])=>c), datasets:[{ data:cities.map(([,m])=>m.cpo), backgroundColor:'#FF5A36', borderRadius:4 }] },
      options:{ indexAxis:'y', plugins:{legend:{display:false},tooltip:{callbacks:{label:x=>tomanCompact(x.raw)}}},
        scales:{x:{beginAtZero:true,ticks:{callback:v=>fmtCompact(v)}},y:{grid:{display:false}}} }
    });
  }
}
function cpoKitchenSummaryRows() {
  const c = DATA.cpoBudget;
  if (!c || c.sourceSchema !== 'city_group_summary_v2') return '';
  const m = c.overall.nonKitchen.total;
  return '<tr><td>Estimated Total Cost (MTD)</td><td class="dim">N/A (not in source)</td>' +
    '<td>≈' + cpoSummaryMoney(m.estimatedTotalCost) + '</td></tr>' +
    '<tr><td>CPO Total (MTD)</td><td class="dim">N/A (not in source)</td>' +
    '<td style="color:var(--accent)">' + cpoSummaryMoney(m.cpo) + '</td></tr>';
}
