import Header from '@/components/Header.js'

// The org layout does its own data fetching (org info, member role, tabs), so this covers
// both the layout and the page while that loads. Includes the Header so nothing shifts.
export default function Loading () {
  return (
    <>
      <Header />
      <main className='wrap page stack'>
        <div className='skeleton skeleton-title' />
        <div className='skeleton skeleton-tabs' />
        <div className='card skeleton-card' />
        <div className='card skeleton-card' />
      </main>
    </>
  )
}
