'use strict';
// Cross-module executive view (spec section 6): pipeline, tenders, contracts and technical support side by side.
const P = require('./pipeline');
const PR = require('./pipeline_reports');
const TR = require('./tender_reports');
const CR = require('./contract_reports');

/** Which sections the viewer may see: { pipeline, tenders, contracts }. Each section is null when not permitted. */
async function overview(q, can, defaultCurrency, today) {
  const out = { pipeline: null, tenders: null, contracts: null, comparison: [] };
  if (can('pipeline.view')) out.pipeline = await PR.dashboard(q, today, defaultCurrency);
  if (can('tender.view')) out.tenders = await TR.dashboard(q, defaultCurrency);
  if (can('contract.view')) out.contracts = await CR.dashboard(q, defaultCurrency);
  if (out.pipeline && out.contracts) {
    // pipeline (weighted) against secured contract value, per currency
    const cur = new Set([...Object.keys(out.pipeline.totals), ...out.contracts.money.map((m) => m.currency)]);
    out.comparison = [...cur].sort((a, b) => (b === defaultCurrency) - (a === defaultCurrency) || a.localeCompare(b)).map((c) => {
      const m = out.contracts.money.find((x) => x.currency === c) || { total: 0, acv: 0 };
      const t = out.pipeline.totals[c] || { open: 0, weighted: 0 };
      return { currency: c, pipeline: t.open, weighted: t.weighted, secured: m.total, annual: m.acv };
    });
  }
  return out;
}

module.exports = { overview, OPEN: P.OPEN };
