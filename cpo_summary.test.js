'use strict';

const assert = require('node:assert/strict');
const { buildCpoSummary } = require('./cpo_summary');

function row(city, group, orders, cpo, share) {
  const subsidy = Math.floor(cpo / 2);
  const delivery = cpo - subsidy;
  return {
    City: city,
    Kitchen_Group: 'Non-Kitchen',
    Vendor_Group: group,
    M41_Orders: orders,
    'CPO Total': cpo,
    'CPO Product Subsidy': subsidy,
    'CPO Free Delivery': delivery,
    AOV: orders ? 500 : 0,
    'CPO (T)/ AOV': orders ? +(100 * cpo / 500).toFixed(1) : 0,
    'CPO Product Subsidy / AOV': orders ? +(100 * subsidy / 500).toFixed(1) : 0,
    'CPO Free Delivery / AOV': orders ? +(100 * delivery / 500).toFixed(1) : 0,
    'Share of M41 Orders': share,
  };
}

// Entirely synthetic fixture: city, segment and national weighted values reconcile.
function fixture() {
  return [
    row('All cities', 'Total Non-Kitchen', 10, 114, 100),
    row('All cities', 'TopCritical', 4, 125, 40),
    row('All cities', 'Critical', 4, 110, 40),
    row('All cities', 'Others', 2, 100, 20),
    row('City A', 'Total Non-Kitchen', 6, 110, 100),
    row('City A', 'TopCritical', 3, 120, 50),
    row('City A', 'Critical', 2, 100, 33.3),
    row('City A', 'Others', 1, 100, 16.7),
    row('City B', 'Total Non-Kitchen', 4, 120, 100),
    row('City B', 'TopCritical', 1, 140, 25),
    row('City B', 'Critical', 2, 120, 50),
    row('City B', 'Others', 1, 100, 25),
  ];
}

const s = buildCpoSummary(fixture());
assert.equal(s.sourceSchema, 'city_group_summary_v2');
assert.equal(Object.keys(s.byCity).length, 2);
assert.equal(s.overall.all.m4oOrders, 10);
assert.equal(s.overall.all.cpo, 114); // pre-aggregated; not 110+120
assert.equal(s.overall.all.estimatedTotalCost, 1140); // 10 orders × 114 T/order
assert.equal(s.byCity['City A'].m4oOrders, 6);
assert.equal(s.byCity['City A'].projectOrderSharePct, 60);
assert.equal(s.overall.nonKitchen.bySegment.TopCritical.m4oOrders, 4);
assert.equal(s.byCity['City B'].bySegment.Critical.cpo, 120);
assert.equal(s.byCity['City A'].bySegment.Other.shareOfOrdersPct, 16.7);
assert.equal(s.overall.kitchen, undefined);

const missingHeader = fixture();
delete missingHeader[0]['CPO Total'];
assert.throws(() => buildCpoSummary(missingHeader), /missing column/i);

const duplicate = fixture();
duplicate.push({ ...duplicate[0] });
assert.throws(() => buildCpoSummary(duplicate), /Duplicate CPO row/);

const wrongTotal = fixture();
wrongTotal[0].M41_Orders = 11;
assert.throws(() => buildCpoSummary(wrongTotal), /segment orders do not match/);

const wrongKitchen = fixture();
wrongKitchen[1].Kitchen_Group = 'Kitchen';
assert.throws(() => buildCpoSummary(wrongKitchen), /Unexpected Kitchen_Group/);

console.log('CPO summary parser tests passed');
