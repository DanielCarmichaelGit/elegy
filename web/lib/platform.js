// Which app download to offer. Browsers on Apple silicon still say "Intel Mac",
// so Macs get the Apple silicon build with the Intel one offered next to it.
const RELEASE = 'https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download'

export const DOWNLOADS = {
  macArm: { label: 'Download for Mac', href: `${RELEASE}/quilt-mac-arm64.dmg` },
  macIntel: { label: 'Mac with Intel', href: `${RELEASE}/quilt-mac-x64.dmg` },
  windows: { label: 'Download for Windows', href: `${RELEASE}/quilt-windows-x64.exe` }
}

export function downloadFor (userAgent = '') {
  if (/Macintosh|Mac OS X/.test(userAgent)) return DOWNLOADS.macArm
  if (/Windows/.test(userAgent)) return DOWNLOADS.windows
  return null
}
