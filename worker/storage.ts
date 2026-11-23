import { createClient } from '@tursodatabase/serverless/compat'
import { DAY, key, utcEraRange, type Artist, type Filters, type Manifest, type Play, type Status, type Summary, type Track } from '../shared/history'

export type Member = string | number | null
export type Statement = { sql: string; args?: Member[] }
export type Row = Record<string, unknown>
export type Storage = {
  read: (statement: Statement) => Promise<Row[]>
  write: (statements: Statement[]) => Promise<number[]>
}

export function remoteStorage(url: string, token: string): Storage {
  const client = createClient({ url, authToken: token })
  return {
    read: async (statement) => (await client.execute(statement)).rows,
    write: async (statements) => (await client.batch(statements, 'write')).map((result) => result.rowsAffected),
  }
}

export function pack(plays: Play[]) {
  const tracks = new Map<string, { id: string; title: string; artist: string; ak: string; album: string; bk: string; credits: Map<string, string> }>()
  for (const [id, , title, artist, album, , credits] of plays) {
    const track = tracks.get(id) ?? { id, title, artist, ak: key(artist), album, bk: key(album), credits: new Map() }
    for (const name of (credits?.length ? credits : [artist])) if (name) track.credits.set(key(name), name)
    tracks.set(id, track)
  }
  return {
    tracks: JSON.stringify([...tracks.values()].map(({ credits, ...track }) => ({ ...track, credits: [...credits] }))),
    plays: JSON.stringify(plays.map(([id, time, , , , ms]) => [id, time, ms])),
  }
}

export function writePlays(plays: Play[], source: 0 | 1, gate: Statement): Statement[] {
  if (!plays.length) return []
  const packed = pack(plays)
  const where = `WHERE EXISTS (${gate.sql})`
  return [
    {
      sql: `INSERT INTO tracks (id, title, artist, artist_key, album, album_key)
            SELECT value->>'id', value->>'title', value->>'artist', value->>'ak', value->>'album', value->>'bk'
            FROM json_each(?) ${where}
            ON CONFLICT(id) DO UPDATE SET
              title = COALESCE(NULLIF(tracks.title, ''), excluded.title),
              artist = COALESCE(NULLIF(tracks.artist, ''), excluded.artist),
              artist_key = COALESCE(NULLIF(tracks.artist_key, ''), excluded.artist_key),
              album = COALESCE(NULLIF(tracks.album, ''), excluded.album),
              album_key = COALESCE(NULLIF(tracks.album_key, ''), excluded.album_key)
            WHERE (tracks.title = '' AND excluded.title != '') OR (tracks.artist = '' AND excluded.artist != '')
              OR (tracks.album = '' AND excluded.album != '')`,
      args: [packed.tracks, ...(gate.args ?? [])],
    },
    {
      sql: `INSERT OR IGNORE INTO track_artists (name_key, track_id, name)
            SELECT c.value->>0, t.value->>'id', c.value->>1
            FROM json_each(?) AS t, json_each(t.value->'credits') AS c ${where}`,
      args: [packed.tracks, ...(gate.args ?? [])],
    },
    {
      sql: `INSERT OR IGNORE INTO plays (source, time, track_id, ms)
            SELECT ?, value->>1, value->>0, value->>2 FROM json_each(?) ${where}`,
      args: [source, packed.plays, ...(gate.args ?? [])],
    },
  ]
}

export async function importState(db: Storage, id: string) {
  const [row] = await db.read({ sql: 'SELECT n, next, first, last, full FROM archive_imports WHERE id = ?', args: [id] })
  return row ? { n: Number(row.n), next: Number(row.next), first: Number(row.first), last: Number(row.last), full: Boolean(row.full) } : null
}

export async function beginImport(db: Storage, manifest: Manifest) {
  const { id, count, first, last, full } = manifest
  const [row] = await db.read({
    sql: `INSERT INTO archive_imports (id, n, first, last, full) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET full = MAX(archive_imports.full, excluded.full)
          WHERE archive_imports.n = excluded.n AND archive_imports.first = excluded.first AND archive_imports.last = excluded.last
          RETURNING next`,
    args: [id, count, first, last, Number(full)],
  })
  return row ? Number(row.next) : null
}

