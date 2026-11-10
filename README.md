# BYO Stream

**Screen sharing in Discord voice channels, through a server you or a friend runs.**
For when Discord's Go Live isn't available, as in Brazil since August 2026.

[Português (Brasil)](README.pt-BR.md) · [Download](#install) · [Run a server](docs/SERVER.md)

BYO Stream turns Discord's own Go Live back on: the Share Your Screen button, the
window picker, LIVE badges, stream tiles, viewer counts and per-stream volume all work
as usual. Only the video and sound go a different way: through a
[LiveKit](https://livekit.io) server instead of Discord's. Voice chat stays on Discord.

Everyone who streams or watches needs BYO Stream installed, with access to the same
server.

> [!WARNING]
> BYO Stream modifies the Discord app. That's against Discord's Terms of Service, and
> Discord can act against accounts for it. Use it with friends, at your own risk. The
> person running the server is responsible for what is streamed through it. BYO Stream
> isn't made by or affiliated with Discord.

## Install

You need two things from whoever runs your server: **the server address** (like
`https://streams.example.com`) and **your access key**. Keep the key to yourself: it's
what lets you onto the server.

Use the official Discord app from [discord.com](https://discord.com/download), and open
it at least once before installing. Run the installer again after every Discord update,
which removes BYO Stream. Running it again also updates BYO Stream.

### Windows

1. Download **[discord-byo-stream-windows-v0.1.1.zip](https://github.com/ADCDS/discord-byo-stream/releases/download/windows-v0.1.1/discord-byo-stream-windows-v0.1.1.zip)**.
2. Right-click the zip, choose **Extract All**, then **Extract**.
3. In the folder that opens, double-click **Install.cmd**.
   - If Windows says it protected your PC, click **More info**, then **Run anyway**.
   - If it asks whether to open or run the file, click **Run**.
4. Type or paste the server address, press Enter, then the access key, and press Enter.

Discord restarts with BYO Stream. **Uninstall.cmd**, in the same folder, removes it.

<details>
<summary>Or install from PowerShell</summary>

```powershell
irm https://github.com/ADCDS/discord-byo-stream/releases/download/windows-v0.1.1/install.ps1 | iex
```

To pass the answers instead of typing them, or to uninstall:

```powershell
& ([scriptblock]::Create((irm https://github.com/ADCDS/discord-byo-stream/releases/download/windows-v0.1.1/install.ps1))) -Server https://streams.example.com YOUR-KEY
& ([scriptblock]::Create((irm https://github.com/ADCDS/discord-byo-stream/releases/download/windows-v0.1.1/install.ps1))) -Uninstall
```
</details>

### macOS

The easiest way is one line in Terminal:

1. Open **Terminal** (press Cmd+Space, type `Terminal`, press Return).
2. Paste this and press Return:
   ```sh
   curl -fsSL https://github.com/ADCDS/discord-byo-stream/releases/download/macos-v0.1.1/install.sh | sh
   ```
3. Type or paste the server address, press Return, then the access key, and press
   Return.
4. If it says **macOS blocked changes to Discord.app**: open **System Settings** >
   **Privacy & Security** > **App Management**, and turn on **Terminal**. Quit Terminal
   (Cmd+Q), open it again, and repeat step 2.

Discord closes and reopens with BYO Stream.

<details>
<summary>Or download it and double-click</summary>

1. Download **[discord-byo-stream-macos-v0.1.1.zip](https://github.com/ADCDS/discord-byo-stream/releases/download/macos-v0.1.1/discord-byo-stream-macos-v0.1.1.zip)**
   and open it, if your browser didn't already.
2. Double-click **Install.command**. The first time, macOS says it can't verify it,
   because BYO Stream isn't from the App Store or signed by Apple:
   - macOS 15 or newer: click **Done**, then open **System Settings** > **Privacy &
     Security**, scroll down to *"Install.command" was blocked*, click **Open Anyway**,
     and confirm with your password.
   - macOS 14 or older: Control-click **Install.command**, choose **Open**, then **Open**.
3. Terminal opens and asks for the server address and access key, as above. Step 4
   above applies here too.

**Uninstall.command** removes it, after the same first-time approval.
</details>

To uninstall from Terminal:

```sh
curl -fsSL https://github.com/ADCDS/discord-byo-stream/releases/download/macos-v0.1.1/install.sh | sh -s -- --uninstall
```

### Linux

Close Discord fully (including its tray icon), then in a terminal:

```sh
curl -fsSL https://github.com/ADCDS/discord-byo-stream/releases/download/linux-v0.1.1/install.sh | sh
```

It asks for the server address and access key; then open Discord. To uninstall, add
`-s -- --uninstall` after `sh`. You can also download
[discord-byo-stream-linux-v0.1.1.tar.gz](https://github.com/ADCDS/discord-byo-stream/releases/download/linux-v0.1.1/discord-byo-stream-linux-v0.1.1.tar.gz),
unpack it and run `sh install.sh` in its folder.

This needs Discord's `.deb` or `.tar.gz` from discord.com. The Flatpak and Snap
versions keep their files read-only, so BYO Stream can't be added to them.

### Installing for someone else

To skip the questions, put the server and key in the command:

```sh
curl -fsSL https://github.com/ADCDS/discord-byo-stream/releases/download/macos-v0.1.1/install.sh | sh -s -- --server https://streams.example.com YOUR-KEY
```

(Use the `linux-v0.1.1` address on Linux.) If you run a server,
`python3 keys.py add <name>` prints a message with everything a friend needs.

## Using it

**To stream**, join a voice channel and click Discord's **Share Your Screen** button,
as usual.

- On Windows and macOS, Discord's own window shows your apps and screens, without
  thumbnails. Pick one, choose the quality, and click **Go Live**.
- On Linux, your desktop's screen-sharing dialog opens. Pick a window or screen there.

Without Nitro, you can still stream at up to 1080p, because the video doesn't go
through Discord. The first time on macOS, allow Discord to record your screen when
asked (System Settings > Privacy & Security > Screen & System Audio Recording, called
Screen Recording on older macOS), then quit and reopen Discord. The first stream with
sound also asks to record audio.

**To watch**, click a friend with the **LIVE** badge in the voice channel, or their
stream tile, as usual. Right-click a stream to change its volume.

A stream can take a few seconds to reach full sharpness: it starts at a lower quality
and steps up as the connection allows. Streams use your computer's hardware video
encoder where Discord's browser engine offers it, as on Macs, so streaming next to a
game costs little CPU. Otherwise the picture may shrink when the CPU is busy.

If a Discord update breaks the Go Live buttons, BYO Stream shows its own small panel
instead. **Ctrl+Alt+V** opens that panel at any time, with stream stats.

### Stream sound

BYO Stream sends the sound of what you share, and never the voice call or the streams
you're watching, so nobody hears themselves.

| | Sharing a window | Sharing a whole screen |
|---|---|---|
| Windows 10 (2004 or newer), 11 | The sound of that window's app | No sound |
| macOS 14.2 or newer | The sound of that window's app | No sound |
| macOS 14.1 or older | No sound | No sound |
| Linux, with PipeWire | The sound of that window's app, if its title names it; otherwise every app except Discord | Every app except Discord |

On Windows and macOS, sharing a whole screen has no sound because there's no way there
to capture everything except Discord's voice. To share a game or a video with sound,
share its window. When a stream can't have the sound you asked for, Discord shows a
notice saying why.

On macOS, browsers count as one app: sharing a Chrome, Edge or Opera window sends all
of that browser's sound. Sharing a Safari window sends the sound of Safari and of other
apps built on Safari's engine. Some apps have no sound to capture, including many games
run through Wine or CrossOver.

## Troubleshooting

**The installer says it couldn't find Discord.** Install the official Discord app, open
it once, and run the installer again. On Linux, Flatpak and Snap Discord aren't
supported.

**"didn't accept that access key"** or **"couldn't reach"**. Copy the server address
and key again, exactly as you got them. If they're right, the server may be down: ask
whoever runs it.

**The Share Your Screen button is missing or does nothing.** Quit Discord fully (from
its tray or menu bar icon, not just the window) and open it again. If Discord updated,
run the installer again.

**My friends can't see my stream.** They need BYO Stream too, set up with the same
server, and they must be in the same voice channel.

**Black screen when watching.** Wait a few seconds. If it stays black, the streamer
should stop and start the stream again.

**Logs.** BYO Stream writes logs to a `discord-byo-stream` folder: in
`%APPDATA%` on Windows, `~/Library/Application Support` on macOS, and `~/.config` on
Linux. `plugin.log` and `main.log` record what happened, and `status.json` shows the
current streams. They never contain your access key, so you can share them when asking
for help.

## Run your own server

A small VPS with a domain name is enough for a group of friends. See
[docs/SERVER.md](docs/SERVER.md) ([em português](docs/SERVIDOR.md)).

## How it works

- **The hook** (`installer/app-index.js`, `installer/main.js`) runs in Discord's main
  process. The installer adds it the way BetterDiscord does: Discord's `app.asar` is
  renamed to `byo-stream.app.asar`, and a small `app/` folder loads the hook first.
  The hook opens Discord's content security policy to your server only, runs the
  plugin in the main window, and picks the stream's audio source.
- **The plugin** (`plugin/`) runs in Discord's page. It overrides the client-side
  experiment that hides Go Live, intercepts Discord's own Go Live actions, and sends
  the stream to LiveKit instead. None of it reaches Discord's servers: Go Live gateway
  calls are dropped, and the replies those servers would send are created locally.
  Discord's camera stays off, since it would go through Discord.
- **The server** (`server/`) swaps a per-person access key for a short-lived LiveKit
  token for one voice channel's room. Each Discord voice channel gets its own room.

The installer saves the server address and key in `config.json` in the logs folder
above, readable only by you. The audio rules are in `installer/audio-source.js` (macOS
and Windows) and `installer/linux-audio.js` (PipeWire).

## Development

```sh
cd plugin && npm ci --ignore-scripts && cd ..
sh tools/package.sh linux                 # or macos, windows: dist/release/<platform>
node test/audio-source-test.mjs           # which sound a shared window gets
sh test/install-test.sh                   # installer, in a fake macOS home
powershell -File test\install-test.ps1    # installer, on Windows
python3 test/server-test.py               # token service
```

For tests against a real server, copy `byo-stream.config.example.json` to
`byo-stream.config.json` and fill it in, and put a key in `.keys/e2e.key`. Then
`cd plugin && node build.mjs` builds the plugin into `dist/public`, and:

```sh
node test/e2e.mjs                         # two Chrome clients streaming through your server
node test/viewer.mjs <voice channel id>   # a stats-only viewer of a live room
```

`tools/run-in-flatpak-discord.mjs <key-name>` loads the plugin into Flatpak Discord
over its debug port, for development. The debug port lets any program on your
computer control Discord while it's open.

### Releases

Each platform has its own release. Push a tag named `windows-v<version>`,
`macos-v<version>` or `linux-v<version>`, where `<version>` matches
`plugin/package.json`. The release workflow builds that platform, runs its tests and
publishes the release, with the installer files also attached on their own for the
one-line installs. Update the download links in both READMEs when the version changes.

## Known limits

- A Discord update replaces `app.asar` and silently removes BYO Stream. Run the
  installer again after one.
- LIVE badges only show for people in your voice channel who have BYO Stream.
- No stream preview thumbnails, and no camera.
- On macOS 14 and older, window capture uses Chromium's older capturer, which can be
  slower.
- Per-app sound uses Chromium features that Electron doesn't document. A future
  Discord update may change them.
- Streams carry an extra 720p layer so new viewers start quickly, which costs the
  streamer's computer a second video encoder.

## License

[MIT](LICENSE). Discord is a trademark of Discord Inc.; this project isn't affiliated with it.
