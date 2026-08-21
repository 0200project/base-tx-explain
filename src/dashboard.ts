/**
 * Founder dashboard, served cookie-gated from the API origin (the static
 * site's /dashboard/ page moved here so the page itself is behind the token,
 * not just the daily-detail data). index.ts owns the routes and the auth;
 * this module only renders HTML.
 *
 * Styling comes from the public site's stylesheet (cross-origin CSS link);
 * data loads client-side: Blockscout (public API), /healthz (public,
 * same origin), /stats (same origin, HttpOnly cookie attaches automatically).
 */

const SITE_URL = 'https://0200project.com';

const BRAND_SVG =
  '<svg viewBox="0 0 64 36" aria-hidden="true" style="height:1.125rem;width:auto">' +
  '<rect x="0" y="0" width="15" height="15" rx="4" fill="#2a2a31"/>' +
  '<rect x="20" y="0" width="15" height="15" rx="4" fill="#4e9eff"/>' +
  '<rect x="0" y="20" width="15" height="15" rx="4" fill="#2a2a31"/>' +
  '<rect x="20" y="20" width="15" height="15" rx="4" fill="#2a2a31"/>' +
  '<rect x="44" y="1.5" width="20" height="7" rx="3.5" fill="#ececf1"/>' +
  '<rect x="44" y="14.5" width="14" height="7" rx="3.5" fill="#8b8b94"/>' +
  '<rect x="44" y="27.5" width="9" height="7" rx="3.5" fill="#55555e"/></svg>';

function head(title: string, extraCss: string): string {
  return (
    '<!doctype html><html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${title}</title>` +
    '<meta name="robots" content="noindex, nofollow">' +
    '<meta name="theme-color" content="#050505">' +
    '<link rel="icon" href="/favicon.ico">' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">' +
    `<link rel="stylesheet" href="${SITE_URL}/assets/style.css">` +
    `<style>${extraCss}</style>` +
    '</head><body>'
  );
}

function header(right: string): string {
  return (
    '<header class="nav"><div class="container nav-inner">' +
    `<a class="brand" href="${SITE_URL}/" aria-label="0200project site">${BRAND_SVG}0200project</a>` +
    '<span class="dash-tag">dashboard</span>' +
    right +
    '</div></header>'
  );
}

const SHARED_CSS = `
  .dash-tag {
    font-family: var(--mono);
    font-size: 0.71875rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-faint);
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    padding: 0.2rem 0.65rem;
  }
`;

