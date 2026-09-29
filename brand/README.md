# Quilt: logo guidelines

## 1. The logo
- **Idea:** the Q is pieced like a real quilt block, from squares and half-square triangles that round its
  corners. Many pieces, one whole: which is what Quilt does for people and their AIs.
- **Construction:** a 6 × 6 grid. The Q's bowl is 5 × 5; the tail runs out on the diagonal into the sixth row
  and column. Every patch is its own shape; the seams between them are real gaps (7.8 % of a cell).
- **Versions:**
  - `logo/quilt-horizontal.svg`: primary. The pieced Q replaces the Q of "Quilt" (Poppins SemiBold, outlined).
  - `logo/quilt-stacked.svg`: the block over the wordmark, for square spaces.
  - `logo/quilt-symbol.svg`: the pieced Q alone.
  - `logo/quilt-icon.svg`: the whole quilt block (Q plus muslin ground) on a cream tile: the app icon.
  - `logo/quilt-symbol-small.svg`: the small-size cut (no seams, one colour); used for 16–32 px and favicons.
  - `-dark` versions: for dark backgrounds (lighter fabrics, cream wordmark).
  - `one-colour/`: black, white and madder versions for single-colour printing, embroidery and stamps.
  - `web/`: favicon.ico / favicon.svg, apple-touch-icon, 192/512 and maskable icons, `site.webmanifest`,
    and `head-snippet.html` to paste into a page's `<head>`.

## 2. Clear space
Keep **one grid cell** (one square of the Q) clear on every side. The zone scales with the logo.

## 3. Minimum size
| Version | Screen | Print |
|---|---|---|
| Horizontal | 96 px wide | 25 mm wide |
| Symbol / icon (full detail) | 40 px | 10 mm |
| Below that | use `quilt-symbol-small.svg` / the favicon files, down to 16 px | 6 mm |

## 4. Colour
| Name | HEX | RGB | CMYK (approx.) | Use |
|---|---|---|---|---|
| Madder | `#C4472F` | 196, 71, 47 | 0 64 76 23 | Lead fabric: squares of the Q, the tail square |
| Oxblood | `#8F2F22` | 143, 47, 34 | 0 67 76 44 | Second fabric: alternating squares |
| Indigo | `#2F5D62` | 47, 93, 98 | 52 5 0 62 | Accent: the triangles that round the corners and piece the tail |
| Muslin | `#EADFCD` | 234, 223, 205 | 0 5 12 8 | Ground fabric: the block behind the Q (app icon, stacked logo) |
| Cream | `#F6F2EA` | 246, 242, 234 | 0 2 5 4 | Page background and icon tile |
| Ink | `#211D18` | 33, 29, 24 | 0 12 27 87 | The wordmark "uilt"/"Quilt" and text |

The fabrics always keep their places: madder and oxblood alternate like a checkerboard, and indigo is only used for
triangles. **Approved pairs:** full colour on cream or white · dark version on ink · one-colour black on light ·
one-colour white on dark or on madder.
CMYK values are straight conversions. Proof them on press and match Pantone there if you need spot colours.

## 5. Typography
- Wordmark and headlines: **Poppins SemiBold** (the wordmark is outlined, so don't retype it).
  Body text: Poppins Regular/Medium · code: IBM Plex Mono · web fallback: system-ui, sans-serif.
- Licences: Poppins and IBM Plex Mono are both SIL Open Font License, so they're free for logos and apps.

## 6. Don'ts
Don't recolour patches or shuffle the checkerboard · don't remove seams at large sizes (or add them at small sizes:
use the small cut) · don't stretch, rotate or skew the grid · don't add shadows, outlines, gradients or textures ·
don't rearrange the lockups or change the space between the Q and "uilt" · don't set the wordmark in live text.

## 7. Files
Masters are SVG. PNGs are exports. Built with the logo-design skill (kaankiziltug/logo-design-skill).
A trademark search is still needed before registering the mark.
