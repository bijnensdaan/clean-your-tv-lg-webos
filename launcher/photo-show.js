/* Idle photo show on Home. Two <img> layers crossfade; at most two blob URLs live at once. */
(function (root) {
  'use strict';
  var IDLE_MS = 60000,
    FADE_MS = 1200,
    // Small anti burn-in offsets (px), one per photo, cycling.
    OFFSETS = [
      [0, 0],
      [12, -8],
      [-12, 8],
      [16, 10],
      [-16, -10],
      [8, 14],
      [-8, -14]
    ],
    HOME_ZONES = ['grid', 'top', 'shelf'],
    idleMs = IDLE_MS,
    // Test-only override of seconds per photo (ms); null uses the setting.
    slideMs = null,
    switches = 0,
    idleTimer = null,
    slideTimer = null,
    cleanupTimer = null,
    running = false,
    starting = false,
    generation = 0,
    overlay = null,
    layers = [],
    // Per layer: { id, url, ready }.
    slots = [null, null],
    front = 0,
    order = [],
    index = 0,
    seconds = 10,
    shownAt = 0,
    step = 0,
    focused = true,
    swallowKey = null,
    swallowKeyTimer = null,
    failures = 0,
    swallowPointer = false,
    swallowPointerTimer = null,
    pointerX = null,
    pointerY = null;

  function store() {
    return root.PhotoShowStore || null;
  }
  function style(el, name, value) {
    var prefixed = 'webkit' + name.charAt(0).toUpperCase() + name.slice(1);
    if (prefixed in el.style) el.style[prefixed] = value;
    el.style[name] = value;
  }
  function build() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'photoShowOverlay';
    overlay.className = 'photo-show';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;' +
      'background:#000;z-index:200000;overflow:hidden;cursor:none;display:none';
    for (var i = 0; i < 2; i++) {
      var img = document.createElement('img');
      img.className = 'photo-show-layer';
      img.alt = '';
      img.style.cssText =
        'position:absolute;top:0;left:0;width:100%;height:100%;' +
        'object-fit:contain;opacity:0;border:0';
      style(img, 'transition', 'opacity ' + FADE_MS + 'ms ease-in-out');
      overlay.appendChild(img);
      layers.push(img);
    }
    document.body.appendChild(overlay);
  }
  function rendered() {
    return root.RootLauncherRendered === true;
  }
  function overlayOpen() {
    var panels = [
      root.RenewalPanel,
      root.HomeLayoutPanel,
      root.HomeThemePanel,
      root.SystemUpdates
    ];
    for (var i = 0; i < panels.length; i++) {
      try {
        if (panels[i] && panels[i].isOpen && panels[i].isOpen()) return true;
      } catch (_) {}
    }
    return false;
  }
  // Home is the active view: rendered, visible, focused and not in any mode or panel.
  function homeActive() {
    if (!rendered() || document.hidden || !focused || overlayOpen())
      return false;
    var state = root.HomeIdleState && root.HomeIdleState();
    if (!state || !state.focused || state.busy) return false;
    return HOME_ZONES.indexOf(state.zone) >= 0;
  }
  function arm() {
    root.clearTimeout(idleTimer);
    idleTimer = null;
    if (running || starting || document.hidden) return;
    idleTimer = root.setTimeout(onIdle, idleMs);
  }
  function onIdle() {
    idleTimer = null;
    if (!homeActive()) return arm();
    begin(false).then(function (started) {
      if (!started) arm();
    });
  }
  function load(slot, id) {
    var token = generation,
      s = store();
    slots[slot] = { id: id, url: null, ready: false, failed: false };
    var entry = slots[slot];
    return s
      .get(id)
      .then(function (record) {
        if (token !== generation || slots[slot] !== entry) return false;
        if (!record || !record.blob) throw Error('missing');
        entry.url = root.URL.createObjectURL(record.blob);
        return new Promise(function (resolve) {
          var img = layers[slot];
          img.onload = function () {
            img.onload = img.onerror = null;
            resolve(true);
          };
          img.onerror = function () {
            img.onload = img.onerror = null;
            resolve(false);
          };
          img.src = entry.url;
        });
      })
      .then(
        function (ok) {
          if (slots[slot] !== entry) return false;
          entry.ready = !!ok;
          entry.failed = !ok;
          return !!ok;
        },
        function () {
          if (slots[slot] === entry) entry.failed = true;
          return false;
        }
      );
  }
  function clearSlot(slot) {
    var entry = slots[slot],
      img = layers[slot];
    slots[slot] = null;
    if (img) {
      img.onload = img.onerror = null;
      img.removeAttribute('src');
      img.style.opacity = '0';
    }
    if (entry && entry.url) root.URL.revokeObjectURL(entry.url);
  }
  function place(slot) {
    var offset = OFFSETS[step % OFFSETS.length];
    step++;
    style(
      layers[slot],
      'transform',
      'translate(' + offset[0] + 'px,' + offset[1] + 'px)'
    );
  }
  function nextIndex() {
    return order.length ? (index + 1) % order.length : 0;
  }
  // Fill the hidden layer with the next photo while the current one shows.
  function preload() {
    var back = 1 - front;
    if (order.length < 2) return;
    var id = order[nextIndex()];
    if (slots[back] && slots[back].id === id && !slots[back].failed) return;
    clearSlot(back);
    load(back, id).then(function (ok) {
      if (!running) return;
      if (!ok && slots[back] && slots[back].id === id) {
        // Skip an unreadable photo; give up after one failed pass.
        clearSlot(back);
        index = nextIndex();
        if (++failures < order.length) root.setTimeout(preload, 0);
        return;
      }
      if (ok) failures = 0;
      if (ok && !slideTimer) schedule();
    });
  }
  function schedule() {
    root.clearTimeout(slideTimer);
    slideTimer = null;
    if (!running || order.length < 2) return;
    var wait = Math.max(
      0,
      shownAt + (slideMs !== null ? slideMs : seconds * 1000) - Date.now()
    );
    slideTimer = root.setTimeout(advance, wait);
  }
  function advance() {
    slideTimer = null;
    if (!running) return;
    var back = 1 - front,
      entry = slots[back];
    // Wait for the preload; it reschedules when ready.
    if (!entry || !entry.ready || entry.id !== order[nextIndex()]) {
      preload();
      return;
    }
    var old = front;
    place(back);
    layers[back].style.opacity = '1';
    layers[old].style.opacity = '0';
    front = back;
    index = nextIndex();
    shownAt = Date.now();
    switches++;
    root.clearTimeout(cleanupTimer);
    cleanupTimer = root.setTimeout(function () {
      cleanupTimer = null;
      if (!running) return;
      clearSlot(old);
      preload();
    }, FADE_MS + 50);
    schedule();
  }
  function begin(force) {
    var s = store();
    if (running || starting || !s) return Promise.resolve(running);
    starting = true;
    var token = ++generation;
    return Promise.all([s.settings(), s.list()])
      .then(function (values) {
        starting = false;
        var settings = values[0],
          items = values[1];
        if (token !== generation) return false;
        if (!settings.enabled || !items.length) return false;
        if (!force && !homeActive()) return false;
        build();
        seconds = settings.seconds;
        order = items.map(function (item) {
          return item.id;
        });
        index = 0;
        front = 0;
        failures = 0;
        running = true;
        root.clearTimeout(idleTimer);
        idleTimer = null;
        return load(0, order[0]).then(function (ok) {
          if (!running || token !== generation) return false;
          if (!ok && order.length < 2) {
            stop();
            return false;
          }
          overlay.style.display = 'block';
          document.body.classList.add('photo-show-active');
          place(0);
          // Force a style flush so the first fade-in transitions.
          void layers[0].offsetWidth;
          layers[0].style.opacity = ok ? '1' : '0';
          shownAt = Date.now();
          preload();
          return true;
        });
      })
      .catch(function () {
        starting = false;
        if (token === generation && running) stop();
        return false;
      });
  }
  function stop() {
    var was = running || starting;
    generation++;
    running = false;
    starting = false;
    root.clearTimeout(slideTimer);
    root.clearTimeout(cleanupTimer);
    slideTimer = cleanupTimer = null;
    clearSlot(0);
    clearSlot(1);
    if (overlay) overlay.style.display = 'none';
    if (document.body) document.body.classList.remove('photo-show-active');
    arm();
    return was;
  }
  // Store changes: keep running with the new order/seconds, or stop if invalid.
  function revalidate() {
    var s = store();
    if (!s) return;
    if (!running) {
      if (!starting) arm();
      return;
    }
    var token = generation;
    Promise.all([s.settings(), s.list()]).then(
      function (values) {
        if (!running || token !== generation) return;
        var settings = values[0],
          items = values[1];
        if (!settings.enabled || !items.length) return stop();
        var current = slots[front] && slots[front].id;
        order = items.map(function (item) {
          return item.id;
        });
        var at = order.indexOf(current);
        if (at < 0) {
          // The visible photo was deleted: restart from the top.
          stop();
          begin(true);
          return;
        }
        index = at;
        if (settings.seconds !== seconds) {
          seconds = settings.seconds;
          shownAt = Date.now();
        }
        schedule();
        preload();
      },
      function () {}
    );
  }
  function releasePointerLater() {
    root.clearTimeout(swallowPointerTimer);
    swallowPointerTimer = root.setTimeout(function () {
      swallowPointer = false;
    }, 800);
  }
  function swallow(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }
  // The key that stopped the show (and its auto-repeat) is swallowed until keyup;
  // the timer covers a keyup that never arrives.
  function holdKey(code) {
    swallowKey = code;
    root.clearTimeout(swallowKeyTimer);
    swallowKeyTimer = root.setTimeout(function () {
      swallowKey = null;
    }, 1500);
  }
  function onKeyDown(event) {
    if (running || starting) {
      swallow(event);
      holdKey(event.keyCode);
      stop();
      return;
    }
    if (swallowKey !== null && event.keyCode === swallowKey) {
      swallow(event);
      holdKey(event.keyCode);
      return;
    }
    swallowKey = null;
    arm();
  }
  function onKeyUp(event) {
    if (running || starting) {
      swallow(event);
      return;
    }
    if (swallowKey !== null && event.keyCode === swallowKey) {
      swallowKey = null;
      swallow(event);
      return;
    }
    arm();
  }
  function onKeyPress(event) {
    if (running || starting || swallowKey !== null) swallow(event);
  }
  function onPointerMove(event) {
    // Mouse and pointer events may round the same position differently.
    var first = pointerX === null,
      moved =
        !first &&
        Math.abs(event.clientX - pointerX) +
          Math.abs(event.clientY - pointerY) >
          2;
    // The anchor only moves on real movement, so slow drift still adds up.
    if (first || moved) {
      pointerX = event.clientX;
      pointerY = event.clientY;
    }
    if (running || starting) {
      swallow(event);
      // A synthetic move at an unchanged position (overlay shown) is not input.
      if (moved) stop();
      return;
    }
    if (moved || first) arm();
  }
  function onPointerPress(event) {
    if (running || starting) {
      swallow(event);
      swallowPointer = true;
      releasePointerLater();
      stop();
      return;
    }
    if (swallowPointer) {
      swallow(event);
      if (event.type === 'click') swallowPointer = false;
      return;
    }
    arm();
  }
  function listen() {
    var options = true;
    root.addEventListener('keydown', onKeyDown, options);
    root.addEventListener('keyup', onKeyUp, options);
    root.addEventListener('keypress', onKeyPress, options);
    root.addEventListener('mousemove', onPointerMove, options);
    root.addEventListener('pointermove', onPointerMove, options);
    [
      'mousedown',
      'mouseup',
      'click',
      'pointerdown',
      'pointerup',
      'wheel',
      'mousewheel',
      'touchstart'
    ].forEach(function (type) {
      root.addEventListener(type, onPointerPress, options);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        stop();
        root.clearTimeout(idleTimer);
        idleTimer = null;
      } else arm();
    });
    root.addEventListener('blur', function () {
      focused = false;
      stop();
    });
    root.addEventListener('focus', function () {
      focused = true;
      arm();
    });
    document.addEventListener('photo-show-change', revalidate);
    arm();
  }

  root.PhotoShow = {
    start: function () {
      return begin(true);
    },
    stop: function () {
      return stop();
    },
    isRunning: function () {
      return running;
    },
    // configure({ idleMs, slideMs }) shortens timings for the preview and tests.
    configure: function (options) {
      if (options && typeof options.idleMs === 'number' && options.idleMs > 0)
        idleMs = options.idleMs;
      if (options && 'slideMs' in options) {
        slideMs =
          typeof options.slideMs === 'number' && options.slideMs > 0
            ? options.slideMs
            : null;
        if (running) schedule();
      }
      arm();
      return { idleMs: idleMs, slideMs: slideMs };
    },
    state: function () {
      return {
        running: running,
        index: index,
        id: (slots[front] && slots[front].id) || null,
        seconds: seconds,
        switches: switches
      };
    },
    homeActive: homeActive
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', listen);
  else listen();
})(this);
