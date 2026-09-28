// A minimal event emitter that works in browsers and Node. on() returns an unsubscribe function.
export class Emitter {
  constructor () { this._handlers = new Map() }

  on (name, fn) {
    if (!this._handlers.has(name)) this._handlers.set(name, new Set())
    this._handlers.get(name).add(fn)
    return () => this._handlers.get(name)?.delete(fn)
  }

  emit (name, ...args) {
    for (const fn of [...(this._handlers.get(name) || [])]) {
      try { fn(...args) } catch (err) { console.error(err) }
    }
  }
}
