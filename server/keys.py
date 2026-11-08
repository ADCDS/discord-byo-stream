#!/usr/bin/env python3
"""Manages access keys on the server itself. Standard library only.
    python3 keys.py add <name>      create or replace <name>'s key, and print it to send
    python3 keys.py revoke <name>   remove <name>'s key
    python3 keys.py list            list who has a key
Only each key's SHA-256 is stored (in data/keys.json, next to this file), so a key is
shown once, when it's made. Changes apply right away, without a restart."""
import hashlib
import json
import os
import re
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS_FILE = os.path.join(HERE, "data", "keys.json")
NAME = re.compile(r"^[a-z0-9_-]{1,32}$")


def load() -> dict:
    if not os.path.exists(KEYS_FILE):
        return {}
    with open(KEYS_FILE, encoding="utf-8") as f:
        return json.load(f)


def save(keys: dict):
    os.makedirs(os.path.dirname(KEYS_FILE), mode=0o700, exist_ok=True)
    tmp = KEYS_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(keys, f, indent=1)
    os.replace(tmp, KEYS_FILE)


def server_address() -> str:
    """https://<host>, from LIVEKIT_URL in .env, which is on the same host."""
    try:
        with open(os.path.join(HERE, ".env"), encoding="utf-8") as f:
            match = re.search(r"^LIVEKIT_URL=wss://([^/\s]+)", f.read(), re.MULTILINE)
        if match:
            return f"https://{match.group(1)}"
    except OSError:
        pass
    return "https://<your server>"


def main(argv: list[str]) -> int:
    action = argv[1] if len(argv) > 1 else ""
    if action == "list" and len(argv) == 2:
        names = sorted(load().values())
        print("\n".join(names) if names else "no keys yet")
        return 0
    if action not in ("add", "revoke") or len(argv) != 3 or not NAME.match(argv[2]):
        print(__doc__.strip(), file=sys.stderr)
        print("\nNames use a-z, 0-9, _ and -, up to 32 characters.", file=sys.stderr)
        return 2
    name = argv[2]
    keys = {digest: owner for digest, owner in load().items() if owner != name}
    if action == "revoke":
        save(keys)
        print(f"removed {name}'s key")
        return 0
    key = secrets.token_urlsafe(32)
    keys[hashlib.sha256(key.encode()).hexdigest()] = name
    save(keys)
    print(f"""Send this to {name}. The key isn't stored anywhere, so this is the only time it's shown.

BYO Stream: screen sharing in Discord through my server.
Install guide: https://github.com/ADCDS/discord-byo-stream#install
Em português: https://github.com/ADCDS/discord-byo-stream/blob/main/README.pt-BR.md

Server: {server_address()}
Access key: {key}""")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
