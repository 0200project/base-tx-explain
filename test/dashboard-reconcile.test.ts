import { describe, expect, it } from 'vitest';
import { dashboardPage } from '../src/dashboard.js';

/**
 * The reconciliation panel is built as a markup string in one place and driven
 * by getElementById in another. Nothing in the type system connects the two, so
 * a renamed id would silently leave the delta blank — which is the exact
 * failure this panel exists to prevent. These assertions tie them together.
 */
describe('dashboard reconciliation panel', () => {
  const html = dashboardPage();

  it('renders every element the reconciliation script writes into', () => {
    for (const id of ['rc-booked', 'rc-chain', 'rc-delta', 'rc-delta-tile', 'rc-delta-label', 'rc-note']) {
      expect(html, `missing element id="${id}"`).toContain('id="' + id + '"');
    }
  });

  it('queries only ids that exist in the markup', () => {
    const fn = html.slice(html.indexOf('function renderReconciliation'), html.indexOf('function renderTreasury'));
    expect(fn.length).toBeGreaterThan(0);
    for (const m of fn.matchAll(/\$\('([a-z0-9-]+)'\)/g)) {
      expect(html, `script reads #${m[1]} but the markup has no such element`).toContain('id="' + m[1] + '"');
    }
  });

  it('wires the panel into the stats load path', () => {
    expect(html).toContain('renderReconciliation(d.reconciliation)');
  });
});
