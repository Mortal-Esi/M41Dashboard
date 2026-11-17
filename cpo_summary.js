'use strict';

// CPO_Budget_MTD contains pre-aggregated, NON-KITCHEN city × vendor-group rows.
// "CPO Total" and its components are Toman PER ORDER, not total expenditure.
// Never aggregate CPOs by summing or taking an unweighted mean.
const GROUP_NAMES = ['TopCritical', 'Critical', 'Others'];
const REQUIRED_FIELDS = [
  'City', 'Kitchen_Group', 'Vendor_Group', 'M41_Orders',
  'CPO Total', 'CPO Product Subsidy', 'CPO Free Delivery', 'AOV',
  'CPO (T)/ AOV', 'CPO Product Subsidy / AOV',
  'CPO Free Delivery / AOV', 'Share of M41 Orders',
];

function numeric(row, field, label) {
  const value = row[field];
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new Error('Missing ' + field + ' at ' + label);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error('Invalid ' + field + ' at ' + label + ': ' + String(value));
  }
  return number;
}

function asMetrics(row) {
  const label = String(row.City) + ' / ' + String(row.Vendor_Group);
  const m4oOrders = numeric(row, 'M41_Orders', label);
  const total = numeric(row, 'CPO Total', label);
  const subsidy = numeric(row, 'CPO Product Subsidy', label);
  const delivery = numeric(row, 'CPO Free Delivery', label);
  const aov = numeric(row, 'AOV', label);
  const cpoPctAov = numeric(row, 'CPO (T)/ AOV', label);
  const subsidyPctAov = numeric(row, 'CPO Product Subsidy / AOV', label);
  const deliveryPctAov = numeric(row, 'CPO Free Delivery / AOV', label);
  const shareOfOrdersPct = numeric(row, 'Share of M41 Orders', label);
  if (!Number.isInteger(m4oOrders)) {
    throw new Error('M41_Orders must be an integer at ' + label);
  }
  // The sheet publishes rounded whole-Toman CPOs; parts may differ by 1 T.
  if (Math.abs(total - subsidy - delivery) > 1.01) {
    throw new Error('CPO components do not reconcile at ' + label);
  }
  if (shareOfOrdersPct > 100.1) {
    throw new Error('Share of M41 Orders exceeds 100% at ' + label);
  }
  return {
    m4oOrders,
    cpo: m4oOrders ? total : null,
    subsidyCpo: m4oOrders ? subsidy : null,
    freeDeliveryCpo: m4oOrders ? delivery : null,
    aov: m4oOrders ? aov : null,
    cpoPctAov: m4oOrders ? cpoPctAov : null,
    subsidyPctAov: m4oOrders ? subsidyPctAov : null,
    deliveryPctAov: m4oOrders ? deliveryPctAov : null,
    shareOfOrdersPct,
    // Estimated, not booked spend: CPO values in the sheet are rounded.
    estimatedTotalCost: total * m4oOrders,
    estimatedSubsidyCost: subsidy * m4oOrders,
    estimatedDeliveryCost: delivery * m4oOrders,
  };
}

function buildCpoSummary(rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new Error('CPO_Budget_MTD is empty; refusing to publish zero CPO data');
  }
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(rawRows[0], field)) {
      throw new Error('CPO_Budget_MTD schema missing column: ' + field);
    }
  }
  const rows = rawRows.filter(r => r.City !== null && r.City !== undefined &&
    String(r.City).trim() !== '');
  const groupsByCity = new Map();
  for (const row of rows) {
    const city = String(row.City).trim();
    const group = String(row.Vendor_Group || '').trim();
    if (row.Kitchen_Group !== 'Non-Kitchen') {
      throw new Error('Unexpected Kitchen_Group in CPO_Budget_MTD: ' + String(row.Kitchen_Group));
    }
    if (group !== 'Total Non-Kitchen' && !GROUP_NAMES.includes(group)) {
      throw new Error('Unexpected Vendor_Group in CPO_Budget_MTD: ' + group);
    }
    if (!groupsByCity.has(city)) groupsByCity.set(city, new Map());
    const byGroup = groupsByCity.get(city);
    if (byGroup.has(group)) throw new Error('Duplicate CPO row: ' + city + ' / ' + group);
    byGroup.set(group, asMetrics(row));
  }
  function getCity(groupRows, city) {
    if (!groupRows || groupRows.size !== 4 ||
        !groupRows.has('Total Non-Kitchen') ||
        !GROUP_NAMES.every(g => groupRows.has(g))) {
      throw new Error('Missing CPO city/group rows: ' + city);
    }
    const total = groupRows.get('Total Non-Kitchen');
    const segmentsOrders = GROUP_NAMES.reduce((sum, group) =>
      sum + groupRows.get(group).m4oOrders, 0);
    if (segmentsOrders !== total.m4oOrders) {
      throw new Error('CPO segment orders do not match total for ' + city);
    }
    const bySegment = {
      TopCritical: groupRows.get('TopCritical'),
      Critical: groupRows.get('Critical'),
      Other: groupRows.get('Others'),
    };
    return { ...total, bySegment };
  }
  const national = getCity(groupsByCity.get('All cities'), 'All cities');
  const byCity = {};
  let cityOrders = 0;
  for (const [city, groupRows] of groupsByCity) {
    if (city === 'All cities') continue; // avoid double-counting the total row
    const cityMetrics = getCity(groupRows, city);
    cityOrders += cityMetrics.m4oOrders;
    cityMetrics.projectOrderSharePct = national.m4oOrders
      ? Math.round(cityMetrics.m4oOrders / national.m4oOrders * 1000) / 10 : 0;
    byCity[city] = cityMetrics;
  }
  if (cityOrders !== national.m4oOrders) {
    throw new Error('CPO city orders do not reconcile with All cities total: ' +
      cityOrders + ' vs ' + national.m4oOrders);
  }
  return {
    sourceSchema: 'city_group_summary_v2',
    sourceTab: 'CPO_Budget_MTD',
    scope: 'Non-Kitchen',
    unit: 'Toman',
    granularity: 'city_vendor_group',
    overall: {
      all: national,
      nonKitchen: { total: national, bySegment: national.bySegment },
    },
    byCity,
  };
}

module.exports = { buildCpoSummary };
