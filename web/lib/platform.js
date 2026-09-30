// Which app download to offer. Browsers on Apple silicon still say "Intel Mac",
// so Macs get the Apple silicon build with the Intel one offered next to it.
const RELEASE = 'https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download'

export const DOWNLOADS = {
  macArm: { os: 'mac', label: 'Download for Mac', fine: 'Mac', href: `${RELEASE}/quilt-mac-arm64.dmg` },
  macIntel: { os: 'mac', label: 'Mac with Intel', fine: 'Intel Mac', href: `${RELEASE}/quilt-mac-x64.dmg` },
  windows: { os: 'windows', label: 'Download for Windows', fine: 'Windows', href: `${RELEASE}/quilt-windows-x64.exe` }
}

export function downloadFor (userAgent = '') {
  if (/Macintosh|Mac OS X/.test(userAgent)) return DOWNLOADS.macArm
  if (/Windows/.test(userAgent)) return DOWNLOADS.windows
  return null
}

// The fuller pick used by the landing page's client-side download buttons: which button(s) to
// show as the primary call to action, and which builds belong in the fine print underneath.
// `platform`/`architecture` come from navigator.userAgentData.getHighEntropyValues(); `ua` is a
// fallback user-agent string for when high-entropy values aren't available (e.g. the server).
export function pickDownloads ({ platform = '', architecture = '', ua = '' } = {}) {
  const p = String(platform).toLowerCase()
  const arch = String(architecture).toLowerCase()
  const isMac = p.includes('mac') || (!p && /Macintosh|Mac OS X/.test(ua))
  const isWin = p.includes('win') || (!p && /Windows/.test(ua))

  if (isMac) {
    // Browsers report "Intel" even on Apple silicon; only trust an explicit "x86" architecture.
    const isArm = arch !== 'x86'
    const primary = isArm ? DOWNLOADS.macArm : { ...DOWNLOADS.macIntel, label: 'Download for Mac' }
    const otherMac = isArm ? DOWNLOADS.macIntel : DOWNLOADS.macArm
    return { primary: [primary], others: [otherMac, DOWNLOADS.windows] }
  }
  if (isWin) return { primary: [DOWNLOADS.windows], others: [DOWNLOADS.macArm] }
  // Can't tell (Safari, Firefox, Linux, mobile, or detection failed): offer both.
  return { primary: [DOWNLOADS.macArm, DOWNLOADS.windows], others: [DOWNLOADS.macIntel] }
}
