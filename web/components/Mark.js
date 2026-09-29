import { quiltMark } from '@/lib/mark.js'

// The pieced-Q mark as inline SVG (the same drawing the desktop app uses).
export default function Mark ({ word = true, sew = false, loop = false, className = '' }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: quiltMark({ word, sew, loop }) }} />
}
