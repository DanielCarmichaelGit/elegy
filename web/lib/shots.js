// The homepage screenshots, pre-sized as WebP (public/shots/<name>-<width>.webp) so the static
// page serves small files straight from the CDN. The originals are 2560x1600.
export const SHOT_WIDTHS = [640, 1280, 1920]
export const SHOT_RATIO = { width: 1600, height: 1000 }

export const shotSrc = (name, width = 1280) => `/shots/${name}-${width}.webp`
export const shotSrcSet = (name) => SHOT_WIDTHS.map((w) => `${shotSrc(name, w)} ${w}w`).join(', ')
