import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { archiveRow, DAY, defaults, listenRow, playlistCsv, type Play, type Requester } from '../shared/history'
import { localDate, localEraRange, since } from '../src/dates'
import { seal } from '../worker/auth'
import { syncPage } from '../worker/feed'
import { createApp } from '../worker/index'
import { appendImport, artists, beginImport, playlist, status, writePlays, type Statement, type Storage } from '../worker/storage'

const schema = await Bun.file(new URL('../schema.sql', import.meta.url)).text()
const now = 1_795_392_000
const track = (letter: string) => letter.repeat(22)
const play = (letter: string, days: number, artist = 'North', ms = 90000): Play => [track(letter), now - DAY * days, `Track ${letter}`, artist, 'Night', ms]

function memory() {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(schema)
  const run = db.transaction((statements: Statement[]) => statements.map((s) => db.query(s.sql).run(...(s.args ?? [])).changes))
  const store: Storage = {
    read: async (s) => db.query(s.sql).all(...(s.args ?? [])) as Record<string, unknown>[],
    write: async (s) => run(s),
  }
  return store
}

async function add(db: Storage, id: string, rows: Play[], full = true) {
  const dates = rows.map((r) => r[1])
  expect(await beginImport(db, { id, count: rows.length, first: Math.min(...dates), last: Math.max(...dates), full })).toBe(0)
  return appendImport(db, id, 0, rows)
}

test('normalizes archive plays without keeping identifying fields or private entries', () => {
  const timestamp = '2019-01-29T20:05:00Z'
  const row = { ts: timestamp, spotify_track_uri: `spotify:track:${track('a')}`, master_metadata_track_name: '  Track   A ', master_metadata_album_artist_name: 'North', master_metadata_album_name: 'Night', ms_played: 51000, ip_addr: '192.0.2.1', platform: 'test', username: 'fixture' }
  expect(archiveRow(row)).toEqual([track('a'), Date.parse(timestamp) / 1000, 'Track A', 'North', 'Night', 51000])
  expect(archiveRow({ ...row, incognito_mode: true })).toBe('private')
  expect(archiveRow({ ...row, spotify_track_uri: null })).toBeUndefined()
  expect(archiveRow({ ...row, ts: '2019-01-29' })).toBeUndefined()
})

test('resumes idempotently and applies archive precedence only once coverage is complete', async () => {
  const db = memory()
  const first = play('a', 500)
  const last = play('b', 400)
  const overlap = play('a', 499)
  const later = play('a', 399)
  await db.write(writePlays([overlap, later], 1, { sql: 'SELECT 1' }))
  const manifest = { id: 'fixture', count: 2, first: first[1], last: last[1], full: true }
  expect(await beginImport(db, manifest)).toBe(0)
  expect(await appendImport(db, manifest.id, 0, [first])).toEqual({ inserted: 1, next: 1, advanced: true })
  expect(await appendImport(db, manifest.id, 0, [first])).toEqual({ inserted: 0, next: 1, advanced: false })
  expect(await beginImport(db, manifest)).toBe(1)
  expect((await status(db, true)).coverage).toEqual([])
  expect((await playlist(db, defaults('forgotten'), now))[0]?.plays).toBe(3)
  expect(await appendImport(db, manifest.id, 1, [last])).toEqual({ inserted: 1, next: 2, advanced: true })
  expect((await playlist(db, defaults('forgotten'), now))[0]?.plays).toBe(2)
  expect((await status(db, true)).coverage).toEqual([{ first: first[1], last: last[1] }])
})

test('queries lifetime, era, exact artist, cap and qualifying duration independently', async () => {
  const db = memory()
  await add(db, 'history', [play('a', 600), play('a', 400), play('a', 1, 'North', 1000), play('b', 418), play('b', 420), play('c', 422, 'North Star'), play('c', 430, 'North Star'), play('d', 415, 'South'), play('d', 414, 'South'), play('d', 20, 'South')])
  const forgotten = defaults('forgotten')
  expect((await playlist(db, forgotten, now)).map((r) => r.id)).toEqual(['c', 'b', 'a'].map(track))
  expect((await playlist(db, { ...forgotten, artist: 'north' }, now)).map((r) => r.id)).toEqual(['b', 'a'].map(track))
  expect((await playlist(db, { ...forgotten, perArtist: 1 }, now)).map((r) => r.id)).toEqual(['c', 'b'].map(track))
  const date = new Date(play('d', 415)[1] * 1000).toISOString().slice(0, 10)
  expect(await playlist(db, { ...defaults('era'), from: date, to: date }, now)).toEqual([{ id: track('d'), title: 'Track d', artist: 'South', album: 'Night', plays: 1, last: play('d', 20)[1] }])
  expect((await artists(db, 'NORTH')).map((r) => r.name)).toEqual(['North', 'North Star'])
})

