import { strToU8, zipSync } from 'fflate'

const recordings = [
  ['3n3Ppam7vgaVa1iaRUc9Lp', 'Mr. Brightside', 'The Killers', 'Hot Fuss'],
  ['4cOdK2wGLETKBW3PvgPWqT', 'Never Gonna Give You Up', 'Rick Astley', 'Whenever You Need Somebody'],
  ['7ouMYWpwJ422jRcDASZB7P', 'Knights of Cydonia', 'Muse', 'Black Holes and Revelations'],
]
const rows = Array.from({ length: 150 }, (_, i) => {
  const [id, title, artist, album] = recordings[i % recordings.length]
  return {
    ts: new Date(Date.UTC(2020, 2, 1 + i)).toISOString(),
    spotify_track_uri: `spotify:track:${id}`,
    master_metadata_track_name: title,
    master_metadata_album_artist_name: artist,
    master_metadata_album_name: album,
    ms_played: 90_000,
    incognito_mode: false,
  }
})
const path = process.argv[2] ?? 'retrace-test-history.zip'
await Bun.write(path, zipSync({ 'Streaming_History_Audio_2020_0.json': strToU8(JSON.stringify(rows)) }))
console.log(`Wrote ${rows.length} synthetic plays to ${path}. Import them into a test database only.`)
