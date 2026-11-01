# Share image and icons

Sources for the pictures a link to Tessera shows elsewhere.

- `og.html` draws the 1200×630 share image (`public/og.png`) that chat apps
  and social sites show for a link. It loads the fonts from `node_modules`, so
  run `pnpm install` first.
- `icon.svg` is the favicon, also copied to `static/icon.svg`. `touch.svg` is
  the same mark without rounded corners, for `static/apple-touch-icon.png`
  (iOS rounds the corners itself and fills transparency with black).

To re-render from `apps/web`:

```sh
chrome --headless=new --hide-scrollbars --allow-file-access-from-files \
  --virtual-time-budget=3000 --window-size=1200,630 \
  --screenshot=public/og.png "file://$PWD/share/og.html"
chrome --headless=new --window-size=180,180 \
  --screenshot=static/apple-touch-icon.png "file://$PWD/share/touch.svg"
for s in 192 512; do chrome --headless=new --default-background-color=00000000 \
  --window-size=$s,$s --screenshot=static/icon-$s.png "file://$PWD/share/icon.svg"; done
```

`public/favicon.ico` is the 512 icon saved at 16, 32 and 48px.

`public/` is copied into `dist/` as it is, for files that need a fixed URL
(the share image, `favicon.ico`, `robots.txt`, `sitemap.xml`). `static/` is
referenced from the pages and bundled by Parcel.

Share image URLs are absolute (`https://tessera.qot.nz/og.png`) because
crawlers want them that way. When the image changes, bump the `?v=` on the
`og:image` and `twitter:image` tags so caches pick up the new one.
