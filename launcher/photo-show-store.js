/* Local photo list for the idle photo show. Separate from the personal wallpaper slot. */
(function (root) {
  'use strict';
  var MAX = 50,
    NEAR = 45,
    MAX_BYTES = 2 * 1024 * 1024,
    // nearFull also triggers when known free app storage drops below this.
    LOW_FREE = 50 * 1024 * 1024,
    THUMB_W = 240,
    THUMB_H = 135,
    SECONDS = [5, 8, 10, 15, 20, 30, 60],
    TYPES = ['image/jpeg', 'image/png', 'image/webp'],
    DEFAULTS = { enabled: true, seconds: 10 },
    database = null,
    writeQueue = Promise.resolve(),
    listeners = [],
    counter = 0;

  function failure(code, message) {
    var error = Error(message);
    error.code = code;
    return error;
  }
  function emit() {
    listeners.slice().forEach(function (fn) {
      try {
        fn();
      } catch (_) {}
    });
    try {
      root.document.dispatchEvent(new root.CustomEvent('photo-show-change'));
    } catch (_) {}
  }
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var at = listeners.indexOf(fn);
      if (at >= 0) listeners.splice(at, 1);
    };
  }
  function serialized(action) {
    var result = writeQueue.then(action);
    writeQueue = result.catch(function () {});
    return result;
  }
  function open() {
    if (database) return database;
    database = new Promise(function (resolve, reject) {
      if (!root.indexedDB) {
        database = null;
        reject(Error('Photo storage unavailable'));
        return;
      }
      var done = false,
        request = root.indexedDB.open('ctv-photo-show-v1', 1),
        timer = root.setTimeout(function () {
          done = true;
          database = null;
          reject(Error('Photo storage timed out'));
        }, 8000);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains('photos'))
          db.createObjectStore('photos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      request.onsuccess = function () {
        root.clearTimeout(timer);
        var db = request.result;
        if (done) {
          db.close();
          return;
        }
        done = true;
        db.onversionchange = function () {
          db.close();
          database = null;
        };
        resolve(db);
      };
      request.onerror = request.onblocked = function () {
        if (done) return;
        done = true;
        root.clearTimeout(timer);
        database = null;
        reject(Error('Photo storage unavailable'));
      };
    });
    return database;
  }
  // action(stores, set) runs inside one transaction over photos + meta.
  function transaction(mode, action) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(['photos', 'meta'], mode),
          result,
          timer = root.setTimeout(function () {
            try {
              tx.abort();
            } catch (_) {}
          }, 8000);
        tx.oncomplete = function () {
          root.clearTimeout(timer);
          resolve(result);
        };
        tx.onabort = tx.onerror = function (event) {
          root.clearTimeout(timer);
          var cause = tx.error || (event && event.target && event.target.error);
          reject(
            cause && cause.name === 'QuotaExceededError'
              ? cause
              : Error('Could not save photos. Check available app storage.')
          );
        };
        try {
          action(
            { photos: tx.objectStore('photos'), meta: tx.objectStore('meta') },
            function (value) {
              result = value;
            }
          );
        } catch (e) {
          try {
            tx.abort();
          } catch (_) {}
          root.clearTimeout(timer);
          reject(e);
        }
      });
    });
  }
  function readOrder(stores, then) {
    var request = stores.meta.get('order');
    request.onsuccess = function () {
      var value = request.result;
      then(Array.isArray(value) ? value.slice() : []);
    };
  }
  function normalize(value) {
    var out = { enabled: DEFAULTS.enabled, seconds: DEFAULTS.seconds };
    if (value && typeof value === 'object') {
      if (typeof value.enabled === 'boolean') out.enabled = value.enabled;
      if (typeof value.seconds === 'number' && isFinite(value.seconds))
        out.seconds = clampSeconds(value.seconds);
    }
    return out;
  }
  function clampSeconds(n) {
    var best = SECONDS[0];
    for (var i = 0; i < SECONDS.length; i++)
      if (Math.abs(SECONDS[i] - n) < Math.abs(best - n)) best = SECONDS[i];
    return best;
  }
  function toBlob(canvas) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) {
        canvas.toBlob(
          function (blob) {
            resolve(blob || fromDataURL(canvas.toDataURL('image/jpeg', 0.8)));
          },
          'image/jpeg',
          0.8
        );
        return;
      }
      resolve(fromDataURL(canvas.toDataURL('image/jpeg', 0.8)));
    });
  }
  function fromDataURL(url) {
    var raw = root.atob(url.slice(url.indexOf(',') + 1)),
      bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new root.Blob([bytes], { type: 'image/jpeg' });
  }
  // Decode once at add time: dimensions plus a small letterboxed JPEG thumbnail.
  function prepare(blob) {
    return new Promise(function (resolve, reject) {
      var url = root.URL.createObjectURL(blob),
        image = new root.Image(),
        done = false,
        timer = root.setTimeout(function () {
          finish(Error('Photo decode timed out'));
        }, 10000);
      function finish(error, value) {
        if (done) return;
        done = true;
        root.clearTimeout(timer);
        image.onload = image.onerror = null;
        root.URL.revokeObjectURL(url);
        if (error) reject(failure('invalid', error.message));
        else resolve(value);
      }
      image.onload = function () {
        var w = image.naturalWidth,
          h = image.naturalHeight;
        if (!w || !h) return finish(Error('Could not decode photo'));
        try {
          var canvas = root.document.createElement('canvas'),
            ctx = canvas.getContext('2d'),
            scale = Math.min(THUMB_W / w, THUMB_H / h),
            dw = Math.max(1, Math.round(w * scale)),
            dh = Math.max(1, Math.round(h * scale));
          canvas.width = THUMB_W;
          canvas.height = THUMB_H;
          ctx.fillStyle = '#111820';
          ctx.fillRect(0, 0, THUMB_W, THUMB_H);
          ctx.drawImage(
            image,
            Math.round((THUMB_W - dw) / 2),
            Math.round((THUMB_H - dh) / 2),
            dw,
            dh
          );
          toBlob(canvas).then(function (thumb) {
            canvas.width = canvas.height = 0;
            finish(null, { width: w, height: h, thumb: thumb });
          }, finish);
        } catch (e) {
          finish(e);
        }
      };
      image.onerror = function () {
        finish(Error('Could not decode photo'));
      };
      image.src = url;
    });
  }
  function newId() {
    counter = (counter + 1) % 1296;
    return (
      'p' +
      Date.now().toString(36) +
      counter.toString(36) +
      Math.floor(Math.random() * 1679616).toString(36)
    );
  }
  function meta(record) {
    return {
      id: record.id,
      thumb: record.thumb,
      width: record.width,
      height: record.height,
      size: record.size,
      addedAt: record.addedAt
    };
  }
  function list() {
    return transaction('readonly', function (stores, set) {
      readOrder(stores, function (order) {
        var out = [],
          remaining = order.length;
        if (!remaining) return set(out);
        order.forEach(function (id, index) {
          var request = stores.photos.get(id);
          request.onsuccess = function () {
            if (request.result) out[index] = meta(request.result);
            if (--remaining === 0)
              set(
                out.filter(function (item) {
                  return !!item;
                })
              );
          };
        });
      });
    });
  }
  function get(id) {
    return transaction('readonly', function (stores, set) {
      var request = stores.photos.get(String(id));
      request.onsuccess = function () {
        set(request.result || null);
      };
    });
  }
  function count() {
    return transaction('readonly', function (stores, set) {
      readOrder(stores, function (order) {
        set(order.length);
      });
    });
  }
  function add(input) {
    var blob = input && input.blob ? input.blob : input;
    if (!blob || typeof blob.size !== 'number' || typeof blob.type !== 'string')
      return Promise.reject(failure('invalid', 'Not a photo'));
    if (TYPES.indexOf(blob.type) < 0)
      return Promise.reject(
        failure('type', 'Only JPEG, PNG or WebP photos are supported')
      );
    if (blob.size < 1 || blob.size > MAX_BYTES)
      return Promise.reject(failure('size', 'Photo is larger than 2 MiB'));
    var required = 0;
    return serialized(function () {
      return count()
        .then(function (n) {
          if (n >= MAX) throw failure('limit', 'Photo limit reached');
          return prepare(blob);
        })
        .then(function (info) {
          required = blob.size + info.thumb.size + 4096;
          return root.StorageBudget.check(required).then(function () {
            return info;
          });
        })
        .then(function (info) {
          var record = {
            id: newId(),
            blob: blob,
            thumb: info.thumb,
            width: info.width,
            height: info.height,
            size: blob.size,
            addedAt: Date.now()
          };
          return transaction('readwrite', function (stores, set) {
            readOrder(stores, function (order) {
              if (order.length >= MAX) {
                set(null);
                return;
              }
              stores.photos.put(record);
              order.push(record.id);
              stores.meta.put(order, 'order');
              set(meta(record));
            });
          }).then(function (value) {
            if (!value) throw failure('limit', 'Photo limit reached');
            return value;
          });
        })
        .catch(function (error) {
          if (error && error.name === 'QuotaExceededError')
            return root.StorageBudget.quotaFailure(error, required);
          throw error;
        });
    }).then(function (value) {
      emit();
      return value;
    });
  }
  function remove(id) {
    return serialized(function () {
      return transaction('readwrite', function (stores, set) {
        readOrder(stores, function (order) {
          var at = order.indexOf(id);
          stores.photos.delete(String(id));
          if (at >= 0) order.splice(at, 1);
          stores.meta.put(order, 'order');
          set(at >= 0);
        });
      });
    }).then(function (value) {
      emit();
      return value;
    });
  }
  function move(id, delta) {
    return serialized(function () {
      return transaction('readwrite', function (stores, set) {
        readOrder(stores, function (order) {
          var at = order.indexOf(id),
            to = Math.max(
              0,
              Math.min(order.length - 1, at + (Math.round(delta) || 0))
            );
          if (at < 0 || to === at) {
            set(at);
            return;
          }
          order.splice(at, 1);
          order.splice(to, 0, id);
          stores.meta.put(order, 'order');
          set(to);
        });
      });
    }).then(function (value) {
      emit();
      return value;
    });
  }
  function clear() {
    return serialized(function () {
      return transaction('readwrite', function (stores) {
        stores.photos.clear();
        stores.meta.put([], 'order');
      });
    }).then(function () {
      emit();
    });
  }
  function settings() {
    return transaction('readonly', function (stores, set) {
      var request = stores.meta.get('settings');
      request.onsuccess = function () {
        set(normalize(request.result));
      };
    });
  }
  function saveSettings(partial) {
    return serialized(function () {
      return transaction('readwrite', function (stores, set) {
        var request = stores.meta.get('settings');
        request.onsuccess = function () {
          var next = normalize(request.result);
          if (partial && typeof partial.enabled === 'boolean')
            next.enabled = partial.enabled;
          if (
            partial &&
            typeof partial.seconds === 'number' &&
            isFinite(partial.seconds)
          )
            next.seconds = clampSeconds(partial.seconds);
          stores.meta.put(next, 'settings');
          set(next);
        };
      });
    }).then(function (value) {
      emit();
      return value;
    });
  }
  // nearFull: 45+ photos, or the known free app storage is below 50 MiB.
  function usage() {
    return list().then(function (items) {
      var bytes = 0;
      items.forEach(function (item) {
        bytes += (item.size || 0) + ((item.thumb && item.thumb.size) || 0);
      });
      var base = {
        count: items.length,
        max: MAX,
        bytes: bytes,
        available: null,
        nearFull: items.length >= NEAR
      };
      if (!root.StorageBudget) return base;
      return root.StorageBudget.estimate(0).then(
        function (b) {
          base.available = b.available;
          if (b.available !== null && b.available < LOW_FREE)
            base.nearFull = true;
          return base;
        },
        function () {
          return base;
        }
      );
    });
  }
  root.PhotoShowStore = {
    MAX: MAX,
    SECONDS: SECONDS.slice(),
    list: list,
    get: get,
    add: add,
    remove: remove,
    move: move,
    clear: clear,
    settings: settings,
    saveSettings: saveSettings,
    usage: usage,
    onChange: onChange
  };
})(this);
