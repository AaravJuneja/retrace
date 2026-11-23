import { DAY, int, listenRow, object, type Requester } from '../shared/history'
import { writePlays, type Storage } from './storage'

const PAGE = 48
const RETRY_WINDOW = 2 * DAY

export async function syncPage(db: Storage, name: string, now: number, request: Requester = fetch) {
  let [state] = await db.read({ sql: 'SELECT * FROM feed_state WHERE id = 1' })
  if (!state) {
    await db.write([{ sql: 'INSERT OR IGNORE INTO feed_state (id, username) VALUES (1, ?)', args: [name] }])
    ;[state] = await db.read({ sql: 'SELECT * FROM feed_state WHERE id = 1' })
  }
  if (!state || state.username !== name) throw new Error('Feed username changed; keep one ListenBrainz account per database.')
  const revision = Number(state.revision)
  const success = state.success == null ? null : Number(state.success)
  if (state.cursor == null && success !== null && now - success < 1800 && !state.error) return { pending: false, synced: success }
  const started = state.started == null ? now : Number(state.started)
  const cursor = state.cursor == null ? now + 1 : Number(state.cursor)
  const floor = state.floor == null ? (success === null ? 0 : success - RETRY_WINDOW) : Number(state.floor)

  try {
    const response = await request(`https://api.listenbrainz.org/1/user/${encodeURIComponent(name)}/listens?count=${PAGE}&max_ts=${cursor}`, { headers: { Accept: 'application/json', 'User-Agent': 'Retrace/1.0 (personal listening history)' }, signal: AbortSignal.timeout(12_000) })
    if (!response.ok) throw new Error('ListenBrainz is unavailable.')
    const body = object(await response.json())
    const rows = object(body?.payload)?.listens
    if (!Array.isArray(rows) || rows.length > PAGE || rows.some((r) => !int(object(r)?.listened_at, 0, cursor - 1))) throw new Error('Unexpected ListenBrainz page.')
    const oldest = Math.min(...rows.map((r) => r.listened_at as number))
    const pending = rows.length === PAGE && oldest > floor
    const next = pending ? oldest + 1 : null
    if (next === cursor) throw new Error('ListenBrainz did not advance its cursor.')
    const plays = rows.filter((r) => r.listened_at >= floor).flatMap((r) => {
      const play = listenRow(r)
      return play ? [play] : []
    })
    const gate = { sql: 'SELECT 1 FROM feed_state WHERE id = 1 AND revision = ?', args: [revision] }
    const results = await db.write([
      ...writePlays(plays, 1, gate),
      { sql: `UPDATE feed_state SET revision = revision + 1, cursor = ?, floor = ?, started = ?,
              success = ?, error = 0 WHERE id = 1 AND revision = ?`,
        args: [next, pending ? floor : null, pending ? started : null, pending ? success : started, revision] },
    ])
    if (!results.at(-1)) return { pending: true, synced: success }
    return { pending, synced: pending ? success : started }
  } catch (error) {
    await db.write([{ sql: 'UPDATE feed_state SET error = 1 WHERE id = 1 AND revision = ?', args: [revision] }])
    throw error
  }
}
