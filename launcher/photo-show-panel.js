/* Trusted settings for the idle photo show. Thumbnail object URLs are owned and revoked here. */
(function (root) {
  'use strict';
  var locales = {
    nl: {
      'Photo show': 'Fotoshow',
      'Photo show: On': 'Fotoshow: aan',
      'Photo show: Off': 'Fotoshow: uit',
      'Seconds per photo: {n}': 'Seconden per foto: {n}',
      '{n} / {max} photos': '{n} / {max} foto’s',
      'Photo {n}': 'Foto {n}',
      'Move up': 'Omhoog',
      'Move down': 'Omlaag',
      'Delete': 'Verwijderen',
      'Delete all': 'Alles verwijderen',
      'Delete all photos': 'Alle foto’s verwijderen',
      'Delete all photos from the photo show? This cannot be undone.':
        'Alle foto’s uit de fotoshow verwijderen? Dit kan niet ongedaan worden gemaakt.',
      'Press again to delete all': 'Druk nogmaals om alles te verwijderen',
      'Add photos from phone': 'Foto’s toevoegen via telefoon',
      'No photos yet. Use “Add photos from phone” to add some.':
        'Nog geen foto’s. Gebruik “Foto’s toevoegen via telefoon” om foto’s toe te voegen.',
      'Photo limit reached. Delete photos to add new ones.':
        'Maximum aantal foto’s bereikt. Verwijder foto’s om nieuwe toe te voegen.',
      'Photo storage is almost full.': 'De fotoopslag is bijna vol.',
      'Could not change photo show settings.':
        'Kon de instellingen van de fotoshow niet wijzigen.',
      'Done': 'Klaar',
      'Scan the QR code with your phone, or open:':
        'Scan de QR-code met je telefoon, of open:',
      'Waiting for photos… {n} received': 'Wachten op foto’s… {n} ontvangen',
      '1 photo added.': '1 foto toegevoegd.',
      '{n} photos added.': '{n} foto’s toegevoegd.',
      '{n} could not be added.': '{n} konden niet worden toegevoegd.',
      'Photo receiver stopped. Try again.':
        'Fotos ontvangen is gestopt. Probeer het opnieuw.'
    }
  };
  var panel,
    toggle,
    seconds,
    countText,
    warning,
    status,
    empty,
    addButton,
    listHost,
    clearButton,
    connection,
    qr,
    addressText,
    pinText,
    doneButton,
    receiver = null,
    receiverSignal = null,
    receiverTimer = null,
    receiverGeneration = 0,
    received = 0,
    rejected = 0,
    urls = [],
    active = false,
    current = { enabled: true, seconds: 10 },
    armed = false,
    armTimer = null,
    generation = 0;
  function t(source, values) {
    var language = root.HomeI18n && root.HomeI18n.language(),
      strings = locales[language],
      text =
        (strings && strings[source]) ||
        (root.HomeWallpaperPanel
          ? root.HomeWallpaperPanel.t(source)
          : root.HomeI18n
            ? root.HomeI18n.t(source)
            : source);
    return text.replace(/\{([a-z]+)\}/g, function (all, key) {
      return values && values[key] !== undefined ? String(values[key]) : all;
    });
  }
  function node(tag, parent, id, className) {
    var el = document.createElement(tag);
    if (id) el.id = id;
    if (className) el.className = className;
    parent.appendChild(el);
    return el;
  }
  function button(parent, id, action) {
    var el = node('button', parent, id);
    el.type = 'button';
    el.onclick = action;
    return el;
  }
  function store() {
    return root.PhotoShowStore;
  }
  function fail(error) {
    if (!status) return;
    status.textContent =
      error && error.code === 'storage-full'
        ? error.message
        : t('Could not change photo show settings.');
  }
  function run(promise) {
    return Promise.resolve(promise).then(function () {
      if (status) status.textContent = '';
    }, fail);
  }
  function revoke() {
    urls.forEach(function (url) {
      root.URL.revokeObjectURL(url);
    });
    urls = [];
  }
  function disarm() {
    armed = false;
    root.clearTimeout(armTimer);
    armTimer = null;
  }
  function labels() {
    toggle.textContent = t(
      current.enabled ? 'Photo show: On' : 'Photo show: Off'
    );
    toggle.setAttribute('aria-pressed', String(current.enabled));
    seconds.textContent = t('Seconds per photo: {n}', { n: current.seconds });
    addButton.textContent = t('Add photos from phone');
    if (doneButton) doneButton.textContent = t('Done');
    clearButton.textContent = t(
      armed ? 'Press again to delete all' : 'Delete all'
    );
  }
  function focusKey() {
    var el = document.activeElement;
    if (!panel || !panel.contains(el)) return null;
    return {
      el: el,
      id: el.getAttribute('data-photo-id'),
      action: el.getAttribute('data-photo-action'),
      index: Number(el.getAttribute('data-photo-index'))
    };
  }
  function row(item, index, total) {
    var li = node('li', listHost, null, 'photo-show-row'),
      url = item.thumb ? root.URL.createObjectURL(item.thumb) : '';
    li.setAttribute('data-photo-id', item.id);
    if (url) urls.push(url);
    var img = node('img', li, null, 'photo-show-thumb');
    img.alt = '';
    if (url) img.src = url;
    var label = node('span', li, null, 'photo-show-label');
    label.textContent =
      t('Photo {n}', { n: index + 1 }) +
      ' · ' +
      item.width +
      ' × ' +
      item.height;
    [
      ['up', 'Move up', -1],
      ['down', 'Move down', 1],
      ['delete', 'Delete', 0]
    ].forEach(function (spec) {
      var el = button(li, null, function () {
        if (el.getAttribute('aria-disabled') === 'true') return;
        disarm();
        run(
          spec[0] === 'delete'
            ? store().remove(item.id)
            : store().move(item.id, spec[2])
        );
      });
      el.textContent = t(spec[1]);
      el.setAttribute('data-photo-action', spec[0]);
      el.setAttribute('data-photo-id', item.id);
      el.setAttribute('data-photo-index', String(index));
      // Edge moves stay focusable so remote columns line up; the store clamps.
      if (
        (spec[0] === 'up' && index === 0) ||
        (spec[0] === 'down' && index === total - 1)
      )
        el.setAttribute('aria-disabled', 'true');
    });
  }
  function restoreFocus(before) {
    if (!before) return;
    var el = before.el;
    if (document.body.contains(el) && !el.disabled && panel.contains(el)) {
      el.focus();
      return;
    }
    var buttons = Array.prototype.slice.call(
        listHost.querySelectorAll('button')
      ),
      enabled = buttons.filter(function (b) {
        return !b.disabled;
      }),
      target = null;
    if (before.id && before.action) {
      // A moved photo keeps focus; at the list edge use its other move button.
      enabled.forEach(function (b) {
        if (target || b.getAttribute('data-photo-id') !== before.id) return;
        if (b.getAttribute('data-photo-action') === before.action) target = b;
      });
      if (!target)
        enabled.forEach(function (b) {
          if (!target && b.getAttribute('data-photo-id') === before.id)
            target = b;
        });
      if (!target && before.action === 'delete') {
        var rows = listHost.children,
          at = Math.min(before.index, rows.length - 1);
        if (at >= 0)
          target = rows[at].querySelector('[data-photo-action="delete"]');
      }
    }
    if (!target) target = clearButton.disabled ? toggle : clearButton;
    if (target) target.focus();
  }
  function render(items, use) {
    var before = focusKey();
    revoke();
    while (listHost.firstChild) listHost.removeChild(listHost.firstChild);
    items.forEach(function (item, index) {
      row(item, index, items.length);
    });
    countText.textContent = t('{n} / {max} photos', {
      n: use.count,
      max: use.max
    });
    warning.hidden = !use.nearFull && use.count < use.max;
    warning.textContent =
      use.count >= use.max
        ? t('Photo limit reached. Delete photos to add new ones.')
        : t('Photo storage is almost full.');
    empty.hidden = items.length > 0;
    empty.textContent = t(
      'No photos yet. Use “Add photos from phone” to add some.'
    );
    listHost.hidden = !items.length;
    clearButton.disabled = !items.length;
    addButton.disabled = receiving() || use.count >= use.max;
    if (!items.length) disarm();
    labels();
    restoreFocus(before);
  }
  function refresh() {
    if (!panel || !store()) return Promise.resolve();
    var token = ++generation;
    labels();
    return Promise.all([store().list(), store().usage(), store().settings()])
      .then(function (values) {
        if (token !== generation || !panel) return;
        current = values[2];
        render(values[0], values[1]);
      })
      .catch(function (error) {
        if (token === generation) fail(error);
      });
  }
  function cycleSeconds() {
    var options = store().SECONDS,
      at = options.indexOf(current.seconds);
    return options[(at + 1) % options.length];
  }
  function clearAll() {
    disarm();
    run(store().clear());
  }
  function receiving() {
    return !!receiverSignal;
  }
  function summary() {
    var text =
      received === 1
        ? t('1 photo added.')
        : t('{n} photos added.', { n: received });
    if (rejected) text += ' ' + t('{n} could not be added.', { n: rejected });
    return text;
  }
  // Ends the phone session; the summary or a store error stays visible.
  function stopReceiver(message) {
    receiverGeneration++;
    root.clearTimeout(receiverTimer);
    receiverTimer = null;
    if (receiverSignal) receiverSignal.cancelled = true;
    receiverSignal = null;
    var old = receiver;
    receiver = null;
    if (old && root.ThemeReceiver) root.ThemeReceiver.stop(old.sessionId);
    if (addButton) addButton.disabled = false;
    if (connection && !connection.hidden) {
      var focused = panel.contains(document.activeElement);
      connection.hidden = true;
      if (focused) addButton.focus();
    }
    if (status && message !== undefined) status.textContent = message;
  }
  function decodePhoto(envelope) {
    var image = envelope && envelope.image;
    if (
      !envelope ||
      envelope.schemaVersion !== 1 ||
      envelope.kind !== 'wallpaper' ||
      !image ||
      ['image/jpeg', 'image/png'].indexOf(image.mediaType) < 0 ||
      typeof image.data !== 'string' ||
      !Number.isInteger(image.size) ||
      image.data.length !== 4 * Math.ceil(image.size / 3) ||
      /[^A-Za-z0-9+/=]/.test(image.data)
    )
      throw Error('Invalid photo');
    var raw = root.atob(image.data);
    if (raw.length !== image.size) throw Error('Invalid photo');
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    if (
      root.ThemeData &&
      root.ThemeData.hash &&
      root.ThemeData.hash(bytes) !== image.sha256
    )
      throw Error('Invalid photo');
    return {
      blob: new root.Blob([bytes], { type: image.mediaType }),
      width: image.width,
      height: image.height
    };
  }
  function receive() {
    if (receiving() || !store()) return;
    stopReceiver();
    var token = receiverGeneration,
      signal = { cancelled: false };
    receiverSignal = signal;
    received = rejected = 0;
    addButton.disabled = true;
    function live() {
      return (
        token === receiverGeneration &&
        active &&
        !signal.cancelled &&
        !document.hidden
      );
    }
    function waiting() {
      status.textContent = t('Waiting for photos… {n} received', {
        n: received
      });
    }
    function fail(error) {
      if (!live()) return;
      var code = error && error.code;
      stopReceiver(
        code === 'limit'
          ? summary() +
              ' ' +
              t('Photo limit reached. Delete photos to add new ones.')
          : code === 'storage-full'
            ? summary() + ' ' + error.message
            : received
              ? summary() + ' ' + t('Photo receiver stopped. Try again.')
              : t('Photo receiver stopped. Try again.')
      );
      refresh();
    }
    function poll() {
      if (!live() || !receiver) return;
      var session = receiver;
      if (Date.now() >= session.expiresAt) {
        fail();
        return;
      }
      root.ThemeReceiver.status(session.sessionId, signal)
        .then(function (value) {
          if (!live()) return;
          if (typeof value.expiresAt === 'number')
            session.expiresAt = value.expiresAt;
          if (value.state !== 'received') {
            if (value.state === 'waiting' && value.remaining === 0) {
              stopReceiver(summary());
              refresh();
              return;
            }
            receiverTimer = root.setTimeout(poll, 500);
            return;
          }
          return root.ThemeReceiver.read(session.sessionId, value.size, signal)
            .then(function (envelope) {
              if (!live()) throw Error('Cancelled');
              var photo;
              try {
                photo = decodePhoto(envelope);
              } catch (_) {
                rejected++;
                return;
              }
              return store()
                .add(photo)
                .then(
                  function () {
                    received++;
                  },
                  function (error) {
                    var code = error && error.code;
                    if (code === 'limit' || code === 'storage-full')
                      throw error;
                    rejected++;
                  }
                );
            })
            .then(function () {
              if (!live()) return;
              waiting();
              poll();
            });
        })
        .catch(fail);
    }
    if (!root.ThemeReceiver) {
      fail();
      return;
    }
    store()
      .usage()
      .then(function (use) {
        if (!live()) return;
        if (use.count >= use.max) {
          stopReceiver(
            t('Photo limit reached. Delete photos to add new ones.')
          );
          refresh();
          return;
        }
        return root.ThemeReceiver.start(signal, 'photos', {
          limit: use.max - use.count
        }).then(function (session) {
          if (!live()) {
            root.ThemeReceiver.stop(session.sessionId);
            return;
          }
          receiver = session;
          var url = 'http://' + session.addresses[0] + ':8879/wallpaper';
          connection.hidden = false;
          addressText.textContent =
            t('Scan the QR code with your phone, or open:') +
            ' ' +
            session.addresses
              .map(function (address) {
                return 'http://' + address + ':8879/wallpaper';
              })
              .join(' · ');
          pinText.textContent = 'PIN: ' + session.pin;
          if (root.WallpaperQR)
            root.WallpaperQR.render(qr, url + '#pin=' + session.pin);
          doneButton.focus();
          waiting();
          poll();
        });
      })
      .catch(fail);
  }
  function mount(host) {
    if (panel) {
      host.appendChild(panel);
      if (active) refresh();
      return;
    }
    panel = node('div', host, 'photoShowPanel');
    if (!store()) return;
    var controls = node('div', panel, null, 'photo-show-controls');
    toggle = button(controls, 'photoShowEnabled', function () {
      run(store().saveSettings({ enabled: !current.enabled }));
    });
    seconds = button(controls, 'photoShowSeconds', function () {
      run(store().saveSettings({ seconds: cycleSeconds() }));
    });
    countText = node('p', panel, 'photoShowCount');
    warning = node('p', panel, 'photoShowWarning');
    warning.setAttribute('role', 'status');
    warning.hidden = true;
    status = node('p', panel, 'photoShowStatus');
    status.setAttribute('aria-live', 'polite');
    empty = node('p', panel, 'photoShowEmpty');
    var actions = node('div', panel, null, 'photo-show-controls');
    addButton = button(actions, 'photoShowAdd', receive);
    clearButton = button(actions, 'photoShowClear', function () {
      if (root.HomeI18n && root.HomeI18n.confirm) {
        root.HomeI18n.confirm(
          {
            title: t('Delete all photos'),
            message: t(
              'Delete all photos from the photo show? This cannot be undone.'
            ),
            action: t('Delete all')
          },
          clearAll
        );
        return;
      }
      if (armed) {
        clearAll();
        return;
      }
      armed = true;
      labels();
      armTimer = root.setTimeout(function () {
        disarm();
        if (panel) labels();
      }, 4000);
    });
    connection = node('div', panel, 'photoShowConnection');
    connection.hidden = true;
    qr = node('canvas', connection, 'photoShowQR');
    qr.setAttribute('role', 'img');
    qr.setAttribute('aria-label', t('Add photos from phone'));
    addressText = node('p', connection, 'photoShowAddress');
    pinText = node('p', connection, 'photoShowPIN');
    doneButton = button(connection, 'photoShowDone', function () {
      stopReceiver(summary());
      refresh();
    });
    listHost = node('ul', panel, 'photoShowList');
    listHost.hidden = true;
    labels();
    // Thumbnails load only while the Photo show category is visible.
  }
  function unmount() {
    active = false;
    stopReceiver('');
    disarm();
    generation++;
    revoke();
    if (listHost)
      while (listHost.firstChild) listHost.removeChild(listHost.firstChild);
  }
  if (root.PhotoShowStore)
    root.PhotoShowStore.onChange(function () {
      if (panel && active) refresh();
    });
  root.addEventListener('pagehide', unmount);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && receiving()) stopReceiver('');
  });
  root.PhotoShowPanel = {
    mount: mount,
    refresh: refresh,
    t: t,
    activate: function (value) {
      if (value) {
        active = true;
        refresh();
      } else if (active) unmount();
    },
    unmount: unmount
  };
})(window);
