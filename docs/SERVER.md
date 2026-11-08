# Running a BYO Stream server

[Português](SERVIDOR.md) · [Back to the README](../README.md)

A BYO Stream server has two parts, both in `server/`:

- **LiveKit**, which carries the streams' video and sound.
- **The token service**, which checks each person's access key and lets them into the
  LiveKit room of the voice channel they're in.

Your friends install BYO Stream from this repository's releases and type in your
server's address and the key you give them. Their Discord then connects to your
server for streams. Nothing else in Discord changes.

## What you need

- **A Linux server with a public IP address.** A small VPS (1 vCPU, 1 GB of RAM) is
  enough for a group of friends. Bandwidth matters more than CPU: the server sends
  every viewer their own copy of a stream, up to about 10 Mbit/s each at 1080p60. One
  1080p30 stream with four viewers needs about 20 Mbit/s of upload from the server.
- **A domain or subdomain** pointing at that IP, such as `streams.example.com`. If
  it's on Cloudflare, set it to *DNS only* (grey cloud): LiveKit's media can't go
  through a proxy.
- **Docker** with the Compose plugin, and **Caddy** for HTTPS. Any other reverse proxy
  with WebSocket support works too.
- **Open ports:** 443/tcp for HTTPS, 7881/tcp, and 50000 to 60000/udp for LiveKit.

The commands below are for Debian or Ubuntu, run as a normal user who can use Docker.
They use your domain from a `DOMAIN` variable, so set it first, in the same terminal:

```sh
DOMAIN=streams.example.com   # your domain
```

## 1. Get the files

```sh
git clone https://github.com/ADCDS/discord-byo-stream ~/discord-byo-stream
cd ~/discord-byo-stream/server
```

## 2. Configure LiveKit

Copy the example and give it its own API key and secret:

```sh
cp livekit.example.yml livekit.yml
sed -i "s/^  REPLACE_WITH_API_KEY: .*/  API$(openssl rand -hex 6): $(openssl rand -hex 32)/" livekit.yml
```

The defaults use the ports listed above. If you change them, change your firewall to
match.

## 3. Configure the token service

```sh
cp .env.example .env
sed -i "s/streams.example.com/$DOMAIN/; s/^UID_GID=.*/UID_GID=$(id -u):$(id -g)/" .env
mkdir -p data && chmod 700 data && echo '{}' > data/keys.json
```

`.env` says
where LiveKit is (`LIVEKIT_URL`), starts the bundled LiveKit (`COMPOSE_PROFILES`), and
reads LiveKit's key from `livekit.yml`.

## 4. Start it

```sh
docker compose up -d
docker compose ps
```

Both `tokens` and `livekit` should be `Up`. `docker compose logs` shows what they're
doing. They restart by themselves after a reboot.

## 5. Set up HTTPS

Install Caddy, then put the routes from `Caddyfile.example` in `/etc/caddy/Caddyfile`,
with your domain in place of `streams.example.com`:

```sh
sudo apt install caddy
sudo cp Caddyfile.example /etc/caddy/Caddyfile
sudo sed -i "s/streams.example.com/$DOMAIN/" /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If Caddy already serves a site on this domain, add the `route` blocks to that site's
block instead, before anything that catches every path. Caddy gets the HTTPS
certificate by itself, once the domain points at the server and port 443 is open.

Check it from any computer:

```sh
curl https://$DOMAIN/dstream/health
```

It should print `{"ok": true}`.

## 6. Open the firewall

If you use `ufw`:

```sh
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 50000:60000/udp
```

Cloud providers often have a firewall of their own in their control panel. Open the
same ports there.

## 7. Give your friends keys

Each person gets their own key, so you can remove one without affecting the others:

```sh
python3 keys.py add alice     # makes a key and prints a message to send Alice
python3 keys.py list          # who has a key
python3 keys.py revoke alice  # removes Alice's key, right away
```

The message has your server's address, Alice's key, and a link to the install guide.
The key is printed only once, because the server only stores its SHA-256 hash. If
it's lost, run `add` again for a new one.

Anyone with a key can use your server's bandwidth and join the stream room of any
voice channel whose ID they know. Only give keys to people you trust, and revoke keys
you no longer need.

## Updating

```sh
cd ~/discord-byo-stream && git pull
cd server && docker compose up -d --force-recreate
```

People update their own BYO Stream by running the installer of a newer release.

## If you already run LiveKit

You can use an existing LiveKit server, as long as it's reachable at
`wss://YOUR-DOMAIN/livekit`, on the same domain as the token service. BYO Stream only
opens Discord's security policy for that one domain. In `.env`:

- delete the `COMPOSE_PROFILES=livekit` line, so the bundled LiveKit doesn't start;
- point `LIVEKIT_YML` at your `livekit.yml`, or set `LIVEKIT_API_KEY` and
  `LIVEKIT_API_SECRET` instead.

Then run `docker compose up -d`, and add the `/dstream/*` route from
`Caddyfile.example` to your existing site.

## Serving the installer yourself (optional)

Normally people download BYO Stream from GitHub. You can also serve it from your
server. That installer is already set to your server, so people only type their key. On a computer
with Node.js 22, in a copy of this repository:

```sh
cp byo-stream.config.example.json byo-stream.config.json   # set "server" to https://YOUR-DOMAIN
cd plugin && npm ci --ignore-scripts && node build.mjs
```

Copy `dist/public` to the server, enable the `/dstream/dl/*` route in your Caddyfile
with that folder as its `root`, and reload Caddy. People can then install with:

```sh
curl -fsSL https://YOUR-DOMAIN/dstream/dl/install.sh | sh
```

or on Windows `irm https://YOUR-DOMAIN/dstream/dl/install.ps1 | iex`.

## Troubleshooting

- **`curl .../dstream/health` fails.** Check `docker compose ps`, then Caddy with
  `sudo journalctl -u caddy -n 50`. Certificate errors usually mean the domain doesn't
  point at this server yet, or port 443 is closed.
- **People connect but streams stay black.** LiveKit's media isn't getting through.
  Check that 7881/tcp and 50000 to 60000/udp are open in every firewall, and that no
  proxy or CDN sits in front of the domain. `docker compose logs livekit` shows the
  public IP LiveKit found for itself, which must be the server's real public IP.
- **The installer says your server "doesn't look like a BYO Stream server".** The
  `/dstream/*` route is missing or points to the wrong port.
- **"didn't accept that access key".** The key isn't in `data/keys.json`: check with
  `python3 keys.py list`, and make a new one with `add` if needed.
- Very strict networks that block both UDP and port 7881 can't connect. LiveKit can
  relay through TURN on port 443 for them, which needs its own domain and
  certificate: see [LiveKit's documentation](https://docs.livekit.io/home/self-hosting/deployment/).
