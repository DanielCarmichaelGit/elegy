// Pure — no Next imports — so these can be unit-tested directly.

export function isValidEmail (email) {
  return typeof email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
}

// Max 72: bcrypt (what Supabase hashes passwords with) ignores anything past it.
export function isValidPassword (password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 72
}
