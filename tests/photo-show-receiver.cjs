'use strict';
// Shared receiver 'photos' sessions: several phone uploads with one PIN.
const assert = require('assert/strict'),
  http = require('http'),
  crypto = require('crypto'),
  fs = require('fs'),
  acorn = require('acorn');
const core = require('../theme-receiver/core');
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
  'base64'
);
const body = JSON.stringify({
  schemaVersion: 1,
  kind: 'wallpaper',
  source: 'phone',
  image: {
    mediaType: 'image/png',
    width: 1,
    height: 1,
    size: image.length,
    sha256: crypto.createHash('sha256').update(image).digest('hex'),
    data: image.toString('base64')
  },
  variants: []
});
function request(s, path, method = 'GET', content, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: s.port,
        path,
        method,
        headers: Object.assign(
          {
            Host: '127.0.0.1:' + s.port,
            'X-CYTV-PIN': s.pin,
            'Content-Type': 'application/json'
          },
          headers
        )
      },
      (res) => {
        const chunks = [];
        res.on('data', (x) => chunks.push(x));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {}
          resolve({ code: res.statusCode, text, json });
        });
      }
    );
    r.on('error', reject);
    r.end(content);
  });
}
const post = (s, headers) => request(s, '/v1/wallpaper', 'POST', body, headers);
function readAll(r, id) {
  const chunks = [];
  let offset = 0,
    part;
  do {
    part = r.read(id, offset);
    chunks.push(Buffer.from(part.data, 'base64'));
    offset = part.nextOffset;
  } while (!part.done);
  return Buffer.concat(chunks).toString();
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  acorn.parse(fs.readFileSync('theme-receiver/core.js', 'utf8'), {
    ecmaVersion: 5
  });
  const r = core.create({ port: 0 });
  await assert.rejects(
    r.start({ kind: 'photos', limit: 0 }),
    /invalid-request/
  );
  await assert.rejects(
    r.start({ kind: 'photos', limit: 51 }),
    /invalid-request/
  );
  await assert.rejects(
    r.start({ kind: 'photos', limit: 2.5 }),
    /invalid-request/
  );
  let s = await r.start({ kind: 'photos' });
  assert.equal(s.kind, 'photos');
  assert.equal(s.photoProtocol, 1);
  assert.equal(s.photoLimit, 50);
  assert.match(s.pin, /^\d{6}$/);
  const page = await request(s, '/wallpaper');
  assert.equal(page.code, 200);
  assert.match(page.text, /'photos' === 'photos'/);
  assert.match(page.text, /Number\('50'\)/);
  const caps = await request(s, '/v1/wallpaper-capabilities');
  assert.equal(caps.code, 200);
  assert.equal(caps.json.multiple, true);
  assert.equal(caps.json.remaining, 50);

  // Three sequential uploads with the same PIN; 409 (retryable) while unread.
  const firstExpiry = r.status(s.sessionId).expiresAt;
  for (let i = 1; i <= 3; i++) {
    const ok = await post(s);
    assert.equal(ok.code, 202, 'upload ' + i);
    assert.deepEqual(ok.json, {
      returnValue: true,
      count: i,
      remaining: 50 - i
    });
    const status = r.status(s.sessionId);
    assert.equal(status.state, 'received');
    assert.equal(status.count, i);
    assert.equal(status.size, Buffer.byteLength(body));
    const busy = await post(s);
    assert.equal(busy.code, 409);
    assert.equal(busy.json.errorCode, 'photo-pending');
    assert.equal(busy.json.retry, true);
    assert.equal(readAll(r, s.sessionId), body);
    assert.equal(r.status(s.sessionId).state, 'waiting');
    assert.throws(() => r.read(s.sessionId, 0), /not-received/);
    await delay(5);
  }
  assert(r.status(s.sessionId).expiresAt >= firstExpiry, 'idle deadline');

  // Wrong PIN: rejected, session survives below the wrong-PIN limit.
  const wrongPin = s.pin === '000000' ? '111111' : '000000';
  assert.equal((await post(s, { 'X-CYTV-PIN': wrongPin })).code, 403);
  assert.equal(r.status(s.sessionId).state, 'waiting');
  assert.equal((await post(s)).code, 202);
  readAll(r, s.sessionId);
  // Desktop-only fields stay rejected for photos.
  const big = JSON.parse(body);
  big.source = 'cytv';
  assert.equal(
    (await request(s, '/v1/wallpaper', 'POST', JSON.stringify(big))).code,
    400
  );
  assert.equal(r.status(s.sessionId).state, 'waiting');

  // Stop closes the listener.
  await r.stop(s.sessionId);
  assert.throws(() => r.status(s.sessionId), /invalid-session/);
  await assert.rejects(post(s));

  // 20 wrong PINs dispose a photos session too.
  const wrong = core.create({ port: 0, maxWrongPins: 2 });
  s = await wrong.start({ kind: 'photos' });
  await post(s, { 'X-CYTV-PIN': 'bad' });
  await post(s, { 'X-CYTV-PIN': 'bad' });
  await delay(10);
  assert.throws(() => wrong.status(s.sessionId));

  // The cap: limit from the TV (free slots), and 50 at most.
  const capped = core.create({ port: 0 });
  s = await capped.start({ kind: 'photos', limit: 2 });
  assert.equal(s.photoLimit, 2);
  assert.equal((await post(s)).code, 202);
  readAll(capped, s.sessionId);
  const last = await post(s);
  assert.equal(last.code, 202);
  assert.equal(last.json.remaining, 0);
  await delay(10);
  await assert.rejects(post(s), 'listener closes after the last photo');
  assert.equal(capped.status(s.sessionId).state, 'received');
  readAll(capped, s.sessionId);
  assert.deepEqual(capped.status(s.sessionId), {
    state: 'waiting',
    size: 0,
    count: 2,
    remaining: 0,
    expiresAt: capped.status(s.sessionId).expiresAt
  });
  await capped.stop(s.sessionId);
  const fifty = core.create({ port: 0 });
  s = await fifty.start({ kind: 'photos' });
  for (let i = 0; i < 50; i++) {
    assert.equal((await post(s)).code, 202);
    readAll(fifty, s.sessionId);
  }
  assert.equal(fifty.status(s.sessionId).remaining, 0);
  await delay(10);
  await assert.rejects(post(s));
  await fifty.stop(s.sessionId);

  // Idle expiry still disposes the session.
  const exp = core.create({ port: 0, ttlMs: 60 });
  s = await exp.start({ kind: 'photos' });
  await delay(90);
  assert.throws(() => exp.status(s.sessionId), /invalid-session|expired/);

  // Wallpaper stays single-shot with the old status shape.
  const w = core.create({ port: 0 });
  s = await w.start({ kind: 'wallpaper' });
  assert.equal(s.kind, 'wallpaper');
  assert.equal(s.photoProtocol, undefined);
  assert.equal((await post(s)).code, 202);
  assert.deepEqual(w.status(s.sessionId), {
    state: 'received',
    size: Buffer.byteLength(body)
  });
  const page2 = await request(s, '/wallpaper').catch(() => null);
  assert(page2 === null || page2.code !== 200, 'listener closed');
  assert.equal(readAll(w, s.sessionId), body);
  assert.equal(w.status(s.sessionId).state, 'received');
  await w.stop(s.sessionId);
  s = await w.start({ kind: 'wallpaper' });
  const wp = await request(s, '/wallpaper');
  assert.match(wp.text, /'wallpaper' === 'photos'/);
  assert.equal((await post(s)).code, 202);
  await w.stop(s.sessionId);
  console.log(
    'PASS photos receiver: sequential uploads with one PIN, 409 while unread, PIN, cap, stop, expiry; wallpaper single-shot'
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
