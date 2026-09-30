import { RESOURCES, ALLOWED, OPS, LABELS, can } from '@/lib/permissions.js'

const OP_LABELS = { c: 'Create', r: 'Read', u: 'Update', d: 'Delete' }

// One row per resource, one checkbox per op the spec allows (other cells stay blank).
// You can't tick what you don't hold yourself, the API refuses it anyway.
export default function RoleGrid ({ grants, mine, isOwner = false, readOnly = false }) {
  return (
    <table className='grid-table'>
      <thead>
        <tr><th scope='col'>Permission</th>{OPS.map((op) => <th key={op} scope='col'>{OP_LABELS[op]}</th>)}</tr>
      </thead>
      <tbody>
        {RESOURCES.map((res) => (
          <tr key={res}>
            <th scope='row'>{LABELS[res]}{!ALLOWED[res].length && <span className='muted'> · coming with per-seat plans</span>}</th>
            {OPS.map((op) => (
              <td key={op}>
                {ALLOWED[res].includes(op) && (
                  <input
                    type='checkbox'
                    name={`g.${res}.${op}`}
                    aria-label={`${LABELS[res]}: ${OP_LABELS[op]}`}
                    defaultChecked={can(grants, res, op)}
                    disabled={readOnly || !(isOwner || can(mine, res, op))}
                  />)}
              </td>))}
          </tr>))}
      </tbody>
    </table>
  )
}
