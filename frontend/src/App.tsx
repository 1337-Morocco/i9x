import { useEffect, useState } from 'react'
import Desktop from './desktop/Desktop'
import Login from './Login'
import { authapi, getToken, setToken } from './api/auth'
import './App.css'

function App() {
  // undefined = still checking, null = logged out, object = logged in
  const [auth, setAuth] = useState<{ name: string } | null | undefined>(undefined)

  useEffect(() => {
    if (!getToken()) {
      setAuth(null)
      return
    }
    authapi
      .me()
      .then((u) => setAuth({ name: u.name || u.email }))
      .catch(() => { setToken(null); setAuth(null) })
  }, [])

  if (auth === undefined) return <div className="boot" />
  if (!auth) return <Login onAuthed={(name) => setAuth({ name })} />

  return (
    <Desktop
      username={auth.name}
      onLogout={async () => { await authapi.logout(); setToken(null); setAuth(null) }}
    />
  )
}

export default App
