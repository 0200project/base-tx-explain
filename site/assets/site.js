/* 0200project — shared behavior: mobile nav, reveal-on-scroll, copy buttons. */
(function () {
  'use strict';

  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px' }
    );
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* fall through */ }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }
  window.__copyText = copyText;

  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var sel = btn.getAttribute('data-copy');
      var src = document.querySelector(sel);
      if (!src) return;
      var prev = btn.textContent;
      copyText(src.textContent.trim()).then(
        function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = prev; }, 1600); },
        function () { btn.textContent = 'Copy failed'; setTimeout(function () { btn.textContent = prev; }, 1600); }
      );
    });
  });
})();

/* Command palette (Cmd/Ctrl+K), footer live status, kbd label. */
(function () {
  'use strict';

  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  document.querySelectorAll('.kbd-hint').forEach(function (el) {
    el.textContent = isMac ? '⌘K' : 'Ctrl K';
  });

  /* ---- Footer status: live probe of the production API.
     /healthz is CORS-enabled, so read the real health payload when we can;
     fall back to an opaque reachability probe if the CORS fetch fails. ---- */
  var ft = document.querySelector('.footer-status');
  if (ft && window.fetch && window.AbortController) {
    var ftTxt = ft.querySelector('#ft-status');
    var HEALTH = 'https://base-tx-explain.fly.dev/healthz';

    var probeOpaque = function () {
      var ctrl = new AbortController();
      var to = setTimeout(function () { ctrl.abort(); }, 8000);
      fetch(HEALTH, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
        .then(function () { clearTimeout(to); ft.classList.add('ft-ok'); ftTxt.textContent = 'All systems reachable'; })
        .catch(function () { clearTimeout(to); ft.classList.add('ft-bad'); ftTxt.textContent = 'Status: endpoint unreachable'; });
    };

    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, 8000);
    fetch(HEALTH, { mode: 'cors', cache: 'no-store', signal: ctrl.signal })
      .then(function (res) {
        clearTimeout(to);
        if (!res.ok) throw new Error('bad status');
        return res.json();
      })
      .then(function (h) {
        if (!h || h.ok !== true) throw new Error('not ok');
        ft.classList.add('ft-ok');
        var calls = h.lifetime && typeof h.lifetime.calls === 'number' ? h.lifetime.calls : null;
        ftTxt.textContent = calls !== null
          ? 'Operational · ' + calls.toLocaleString() + ' calls served'
          : 'Operational';
      })
      .catch(function () { clearTimeout(to); probeOpaque(); });
  }

  /* ---- Command palette ---- */
  var ITEMS = [
    { g: 'Navigate', t: 'Home', hint: '/', href: '/' },
    { g: 'Navigate', t: 'Tools', hint: '/tools', href: '/tools/' },
    { g: 'Navigate', t: 'Documentation', hint: '/docs', href: '/docs/' },
    { g: 'Navigate', t: 'Pricing', hint: '/docs#pricing', href: '/docs/#pricing' },
    { g: 'Navigate', t: 'Playground', hint: '/playground', href: '/playground/' },
    { g: 'Navigate', t: 'Status', hint: '/status', href: '/status/' },
    { g: 'Navigate', t: 'Changelog', hint: '/changelog', href: '/changelog/' },
    { g: 'Navigate', t: 'Security', hint: '/security', href: '/security/' },
    { g: 'Resources', t: 'GitHub repository', hint: 'github.com', href: 'https://github.com/0200project/base-tx-explain' },
    { g: 'Resources', t: 'MCP Registry', hint: 'registry', href: 'https://registry.modelcontextprotocol.io/v0/servers?search=base-tx-explain' },
    { g: 'Actions', t: 'Copy MCP endpoint', hint: 'copy', copy: 'https://base-tx-explain.fly.dev/mcp' },
    { g: 'Actions', t: 'Copy MCP client config', hint: 'copy', copy: '{\n  "mcpServers": {\n    "base-tx-explain": {\n      "type": "streamable-http",\n      "url": "https://base-tx-explain.fly.dev/mcp"\n    }\n  }\n}' }
  ];

  var root = null, input = null, list = null, open = false, filtered = [], sel = 0, lastFocus = null;

  function build() {
    root = document.createElement('div');
    root.className = 'cmdk';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Command menu');
    root.innerHTML =
      '<div class="cmdk-backdrop"></div>' +
      '<div class="cmdk-panel">' +
      '<input class="cmdk-input" type="text" placeholder="Type a command or search…" aria-label="Search commands" autocomplete="off" spellcheck="false">' +
      '<ul class="cmdk-list" role="listbox" aria-label="Commands"></ul>' +
      '<div class="cmdk-foot"><span>↑↓ navigate</span><span>↵ select</span><span>esc close</span></div>' +
      '</div>';
    document.body.appendChild(root);
    input = root.querySelector('.cmdk-input');
    list = root.querySelector('.cmdk-list');

    root.querySelector('.cmdk-backdrop').addEventListener('click', close);
    input.addEventListener('input', function () { render(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
    });
    list.addEventListener('click', function (e) {
      var li = e.target.closest('.cmdk-item');
      if (li) run(Number(li.getAttribute('data-i')));
    });
    list.addEventListener('mousemove', function (e) {
      var li = e.target.closest('.cmdk-item');
      if (li && Number(li.getAttribute('data-i')) !== sel) { sel = Number(li.getAttribute('data-i')); paint(); }
    });
  }

  function render(q) {
    q = (q || '').trim().toLowerCase();
    filtered = ITEMS.filter(function (it) {
      return !q || (it.t + ' ' + it.g + ' ' + (it.hint || '')).toLowerCase().indexOf(q) !== -1;
    });
    sel = 0;
    var html = '', group = '';
    filtered.forEach(function (it, i) {
      if (it.g !== group && !q) { html += '<li class="cmdk-group" aria-hidden="true">' + it.g + '</li>'; group = it.g; }
      html += '<li class="cmdk-item" role="option" id="cmdk-opt-' + i + '" data-i="' + i + '"><span>' + it.t + '</span><span class="cmdk-hint">' + (it.hint || '') + '</span></li>';
    });
    list.innerHTML = html || '<li class="cmdk-empty">No results.</li>';
    paint();
  }

  function paint() {
    list.querySelectorAll('.cmdk-item').forEach(function (li) {
      var on = Number(li.getAttribute('data-i')) === sel;
      li.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) li.scrollIntoView({ block: 'nearest' });
    });
    input.setAttribute('aria-activedescendant', filtered.length ? 'cmdk-opt-' + sel : '');
  }

  function move(d) {
    if (!filtered.length) return;
    sel = (sel + d + filtered.length) % filtered.length;
    paint();
  }

  function run(i) {
    var it = filtered[i];
    if (!it) return;
    if (it.href) {
      close();
      if (/^https?:/.test(it.href)) window.location.href = it.href;
      else window.location.href = it.href;
    } else if (it.copy) {
      var write = window.__copyText || (navigator.clipboard && function (t) { return navigator.clipboard.writeText(t); });
      if (write) {
        write(it.copy).then(function () {
          var li = list.querySelector('[data-i="' + i + '"] .cmdk-hint');
          if (li) li.textContent = 'copied ✓';
          setTimeout(close, 500);
        }, close);
      } else close();
    }
  }

  function openPalette() {
    if (!root) build();
    lastFocus = document.activeElement;
    root.hidden = false;
    open = true;
    input.value = '';
    render('');
    input.focus();
  }

  function close() {
    if (!root) return;
    root.hidden = true;
    open = false;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      open ? close() : openPalette();
    } else if (e.key === 'Escape' && open) {
      close();
    }
  });

  document.querySelectorAll('.kbd-hint').forEach(function (el) {
    el.addEventListener('click', openPalette);
  });
})();
