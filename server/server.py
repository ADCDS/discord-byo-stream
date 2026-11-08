#!/usr/bin/env python3
"""Issues short-lived LiveKit tokens to VCStream plugin users. Standard library only.

Access keys live in /data/keys.json as {sha256_hex_of_key: owner_name}, so raw
keys never reach this server. The file is re-read per request: editing it adds
or revokes a friend without a restart.

Configuration, from the environment:
  LIVEKIT_URL         wss:// URL clients use for LiveKit, on the same host as this server
  LIVEKIT_API_KEY     LiveKit API key and secret, or instead:
  LIVEKIT_API_SECRET
  LIVEKIT_CONFIG      path to a livekit.yml whose first `keys:` entry is used
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "")
LIVEKIT_CONFIG = os.environ.get("LIVEKIT_CONFIG", "/run/livekit.yml")
KEYS_FILE = os.environ.get("KEYS_FILE", "/data/keys.json")
ROOM_PREFIX = "discord-"
TOKEN_TTL_SECONDS = 600
MAX_BODY_BYTES = 2048
ALLOWED_ORIGINS = {
    "https://discord.com",
    "https://ptb.discord.com",
    "https://canary.discord.com",
}
CHANNEL_ID = re.compile(r"^\d{15,25}$")
LIVEKIT_KEY = re.compile(r"^keys:\s*\n\s+(\S+?):\s*(\S+)\s*$", re.MULTILINE)


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def load_livekit_credentials() -> tuple[str, str]:
    key, secret = os.environ.get("LIVEKIT_API_KEY"), os.environ.get("LIVEKIT_API_SECRET")
    if key and secret:
        return key, secret
    with open(LIVEKIT_CONFIG, encoding="utf-8") as f:
        match = LIVEKIT_KEY.search(f.read())
    if not match:
        raise RuntimeError("no keys: entry found in livekit config")
    return match.group(1), match.group(2)


def owner_of(access_key: str) -> str | None:
    with open(KEYS_FILE, encoding="utf-8") as f:
        keys = json.load(f)
    return keys.get(hashlib.sha256(access_key.encode()).hexdigest())


def mint_token(room: str, identity: str, display_name: str, discord_user_id: str | None) -> str:
    api_key, api_secret = load_livekit_credentials()
    now = int(time.time())
    claims = {
        "iss": api_key,
        "sub": identity,
        "name": display_name,
        "attributes": {"discordUserId": discord_user_id} if discord_user_id else {},
        "nbf": now - 5,
        "exp": now + TOKEN_TTL_SECONDS,
        "video": {
            "room": room,
            "roomJoin": True,
            "canSubscribe": True,
            "canPublish": True,
            "canPublishData": False,
            "canUpdateOwnMetadata": True,  # Viewers publish which stream they're watching.
            "canPublishSources": ["screen_share", "screen_share_audio"],
        },
    }
    header = {"alg": "HS256", "typ": "JWT"}
    signing_input = (
        b64url(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + b64url(json.dumps(claims, separators=(",", ":")).encode())
    )
    signature = hmac.new(api_secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return signing_input + "." + b64url(signature)


def clean_display_name(raw: object, fallback: str) -> str:
    if not isinstance(raw, str):
        return fallback
    cleaned = "".join(ch for ch in raw if ch.isprintable()).strip()[:64]
    return cleaned or fallback


class Handler(BaseHTTPRequestHandler):
    server_version = "dstream"
    sys_version = ""
    timeout = 10

    def log_message(self, fmt, *args):
        print(f"{self.log_date_time_string()} {fmt % args}", flush=True)

    def origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        return origin is None or origin in ALLOWED_ORIGINS

    def reply(self, status: int, payload: dict | None = None):
        body = json.dumps(payload).encode() if payload is not None else b""
        self.send_response(status)
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not self.origin_allowed():
            return self.reply(403, {"error": "origin not allowed"})
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/token":
            return self.reply(404, {"error": "not found"})
        if not self.origin_allowed():
            return self.reply(403, {"error": "origin not allowed"})

        auth = self.headers.get("Authorization", "")
        owner = owner_of(auth[7:]) if auth.startswith("Bearer ") else None
        if owner is None:
            return self.reply(401, {"error": "invalid access key"})

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.reply(400, {"error": "bad content length"})
        if not 0 < length <= MAX_BODY_BYTES:
            return self.reply(400, {"error": "bad body size"})
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.reply(400, {"error": "bad json"})

        channel_id = body.get("channelId") if isinstance(body, dict) else None
        if not isinstance(channel_id, str) or not CHANNEL_ID.match(channel_id):
            return self.reply(400, {"error": "bad channelId"})

        user_id = body.get("userId")
        if user_id is not None and (not isinstance(user_id, str) or not (user_id == "" or CHANNEL_ID.match(user_id))):
            return self.reply(400, {"error": "bad userId"})

        room = ROOM_PREFIX + channel_id
        # The suffix lets one person be connected from two clients at once.
        identity = f"{owner}-{secrets.token_hex(3)}"
        name = clean_display_name(body.get("name"), owner)
        print(f"token owner={owner} room={room}", flush=True)
        token = mint_token(room, identity, name, user_id or None)
        self.reply(200, {"url": LIVEKIT_URL, "token": token, "identity": identity})


if __name__ == "__main__":
    if not LIVEKIT_URL.startswith("wss://"):
        raise SystemExit("set LIVEKIT_URL to the wss:// URL of your LiveKit server")
    load_livekit_credentials()  # Fail at startup, not on the first request.
    ThreadingHTTPServer(("0.0.0.0", 8091), Handler).serve_forever()
