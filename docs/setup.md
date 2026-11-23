# Set up Retrace

## Run locally

```sh
bun install --frozen-lockfile
bun test
bun run dev
```

Copy `.dev.vars.example` to `.dev.vars` and set the values below. Register the local callback URL in Discord.

## Set up the hosted app

1. Set `name`, `routes`, and `APP_ORIGIN` in `wrangler.jsonc`. To use a `workers.dev` address, remove `routes` and enable `workers_dev`. Run `bun run deploy`.
2. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and add `https://YOUR-HOST/api/auth/discord/callback` under **OAuth2 → Redirects**. For the Retrace deployment, use `https://retrace.squeakyfiddlepro.me/api/auth/discord/callback`. Leave **Public Client** off. Enable Developer Mode in Discord, then right-click your own profile and choose **Copy User ID**. No bot or server installation is needed.
3. Sign in to the [Turso CLI](https://docs.turso.tech/cli/introduction), create a database, and apply the schema:

   ```sh
   turso auth login
   turso db create retrace
   turso db shell retrace < schema.sql
   turso db show retrace --url
   turso db tokens create retrace
   ```

4. Set each Worker value with `bunx wrangler secret put NAME`:

   | Name | Value |
   | --- | --- |
   | `DISCORD_CLIENT_ID` | Application ID from the Developer Portal |
   | `DISCORD_CLIENT_SECRET` | OAuth2 client secret from the Developer Portal |
   | `DISCORD_OWNER_ID` | Your Discord user ID, not the application ID |
   | `SESSION_SECRET` | Random secret, for example from `openssl rand -hex 32` |
   | `TURSO_DATABASE_URL` | URL from `turso db show retrace --url` |
   | `TURSO_AUTH_TOKEN` | Database token from `turso db tokens create retrace` |
   | `LISTENBRAINZ_USER` | Optional. Your public ListenBrainz username |

Run `bun run fixture` to create a sample ZIP for testing the import and playlist export.

## Import and sync

- Import the **Extended Streaming History** ZIP or its audio JSON files under **Archive**. Mark it complete if you selected the whole export. Interrupted imports resume when you reselect the same files.
- To collect new plays, open [Connect services](https://listenbrainz.org/settings/music-services/details/), choose Spotify → **Record listening history**, and set `LISTENBRAINZ_USER`. Retrace catches up when opened and pulls one page every three hours. Reconnect Spotify to ListenBrainz every six months.
- Archive plays count at 30 seconds or more; the live feed does not provide played duration. Older archive credits usually name only the album artist, so exact artist filtering can miss guest appearances.
- Displayed dates and era filters use your browser’s time zone. Retrace sends only the selected time bounds for an era query and does not save your time zone.
- Download the TXT from the draft. In [Soundiiz](https://soundiiz.com/webapp/playlists), choose **Import Playlist → From File** and upload it, or copy the links and paste them with **From Plain Text**. Review the tracks and choose Spotify. The free transfer limit is 200 tracks.
- If Turso archives the database after inactivity, run `turso group unarchive`.
