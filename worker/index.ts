import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { BATCH_SIZE, DAY, int, object, parsePlay, readEraRange, readFilters, text, type Play, type Requester } from '../shared/history'
import { authConfig, discordCallback, discordLogin, signedIn, signOut, type Env } from './auth'
import { syncPage } from './feed'
import { appendImport, artists, beginImport, playlist, remoteStorage, status, type Storage } from './storage'

const now = () => Math.floor(Date.now() / 1000)
const importId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id)
const feedUser = (env: Env) => env.LISTENBRAINZ_USER?.trim()

function connect(env: Env): Storage {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw new Error('Database not configured.')
  return remoteStorage(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN)
}

export function createApp(database = connect, discordFetch: Requester = fetch) {
  const app = new Hono<{ Bindings: Env }>()
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    c.header('X-Content-Type-Options', 'nosniff')
    if (c.req.method === 'POST' && c.req.header('Origin') !== c.env.APP_ORIGIN) return c.json({ error: 'Request origin was not accepted.' }, 403)
    await next()
  })
  app.onError((_error, c) => c.json({ error: 'The service is unavailable. Check the Worker and database setup, then retry.' }, 503))
  app.get('/api/session', async (c) => c.json({ signedIn: await signedIn(c), configured: !!authConfig(c.env) }))
  app.get('/api/auth/discord', discordLogin)
  app.get('/api/auth/discord/callback', (c) => discordCallback(c, discordFetch))
  app.use('/api/*', async (c, next) => {
    if (!await signedIn(c)) return c.json({ error: 'Sign in with Discord to continue.' }, 401)
    await next()
  })
  app.use('/api/*', bodyLimit({ maxSize: 262_144, onError: (c) => c.json({ error: 'This batch is too large.' }, 413) }))

  app.post('/api/logout', signOut)
  app.get('/api/status', async (c) => c.json(await status(database(c.env), !!feedUser(c.env))))
  app.post('/api/artists', async (c) => {
    const input = object(await c.req.json().catch(() => null))
    if (!input || typeof input.search !== 'string' || input.search.length > 300) return c.json({ error: 'Enter an artist name.' }, 400)
    return c.json(await artists(database(c.env), text(input.search)))
  })
  app.post('/api/playlist', async (c) => {
    const input = object(await c.req.json().catch(() => null))
    const filters = readFilters(input)
    const range = filters?.mode === 'era' ? readEraRange(filters.from, filters.to, input?.range) : undefined
    if (!filters || (filters.mode === 'era' ? !range : input?.range !== undefined)) return c.json({ error: 'Check the date range and playlist limits.' }, 400)
    return c.json(await playlist(database(c.env), filters, now(), range))
  })
  app.post('/api/import/start', async (c) => {
    const input = object(await c.req.json().catch(() => null))
    if (!input || !importId(input.id) || !int(input.count, 1, 10_000_000) || !int(input.first, 0, now() + DAY) || !int(input.last, input.first, now() + DAY) || typeof input.full !== 'boolean') return c.json({ error: 'Invalid archive details.' }, 400)
    const next = await beginImport(database(c.env), { id: input.id, count: input.count, first: input.first, last: input.last, full: input.full })
    return next === null ? c.json({ error: 'These archive details do not match the previous import.' }, 409) : c.json({ next })
  })
  app.post('/api/import/batch', async (c) => {
    const input = object(await c.req.json().catch(() => null))
    if (!input || !importId(input.id) || !int(input.offset, 0, 10_000_000) || !Array.isArray(input.rows) || !int(input.rows.length, 1, BATCH_SIZE)) return c.json({ error: 'Invalid archive batch.' }, 400)
    const stamp = now()
    const rows = input.rows.map((row) => parsePlay(row, stamp))
    if (rows.some((row) => !row)) return c.json({ error: 'This batch contains an invalid play.' }, 400)
    const result = await appendImport(database(c.env), input.id, input.offset, rows as Play[])
    return result.next === null || (!result.advanced && result.next === input.offset) ? c.json({ error: 'This batch does not match the archive cursor.' }, 409) : c.json(result)
  })
  app.post('/api/sync', async (c) => {
    const name = feedUser(c.env)
    if (!name) return c.json({ error: 'ListenBrainz is not configured.' }, 409)
    try { return c.json(await syncPage(database(c.env), name, now())) }
    catch { return c.json({ error: 'Could not sync ListenBrainz. Check the connection and try again.' }, 502) }
  })
  app.notFound((c) => c.json({ error: 'Not found.' }, 404))
  return app
}

const app = createApp()
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env) {
    const name = feedUser(env)
    if (name) await syncPage(connect(env), name, now())
  },
}
