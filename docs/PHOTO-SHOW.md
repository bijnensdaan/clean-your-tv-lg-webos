# Apple theme and photo show (personal fork)

[Documentation](README.md) · [Controls](CONTROLS.md) · [Themes](THEMES.md)

This fork adds three things on top of release 1.19.0. None of them is verified on
a physical TV yet; the target is an LG BX (webOS 5, No-root).

## Apple theme

`builtin:apple` (`themes/apple/`) is derived from Liquid Glass: translucent
layers over an original dark backdrop, rounded tiles and soft shadows. Focus is
shown with a brighter fill, a deeper shadow and a light edge. It uses no blur,
`backdrop-filter`, transforms or author animations. Choose it under
**Settings → Themes → Apple**. After editing `themes/apple/`, commit the sources,
delete `launcher/themes/apple/` and run `node scripts/build-builtin-theme.cjs
themes/apple` and `node scripts/build-tv-theme-catalog.cjs`.

## Photo list

- Stored in a separate IndexedDB database `ctv-photo-show-v1` (stores `photos` and
  `meta`); the personal wallpaper database is unchanged.
- At most 50 photos (JPEG, PNG or WebP, at most 2 MiB each). A small JPEG thumbnail
  is stored with each photo so the settings list never decodes full images.
- A warning appears from 45 photos or when the TV reports less than 50 MiB free.
- **Settings → Photo show**: on/off, seconds per photo (5, 8, 10, 15, 20, 30, 60),
  move up/down, delete, delete all, and **Add photos from phone**.

## Adding photos from a phone

**Add photos from phone** starts a receiver session of kind `photos` (port 8879,
same QR code and `x-cytv-pin` PIN as the wallpaper flow). Choose several photos;
the phone page resizes each to fit 1920×1080 without cropping and encodes JPEG of
about 500 KB, then sends them one by one. The session keeps the same PIN while the
TV stores each photo, renews its 10-minute timeout after every photo, and closes
when the list is full, after **Done**, or when settings close. Wallpaper and theme
sessions are unchanged. The receiver code is shared, so the Root build contains
this session kind too, without Root UI.

## Idle slideshow

`launcher/photo-show.js` starts a full-screen slideshow after 60 seconds without
key or pointer input while Home is the active view (no settings, panel, move,
picker or edit mode). Any key or pointer movement stops it and is not passed on to
Home. Only two image layers exist and at most two photo URLs are alive; photos
crossfade by opacity and shift a few pixels each time to reduce OLED burn-in.
Home routing and the triple-Home emergency stop are not changed.

The idle time is 60 seconds because the LG OLED screensaver starts after a few
minutes without input (about two minutes observed on the BX) and also covers the
slideshow; webOS only skips it for full-screen video. The slideshow therefore runs
until the TV's own screensaver takes over.

## Preview

```sh
.venv-cytv/bin/python scripts/preview.py     # Windows: .venv-cytv\Scripts\python
```

Open `http://127.0.0.1:8765/?photos=demo&idle=5`, choose the Apple theme, then
open **Settings → Photo show**. `photos=demo` seeds six generated demo photos and
`idle=5` shortens the idle time to five seconds; both exist only in the preview.
The phone-to-TV upload cannot run in the preview because it needs the TV service.

## Tests

`npm run test:photo-show` covers the store, settings panel, receiver sessions,
phone page, panel receive flow and idle slideshow. Also run `npm run lint:compat`,
`npm run test:compat` and `npm run test:themes`.
