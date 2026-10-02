// Node prints "SQLite is an experimental feature" the moment node:sqlite loads, which
// Quilt does to read Cursor's chat database. The warning is known and harmless, so it is
// kept off people's terminals; every other warning is still printed as Node would.
const printers = process.listeners('warning')
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning && warning.name === 'ExperimentalWarning' && /sqlite/i.test(String(warning.message))) return
  for (const print of printers) print.call(process, warning)
})
