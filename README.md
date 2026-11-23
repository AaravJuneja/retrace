<p align="center">
  <img src="./assets/hero.png" alt="Retrace" width="100%" />
</p>

Find the music you used to play. Retrace builds playlists from your Spotify listening history, not your likes.

[Open Retrace](https://retrace.squeakyfiddlepro.me)

## How it works

Import Spotify’s **Extended Streaming History** to start with your oldest plays. Find forgotten favorites, look for deep cuts, or pick an era. Narrow the list to one artist, then download a CSV to save it to Spotify through Soundiiz.

The ZIP stays on your device. Only the music play records go to your private database. If you want to keep collecting new plays, connect ListenBrainz. Its hosted listening history is public.

## Development

```sh
bun install --frozen-lockfile
bun test
bun run dev
```

The app uses Cloudflare Workers, Turso, and Discord for owner sign-in. See the [setup guide](docs/setup.md) for configuration and sample data.
