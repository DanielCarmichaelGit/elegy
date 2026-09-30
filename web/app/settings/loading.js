import Header from '@/components/Header.js'

// Shown instantly on navigation while settings loads. Includes the Header so nothing shifts.
export default function Loading () {
  return (
    <>
      <Header />
      <main className='wrap page stack' style={{ maxWidth: 640 }}>
        <div className='skeleton skeleton-title' />
        <div className='card skeleton-card' />
        <div className='card skeleton-card' />
      </main>
    </>
  )
}
