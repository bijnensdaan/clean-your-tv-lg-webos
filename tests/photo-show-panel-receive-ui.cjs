// Photo show panel: "Add photos from phone" with a stubbed ThemeReceiver.
const { chromium, stage, fs, path } = require('./themes/browser.cjs');
const assert = require('node:assert/strict');
const http = require('node:http');

function serve(site) {
  return http.createServer((req, res) => {
    const file = path.resolve(
      site,
      '.' + new URL(req.url, 'http://localhost').pathname
    );
    if (!file.startsWith(site + path.sep) || !fs.existsSync(file))
      return res.writeHead(404).end();
    res.setHeader(
      'Content-Type',
      {
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.css': 'text/css',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.html': 'text/html'
      }[path.extname(file)] || 'application/octet-stream'
    );
    res.end(fs.readFileSync(file));
  });
}
const settle = (page, ms = 250) => page.waitForTimeout(ms);

// Installs a stub receiver that delivers `count` phone envelopes.
function stub(page, count) {
  return page.evaluate(async (count) => {
    async function envelope(i) {
      const blob = await new Promise((resolve) => {
        const c = document.createElement('canvas');
        c.width = 640;
        c.height = 360;
        const x = c.getContext('2d');
        x.fillStyle = i ? '#c04040' : '#4040c0';
        x.fillRect(0, 0, 640, 360);
        c.toBlob(resolve, 'image/jpeg', 0.8);
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let raw = '';
      for (let at = 0; at < bytes.length; at++)
        raw += String.fromCharCode(bytes[at]);
      return {
        schemaVersion: 1,
        kind: 'wallpaper',
        source: 'phone',
        image: {
          mediaType: 'image/jpeg',
          width: 640,
          height: 360,
          size: bytes.length,
          sha256: ThemeData.hash(bytes),
          data: btoa(raw)
        },
        variants: []
      };
    }
    const queue = [];
    for (let i = 0; i < count; i++) queue.push(await envelope(i));
    const log = (window.__receiver = { starts: [], stops: [], reads: 0 });
    window.ThemeReceiver = {
      start(signal, kind, options) {
        log.starts.push({ kind, options });
        return Promise.resolve({
          sessionId: 'session-' + log.starts.length,
          pin: '123456',
          addresses: ['192.168.1.20'],
          port: 8879,
          expiresAt: Date.now() + 600000,
          kind: 'photos',
          photoProtocol: 1,
          photoLimit: options.limit
        });
      },
      status() {
        return Promise.resolve(
          queue.length
            ? { state: 'received', size: 1000, count: 0, remaining: 5 }
            : { state: 'waiting', size: 0, count: 0, remaining: 5 }
        );
      },
      read() {
        log.reads++;
        return Promise.resolve(queue.shift());
      },
      stop(id) {
        log.stops.push(id);
        return Promise.resolve();
      }
    };
  }, count);
}

(async () => {
  const site = stage('photo-show'),
    server = serve(site);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || 'chrome'
  });
  try {
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        locale: 'en-US'
      }),
      page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(/^https:/, (route) => route.abort());
    await page.goto(
      'http://127.0.0.1:' + server.address().port + '/launcher/index.html'
    );
    await page.locator('#tiles .focused').waitFor();
    await page.evaluate(() => PhotoShowStore.clear());
    await stub(page, 2);
    await page.locator('#btnSettings').click();
    await page.locator('[data-category=photos]').click();
    await settle(page);
    const add = page.locator('#photoShowAdd');
    assert.equal(await add.isDisabled(), false, 'Add photos is enabled');
    assert(await page.locator('#photoShowConnection').isHidden());
    await add.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () =>
        /2 received/.test(
          document.querySelector('#photoShowStatus').textContent
        ),
      null,
      { timeout: 10000 }
    );
    assert.deepEqual(await page.evaluate(() => window.__receiver.starts), [
      { kind: 'photos', options: { limit: 50 } }
    ]);
    assert(await page.locator('#photoShowConnection').isVisible());
    assert.equal(
      await page.locator('#photoShowPIN').innerText(),
      'PIN: 123456'
    );
    assert.match(
      await page.locator('#photoShowAddress').innerText(),
      /http:\/\/192\.168\.1\.20:8879\/wallpaper/
    );
    assert(
      await page
        .locator('#photoShowQR')
        .evaluate((c) => c.width > 100 && c.width === c.height),
      'QR rendered'
    );
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      'photoShowDone'
    );
    assert(await add.isDisabled(), 'no second session while receiving');
    const items = await page.evaluate(() => PhotoShowStore.list());
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((i) => [i.width, i.height]),
      [
        [640, 360],
        [640, 360]
      ]
    );
    await settle(page);
    assert.equal(await page.locator('#photoShowList li').count(), 2);
    assert.equal(
      await page.locator('#photoShowCount').innerText(),
      '2 / 50 photos'
    );
    await page.keyboard.press('Enter');
    await settle(page);
    assert(await page.locator('#photoShowConnection').isHidden());
    assert.deepEqual(await page.evaluate(() => window.__receiver.stops), [
      'session-1'
    ]);
    assert.equal(
      await page.locator('#photoShowStatus').innerText(),
      '2 photos added.'
    );
    assert.equal(await add.isDisabled(), false);

    // Leaving the category stops a running session.
    await stub(page, 0);
    await add.click();
    await page.locator('#photoShowConnection').waitFor();
    await page.locator('[data-category=wallpapers]').click();
    await settle(page);
    assert.deepEqual(await page.evaluate(() => window.__receiver.stops), [
      'session-1'
    ]);

    // Limit: the session asks only for the free slots; a full store stops it.
    await page.evaluate(async () => {
      const blob = await new Promise((resolve) => {
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = 180;
        c.getContext('2d').fillRect(0, 0, 320, 180);
        c.toBlob(resolve, 'image/jpeg', 0.8);
      });
      for (let i = (await PhotoShowStore.list()).length; i < 49; i++)
        await PhotoShowStore.add(blob);
    });
    await stub(page, 2);
    await page.locator('[data-category=photos]').click();
    await settle(page);
    await add.click();
    await page.waitForFunction(
      () =>
        /Photo limit reached/.test(
          document.querySelector('#photoShowStatus').textContent
        ),
      null,
      { timeout: 10000 }
    );
    assert.deepEqual(await page.evaluate(() => window.__receiver.starts), [
      { kind: 'photos', options: { limit: 1 } }
    ]);
    assert.match(
      await page.locator('#photoShowStatus').innerText(),
      /^1 photos added\. Photo limit reached/
    );
    assert.deepEqual(await page.evaluate(() => window.__receiver.stops), [
      'session-1'
    ]);
    assert(await page.locator('#photoShowConnection').isHidden());
    await settle(page);
    assert(await add.isDisabled(), 'full list: no new session');
    await stub(page, 0);
    await add.evaluate((b) => b.click());
    await settle(page);
    assert.deepEqual(await page.evaluate(() => window.__receiver.starts), []);
    await page.evaluate(() => PhotoShowStore.clear());
    assert.deepEqual(errors, []);
    console.log(
      'PASS photo show panel receive: QR/PIN session, 2 phone photos stored, Done/leave stop, limit'
    );
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
