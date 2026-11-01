'use strict';
// PostgreSQL refuses a statement that is sent a different number of parameters than it uses. The integration tests would catch
// that, but only against a real database, so this guards every report with a fake query function that checks the same rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../src/services/ticket_reports');

const user = (role) => ({ id: '00000000-0000-0000-0000-000000000001', name: 'A', email: 'a@x.test', kind: 'staff', role });
const p = { from: '2026-01-01', to: '2026-01-31', customer: '00000000-0000-0000-0000-0000000000c1' };

test('every report sends exactly the parameters its queries use', async () => {
  const seen = [];
  const q = async (text, params = []) => {
    const used = new Set([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    const max = used.size ? Math.max(...used) : 0;
    assert.equal(used.size, params.length, `statement uses ${used.size} parameters but is sent ${params.length}: ${text.slice(0, 80)}`);
    assert.equal(max, params.length, `parameters must be numbered $1..$${params.length}`);
    seen.push(text);
    return { rows: [], rowCount: 0 };
  };
  for (const id of Object.keys(R.REPORTS)) {
    for (const role of ['platform_admin', 'agent']) {
      for (const customer of [null, p.customer]) {
        try { await R.run(q, user(role), id, { ...p, customer }); } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; }
      }
    }
  }
  assert.ok(seen.length >= Object.keys(R.REPORTS).length, 'every report ran at least one query');
});