const LOGIN_CSS =
  SHARED_CSS +
  `
  .gate {
    min-height: calc(100vh - var(--nav-h));
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem 1.25rem 4rem;
  }
  .gate-panel { width: 100%; max-width: 22rem; padding: 2rem 1.75rem; }
  .gate-panel h1 { font-size: 1.25rem; letter-spacing: -0.015em; margin: 0 0 0.375rem; }
  .gate-panel p { color: var(--fg-muted); font-size: 0.875rem; margin: 0 0 1.5rem; }
  .gate-panel input {
    width: 100%;
    height: 2.5rem;
    padding: 0 0.875rem;
    background: var(--bg-inset);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    font-family: var(--mono);
    font-size: 0.875rem;
    color: var(--fg);
  }
  .gate-panel input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  .gate-panel button { width: 100%; margin-top: 0.75rem; }
  .gate-err { color: var(--fg-muted); font-size: 0.8125rem; margin-top: 0.875rem; }
  .gate-err:empty { display: none; }
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function loginPage(opts: { error?: string } = {}): string {
  return (
    head('Dashboard — 0200project', LOGIN_CSS) +
    header('') +
    '<main class="gate"><div class="panel gate-panel card">' +
    '<h1>Founder dashboard</h1>' +
    '<p>Enter the stats token. It is checked by this server and kept as an HttpOnly cookie — it never touches page scripts.</p>' +
    '<form method="post" action="/dashboard/login">' +
    '<input type="password" name="token" autocomplete="current-password" autofocus aria-label="Stats token" placeholder="stats token">' +
    '<button class="btn btn-primary" type="submit">Unlock</button>' +
    '</form>' +
    `<p class="gate-err">${opts.error ? escapeHtml(opts.error) : ''}</p>` +
    '</div></main>' +
    '</body></html>'
  );
}

const DASH_CSS =
  SHARED_CSS +
  `
  .dash-col { max-width: 46rem; }
  .dash-body { padding-bottom: clamp(4rem, 9vw, 6.5rem); }
  .page-hero { padding-block: clamp(2.5rem, 6vw, 4rem) clamp(1.5rem, 4vw, 2.5rem); }
  .dash-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1rem; margin-bottom: 2rem; }
  .dash-section { margin-top: clamp(2.5rem, 6vw, 3.5rem); }
  .dash-section > h2 { font-size: 1.375rem; letter-spacing: -0.015em; margin-bottom: 1rem; }
  .dash-section .section-msg { margin-top: 0.75rem; }
  .dash-section .section-msg:empty { display: none; }

  .rev-hero { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 1.5rem 2.5rem; padding: 1.5rem; }
  .rev-amount { font-family: var(--mono); font-size: clamp(1.875rem, 5vw, 2.5rem); line-height: 1.1; color: var(--fg-strong); letter-spacing: -0.02em; }
  .rev-sub { margin-top: 0.375rem; }
  .rev-target { flex: 1 1 14rem; max-width: 18rem; }
  .progress { height: 4px; margin-top: 0.5rem; background: var(--bg-hover); border-radius: 999px; overflow: hidden; }
  .progress i { display: block; height: 100%; width: 0; background: var(--accent); border-radius: 999px; }
  .rev-table { margin-top: 1rem; }
  .rev-table td.num, .stats-table td.num { text-align: right; font-family: var(--mono); font-size: 0.8125rem; }
  .rev-table th.num, .stats-table th.num { text-align: right; }
  .rev-table td.t { white-space: nowrap; }
  .rev-table a { color: var(--accent); font-family: var(--mono); font-size: 0.8125rem; }
  .rev-table a:hover { color: var(--accent-strong); }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr)); gap: 0.75rem; }
  .tile { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem 1.125rem; }
  .tile .n { font-family: var(--mono); font-size: 1.375rem; color: var(--fg-strong); letter-spacing: -0.01em; }
  .tile .l { font-family: var(--mono); font-size: 0.65625rem; letter-spacing: 0.07em; text-transform: uppercase; color: var(--fg-faint); margin-top: 0.25rem; }
  .recon { margin-top: 0.75rem; }
  .recon .tile.flag { border-color: #b4791f; }
  .recon .tile.flag .n { color: #e0a244; }
  .recon-note { margin-top: 0.625rem; }
  .usage-note { margin-top: 0.75rem; }

  .chart-panel { padding: 1.25rem; margin-top: 1.25rem; }
  .chart { display: flex; align-items: flex-end; gap: 2px; height: 120px; }
  .bar-col { flex: 1 1 0; min-width: 0; height: 100%; display: flex; align-items: flex-end; }
  .bar { width: 100%; background: var(--accent); border-radius: 4px 4px 0 0; }
  .bar.zero { background: var(--border-strong); border-radius: 0; height: 2px; }
  .chart-labels { display: flex; gap: 2px; margin-top: 0.4375rem; height: 1.1em; font-family: var(--mono); font-size: 0.6875rem; color: var(--fg-faint); }
  .chart-labels span { flex: 1 1 0; min-width: 0; position: relative; }
  .chart-labels b { position: absolute; top: 0; left: 0; font-weight: 400; white-space: nowrap; }
  .chart-labels span.end b { left: auto; right: 0; }

  .conv-line { margin-top: 1.25rem; color: var(--fg-muted); }
  .stats-table-wrap { margin-top: 1.25rem; }
  .stats-h { font-family: var(--mono); font-size: 0.71875rem; font-weight: 500; letter-spacing: 0.07em; text-transform: uppercase; color: var(--fg-faint); margin-top: 1.75rem; }
  .logout-form { margin-left: auto; }
`;

/* eslint-disable no-useless-escape */
const DASH_SCRIPT = `
(function () {
  var WALLET = '0xd4ec730ab062f20460727710fce70664948a6bc9';
  var USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  var TARGET_USD = 25;
  var TRANSFERS_URL = 'https://base.blockscout.com/api/v2/addresses/' + WALLET +
    '/token-transfers?type=ERC-20&filter=to';

  var $ = function (id) { return document.getElementById(id); };

  function usd(n) {
    n = Number(n);
    if (!isFinite(n)) n = 0;
    var s = n.toFixed(6).replace(/(\\.\\d\\d\\d*?)0+$/, '$1');
    return '$' + s;
  }

  function int(n) {
    n = Number(n);
    if (!isFinite(n)) n = 0;
    return Math.round(n).toLocaleString();
  }

  function shortAddr(a) {
    return (typeof a === 'string' && a.length > 12) ? a.slice(0, 6) + '\\u2026' + a.slice(-4) : (a || '');
  }

  function parseDay(s) {
    var p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function dayLabel(s) {
    return parseDay(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  /* ---------- revenue ---------- */

  // The balance is authoritative and comes from our own server (/stats
  // treasury block, read via Base RPC with failover). The per-payment list
  // below is a public-explorer nicety and degrades on its own: Blockscout
  // being down must never blank the number this page exists to show.
  // Booked revenue vs. the chain. The payment path serves the caller when a
  // settlement is ambiguous (deliberately - denying a real payer is the worse
  // error), so these two numbers can drift apart for good reasons. This panel
  // exists so the drift is a named number instead of a silent discrepancy:
  // without it, money that arrived but never booked reads as $0 earned.
  function renderReconciliation(r) {
    if (!r) return;
    var tile = $('rc-delta-tile');
    var note = $('rc-note');
    $('rc-booked').textContent = usd(r.booked_usd);
    $('rc-chain').textContent = r.received_usd === null ? '\\u2014' : usd(r.received_usd);

    if (r.delta_usd === null) {
      $('rc-delta').textContent = '\\u2014';
      $('rc-delta-label').textContent = 'Unbooked';
      tile.className = 'tile';
      note.textContent = r.note || '';
      return;
    }
    var d = Number(r.delta_usd);
    $('rc-delta').textContent = usd(Math.abs(d));
    $('rc-delta-label').textContent = d < 0 ? 'Overbooked' : 'Unbooked';
    // Flag only a real divergence; a reconciled ledger stays quiet.
    tile.className = r.status === 'reconciled' ? 'tile' : 'tile flag';
    note.textContent = r.note || '';
  }

  function renderTreasury(t) {
    if (!t) return;
    var bal = Number(t.usdc_balance);
    $('rev-total').textContent = usd(bal);
    var pct = Math.min(100, (bal / TARGET_USD) * 100);
    $('rev-bar').style.width = pct.toFixed(1) + '%';
    $('rev-target-label').textContent = usd(bal) + ' of $' + TARGET_USD + ' validation target';
    var note = 'Balance read from Base RPC by this server';
    if (t.read_at) note += ' as of ' + new Date(t.read_at).toLocaleTimeString();
    if (t.error) note += ' \\u2014 latest refresh failed, this is the last good read';
    $('rev-note').textContent = note + '.';
  }

  function loadTransfers() {
    var msg = $('rev-msg');
    return fetch(TRANSFERS_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var items = (data.items || []).filter(function (t) {
          var tok = t.token || {};
          var addr = String(tok.address_hash || tok.address || '').toLowerCase();
          return addr === USDC;
        });

        var total = 0;
        var rows = items.map(function (t) {
          var raw = t.total && t.total.value != null ? t.total.value : '0';
          var amt = Number(raw) / 1e6;
          total += amt;
          var from = t.from && (t.from.hash || t.from.address) || (typeof t.from === 'string' ? t.from : '');
          var hash = t.transaction_hash || t.tx_hash || '';
          return { time: t.timestamp ? new Date(t.timestamp) : null, from: from, amt: amt, hash: hash };
        });

        rows.sort(function (a, b) { return (b.time ? b.time.getTime() : 0) - (a.time ? a.time.getTime() : 0); });

        $('rev-count').textContent = rows.length + (rows.length === 1 ? ' payment received' : ' payments received');

        var wrap = $('rev-table');
        if (rows.length === 0) {
          wrap.innerHTML = '';
          msg.textContent = 'No on-chain payments yet.';
          return;
        }
        msg.textContent = '';

        var table = document.createElement('table');
        table.className = 'rev-table';
        table.innerHTML = '<thead><tr><th>Time</th><th>From</th><th class="num">Amount</th><th>Tx</th></tr></thead>';
        var tbody = document.createElement('tbody');
        rows.slice(0, 10).forEach(function (row) {
          var tr = document.createElement('tr');

          var tdT = document.createElement('td');
          tdT.className = 't';
          tdT.textContent = row.time
            ? row.time.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' +
              row.time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
            : '';
          tr.appendChild(tdT);

          var tdF = document.createElement('td');
          tdF.className = 'mono small';
          tdF.textContent = shortAddr(row.from);
          tdF.title = row.from;
          tr.appendChild(tdF);

          var tdA = document.createElement('td');
          tdA.className = 'num';
          tdA.textContent = usd(row.amt);
          tr.appendChild(tdA);

          var tdX = document.createElement('td');
          if (/^0x[0-9a-fA-F]{64}$/.test(row.hash)) {
            var a = document.createElement('a');
            a.href = 'https://basescan.org/tx/' + row.hash;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = shortAddr(row.hash);
            tdX.appendChild(a);
          }
          tr.appendChild(tdX);

          tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        var box = document.createElement('div');
        box.className = 'table-wrap rev-table';
        box.appendChild(table);
        wrap.innerHTML = '';
        wrap.appendChild(box);
      })
      .catch(function () {
        $('rev-count').textContent = 'payment list unavailable';
        msg.textContent = 'The public explorer (Blockscout) is not answering, so the per-payment list is unavailable. The balance above reads directly from the chain and stays live.';
      });
  }

  /* ---------- server usage (same-origin /healthz) ---------- */

  var lastLifetime = null;

  function loadUsage() {
    var msg = $('usage-msg');
    return fetch('/healthz', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        var L = d.lifetime || {};
        lastLifetime = L;
        $('t-calls').textContent = int(L.calls);
        $('t-free').textContent = int(L.free);
        $('t-wall').textContent = int(L.wall_hits);
        $('t-paid').textContent = int(L.paid_calls);
        $('t-clients').textContent = int(L.unique_clients);
        var bits = ['Wall hits are 402 payment challenges served.'];
        if (d.version) bits.unshift('Server v' + d.version + (d.payment_mode ? ' \\u00b7 payment mode: ' + d.payment_mode : '') + '.');
        $('usage-note').textContent = bits.join(' ');
        msg.textContent = '';
      })
      .catch(function () {
        msg.textContent = 'Could not reach /healthz right now. The section will retry on the next refresh.';
      });
  }

  /* ---------- daily detail (same-origin /stats, cookie-authenticated) ---------- */

  function renderChart(daily) {
    var days = daily.slice(-30);
    var chart = $('chart');
    var labels = $('chart-labels');
    chart.innerHTML = '';
    labels.innerHTML = '';

    var max = 0, maxIdx = 0;
    days.forEach(function (d, i) {
      var c = Number(d.calls) || 0;
      if (c > max) { max = c; maxIdx = i; }
    });

    days.forEach(function (d, i) {
      var calls = Number(d.calls) || 0;
      var col = document.createElement('div');
      col.className = 'bar-col';
      col.title = dayLabel(d.day) + ': ' + calls + ' calls (' +
        (Number(d.free) || 0) + ' free / ' +
        (Number(d.wall_hits) || 0) + ' wall / ' +
        (Number(d.paid_calls) || 0) + ' paid)';

      var bar = document.createElement('div');
      if (calls > 0 && max > 0) {
        bar.className = 'bar';
        bar.style.height = Math.max(2, (calls / max) * 100) + '%';
      } else {
        bar.className = 'bar zero';
      }
      col.appendChild(bar);
      chart.appendChild(col);

      var cell = document.createElement('span');
      var isLast = i === days.length - 1;
      if ((i === maxIdx && max > 0) || isLast) {
        if (isLast) cell.className = 'end';
        var b = document.createElement('b');
        b.textContent = dayLabel(d.day);
        cell.appendChild(b);
      }
      labels.appendChild(cell);
    });
  }

  function renderStatsTable(daily) {
    var tbody = $('stats-tbody');
    tbody.innerHTML = '';
    daily.slice(-7).reverse().forEach(function (d) {
      var tr = document.createElement('tr');
      var cells = [
        [dayLabel(d.day), ''],
        [int(d.calls), 'num'],
        [int(d.free), 'num'],
        [int(d.wall_hits), 'num'],
        [int(d.paid_calls), 'num'],
        [usd(d.revenue_usd), 'num']
      ];
      cells.forEach(function (c) {
        var td = document.createElement('td');
        td.textContent = c[0];
        if (c[1]) td.className = c[1];
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function renderConversion(lifetime) {
    var L = lifetime || lastLifetime || {};
    var wall = Number(L.wall_hits) || 0;
    var paid = Number(L.paid_calls) || 0;
    var settled = Number(L.settlements) || 0;
    $('conv-line').textContent = 'Lifetime conversion: ' + wall +
      (wall === 1 ? ' request' : ' requests') + ' hit the paywall; ' + paid +
      (paid === 1 ? ' call arrived' : ' calls arrived') + ' carrying a payment; ' + settled +
      (settled === 1 ? ' payment' : ' payments') + ' settled on-chain.';
  }

  function loadStats() {
    var msg = $('stats-msg');
    var content = $('stats-content');
    return fetch('/stats', { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) { throw { code: 401 }; }
        if (r.status === 404) { throw { code: 404 }; }
        if (!r.ok) { throw { code: r.status }; }
        return r.json();
      })
      .then(function (d) {
        renderTreasury(d.treasury);
        renderReconciliation(d.reconciliation);
        var daily = d.daily || [];
        renderChart(daily);
        renderStatsTable(daily);
        renderConversion(d.lifetime);
        content.hidden = false;
        msg.textContent = '';
      })
      .catch(function (e) {
        content.hidden = true;
        if (e && e.code === 401) {
          msg.innerHTML = 'Session expired \\u2014 <a href="/dashboard">log in again</a>.';
        } else if (e && e.code === 404) {
          msg.textContent = 'Stats not enabled on the server.';
        } else {
          msg.textContent = 'Could not load stats right now. The section will retry on the next refresh.';
        }
      });
  }

  /* ---------- refresh loop ---------- */

  function stamp() {
    $('last-updated').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
  }

  function refreshAll() {
    var btn = $('refresh');
    btn.disabled = true;
    Promise.all([loadTransfers(), loadUsage()])
      .then(function () { return loadStats(); })
      .then(function () {
        stamp();
        btn.disabled = false;
      });
  }

  $('refresh').addEventListener('click', refreshAll);
  setInterval(refreshAll, 120000);
  refreshAll();
})();
`;
/* eslint-enable no-useless-escape */

export function dashboardPage(): string {
  return (
    head('Dashboard — 0200project', DASH_CSS) +
    header(
      '<form class="logout-form" method="post" action="/dashboard/logout">' +
        '<button class="btn btn-ghost btn-sm" type="submit">Log out</button></form>',
    ) +
    '<main>' +
    '<section class="page-hero"><div class="container">' +
    '<span class="eyebrow">Dashboard</span>' +
    '<h1 class="h-section">Revenue and usage</h1>' +
    '<p class="lead">On-chain USDC in the payment wallet, plus lifetime server counters. Served token-gated from the API origin; the balance is read by this server straight from Base RPC, while the per-payment list comes from a public explorer and may lag or drop out independently.</p>' +
    '</div></section>' +
    '<div class="container dash-body"><div class="dash-col">' +
    '<div class="dash-meta">' +
    '<button class="btn btn-ghost btn-sm" id="refresh" type="button">Refresh</button>' +
    '<span class="small faint" id="last-updated"></span>' +
    '<span class="small faint">Auto-refreshes every 2 minutes.</span>' +
    '</div>' +
    '<section class="dash-section" id="sec-revenue" style="margin-top:0">' +
    '<h2>Revenue</h2>' +
    '<div class="panel"><div class="rev-hero">' +
    '<div><div class="rev-amount" id="rev-total">&mdash;</div>' +
    '<div class="small faint rev-sub"><span id="rev-count">&mdash;</span> &middot; USDC on Base</div>' +
    '<div class="small faint rev-sub" id="rev-note"></div></div>' +
    '<div class="rev-target"><div class="small faint" id="rev-target-label">$25 validation target</div>' +
    '<div class="progress"><i id="rev-bar"></i></div></div>' +
    '</div></div>' +
    '<div class="tiles recon">' +
    '<div class="tile"><div class="n" id="rc-booked">&mdash;</div><div class="l">Booked revenue</div></div>' +
    '<div class="tile"><div class="n" id="rc-chain">&mdash;</div><div class="l">Received on chain</div></div>' +
    '<div class="tile" id="rc-delta-tile"><div class="n" id="rc-delta">&mdash;</div><div class="l" id="rc-delta-label">Unbooked</div></div>' +
    '</div>' +
    '<p class="small faint recon-note" id="rc-note"></p>' +
    '<div id="rev-table"></div>' +
    '<p class="small faint section-msg" id="rev-msg"></p>' +
    '</section>' +
    '<section class="dash-section" id="sec-usage">' +
    '<h2>Server usage</h2>' +
    '<div class="tiles">' +
    '<div class="tile"><div class="n" id="t-calls">&mdash;</div><div class="l">Total calls</div></div>' +
    '<div class="tile"><div class="n" id="t-free">&mdash;</div><div class="l">Free calls</div></div>' +
    '<div class="tile"><div class="n" id="t-wall">&mdash;</div><div class="l">Wall hits</div></div>' +
    '<div class="tile"><div class="n" id="t-paid">&mdash;</div><div class="l">Payment attempts</div></div>' +
    '<div class="tile"><div class="n" id="t-clients">&mdash;</div><div class="l">Unique clients</div></div>' +
    '</div>' +
    '<p class="small faint usage-note" id="usage-note">Wall hits are 402 payment challenges served.</p>' +
    '<p class="small faint section-msg" id="usage-msg"></p>' +
    '</section>' +
    '<section class="dash-section" id="sec-stats">' +
    '<h2>Daily detail</h2>' +
    '<p class="small faint section-msg" id="stats-msg"></p>' +
    '<div id="stats-content" hidden>' +
    '<div class="panel chart-panel">' +
    '<div class="chart" id="chart" role="img" aria-label="Daily total calls, last 30 days"></div>' +
    '<div class="chart-labels" id="chart-labels"></div>' +
    '</div>' +
    '<p class="conv-line" id="conv-line"></p>' +
    '<h3 class="stats-h">Last 7 days</h3>' +
    '<div class="table-wrap stats-table-wrap">' +
    '<table class="stats-table">' +
    '<thead><tr><th>Day</th><th class="num">Calls</th><th class="num">Free</th><th class="num">Wall hits</th><th class="num">Pay attempts</th><th class="num">Settled $</th></tr></thead>' +
    '<tbody id="stats-tbody"></tbody>' +
    '</table>' +
    '</div>' +
    '</div>' +
    '</section>' +
    '<noscript><p class="small faint" style="margin-top:2rem">JavaScript is disabled, so nothing on this page can load. Data comes from Blockscout and this server&rsquo;s /healthz and /stats endpoints.</p></noscript>' +
    '</div></div>' +
    '</main>' +
    `<script>${DASH_SCRIPT}</script>` +
    '</body></html>'
  );
}
