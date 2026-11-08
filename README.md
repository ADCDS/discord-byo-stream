# VCStream

Screen sharing inside Discord voice channels through your own server, for where
Discord's Go Live is unavailable (for example, in Brazil since August 2026).

VCStream switches Discord's own Go Live UI back on: the Share Your Screen button,
the picker, LIVE badges, stream tiles, viewer counts and per-stream volume. The video
and audio go through a LiveKit server you run, never through Discord. Voice chat
stays on Discord as usual. Everyone who wants to watch or stream needs VCStream.

> **Use at your own risk.** VCStream modifies the Discord client, which breaks
> Discord's Terms of Service, and accounts can be actioned for it. It's meant for
> private groups of friends on a server you control. Keep your server invite-only:
> you are responsible for what's streamed through it. VCStream isn't affiliated with
> Discord.

## How it works

- **The hook** (`installer/app-index.js`, `installer/main.js`) runs in Discord's main
  process. The installer adds it the way BetterDiscord does: Discord's `app.asar` is
  renamed to `vcstream.app.asar`, and a small `app/` folder loads the hook first.
  The hook adds your server to Discord's content security policy, runs the plugin in
  the main window, and picks the stream's audio source.
- **The plugin** (`plugin/`) runs in Discord's page. It overrides the client-side
  experiment that hides Go Live, intercepts Discord's own Go Live actions, and sends
  the stream to LiveKit instead. None of it reaches Discord's servers: Go Live
  gateway calls are dropped, and the replies those servers would send are created
  locally. Discord's native camera stays off, since it would use Discord's servers.
- **The server** (`server/`) swaps a per-person access key for a short-lived LiveKit
  token for one voice channel's room. The rooms themselves are on your LiveKit.

If a Discord update breaks the native UI hooks, VCStream falls back to its own
floating panel. Ctrl+Alt+V shows the panel at any time, with stats and a
diagnostics report.

## Platform support

| | Install | Stream audio |
|---|---|---|
| Windows 10 2004+ | `install.ps1` | The shared window's app: the process that owns it, and its children. |
| macOS 14.2+ | `install.sh` | The shared window's app, chosen with Chromium's own rules (see below). |
| macOS 13 to 14.1 | `install.sh` | None. These versions can't capture one app's audio, and the alternative includes the call. |
| Linux, official Discord | `install.sh` | Through PipeWire: the shared window's app if its title names it, otherwise every app except Discord. |
| Linux, Flatpak Discord | `tools/run-in-flatpak-discord.mjs` | As above. |

Discord's own sound, meaning the voice call and streams you watch, is never captured,
so nobody hears themselves. Whole-screen shares on macOS and Windows, and shares of a
Discord window, have no audio, because there's no way there to leave Discord's voice
out. If a stream asked for sound and can't have it, a notice in Discord says why.

On macOS the audio app is picked the way Chromium picks it for its own screen
sharing (`installer/audio-source.js`):

- Chrome, Chromium, Edge and Opera: that browser instance. Their installed web apps
  map to the browser that installed them.
- Safari, Safari Technology Preview and Safari web apps: WebKit's shared audio
  process, which can also carry sound from other apps that use WebKit.
- Any other app: everything under its bundle id, which includes its helper processes.
- Apps without a bundle id, such as many Wine and CrossOver games: no audio.

## Installing

You need an access key from whoever runs your server.

**macOS and Linux:** close Discord, then:

```sh
curl -fsSL https://your-server/dstream/dl/install.sh | sh -s -- <access-key>
```

**Windows:** close Discord, then in PowerShell:

```powershell
& ([scriptblock]::Create((irm https://your-server/dstream/dl/install.ps1))) <access-key>
```

Or download your platform's archive from Releases, unpack it and follow its
`INSTALL.txt`. Run the installer again after a Discord update, which replaces
`app.asar` and drops the hook. To uninstall, pass `--uninstall` (`-Uninstall` on
Windows) instead of a key.

