// Photo show settings panel in both edition bootstraps: controls, list, focus, cleanup.
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
    const blob = await new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 180;
      c.getContext('2d').fillRect(0, 0, 320, 180);
      c.toBlob(resolve, 'image/jpeg', 0.8);
    });
    for (let i = (await PhotoShowStore.list()).length; i < count; i++)
      await PhotoShowStore.add(blob);
  }, count);
}
const settle = (page) => page.waitForTimeout(250);
const active = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return (
      el.id ||
      (el.getAttribute('data-photo-action') || '') +
        ':' +
        (el.getAttribute('data-photo-index') || '')
    );
  });

(async () => {
  const site = stage('photo-show'),
    server = serve(site);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || 'chrome'
  });
  try {
    for (const edition of ['launcher']) {
      const context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          locale: 'en-US'
        }),
        page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route(/^https:/, (route) => route.abort());
      await page.addInitScript(() => {
        window.__urls = { created: 0, revoked: 0 };
        const create = URL.createObjectURL,
          revoke = URL.revokeObjectURL;
        URL.createObjectURL = function (blob) {
          const url = create.call(URL, blob);
          if (new Error().stack.indexOf('photo-show-panel') >= 0) {
            window.__urls.created++;
            (window.__panelURLs = window.__panelURLs || []).push(url);
          }
          return url;
        };
        URL.revokeObjectURL = function (url) {
          if ((window.__panelURLs || []).indexOf(url) >= 0)
            window.__urls.revoked++;
          return revoke.call(URL, url);
        };
      });
      await page.goto(
        'http://127.0.0.1:' +
          server.address().port +
          '/' +
          edition +
          '/index.html'
      );
      await page.locator('#tiles .focused').waitFor();
      await page.evaluate(() => PhotoShowStore.clear());
      await seed(page, 3);
      await page.locator('#btnSettings').click();
      const tab = page.locator('[data-category=photos]');
      assert.equal(await tab.innerText(), 'Photo show');
      assert.deepEqual(
        await page.evaluate(() => {
          const tabs = Array.from(
            document.querySelectorAll('[role=tab][data-category]')
          ).map((t) => t.getAttribute('data-category'));
          // Weather inserts itself directly after Wallpapers.
          return tabs.slice(
            tabs.indexOf('wallpapers') + 1,
            tabs.indexOf('photos')
          );
        }),
        ['weather'],
        'Photo show follows Wallpapers and Weather'
      );
      await tab.click();
      await settle(page);
      assert.equal(
        await page.locator('#photoShowCount').innerText(),
        '3 / 50 photos'
      );
      assert.equal(await page.locator('#photoShowList li').count(), 3);
      assert(await page.locator('#photoShowWarning').isHidden());
      assert(await page.locator('#photoShowEmpty').isHidden());
      assert(
        await page
          .locator('.photo-show-thumb')
          .first()
          .evaluate((img) => img.complete && img.naturalWidth === 240),
        'thumbnail decodes from stored thumb'
      );
      assert.equal(
        await page.locator('#photoShowEnabled').getAttribute('aria-pressed'),
        'true'
      );
      assert.equal(
        await page
          .locator('#photoShowList li >> nth=0 >> [data-photo-action=up]')
          .getAttribute('aria-disabled'),
        'true'
      );
      assert.equal(
        await page
          .locator('#photoShowList li >> nth=2 >> [data-photo-action=down]')
          .getAttribute('aria-disabled'),
        'true'
      );

      // Remote navigation: enter the pane, reach toggle, list rows and Delete all.
      await tab.focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await active(page), 'photoShowEnabled');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.equal(
        await page.locator('#photoShowEnabled').getAttribute('aria-pressed'),
        'false'
      );
      assert.equal(
        await page.locator('#photoShowEnabled').innerText(),
        'Photo show: Off'
      );
      await page.keyboard.press('ArrowRight');
      assert.equal(await active(page), 'photoShowSeconds');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.equal(
        await page.locator('#photoShowSeconds').innerText(),
        'Seconds per photo: 15'
      );
      assert.deepEqual(await page.evaluate(() => PhotoShowStore.settings()), {
        enabled: false,
        seconds: 15
      });
      const seen = new Set();
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press('ArrowDown');
        seen.add(await active(page));
      }
      assert(seen.has('photoShowClear'), 'Delete all reachable: ' + [...seen]);
      for (const id of ['up:0', 'up:1', 'up:2'])
        assert(seen.has(id), id + ' reachable: ' + [...seen]);
      await tab.click();
      await settle(page);
      await page
        .locator('#photoShowList li >> nth=0 >> [data-photo-action=up]')
        .focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await active(page), 'down:0');
      await page.keyboard.press('ArrowRight');
      assert.equal(await active(page), 'delete:0');
      await page.keyboard.press('ArrowDown');
      assert.equal(await active(page), 'delete:1');
      await page.keyboard.press('Escape');
      assert.equal(
        await active(page),
        'settings-tab-photos',
        'Back returns to tab'
      );

      // Move keeps focus on the moved photo.
      const ids = await page.evaluate(async () =>
        (await PhotoShowStore.list()).map((i) => i.id)
      );
      await page
        .locator('#photoShowList li >> nth=0 >> [data-photo-action=down]')
        .focus();
      await page.keyboard.press('Enter');
      await settle(page);
      assert.deepEqual(
        await page.evaluate(async () =>
          (await PhotoShowStore.list()).map((i) => i.id)
        ),
        [ids[1], ids[0], ids[2]]
      );
      assert.equal(await active(page), 'down:1', 'focus follows moved photo');
      assert.equal(
        await page.evaluate(() =>
          document.activeElement.getAttribute('data-photo-id')
        ),
        ids[0]
      );
      await page
        .locator('#photoShowList li >> nth=1 >> [data-photo-action=delete]')
        .click();
      await settle(page);
      assert.equal(await page.locator('#photoShowList li').count(), 2);
      assert.equal(
        await page.locator('#photoShowCount').innerText(),
        '2 / 50 photos'
      );
      const urls = await page.evaluate(() => window.__urls);
      assert.equal(
        urls.created - urls.revoked,
        2,
        'old thumbnail URLs revoked'
      );

      // Near-full and limit warnings.
      await seed(page, 45);
      await settle(page);
      assert(await page.locator('#photoShowWarning').isVisible());
      assert.equal(
        await page.locator('#photoShowWarning').innerText(),
        'Photo storage is almost full.'
      );
      await seed(page, 50);
      await settle(page);
      assert.equal(
        await page.locator('#photoShowWarning').innerText(),
        'Photo limit reached. Delete photos to add new ones.'
      );
      assert.equal(
        await page.locator('#photoShowCount').innerText(),
        '50 / 50 photos'
      );

      // Delete all asks for confirmation; Cancel keeps the photos.
      await page.locator('#photoShowClear').focus();
      await page.keyboard.press('Enter');
      await page.locator('#homeConfirmation').waitFor();
      await page.locator('#homeConfirmation button >> nth=0').click();
      await settle(page);
      assert.equal(await page.locator('#photoShowList li').count(), 50);
      await page.locator('#photoShowClear').click();
      await page.locator('#homeConfirmation button >> nth=1').click();
      await settle(page);
      assert.equal(await page.locator('#photoShowList li').count(), 0);
      assert(await page.locator('#photoShowEmpty').isVisible());
      assert.match(
        await page.locator('#photoShowEmpty').innerText(),
        /Add photos from phone/
      );
      assert(await page.locator('#photoShowClear').isDisabled());
      assert(await page.locator('#photoShowWarning').isHidden());
      assert.equal(
        await active(page),
        'photoShowEnabled',
        'focus survives clear'
      );

      // Leaving the category releases every thumbnail URL.
      await seed(page, 2);
      await settle(page);
      await page.locator('[data-category=wallpapers]').click();
      const released = await page.evaluate(() => window.__urls);
      assert.equal(
        released.created,
        released.revoked,
        'all thumb URLs revoked'
      );

      // Dutch strings are available once Home runs in Dutch.
      assert.equal(
        await page.evaluate(() => {
          const language = HomeI18n.language;
          HomeI18n.language = () => 'nl';
          const out = PhotoShowPanel.t('Photo show');
          HomeI18n.language = language;
          return out;
        }),
        'Fotoshow'
      );
      await page.evaluate(() =>
        PhotoShowStore.clear().then(() =>
          PhotoShowStore.saveSettings({ enabled: true, seconds: 10 })
        )
      );
      assert.deepEqual(errors, [], edition);
      console.log('PASS photo show panel', edition);
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
