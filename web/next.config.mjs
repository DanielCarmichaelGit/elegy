// The Quilt website: sign-in, accounts and downloads (the app itself is the desktop app).
export default {
  poweredByHeader: false,
  // Orgs are only made by signing up as an org; the old "create an org" page moved.
  async redirects () {
    return [{ source: '/orgs/new', destination: '/signup/org', permanent: false }]
  },
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
