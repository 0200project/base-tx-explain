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
