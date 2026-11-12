// Idle photo show on Home: start conditions, input capture, layers, blob URLs, timing.
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

async function seed(page, count) {
  await page.evaluate(async (count) => {
    for (let i = (await PhotoShowStore.list()).length; i < count; i++) {
      const blob = await new Promise((resolve) => {
        const c = document.createElement('canvas');
        // One portrait photo checks aspect-preserving fit.
        c.width = i === 1 ? 360 : 640;
        c.height = i === 1 ? 640 : 360;
        const ctx = c.getContext('2d');
        ctx.fillStyle = 'hsl(' + i * 70 + ',70%,50%)';
        ctx.fillRect(0, 0, c.width, c.height);
        c.toBlob(resolve, 'image/jpeg', 0.8);
      });
      await PhotoShowStore.add(blob);
    }
  }, count);
}
const running = (page) => page.evaluate(() => PhotoShow.isRunning());
const waitRunning = (page, timeout = 4000) =>
  page.waitForFunction(
    () =>
      PhotoShow.isRunning() &&
      document.getElementById('photoShowOverlay').style.display === 'block',
    null,
    { timeout }
  );
const focusedTile = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('#tiles .focused');
    return el ? el.dataset.appId || el.textContent : null;
  });
const quiet = (page) =>
  page.evaluate(() => {
    PhotoShow.configure({ idleMs: 600000, slideMs: null });
    PhotoShow.stop();
  });
const idle = (page, ms) =>
  page.evaluate((ms) => PhotoShow.configure({ idleMs: ms }), ms);

