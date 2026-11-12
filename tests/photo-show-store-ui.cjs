// Photo show storage: order, limits, settings and persistence in the real launcher.
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

// Runs inside the page: a small generated JPEG/PNG of the given size.
const helpers = () => {
  window.__photo = (w, h, type) =>
    new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = 'hsl(' + ((w * 7 + h) % 360) + ',60%,50%)';
      x.fillRect(0, 0, w, h);
      c.toBlob(resolve, type || 'image/jpeg', 0.8);
    });
};

(async () => {
  const site = stage('photo-show'),
    server = serve(site);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || 'chrome'
  });
  const url =
    'http://127.0.0.1:' + server.address().port + '/launcher/index.html';
  try {
    const page = await browser.newPage({
        viewport: { width: 1280, height: 720 },
        locale: 'en-US'
      }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(/^https:/, (route) => route.abort());
    await page.goto(url);
    await page.locator('#tiles .focused').waitFor();
    await page.evaluate(helpers);

    const basics = await page.evaluate(async () => {
      const S = PhotoShowStore;
      let changes = 0;
      const off = S.onChange(() => changes++);
      await S.clear();
      const defaults = await S.settings();
      const a = await S.add(await __photo(640, 360));
      const b = await S.add({ blob: await __photo(300, 400, 'image/png') });
      const c = await S.add(await __photo(1920, 1080));
      const listed = await S.list();
      const full = await S.get(b.id);
      const thumb = listed[0].thumb;
      const order1 = listed.map((i) => i.id);
      await S.move(c.id, -1);
      const order2 = (await S.list()).map((i) => i.id);
      await S.move(a.id, -10);
      await S.move(c.id, 99);
      const order3 = (await S.list()).map((i) => i.id);
      await S.remove(b.id);
      const order4 = (await S.list()).map((i) => i.id);
      const errorsOf = async (input) => {
        try {
          await S.add(input);
          return 'ok';
        } catch (e) {
          return e.code;
        }
      };
      const gif = await errorsOf(
        new Blob([new Uint8Array(10)], { type: 'image/gif' })
      );
      const big = await errorsOf(
        new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/jpeg' })
      );
      const broken = await errorsOf(
        new Blob([new Uint8Array(100)], { type: 'image/jpeg' })
      );
      const check = StorageBudget.check;
      StorageBudget.check = (n) =>
        Promise.reject(StorageBudget.full(StorageBudget.budget(n, 10)));
      const storageFull = await errorsOf(await __photo(100, 100));
      StorageBudget.check = check;
      const usage = await S.usage();
      off();
      return {
        defaults,
        ids: [a.id, b.id, c.id],
        dims: listed.map((i) => [i.width, i.height]),
        thumb: [thumb.type, thumb.size > 0, 'blob' in listed[0]],
        thumbSize: await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
          img.src = URL.createObjectURL(thumb);
        }),
        fullBlob: [full.blob.type, full.blob.size === full.size, full.size > 0],
        order1,
        order2,
        order3,
        order4,
        gif,
        big,
        broken,
        storageFull,
        usage,
        changes
      };
    });
    const [a, b, c] = basics.ids;
    assert.deepEqual(basics.defaults, { enabled: true, seconds: 10 });
    assert.deepEqual(basics.dims, [
      [640, 360],
      [300, 400],
      [1920, 1080]
    ]);
    assert.deepEqual(basics.thumb, ['image/jpeg', true, false]);
    assert.deepEqual(basics.thumbSize, [240, 135], 'thumb is 240x135');
    assert.deepEqual(basics.fullBlob, ['image/png', true, true]);
    assert.deepEqual(basics.order1, [a, b, c]);
    assert.deepEqual(basics.order2, [a, c, b]);
    assert.deepEqual(basics.order3, [a, b, c], 'moves clamp at the edges');
    assert.deepEqual(basics.order4, [a, c]);
    assert.equal(basics.gif, 'type');
    assert.equal(basics.big, 'size');
    assert.equal(basics.broken, 'invalid');
    assert.equal(basics.storageFull, 'storage-full');
    assert.equal(basics.usage.count, 2);
    assert.equal(basics.usage.max, 50);
    assert(basics.usage.bytes > 0);
    assert.equal(basics.usage.nearFull, false);
    assert(basics.changes >= 7, 'change callback fires on writes');
    console.log('PASS add/list/get/move/remove and validation');

    const settings = await page.evaluate(async () => {
      const S = PhotoShowStore;
      const out = [];
      out.push(await S.saveSettings({ seconds: 13 }));
      out.push(await S.saveSettings({ seconds: 1000 }));
      out.push(await S.saveSettings({ seconds: 'x', enabled: 'no' }));
      out.push(await S.saveSettings({ enabled: false, seconds: 8 }));
      return out;
    });
    assert.deepEqual(settings, [
      { enabled: true, seconds: 15 },
      { enabled: true, seconds: 60 },
      { enabled: true, seconds: 60 },
      { enabled: false, seconds: 8 }
    ]);
    await page.reload();
    await page.locator('#tiles .focused').waitFor();
    await page.evaluate(helpers);
    const persisted = await page.evaluate(async () => ({
      settings: await PhotoShowStore.settings(),
      count: (await PhotoShowStore.list()).length
    }));
    assert.deepEqual(persisted, {
      settings: { enabled: false, seconds: 8 },
      count: 2
    });
    console.log('PASS settings clamp and persistence across reload');

    const limit = await page.evaluate(async () => {
      const S = PhotoShowStore;
      await S.clear();
      const blob = await __photo(64, 36);
      const near = [];
      for (let i = 0; i < 50; i++) {
        await S.add(blob);
        if (i === 43 || i === 44) near.push((await S.usage()).nearFull);
      }
      let code = 'ok';
      try {
        await S.add(blob);
      } catch (e) {
        code = e.code;
      }
      // Concurrent adds at the limit are serialized and still refused.
      const parallel = await Promise.all(
        [1, 2].map(() =>
          S.add(blob).then(
            () => 'ok',
            (e) => e.code
          )
        )
      );
      const usage = await S.usage();
      await S.clear();
      return {
        near,
        code,
        parallel,
        usage,
        after: (await S.list()).length,
        settings: await S.settings()
      };
    });
    assert.deepEqual(limit.near, [false, true], 'nearFull from 45 photos');
    assert.equal(limit.code, 'limit');
    assert.deepEqual(limit.parallel, ['limit', 'limit']);
    assert.equal(limit.usage.count, 50);
    assert.equal(limit.usage.nearFull, true);
    assert.equal(limit.after, 0);
    assert.deepEqual(
      limit.settings,
      { enabled: false, seconds: 8 },
      'clear keeps settings'
    );
    console.log('PASS 50-photo limit, nearFull and clear');

    const lowStorage = await page.evaluate(async () => {
      const estimate = StorageBudget.estimate;
      StorageBudget.estimate = (n) =>
        Promise.resolve(StorageBudget.budget(n, 10 * 1024 * 1024));
      const usage = await PhotoShowStore.usage();
      StorageBudget.estimate = estimate;
      await PhotoShowStore.saveSettings({ enabled: true, seconds: 10 });
      return usage;
    });
    assert.equal(lowStorage.nearFull, true, 'nearFull under 50 MiB free');
    console.log('PASS low free storage marks nearFull');
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
