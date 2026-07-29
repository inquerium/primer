/**
 * primer runtime — the wire between a generated interface and the record.
 *
 * Every interface the tutor generates gets this injected. It is the reason there
 * is no separate "log your progress" step: using the thing is the assessment.
 *
 *   primer.observe({ skill: 'cvc_short_a', correct: 1, item: 'cat', response: 'cat', latency_ms: 2100 })
 *   primer.affect('frustration', { intensity: 0.7, evidence: '3 abandoned attempts' })
 *   primer.interest('dinosaurs')
 *   primer.misconception('reads every vowel as short', { skill: 'vowel_team_ai' })
 *   primer.done({ summary: 'Nailed short a. Wobbly on short e.', energy: 'ok' })
 *
 * Calls are batched and flushed every 2s, on tab hide, and on unload.
 */
(function () {
  var cfg = window.__PRIMER__ || {};
  var timer = null;
  var startedAt = Date.now();
  var lastMark = startedAt;

  // Evidence outlives the tab.
  //
  // An in-memory queue loses whatever a child just did the moment the wifi drops or
  // the tablet sleeps — and a service worker cannot help, because service workers
  // need a secure context and a LAN address over plain HTTP is not one. localStorage
  // works on plain HTTP everywhere, so that is what holds the line.
  var STORE = 'primer_pending';
  var queue = [];
  try {
    queue = JSON.parse(localStorage.getItem(STORE) || '[]');
  } catch (e) {
    queue = [];
  }

  function persist() {
    try {
      localStorage.setItem(STORE, JSON.stringify(queue));
    } catch (e) {
      /* storage full or blocked — the in-memory queue still works for this session */
    }
  }

  // Off this machine the record needs a key. It arrives once in the URL the parent
  // scanned, then lives in this device's own storage so the child never sees it
  // and never has to type anything.
  var token = null;
  try {
    var fromUrl = new URLSearchParams(location.search).get('t') ||
      (location.hash.match(/(?:^|[#&])t=([^&]+)/) || [])[1];
    if (fromUrl) {
      localStorage.setItem('primer_token', fromUrl);
      if (history.replaceState) history.replaceState(null, '', location.pathname);
    }
    token = localStorage.getItem('primer_token');
  } catch (e) {
    /* private mode, or storage blocked — loopback does not need a token anyway */
  }

  function post(path, body, beacon) {
    var url = cfg.api + path;
    var payload = JSON.stringify(body);
    if (beacon && navigator.sendBeacon) {
      // sendBeacon cannot set headers, so the token rides in the query string on
      // this path only. It is the last-gasp flush as a tab closes.
      navigator.sendBeacon(
        token ? url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + encodeURIComponent(token) : url,
        new Blob([payload], { type: 'application/json' }),
      );
      return Promise.resolve();
    }
    var headers = { 'content-type': 'application/json' };
    if (token) headers['x-primer-token'] = token;
    return fetch(url, {
      method: 'POST',
      headers: headers,
      body: payload,
      keepalive: true,
    })
      .then(function (res) {
        if (!res.ok) {
          console.warn('[primer] the record refused this batch', res.status);
          return false;
        }
        return true;
      })
      .catch(function (err) {
        // Kept on disk, retried on the next flush and on the next page load.
        console.warn('[primer] offline; evidence kept and will be retried', err);
        return false;
      });
  }

  function flush(beacon) {
    if (!queue.length) return Promise.resolve();
    var batch = queue.slice();
    return post(
      '/api/observe',
      {
        learner_id: cfg.learner_id,
        session_id: cfg.session_id,
        interface_id: cfg.interface_id,
        observations: batch,
      },
      beacon
    ).then(function (ok) {
      // Only drop what the record confirmed it has. Clearing the queue before the
      // request lands is how a dropped connection quietly erases a child's session.
      if (ok !== false) {
        queue.splice(0, batch.length);
        persist();
      }
      return ok;
    });
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      flush(false);
    }, 2000);
  }

  var primer = {
    config: cfg,

    /** Record one attempt. `latency_ms` is filled in from the last call if omitted. */
    observe: function (o) {
      var nowMs = Date.now();
      queue.push({
        skill_id: o.skill || o.skill_id || null,
        correct: o.correct === undefined ? null : Number(o.correct),
        latency_ms: o.latency_ms === undefined ? nowMs - lastMark : o.latency_ms,
        hint_count: o.hints || o.hint_count || 0,
        item: o.item === undefined ? null : String(o.item),
        response: o.response === undefined ? null : String(o.response),
        expected: o.expected === undefined ? null : String(o.expected),
        modality: o.modality || 'selected',
        kind: o.kind || 'attempt',
        source: cfg.interface_id || 'interface',
        meta: o.meta || null,
      });
      lastMark = nowMs;
      persist();
      schedule();
      if (queue.length >= 20) flush(false);
      return primer;
    },

    /** Mark the start of an item, so latency measures thinking time not idle time. */
    mark: function () {
      lastMark = Date.now();
      return primer;
    },

    affect: function (signal, opts) {
      opts = opts || {};
      post('/api/affect', {
        learner_id: cfg.learner_id,
        session_id: cfg.session_id,
        signal: signal,
        intensity: opts.intensity === undefined ? 0.5 : opts.intensity,
        evidence: opts.evidence || null,
      });
      return primer;
    },

    interest: function (topic, opts) {
      opts = opts || {};
      post('/api/interest', {
        learner_id: cfg.learner_id,
        topic: topic,
        weight: opts.weight,
        source: opts.source || 'observed',
        note: opts.note || null,
      });
      return primer;
    },

    misconception: function (pattern, opts) {
      opts = opts || {};
      post('/api/misconception', {
        learner_id: cfg.learner_id,
        pattern: pattern,
        skill_id: opts.skill || opts.skill_id || null,
        example: opts.example || null,
      });
      return primer;
    },

    /** Close out the session. Safe to call more than once. */
    done: function (opts) {
      opts = opts || {};
      return flush(false).then(function () {
        return post('/api/session/end', {
          session_id: cfg.session_id,
          interface_id: cfg.interface_id,
          summary: opts.summary || null,
          energy: opts.energy || null,
          outcome_note: opts.outcome_note || null,
        });
      });
    },

    /**
     * Record the child reading aloud.
     *
     *   var stop = await primer.listen({ prompt: 'Read this page out loud.', skill: 'fl_phrasing' });
     *   // ...child reads...
     *   var artifact = await stop();
     *
     * Returns null immediately if audio capture is switched off for this install —
     * an adult turns it on deliberately. Also returns null if the browser refuses
     * the microphone, which is the child's or parent's second chance to say no.
     *
     * Nothing leaves the machine. The audio is written next to the record on disk.
     */
    listen: function (opts) {
      opts = opts || {};
      if (!cfg.audio_capture) {
        console.info('[primer] audio capture is off for this install; not recording');
        return Promise.resolve(null);
      }
      if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
        return Promise.resolve(null);
      }

      return navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(function (stream) {
          var chunks = [];
          var recorder = new MediaRecorder(stream);
          var startedAt = Date.now();
          recorder.ondataavailable = function (e) {
            if (e.data && e.data.size) chunks.push(e.data);
          };
          recorder.start();

          // The caller gets a stop function rather than a duration, so the page can
          // end the recording when the child stops reading instead of cutting them off.
          return function stop() {
            return new Promise(function (resolve) {
              recorder.onstop = function () {
                stream.getTracks().forEach(function (t) { t.stop(); });
                var blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
                var url =
                  cfg.api +
                  '/api/artifact?learner_id=' + encodeURIComponent(cfg.learner_id) +
                  '&session_id=' + encodeURIComponent(cfg.session_id || '') +
                  '&kind=audio' +
                  '&duration_ms=' + (Date.now() - startedAt) +
                  '&prompt=' + encodeURIComponent(opts.prompt || '') +
                  '&skills=' + encodeURIComponent((opts.skills || (opts.skill ? [opts.skill] : [])).join(','));
                var audioHeaders = { 'content-type': blob.type };
                if (token) audioHeaders['x-primer-token'] = token;
                fetch(url, {
                  method: 'POST',
                  headers: audioHeaders,
                  body: blob,
                })
                  .then(function (r) { return r.json(); })
                  .then(resolve)
                  .catch(function () { resolve(null); });
              };
              recorder.stop();
            });
          };
        })
        .catch(function () {
          // Permission denied, or no microphone. Not an error worth interrupting a
          // child over — the activity continues without audio.
          return null;
        });
    },

    /** Is recording available right now? Lets a page hide its own record button. */
    canListen: function () {
      return Boolean(cfg.audio_capture && navigator.mediaDevices && typeof MediaRecorder !== 'undefined');
    },

    /**
     * What this device can actually do.
     *
     * A browser only exposes the microphone and service workers in a "secure
     * context" — HTTPS, or localhost. A LAN address over plain HTTP is neither, so
     * on a tablet `navigator.mediaDevices` is simply undefined and every recording
     * call quietly does nothing. That silence is the problem: a parent switches
     * audio on, nothing happens, and there is no error anywhere to explain it.
     * The page reports this once so an adult can be told the truth.
     */
    capabilities: function () {
      return {
        secure_context: Boolean(window.isSecureContext),
        microphone: Boolean(navigator.mediaDevices && typeof MediaRecorder !== 'undefined'),
        offline_cache: 'serviceWorker' in navigator,
        durable_queue: (function () {
          try {
            localStorage.setItem('primer_probe', '1');
            localStorage.removeItem('primer_probe');
            return true;
          } catch (e) {
            return false;
          }
        })(),
      };
    },

    flush: function () {
      return flush(false);
    },

    elapsed_ms: function () {
      return Date.now() - startedAt;
    },
  };

  // Anything left over from a session that ended badly goes first.
  if (queue.length) flush(false);

  // Tell the record what this device can do, once, so a parent can be told plainly
  // rather than wondering why the microphone setting appears to do nothing.
  (function reportCapabilities() {
    var caps = primer.capabilities();
    if (cfg.audio_capture && !caps.microphone) {
      post('/api/device', {
        learner_id: cfg.learner_id,
        capabilities: caps,
        note: 'audio is on but this device cannot record: not a secure context',
      });
    }
  })();

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.addEventListener('pagehide', function () {
    flush(true);
  });

  window.primer = primer;
})();