(async () => {
  const site = stage('photo-show-idle'),
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
    await page.addInitScript(() => {
      const live = new Set();
      window.__urls = { created: 0, revoked: 0, max: 0 };
      const create = URL.createObjectURL,
        revoke = URL.revokeObjectURL;
      URL.createObjectURL = function (blob) {
        const url = create.call(URL, blob);
        if (/photo-show\.js/.test(new Error().stack)) {
          window.__urls.created++;
          live.add(url);
          window.__urls.max = Math.max(window.__urls.max, live.size);
        }
        return url;
      };
      URL.revokeObjectURL = function (url) {
        if (live.delete(url)) window.__urls.revoked++;
        return revoke.call(URL, url);
      };
      window.__liveURLs = () => live.size;
    });
    await page.mouse.move(5, 5);
    await page.goto(
      'http://127.0.0.1:' + server.address().port + '/launcher/index.html'
    );
    await page.locator('#tiles .focused').waitFor();
    await page.waitForFunction(() => window.RootLauncherRendered === true);
    await page.evaluate(() => {
      window.__launches = [];
      const call = PalmServiceBridge.prototype.call;
      PalmServiceBridge.prototype.call = function (uri) {
        if (/applicationManager\/launch/.test(uri)) window.__launches.push(uri);
        return call.apply(this, arguments);
      };
    });
    await quiet(page);
    await page.evaluate(() => PhotoShowStore.clear());
    assert.equal(
      await page.evaluate(
        () => document.querySelectorAll('#photoShowOverlay img').length
      ),
      0,
      'overlay is built lazily'
    );

    // Empty list: never starts, even on Home.
    await idle(page, 200);
    await page.waitForTimeout(700);
    assert.equal(await running(page), false, 'no photos, no show');
    await quiet(page);

    await seed(page, 3);

    // Disabled: never starts.
    await page.evaluate(() => PhotoShowStore.saveSettings({ enabled: false }));
    await idle(page, 200);
    await page.waitForTimeout(700);
    assert.equal(await running(page), false, 'disabled, no show');
    await quiet(page);
    await page.evaluate(() => PhotoShowStore.saveSettings({ enabled: true }));

    // Settings panel open: never starts.
    await page.locator('#btnSettings').click();
    await page.waitForFunction(() => RenewalPanel.isOpen());
    await idle(page, 200);
    await page.waitForTimeout(700);
    assert.equal(await running(page), false, 'settings open, no show');
    await quiet(page);
    for (
      let i = 0;
      i < 4 && (await page.evaluate(() => RenewalPanel.isOpen()));
      i++
    )
      await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => RenewalPanel.isOpen()), false);
    // Pointer clicks on the panel moved focus; return remote focus to the grid.
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);

    // Home active: starts after the idle timeout, one visible layer, no UI on top.
    const before = await focusedTile(page);
    assert(before, 'a tile is focused');
    await idle(page, 300);
    await waitRunning(page);
    const layout = await page.evaluate(() => {
      const overlay = document.getElementById('photoShowOverlay'),
        imgs = overlay.querySelectorAll('img'),
        box = overlay.getBoundingClientRect(),
        style = getComputedStyle(overlay);
      return {
        children: overlay.children.length,
        imgs: imgs.length,
        visible: Array.from(imgs).filter((i) => i.style.opacity === '1').length,
        fit: getComputedStyle(imgs[0]).objectFit,
        filter: getComputedStyle(imgs[0]).filter,
        position: style.position,
        bg: style.backgroundColor,
        box: [box.left, box.top, box.width, box.height]
      };
    });
    assert.deepEqual(layout, {
      children: 2,
      imgs: 2,
      visible: 1,
      fit: 'contain',
      filter: 'none',
      position: 'fixed',
      bg: 'rgb(0, 0, 0)',
      box: [0, 0, 1280, 720]
    });

    // Any key stops the show and never reaches Home.
    for (const key of ['ArrowRight', 'Enter', 'Escape', 'ArrowDown']) {
      await idle(page, 300);
      await waitRunning(page);
      await page.keyboard.press(key);
      assert.equal(await running(page), false, key + ' stops the show');
      assert.equal(
        await page.evaluate(
          () => document.getElementById('photoShowOverlay').style.display
        ),
        'none'
      );
      await quiet(page);
      await page.waitForTimeout(150);
      assert.equal(await focusedTile(page), before, key + ' left focus as-is');
    }
    // Held OK (auto-repeat) is swallowed too: no tile edit mode.
    await idle(page, 300);
    await waitRunning(page);
    await page.keyboard.down('Enter');
    for (let i = 0; i < 6; i++) {
      await page.keyboard.down('Enter');
      await page.waitForTimeout(150);
    }
    await page.keyboard.up('Enter');
    await quiet(page);
    assert.equal(await page.locator('#tiles .moving').count(), 0, 'no move');
    assert.equal(await focusedTile(page), before);
    assert.deepEqual(await page.evaluate(() => window.__launches), []);

    // Not running: keys reach Home normally.
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    const after = await focusedTile(page);
    assert.notEqual(after, before, 'keys work when the show is not running');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(150);
    assert.equal(await focusedTile(page), before);

    // Pointer movement stops; a click on a tile under the show launches nothing.
    await idle(page, 300);
    await waitRunning(page);
    await page.mouse.move(400, 300, { steps: 2 });
    assert.equal(await running(page), false, 'pointer move stops the show');
    await quiet(page);
    const tile = await page
      .locator('#tiles .tile, #tiles [data-app-id]')
      .first();
    const box = await tile.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(800);
    await idle(page, 300);
    await waitRunning(page);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await running(page), false, 'click stops the show');
    await quiet(page);
    await page.waitForTimeout(900);
    assert.deepEqual(
      await page.evaluate(() => window.__launches),
      [],
      'no app launch from the stopping key or click'
    );
    await page.mouse.move(5, 5);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);

    // Window blur and hidden document stop the show.
    await idle(page, 300);
    await waitRunning(page);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await running(page), false, 'blur stops the show');
    await idle(page, 200);
    await page.waitForTimeout(600);
    assert.equal(await running(page), false, 'no start while unfocused');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await idle(page, 300);
    await waitRunning(page);
    await quiet(page);

    // Many transitions: one visible layer, at most two blob URLs, all revoked on stop.
    await page.evaluate(() => {
      window.__urls.max = 0;
      PhotoShow.configure({ slideMs: 1400 });
    });
    await idle(page, 200);
    await waitRunning(page);
    const order = await page.evaluate(async () =>
      (await PhotoShowStore.list()).map((p) => p.id)
    );
    const seen = [];
    for (let i = 0; i < 25; i++) {
      const s = await page.evaluate(() => ({
        state: PhotoShow.state(),
        live: window.__liveURLs(),
        visible: Array.from(
          document.querySelectorAll('#photoShowOverlay img')
        ).filter((i) => i.style.opacity === '1').length
      }));
      assert(s.live <= 2, 'blob URLs ' + s.live);
      assert.equal(s.visible, 1, 'exactly one visible layer');
      if (seen[seen.length - 1] !== s.state.id) seen.push(s.state.id);
      await page.waitForTimeout(250);
    }
    const switches = await page.evaluate(() => PhotoShow.state().switches);
    assert(switches >= 3, 'transitions happened: ' + switches);
    assert.deepEqual(
      seen.slice(0, 4),
      [order[0], order[1], order[2], order[0]],
      'stored order, looping'
    );
    assert(
      (await page.evaluate(() => window.__urls.max)) <= 2,
      'never more than two blob URLs'
    );
    // Transforms stay small (anti burn-in offset), no filters.
    const transforms = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#photoShowOverlay img')).map(
        (i) => i.style.transform
      )
    );
    for (const t of transforms)
      assert.match(t, /^(|translate\(-?\d+px, ?-?\d+px\))$/, t);
    await quiet(page);
    assert.equal(await page.evaluate(() => window.__liveURLs()), 0, 'revoked');
    assert.equal(
      await page.evaluate(
        () =>
          Array.from(document.querySelectorAll('#photoShowOverlay img')).filter(
            (i) => i.hasAttribute('src')
          ).length
      ),
      0
    );

    // Seconds setting: 5 s per photo, no switch earlier.
    await page.evaluate(() => PhotoShowStore.saveSettings({ seconds: 5 }));
    await idle(page, 200);
    await waitRunning(page);
    const base = await page.evaluate(() => PhotoShow.state().switches);
    assert.equal(await page.evaluate(() => PhotoShow.state().seconds), 5);
    await page.waitForTimeout(4300);
    assert.equal(
      await page.evaluate(() => PhotoShow.state().switches),
      base,
      'no switch before 5 s'
    );
    await page.waitForTimeout(1200);
    assert.equal(
      await page.evaluate(() => PhotoShow.state().switches),
      base + 1,
      'switch after 5 s'
    );
    // Live seconds update while running.
    await page.evaluate(() => PhotoShowStore.saveSettings({ seconds: 8 }));
    await page.waitForFunction(() => PhotoShow.state().seconds === 8);

    // Settings become invalid while running: stops.
    await page.evaluate(() => PhotoShowStore.saveSettings({ enabled: false }));
    await page.waitForFunction(() => !PhotoShow.isRunning());
    await page.evaluate(() =>
      PhotoShowStore.saveSettings({ enabled: true, seconds: 10 })
    );
    await idle(page, 200);
    await waitRunning(page);
    await page.evaluate(() => PhotoShowStore.clear());
    await page.waitForFunction(() => !PhotoShow.isRunning());
    assert.equal(await page.evaluate(() => window.__liveURLs()), 0);
    await quiet(page);

    assert.deepEqual(await page.evaluate(() => window.__launches), []);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS photo show idle slideshow');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
