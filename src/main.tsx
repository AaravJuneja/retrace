import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/figtree'
import { Archive } from './Archive'
import { Rediscover } from './Rediscover'
import { api, errorText, readStatus, session, sync } from './api'
import './style.css'

const loginMessages: Record<string, string> = {
  unconfigured: 'Discord sign-in isn’t set up yet.',
  cancelled: 'Discord sign-in was cancelled.',
  invalid: 'This sign-in link expired or was invalid. Start sign-in again.',
  unavailable: 'Discord sign-in is temporarily unavailable. Try again later.',
  'not-owner': 'Only the owner’s Discord account can sign in.',
}

function BackgroundSync() {
  const client = useQueryClient()
  const { data } = useQuery({ queryKey: ['status'], queryFn: readStatus })
  const enabled = !!data?.feed.enabled
  useEffect(() => {
    if (!enabled) return
    let active = true
    void (async () => {
      try {
        for (let page = 0; active && page < 16; page++) if (!(await sync()).pending) break
      } catch {
      } finally {
        if (active) await Promise.all(['status', 'playlist', 'artists'].map((name) => client.invalidateQueries({ queryKey: [name] })))
      }
    })()
    return () => { active = false }
  }, [client, enabled])
  return null
}

function Brand() {
  return <Link className="brand" to="/" search={{}} aria-label="Retrace home">
    <img src="/mark.svg" alt="" width="22" height="22" />
    Retrace
  </Link>
}

function Shell() {
  const client = useQueryClient()
  const identity = useQuery({ queryKey: ['session'], queryFn: session })
  const { login } = rootRoute.useSearch()
  const logout = useMutation({
    mutationFn: () => api('logout', {}),
    onSuccess: () => {
      client.setQueryData(['session'], { signedIn: false, configured: true })
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
    },
  })
  return <>
    <header className="top"><div className="wrap top-inner">
      <Brand />
      {identity.data?.signedIn && <>
        <nav aria-label="Workspace"><Link to="/" search={{}} activeOptions={{ exact: true }}>Rediscover</Link><Link to="/archive">Archive</Link></nav>
        <button className="logout" onClick={() => logout.mutate()} disabled={logout.isPending}>Sign out</button>
      </>}
    </div></header>
    {identity.data?.signedIn ? <><BackgroundSync />{logout.isError && <p className="wrap notice" role="alert">{errorText(logout.error)}</p>}<Outlet /></> : <main className="wrap main">
      <section className="gate">
        <h1>Find the music you used to play.</h1>
        <p>A private workspace for your Spotify listening history.</p>
        {identity.isPending ? <p role="status">Checking sign-in…</p> : identity.isError ? <p role="alert">{errorText(identity.error)} <button onClick={() => void identity.refetch()}>Retry</button></p> : <>
          {login && loginMessages[login] ? <p className="notice" role="alert">{loginMessages[login]}</p> : !identity.data?.configured && <p className="notice">Discord sign-in isn’t set up yet.</p>}
          {identity.data?.configured && <a className="primary button" href="/api/auth/discord">Sign in with Discord</a>}
        </>}
      </section>
    </main>}
  </>
}

const rootRoute = createRootRoute({ component: Shell, validateSearch: (search): { login?: string } => typeof search.login === 'string' ? { login: search.login } : {} })
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: Rediscover }),
  createRoute({ getParentRoute: () => rootRoute, path: '/archive', component: Archive }),
])
const router = createRouter({ routeTree })
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
