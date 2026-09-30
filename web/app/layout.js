import { Poppins } from 'next/font/google'
import './globals.css'

const poppins = Poppins({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-poppins' })

export const metadata = {
  title: { default: 'Quilt', template: '%s · Quilt' },
  description: 'Build one project together, live: everyone in their own AI.',
  icons: { icon: '/favicon.svg' }
}

export default function RootLayout ({ children }) {
  return <html lang='en' className={poppins.variable}><body>{children}</body></html>
}
