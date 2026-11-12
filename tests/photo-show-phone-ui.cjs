'use strict';
// Phone page in photos mode against the real receiver: several files, resized
// on the phone, sent one after another with one PIN.
const assert = require('assert/strict'),
  { chromium } = require('playwright'),
  crypto = require('crypto');
const core = require('../theme-receiver/core');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function readAll(r, id) {
  const chunks = [];
  let offset = 0,
    part;
  do {
    part = r.read(id, offset);
    chunks.push(Buffer.from(part.data, 'base64'));
    offset = part.nextOffset;
  } while (!part.done);
  return JSON.parse(Buffer.concat(chunks));
}
(async () => {
  const r = core.create({ port: 0 }),
    s = await r.start({ kind: 'photos', limit: 10 }),
    browser = await chromium.launch({
      headless: true,
      channel: process.env.BROWSER_CHANNEL || 'chrome'
    });
  let tv = true;
  const received = [];
  // The "TV": reads slowly so the phone sees retryable 409 responses.
  const reader = (async () => {
    while (tv) {
      let status;
      try {
        status = r.status(s.sessionId);
      } catch (_) {
        return;
      }
      if (status.state === 'received') {
        await delay(900);
        received.push(readAll(r, s.sessionId));
      }
      await delay(50);
    }
  })();
  try {
    const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        locale: 'en-US'
      }),
      errors = [],
      posts = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (q) => {
      if (q.method() === 'POST') posts.push(q.postData());
    });
    const origin = 'http://127.0.0.1:' + s.port;
    await page.goto(origin + '/wallpaper#pin=' + s.pin);
    assert.match(await page.locator('h1').innerText(), /photo show/i);
    assert.equal(await page.locator('#file').getAttribute('multiple'), '');
    assert.equal(await page.locator('#zoom').count(), 0, 'no crop controls');
    assert.equal(await page.locator('#pin').inputValue(), s.pin);
    assert.match(await page.locator('#status').innerText(), /10 more/);
    const files = await page.evaluate(() => {
      function make(w, h, noise, type, quality) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const x = c.getContext('2d');
        if (noise) {
          const data = x.createImageData(w, h);
          let seed = 7;
          for (let i = 0; i < data.data.length; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            data.data[i] = i % 4 === 3 ? 255 : seed >> 23;
          }
          x.putImageData(data, 0, 0);
        } else {
          x.fillStyle = '#3070c0';
          x.fillRect(0, 0, w, h);
          x.fillStyle = '#f0c040';
          x.fillRect(w / 4, h / 4, w / 2, h / 2);
        }
        return c.toDataURL(type, quality).split(',')[1];
      }
      return [
        make(4000, 3000, true, 'image/jpeg', 0.95),
        make(900, 1600, false, 'image/png'),
        make(1280, 720, false, 'image/jpeg', 0.9)
      ];
    });
    await page.locator('#file').setInputFiles([
      {
        name: 'large.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from(files[0], 'base64')
      },
      {
        name: 'not-a-photo.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from('nope')
      },
      {
        name: 'portrait.png',
        mimeType: 'image/png',
        buffer: Buffer.from(files[1], 'base64')
      },
      {
        name: 'small.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from(files[2], 'base64')
      }
    ]);
    assert.match(await page.locator('#status').innerText(), /4 photos/);
    assert.equal(await page.locator('#send').isDisabled(), false);
    await page.locator('#send').click();
    const progress = new Set();
    for (let i = 0; i < 600; i++) {
      const text = await page.locator('#status').innerText();
      progress.add(text);
      if (/^Sent/.test(text)) break;
      await delay(50);
    }
    const summary = await page.locator('#status').innerText();
    assert.match(summary, /Sent 3 of 4 photos\. 1 could not be sent\./);
    assert.match(summary, /7 more/);
    assert(
      [...progress].some((t) => /Sending 1 of 4/.test(t)),
      [...progress].join(' | ')
    );
    assert(
      [...progress].some((t) => /waiting for the TV/.test(t)),
      'retryable 409 while the TV reads'
    );
    assert.match(
      await page.locator('#errors').innerText(),
      /not-a-photo\.jpg: Not a supported photo/
    );
    for (let i = 0; i < 100 && received.length < 3; i++) await delay(50);
    assert.equal(received.length, 3);
    const sizes = [];
    for (const raw of posts) {
      const v = JSON.parse(raw);
      const bytes = Buffer.from(v.image.data, 'base64');
      assert(bytes.length <= 550 * 1024, 'POST image ' + bytes.length);
      assert(v.image.width <= 1920 && v.image.height <= 1080);
      assert.equal(v.image.mediaType, 'image/jpeg');
      sizes.push(bytes.length);
    }
    const dims = received.map((v) => [v.image.width, v.image.height]);
    assert(dims[0][0] <= 1440 && dims[0][1] <= 1080, 'large fitted ' + dims[0]);
    assert.ok(
      Math.abs(dims[0][0] / dims[0][1] - 4 / 3) < 0.01,
      'aspect kept, no crop'
    );
    assert.deepEqual(dims[1], [607, 1080], 'portrait fitted by height');
    assert.deepEqual(dims[2], [1280, 720], 'small kept');
    for (const v of received) {
      const bytes = Buffer.from(v.image.data, 'base64');
      assert.equal(
        crypto.createHash('sha256').update(bytes).digest('hex'),
        v.image.sha256
      );
    }
    assert.equal(r.status(s.sessionId).count, 3);
    assert.equal(r.status(s.sessionId).remaining, 7);
    assert.deepEqual(errors, []);

    // HEIC goes through the bundled local decoder when the browser lacks it.
    await page.locator('#file').setInputFiles({
      name: 'iPhone.HEIC',
      mimeType: '',
      buffer: require('fs').readFileSync(
        __dirname + '/themes/fixtures/heic/photo.heic'
      )
    });
    await page.locator('#send').click();
    await page.waitForFunction(
      () => /^Sent/.test(document.querySelector('#status').textContent),
      null,
      { timeout: 60000 }
    );
    assert.match(
      await page.locator('#status').innerText(),
      /Sent 1 of 1 photos\./
    );
    for (let i = 0; i < 100 && received.length < 4; i++) await delay(50);
    assert.equal(received.length, 4);
    assert.equal(received[3].image.mediaType, 'image/jpeg');
    assert.equal(r.status(s.sessionId).remaining, 6);

    // Wrong PIN ends the batch with a clear message, the rest is not sent.
    await page.locator('#pin').fill(s.pin === '000000' ? '111111' : '000000');
    await page.locator('#file').setInputFiles([
      {
        name: 'small.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from(files[2], 'base64')
      },
      {
        name: 'small2.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from(files[2], 'base64')
      }
    ]);
    await page.locator('#send').click();
    await page.waitForFunction(() =>
      /Wrong PIN/.test(document.querySelector('#status').textContent)
    );
    assert.match(
      await page.locator('#status').innerText(),
      /Sent 0 of 2 photos\. 2 could not be sent\./
    );
    assert.equal(r.status(s.sessionId).count, 4);
    assert(
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth
      ))
    );
    console.log(
      'PASS photo show phone page: multiple files, fit ≤1920×1080, ≤550 KB JPEG (' +
        sizes.join(', ') +
        ' bytes), 409 retry, per-file errors, summary'
    );
  } finally {
    tv = false;
    await reader;
    await browser.close();
    await r.stop(s.sessionId).catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