On macOS, if the installer says macOS blocked changes to Discord.app, turn on your
terminal app under System Settings > Privacy & Security > App Management, then run
it again. The first stream with sound asks for permission to record audio.

**Flatpak Discord** keeps its files read-only, so it can't be hooked. From a clone of
this repository, load the plugin over Discord's debug port instead:

```sh
flatpak run com.discordapp.Discord --remote-debugging-port=9224
node tools/run-in-flatpak-discord.mjs <key-name>   # key read from .keys/<key-name>.key
```

The debug port lets any local program control Discord while it's open.

## Running a server

1. **LiveKit.** Run a [LiveKit server](https://docs.livekit.io/home/self-hosting/)
   reachable over `wss://` on the same host you'll serve VCStream from, proxied at
   `/livekit`. The plugin's security policy only allows that one host.
2. **Token service.** Copy `server/` to the host (for example `/opt/discord-stream`),
   copy `.env.example` to `.env` and fill it in, create `data/keys.json` containing
   `{}`, then `docker compose up -d`. It listens on `127.0.0.1:8091`.
3. **Web server.** Route `/dstream/*` to the token service and serve the built files
   at `/dstream/dl/`. `server/Caddyfile.example` shows both routes for Caddy.
4. **Build for your server.** Set `server` in `vcstream.config.json` to your https
   origin, build (see below) and copy `dist/public/*` to the folder served at
   `/dstream/dl/`.
5. **Keys.** Set `sshHost` and `serverDir` in `vcstream.config.json`, then
   `tools/keys.sh add <name>` creates a key in `.keys/<name>.key` and registers its
   SHA-256 on the server. `tools/keys.sh revoke <name>` removes it. Both apply
   immediately.

## Development

```sh
cd plugin && npm ci --ignore-scripts && node build.mjs   # writes dist/public
node test/audio-source-test.mjs                          # which audio a shared window gets
sh test/install-test.sh                                  # installer, fake macOS home
powershell -File test\install-test.ps1                   # installer, on Windows
BLOCKS=30 MODE=smooth node test/e2e.mjs                  # two Chrome clients via your server
node test/viewer.mjs <voice channel id> 60               # stats-only viewer of a live room
```

`e2e.mjs` and `viewer.mjs` need a key at `.keys/e2e.key`. `.keys/` holds secrets, so
it's ignored by git; `dist/public` holds none.

## Releases

Push a tag named `linux-v<version>`, `macos-v<version>` or `windows-v<version>`, where
`<version>` matches `plugin/package.json`. The release workflow builds that platform's
archive, runs its installer test, and publishes a GitHub release. Set the repository
variable `VCSTREAM_SERVER` to build for a server other than the one in
`vcstream.config.json`. `tools/package.sh <platform>` builds the same archive locally.

## Troubleshooting

Installs made with the installer write logs to the `VCStream` folder in the app data
directory (`~/Library/Application Support` on macOS, `%APPDATA%` on Windows,
`~/.config` on Linux):

- `main.log`: the hook loading, and audio-source decisions.
- `plugin.log`: the plugin, including time to first frame when watching.
- `status.json`: current state every 15 seconds: streams, resolution, fps, dropped frames.

## Known limits

- A Discord update replaces `app.asar` and silently removes the hook, so run the
  installer again after one.
- LIVE badges only appear for people in the same voice channel with VCStream running.
- No stream preview thumbnails, and no camera.
- The first stream on macOS asks for Screen Recording permission, and Discord may need
  a restart after granting it. The first stream with sound asks to record audio.
- On macOS 14 and earlier, Discord turns off ScreenCaptureKit, so window capture uses
  Chromium's older capturer, which can be slower.
- Per-app audio uses Chromium device ids Electron doesn't document. A future
  Electron may change them.
- Streams start at a lower resolution and step up within seconds. They also carry a
  720p layer so new viewers start quickly, which costs the streamer a second encoder.
