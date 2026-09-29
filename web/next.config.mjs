// The Quilt website: sign-in, accounts and downloads (the app itself is the desktop app).
export default {
  poweredByHeader: false,
  // /link's Approve button must never be clickjacked into an invisible iframe
  async headers () {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }
      ]
    }]
  }
}