export async function appendImport(db: Storage, id: string, offset: number, plays: Play[]) {
  const next = offset + plays.length
  const statement = { sql: 'SELECT 1 FROM archive_imports WHERE id = ? AND next = ? AND n >= ? AND first <= ? AND last >= ?',
    args: [id, offset, next, Math.min(...plays.map((p) => p[1])), Math.max(...plays.map((p) => p[1]))] }
  const [,, inserted, advanced] = await db.write([
    ...writePlays(plays, 0, statement),
    { sql: `UPDATE archive_imports SET next = ? WHERE EXISTS (${statement.sql}) AND id = ?`, args: [next, ...statement.args, id] },
  ])
  return { inserted, next: advanced ? next : (await importState(db, id))?.next ?? null, advanced: !!advanced }
}

export async function status(db: Storage, enabled: boolean): Promise<Status> {
  const [counts, coverage, feed] = await Promise.all([
    db.read({ sql: 'SELECT source, COUNT(*) AS n, MIN(time) AS first, MAX(time) AS last FROM plays GROUP BY source' }),
    db.read({ sql: 'SELECT first, last FROM archive_imports WHERE full = 1 AND next = n ORDER BY first' }),
    db.read({ sql: 'SELECT success, cursor, error FROM feed_state WHERE id = 1' }),
  ])
  function describe(source: 0 | 1): Summary {
    const row = counts.find((c) => Number(c.source) === source)
    return row ? { n: Number(row.n), first: Number(row.first), last: Number(row.last) } : { n: 0, first: null, last: null }
  }
  return {
    archive: describe(0), live: describe(1), coverage: coverage.map((x) => ({ first: Number(x.first), last: Number(x.last) })),
    feed: { enabled, synced: feed[0]?.success == null ? null : Number(feed[0].success), error: !!feed[0]?.error, pending: feed[0]?.cursor != null },
  }
}

export async function artists(db: Storage, search: string): Promise<Artist[]> {
  const args = search ? [key(search)] : []
  const rows = await db.read({
    sql: `SELECT name_key, MIN(name) AS name FROM track_artists ${search ? 'WHERE instr(name_key, ?) > 0' : ''}
          GROUP BY name_key ORDER BY ${search ? 'name_key' : 'COUNT(*) DESC, name_key'} LIMIT 30`, args,
  })
  return rows.map((r) => ({ key: String(r.name_key), name: String(r.name) }))
}

export async function playlist(db: Storage, filters: Filters, now: number, range = utcEraRange(filters.from, filters.to)): Promise<Track[]> {
  const { artist, album, quiet, min, max, perArtist, limit, mode } = filters
  const window = range ? 'p.time >= ? AND p.time < ?' : '1 = 1'
  const matches = [artist && 'EXISTS (SELECT 1 FROM track_artists AS a WHERE a.name_key = ? AND a.track_id = t.id)', album && 't.album_key = ?'].filter(Boolean)
  const order = mode === 'deep-cuts' ? 'hits ASC, last ASC' : mode === 'era' ? 'hits DESC, window_last DESC' : 'hits DESC, last ASC'
  const cap = artist ? null : perArtist
  const conditions = ['hits >= ?', max !== null && 'hits <= ?', quiet > 0 && 'last <= ?'].filter(Boolean).join(' AND ')
  const selected = cap ? 'SELECT *, ROW_NUMBER() OVER (PARTITION BY artist_key ORDER BY ' + order + ', id) AS artist_rank FROM matches' : 'SELECT * FROM matches'
  const timeArgs = range ?? []
  const rows = await db.read({
    sql: `WITH selected AS (
            SELECT t.* FROM tracks AS t ${matches.length ? `WHERE ${matches.join(' AND ')}` : ''}
          ), counts AS (
            SELECT t.id, t.title, t.artist, t.album, t.artist_key,
              SUM(CASE WHEN ${window} THEN 1 ELSE 0 END) AS hits,
              MAX(CASE WHEN ${window} THEN p.time END) AS window_last,
              MAX(p.time) AS last
            FROM selected t JOIN effective_plays p ON p.track_id = t.id
            WHERE p.ms IS NULL OR p.ms >= 30000
            GROUP BY t.id
          ), matches AS (SELECT * FROM counts WHERE ${conditions}), ranked AS (${selected})
          SELECT id, title, artist, album, hits, last FROM ranked ${cap ? 'WHERE artist_rank <= ?' : ''}
          ORDER BY ${order}, artist_key, title, id LIMIT ?`,
    args: [...[artist, album].filter(Boolean), ...timeArgs, ...timeArgs, min,
      ...(max !== null ? [max] : []), ...(quiet > 0 ? [now - quiet * DAY] : []), ...(cap ? [cap] : []), limit],
  })
  return rows.map((r) => ({ id: String(r.id), title: String(r.title), artist: String(r.artist), album: String(r.album), plays: Number(r.hits), last: Number(r.last) }))
}
