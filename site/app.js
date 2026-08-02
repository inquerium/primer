/* primer — site behaviour. Zero dependencies, zero network calls. */
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var raf = window.requestAnimationFrame.bind(window);

  /* ── scroll progress + nav state ───────────────────── */
  var bar = document.querySelector('.progress i');
  var nav = document.querySelector('.nav');
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    raf(function () {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var p = max > 0 ? window.scrollY / max : 0;
      if (bar) bar.style.width = (p * 100).toFixed(2) + '%';
      if (nav) nav.classList.toggle('stuck', window.scrollY > 12);
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ── pointer aura + per-card glow ──────────────────── */
  if (!reduced && window.matchMedia('(pointer: fine)').matches) {
    document.body.classList.add('has-pointer');
    var root = document.documentElement;
    window.addEventListener('mousemove', function (e) {
      root.style.setProperty('--mx', e.clientX + 'px');
      root.style.setProperty('--my', e.clientY + 'px');
    }, { passive: true });

    document.querySelectorAll('.card').forEach(function (card) {
      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--cx', (e.clientX - r.left) + 'px');
        card.style.setProperty('--cy', (e.clientY - r.top) + 'px');
      }, { passive: true });
    });
  }

  /* ── reveal on scroll ──────────────────────────────── */
  var revealables = document.querySelectorAll('.reveal');
  if (reduced || !('IntersectionObserver' in window)) {
    revealables.forEach(function (el) { el.classList.add('in'); });
  } else {
    var revealer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        revealer.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    revealables.forEach(function (el) { revealer.observe(el); });
  }

  /* helper: run fn once, when el first scrolls into view */
  function whenSeen(el, fn, threshold) {
    if (!el) return;
    if (!('IntersectionObserver' in window)) { fn(); return; }
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        fn();
        obs.disconnect();
      });
    }, { threshold: threshold || 0.25 });
    obs.observe(el);
  }

  /* ── record console prints line by line ────────────── */
  var record = document.querySelector('[data-record]');
  if (record) {
    var lines = record.querySelectorAll('[data-line]');
    whenSeen(record, function () {
      if (reduced) { lines.forEach(function (l) { l.classList.add('in'); }); return; }
      lines.forEach(function (l, i) {
        setTimeout(function () { l.classList.add('in'); }, i * 200);
      });
    }, 0.3);
  }

  /* ── counters ──────────────────────────────────────── */
  var scale = document.querySelector('[data-scale]');
  if (scale) {
    var fmt = function (n) {
      if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M';
      return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    };
    whenSeen(scale, function () {
      scale.querySelectorAll('[data-count-to]').forEach(function (el) {
        var target = parseInt(el.getAttribute('data-count-to'), 10);
        if (reduced) { el.textContent = fmt(target); return; }
        var t0 = performance.now(), dur = 1500;
        (function step(now) {
          var p = Math.min(1, (now - t0) / dur);
          el.textContent = fmt(Math.round(target * (1 - Math.pow(1 - p, 3))));
          if (p < 1) raf(step);
        })(t0);
      });
    }, 0.3);
  }

  /* ── click-to-copy install line ────────────────────── */
  var term = document.querySelector('[data-copy]');
  if (term) {
    var hint = term.querySelector('.copy-hint');
    term.addEventListener('click', function () {
      var text = term.querySelector('code').textContent.replace(/^\s*\$\s*/, '').trim();
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(text).then(function () {
        if (!hint) return;
        hint.textContent = 'copied ✓';
        hint.style.opacity = '1';
        setTimeout(function () { hint.textContent = 'click to copy'; hint.style.opacity = ''; }, 1400);
      }).catch(function () { /* clipboard unavailable — leave the UI alone */ });
    });
  }
})();
