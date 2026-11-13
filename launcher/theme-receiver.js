/* Temporary edition-owned LS2 receiver. PINs exist only in the active view. */
(function (root) {
  'use strict';
  var limit = ThemePolicy.limits.envelopeBytes,
    chunkLimit = 48 * 1024;
  function service() {
    return (
      'luna://' +
      (document.querySelector('script[src="root-settings.js"]')
        ? 'com.cleanyourtv.root.preview.service'
        : 'com.gathin.tvhome.renewal') +
      '/'
    );
  }
  var UNAVAILABLE =
    'Theme receiver unavailable. Update Home and its service, then try again.';
  // Messages stay translatable; errorCode/errorText carry the exact cause.
  function failure(message, code, text) {
    var error = Error(message);
    error.errorCode = code;
    error.errorText = text || '';
    return error;
  }
  function rpc(method, payload, signal) {
    return new Promise(function (resolve, reject) {
      var bridge,
        done = false,
        wait = method === 'themeReceiverStart' ? 10000 : 5000,
        timer = setTimeout(function () {
          finish(
            failure(
              UNAVAILABLE,
              'timeout',
              method + ' did not answer within ' + wait / 1000 + ' s'
            )
          );
        }, wait);
      function finish(error, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (bridge && !(error && method === 'themeReceiverStart'))
          try {
            bridge.cancel();
          } catch (_) {}
        if (error) reject(error);
        else resolve(value);
      }
      try {
        bridge = new root.PalmServiceBridge();
        bridge.onservicecallback = function (raw) {
          var response;
          try {
            response = JSON.parse(raw);
          } catch (_) {
            finish(
              failure(
                'Invalid theme receiver response',
                'invalid-response',
                method + ' returned non-JSON'
              )
            );
            return;
          }
          if (
            method === 'themeReceiverStart' &&
            (done || (signal && signal.cancelled)) &&
            response &&
            response.returnValue === true &&
            typeof response.sessionId === 'string'
          ) {
            stop(response.sessionId);
            try {
              bridge.cancel();
            } catch (_) {}
            finish(Error('Cancelled'));
            return;
          }
          if (signal && signal.cancelled) {
            finish(Error('Cancelled'));
            return;
          }
          if (!response || response.returnValue !== true) {
            finish(
              failure(
                UNAVAILABLE,
                (response &&
                  (response.errorCode !== undefined
                    ? String(response.errorCode)
                    : response.errorText && String(response.errorText))) ||
                  'service-error',
                response && response.errorText !== undefined
                  ? String(response.errorText)
                  : method + ' failed'
              )
            );
            return;
          }
          finish(null, response);
        };
        bridge.call(service() + method, JSON.stringify(payload));
      } catch (e) {
        finish(
          failure(
            UNAVAILABLE,
            'bridge-unavailable',
            (e && e.message) || 'PalmServiceBridge call failed'
          )
        );
      }
    });
  }
  function stop(id) {
    return rpc('themeReceiverStop', { sessionId: id }).catch(function () {});
  }
  function privateAddress(value) {
    var p = typeof value === 'string' && value.split('.');
    return (
      p &&
      p.length === 4 &&
      p.every(function (v) {
        return /^(0|[1-9][0-9]{0,2})$/.test(v) && +v <= 255;
      }) &&
      (+p[0] === 10 ||
        (+p[0] === 192 && +p[1] === 168) ||
        (+p[0] === 172 && +p[1] >= 16 && +p[1] <= 31))
    );
  }
  function start(signal, kind, options) {
    var request = {};
    if (kind === 'wallpaper') request = { kind: 'wallpaper' };
    else if (kind === 'photos') {
      // Photos: one QR session accepts several phone images in turn.
      request = { kind: 'photos' };
      if (options && Number.isInteger(options.limit))
        request.limit = options.limit;
    }
    return rpc('themeReceiverStart', request, signal).then(function (s) {
      if (
        kind === 'photos' &&
        (s.kind !== 'photos' ||
          s.photoProtocol !== 1 ||
          !Number.isInteger(s.photoLimit) ||
          s.photoLimit < 1)
      ) {
        if (typeof s.sessionId === 'string') stop(s.sessionId);
        throw failure(
          'Photo receiver unavailable. Update Home and its service.',
          'photo-protocol',
          'Service answered kind ' +
            s.kind +
            ', photoProtocol ' +
            s.photoProtocol +
            ', photoLimit ' +
            s.photoLimit
        );
      }
      if (
        kind === 'wallpaper' &&
        (s.kind !== 'wallpaper' || s.wallpaperProtocol !== 1)
      ) {
        if (typeof s.sessionId === 'string') stop(s.sessionId);
        throw Error(
          'Wallpaper receiver unavailable. Update Home and its service.'
        );
      }
      if (
        typeof s.sessionId !== 'string' ||
        !s.sessionId ||
        s.sessionId.length > 200 ||
        !/^\d{6}$/.test(s.pin) ||
        !Array.isArray(s.addresses) ||
        !s.addresses.length ||
        s.addresses.length > 32 ||
        !s.addresses.every(privateAddress) ||
        s.port !== 8879 ||
        typeof s.expiresAt !== 'number' ||
        s.expiresAt <= Date.now() ||
        s.expiresAt > Date.now() + 610000
      ) {
        if (typeof s.sessionId === 'string') stop(s.sessionId);
        throw failure(
          'Invalid theme receiver response',
          'invalid-session-response',
          'Start answer failed validation (addresses ' +
            JSON.stringify(s.addresses) +
            ', port ' +
            s.port +
            ', expiresAt in ' +
            Math.round((s.expiresAt - Date.now()) / 1000) +
            ' s)'
        );
      }
      return s;
    });
  }
  function status(id, signal) {
    return rpc('themeReceiverStatus', { sessionId: id }, signal).then(
      function (s) {
        if (['waiting', 'receiving', 'received'].indexOf(s.state) < 0)
          throw failure(
            'Theme receiver session expired. Try again.',
            'session-state',
            'Receiver state ' + s.state
          );
        if (
          s.state === 'received' &&
          (!Number.isInteger(s.size) || s.size <= 0 || s.size > limit)
        )
          throw failure(
            'Invalid received theme size',
            'invalid-size',
            'Received size ' + s.size
          );
        return s;
      }
    );
  }
  function read(id, size, signal) {
    if (!Number.isInteger(size) || size <= 0 || size > limit)
      return Promise.reject(
        failure('Invalid received theme size', 'invalid-size', 'Size ' + size)
      );
    var bytes = new Uint8Array(size),
      offset = 0;
    function next() {
      if (signal && signal.cancelled) throw Error('Cancelled');
      return rpc(
        'themeReceiverRead',
        { sessionId: id, offset: offset },
        signal
      ).then(function (part) {
        if (
          part.offset !== offset ||
          typeof part.data !== 'string' ||
          part.data.length > 4 * Math.ceil(chunkLimit / 3) ||
          part.data.length % 4 !== 0 ||
          /[^A-Za-z0-9+/=]/.test(part.data) ||
          /=[^=]|={3}/.test(part.data)
        )
          throw failure(
            'Invalid received theme chunk',
            'invalid-chunk',
            'Chunk at offset ' + offset
          );
        var raw = atob(part.data),
          end = offset + raw.length;
        if (
          !raw.length ||
          raw.length > chunkLimit ||
          end > size ||
          part.nextOffset !== end ||
          part.done !== (end === size)
        )
          throw failure(
            'Invalid received theme chunk',
            'invalid-chunk',
            'Chunk at offset ' + offset
          );
        for (var i = 0; i < raw.length; i++)
          bytes[offset + i] = raw.charCodeAt(i);
        offset = end;
        if (!part.done) return next();
        if (signal && signal.cancelled) throw Error('Cancelled');
        return JSON.parse(root.ThemeData.decode(bytes));
      });
    }
    return Promise.resolve().then(next);
  }
  root.ThemeReceiver = { start: start, status: status, read: read, stop: stop };
})(this);
