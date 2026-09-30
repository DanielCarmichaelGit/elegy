import Header from '@/components/Header.js'

// Shown instantly on navigation while the dashboard's data loads. Includes the Header so
// nothing shifts when the real page swaps in.
export default function Loading () {
  return (
    <>
      <Header />
      <main className='wrap page stack'>
        <div className='skeleton skeleton-title' />
        <div className='card skeleton-card' />
        <div className='card skeleton-card' />
      </main>
    </>
  )
}