test('local dates and era bounds follow daylight saving time and the calendar day', () => {
  const previous = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const stamp = (iso: string) => Date.parse(iso) / 1000
    expect(localDate(new Date('2025-01-01T02:00:00Z'))).toBe('2024-12-31')
    expect(localEraRange('2024-03-10', '2024-03-10')).toEqual([stamp('2024-03-10T05:00:00Z'), stamp('2024-03-11T04:00:00Z')])
    expect(localEraRange('2024-11-03', '2024-11-03')).toEqual([stamp('2024-11-03T04:00:00Z'), stamp('2024-11-04T05:00:00Z')])
    expect(localEraRange('2024-02-30', '2024-03-01')).toBeUndefined()
    expect(since(stamp('2024-03-10T04:59:00Z'), new Date('2024-03-10T05:01:00Z'))).toBe('1 day ago')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

function external(time: number, letter = 'a') {
  return { listened_at: time, track_metadata: { track_name: 'Track', artist_name: 'North', release_name: 'Night', additional_info: { origin_url: `https://open.spotify.com/track/${track(letter)}`, duration_ms: 123456, music_service: 'spotify.com', submission_client: 'listenbrainz' } } }
}

test('feed keeps unknown played time separate from total track length', () => {
  expect(listenRow(external(now))).toEqual([track('a'), now, 'Track', 'North', 'Night', null, ['North']])
  const row = external(now)
  row.track_metadata.additional_info.submission_client = 'Spotify Extended Streaming History Importer'
  expect(listenRow(row)).toBeUndefined()
  row.track_metadata.additional_info.submission_client = 'listenbrainz'
  row.track_metadata.additional_info.origin_url = 'https://example.test/track/other'
  expect(listenRow(row)).toBeUndefined()
})

test('pages a feed backwards beyond 30 days and keeps the checkpoint after a failed fetch', async () => {
  const db = memory()
  const page = Array.from({ length: 60 }, (_, i) => external(now - 100 * DAY - i))
  const request: Requester = async (url) => {
    const cursor = Number(new URL(String(url)).searchParams.get('max_ts'))
    return Response.json({ payload: { listens: page.filter((r) => r.listened_at < cursor).slice(0, 48) } })
  }
  expect(await syncPage(db, 'fixture', now, request)).toEqual({ pending: true, synced: null })
  await expect(syncPage(db, 'fixture', now, async () => new Response(null, { status: 502 }))).rejects.toThrow()
  expect((await status(db, true)).feed).toEqual({ enabled: true, synced: null, error: true, pending: true })
  expect(await syncPage(db, 'fixture', now, request)).toEqual({ pending: false, synced: now })
  expect((await status(db, true)).live.n).toBe(60)
})

const origin = 'https://retrace.example.test'
const env = { APP_ORIGIN: origin, DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'fixture', DISCORD_OWNER_ID: '987654321098765432', SESSION_SECRET: 'test-only-secret-that-is-not-used-in-production' }
const get = (url: string, cookie?: string) => new Request(`${origin}${url}`, { headers: cookie ? { cookie } : undefined })
const cookiePair = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0]

test('era queries include local midnight and exclude the next day from the results', async () => {
  const db = memory()
  const start = Date.parse('2024-03-10T05:00:00Z') / 1000
  const end = Date.parse('2024-03-11T04:00:00Z') / 1000
  const times = [start - 1, start, end - 1, end]
  await add(db, 'local-day', times.map((time, i) => [track(String(i)), time, `Track ${i}`, 'North', 'Night', 90000]))
  const app = createApp(() => db)
  const value = await seal(env.SESSION_SECRET, { kind: 'session', owner: env.DISCORD_OWNER_ID, exp: Math.floor(Date.now() / 1000) + 600 })
  const query = (body: unknown) => app.request(`${origin}/api/playlist`, {
    method: 'POST', headers: { origin, cookie: `__Host-retrace-session=${value}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, env)
  const filters = { ...defaults('era'), from: '2024-03-10', to: '2024-03-10' }
  const local = await query({ ...filters, range: [start, end] })
  expect(local.status).toBe(200)
  const ids = async (response: Response) => (await response.json() as { id: string }[]).map((r) => r.id)
  expect(await ids(local)).toEqual([track('2'), track('1')])
  expect(await ids(await query(filters))).toEqual([track('1'), track('0')])
  expect((await query({ ...filters, range: [start - 2 * DAY, end] })).status).toBe(400)
  expect((await query({ ...defaults('forgotten'), range: [start, end] })).status).toBe(400)
})

test('session gates every application API, including expired sessions and cross-origin writes', async () => {
  const db = memory()
  const app = createApp(() => db)
  for (const path of ['/api/status', '/api/artists', '/api/playlist', '/api/import/start', '/api/import/batch', '/api/sync']) {
    const method = path === '/api/status' ? 'GET' : 'POST'
    const response = await app.fetch(new Request(origin + path, { method, headers: { origin } }), env)
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
  }
  const expired = await seal(env.SESSION_SECRET, { kind: 'session', owner: env.DISCORD_OWNER_ID, exp: 1 })
  const wrongOwner = await seal(env.SESSION_SECRET, { kind: 'session', owner: '111111111111111111', exp: Math.floor(Date.now() / 1000) + 600 })
  for (const value of [expired, wrongOwner, 'invalid']) expect((await app.fetch(get('/api/status', `__Host-retrace-session=${value}`), env)).status).toBe(401)
  expect((await app.fetch(new Request(`${origin}/api/logout`, { method: 'POST', headers: { origin: 'https://elsewhere.test' } }), env)).status).toBe(403)
})

test('Discord state, PKCE and exact owner check lead to a private session', async () => {
  const db = memory()
  let discordOwner = '111111111111111111'
  let exchangeCount = 0
  const discord: Requester = async (url, init) => {
    expect(init?.redirect).toBe('manual')
    if (String(url).endsWith('/oauth2/token')) {
      exchangeCount++
      expect(init?.body).toBeInstanceOf(URLSearchParams)
      expect((init!.body as URLSearchParams).get('code_verifier')).toMatch(/^[\w-]{43}$/)
      return Response.json({ access_token: 'fixture', token_type: 'Bearer', scope: 'identify' })
    }
    expect(String(url)).toBe('https://discord.com/api/v10/users/@me')
    return Response.json({ id: discordOwner })
  }
  const app = createApp(() => db, discord)
  async function flow() {
    const start = await app.fetch(get('/api/auth/discord'), env)
    const flow = cookiePair(start, '__Host-retrace-flow')
    const link = new URL(start.headers.get('location')!)
    expect(link.searchParams.get('scope')).toBe('identify')
    expect(link.searchParams.get('code_challenge_method')).toBe('S256')
    return { flow, path: `/api/auth/discord/callback?code=fixture&state=${link.searchParams.get('state')}` }
  }
  const first = await flow()
  expect((await app.fetch(get(first.path + 'bad', first.flow), env)).headers.get('location')).toBe('/?login=invalid')
  expect(exchangeCount).toBe(0)
  expect((await app.fetch(get(first.path, first.flow), env)).headers.get('location')).toBe('/?login=not-owner')
  discordOwner = env.DISCORD_OWNER_ID
  const second = await flow()
  const signed = await app.fetch(get(second.path, second.flow), env)
  expect(signed.headers.get('location')).toBe('/')
  const cookie = cookiePair(signed, '__Host-retrace-session')
  expect(cookie).toBeDefined()
  expect((await app.fetch(get('/api/status', cookie), env)).status).toBe(200)
  expect((await app.fetch(new Request('https://preview.example.test/api/status', { headers: { cookie: cookie! } }), env)).status).toBe(401)
})

test('exports Spotify URLs with CSV quoting and protects spreadsheet cells', () => {
  expect(playlistCsv([{ id: track('a'), title: '=bad', artist: 'A, B', album: 'A "quote"', plays: 7, last: now }])).toBe(`title,artist,album,url\r\n"'=bad","A, B","A ""quote""","https://open.spotify.com/track/${track('a')}"\r\n`)
})
