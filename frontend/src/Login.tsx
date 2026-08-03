import { useEffect, useState } from 'react'
import { FiMail, FiLock, FiUser, FiArrowRight } from 'react-icons/fi'
import { authapi, setToken } from './api/auth'

// Login / first-run setup gate. When no account exists yet, the server reports
// setup=true and we show the "create owner account" form; afterwards it's a
// plain email + password login (sign-ups are closed).
export default function Login({ onAuthed }: { onAuthed: (name: string) => void }) {
  const [setup, setSetup] = useState<boolean | null>(null)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    authapi.status().then((s) => setSetup(s.setup)).catch(() => setSetup(false))
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = setup
        ? await authapi.register(email.trim(), password, name.trim())
        : await authapi.login(email.trim(), password)
      setToken(res.token)
      onAuthed(res.name)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">◈</div>
        <h1 className="login-title">i9x</h1>
        <p className="login-sub">
          {setup ? 'Create your account to get started' : 'Sign in to your account'}
        </p>

        {setup && (
          <label className="login-field">
            <FiUser className="login-ico" />
            <input
              autoFocus
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}

        <label className="login-field">
          <FiMail className="login-ico" />
          <input
            autoFocus={!setup}
            type="email"
            placeholder="Email"
            value={email}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="login-field">
          <FiLock className="login-ico" />
          <input
            type="password"
            placeholder={setup ? 'Password (min 8 characters)' : 'Password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <div className="login-error">{error}</div>}

        <button className="login-btn" type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? 'Please wait…' : setup ? 'Create account' : 'Sign in'}
          <FiArrowRight />
        </button>

        {setup === false && (
          <div className="login-switch">Need an account? Ask an administrator to create one.</div>
        )}
      </form>
    </div>
  )
}
