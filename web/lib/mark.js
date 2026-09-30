// The Quilt mark: a Q pieced from four pastel patches, whose tail is a thread that waves just
// under "uilt" and ends in a sharp point. "uilt" is Poppins SemiBold as outlines (the brand kit's
// path, scaled into this drawing). Colours come from --qm-* in globals.css.
const UILT = 'M238.59507199999996 102.49600000000001V200.0H213.77907199999999V187.68Q209.02707199999998 194.016 201.37107199999997 197.624Q193.71507199999996 201.232 184.73907199999996 201.232Q173.29907199999997 201.232 164.49907199999996 196.392Q155.69907199999997 191.552 150.68307199999998 182.136Q145.667072 172.72 145.667072 159.696V102.49600000000001H170.30707199999998V156.176Q170.30707199999998 167.792 176.115072 174.04000000000002Q181.923072 180.288 191.95507199999997 180.288Q202.16307199999997 180.288 207.971072 174.04000000000002Q213.77907199999999 167.792 213.77907199999999 156.176V102.49600000000001ZM258.243072 76.44800000000001Q258.243072 70.28800000000001 262.555072 66.15200000000002Q266.86707199999995 62.01600000000002 273.37907199999995 62.01600000000002Q279.89107199999995 62.01600000000002 284.20307199999996 66.15200000000002Q288.515072 70.28800000000001 288.515072 76.44800000000001Q288.515072 82.608 284.20307199999996 86.744Q279.89107199999995 90.88000000000001 273.37907199999995 90.88000000000001Q266.86707199999995 90.88000000000001 262.555072 86.744Q258.243072 82.608 258.243072 76.44800000000001ZM285.52307199999996 102.49600000000001V200.0H260.88307199999997V102.49600000000001ZM332.45107199999995 69.76000000000002V200.0H307.81107199999997V69.76000000000002ZM383.42707199999995 122.736V169.904Q383.42707199999995 174.832 385.80307199999993 177.03199999999998Q388.17907199999996 179.232 393.81107199999997 179.232H405.25107199999997V200.0H389.76307199999997Q358.611072 200.0 358.611072 169.728V122.736H346.99507199999994V102.49600000000001H358.611072V78.384H383.42707199999995V102.49600000000001H405.25107199999997V122.736Z'
// Puts the outlines' baseline (y 200) at y 97, with the "u" starting at x 107.
const UILT_AT = 'matrix(.5525 0 0 .5525 26.5 -13.5)'

// The Q: a ring (centre 52,62, r 35) cut into four quarter patches, clockwise from the top.
// A circle's stroke starts at 3 o'clock, so 12 o'clock is 3 of its 4 units along.
const RING = [1, 2, 3, 4].map((n, i) =>
  `<circle class="qm-p qm-${n}" style="--o:${i}" cx="52" cy="62" r="35" pathLength="4" stroke-dasharray="1 3" stroke-dashoffset="${-((3 + i) % 4)}"/>`
).join('')

// The thread: a long gentle wave under the word, or a short curl for the Q on its own.
const THREAD_LONG = 'M73 86C81 102 94 110 112 110C132 110 140 104 160 104C180 104 188 111 208 111C228 111 236 105 256 105C264 105 270 106 276 107'
const TIP_LONG = 'M275.5 104.6Q288 107.4 301 111Q288 110.6 274.5 109.4Z'
const THREAD_SHORT = 'M73 86C79 97 86 104 95 107.6'
const TIP_SHORT = 'M95.9 105.3Q105 110 114 115Q104 112.6 94.1 109.9Z'

let sewn = false

/**
 * The mark as inline SVG.
 *  word:   the full "Quilt" lockup (default) or just the Q with a short tail
 *  sew:    sew the patches in once ('first' = only the first time this is called in the page)
 *  loop:   the loading animation (the Q pieces itself together and unpicks, over and over)
 */
export function quiltMark ({ word = true, sew = false, loop = false, cls = '' } = {}) {
  const doSew = sew === 'first' ? !sewn && (sewn = true) : !!sew
  const mode = loop ? ' qm-loop' : doSew ? ' qm-sew' : ''
  const thread = `<path class="qm-t" pathLength="1" d="${word ? THREAD_LONG : THREAD_SHORT}"/><path class="qm-tip" d="${word ? TIP_LONG : TIP_SHORT}"/>`
  const text = word ? `<path class="qm-w" transform="${UILT_AT}" d="${UILT}"/>` : ''
  const vb = word ? '8 18 296 98' : '8 18 108 100'
  return `<svg class="qm${word ? ' qm-word' : ' qm-sym'}${mode}${cls ? ' ' + cls : ''}" viewBox="${vb}" role="img" aria-label="${loop ? 'Loading' : 'Quilt'}">${RING}${thread}${text}</svg>`
}
