"""Starts server/server.py with a throwaway key and checks its answers. Standard library only.
    python3 test/server-test.py"""
import base64
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = "test-key_123"
failures = 0


def check(name, ok, detail=""):
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}{f'  ({detail})' if detail else ''}")
    failures += 0 if ok else 1


def request(path, method="GET", key=None, body=None, origin="https://discord.com"):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    if origin:
        headers["Origin"] = origin
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:8091{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


sys.path.insert(0, os.path.join(ROOT, "server"))
from server import first_livekit_key  # noqa: E402

check("livekit.yml key: plain", first_livekit_key("port: 7880\nkeys:\n  APIabc: s3cret\n") == ("APIabc", "s3cret"))
check("livekit.yml key: after comments", first_livekit_key("keys:\n  # mine\n\n  APIabc: s3cret # note\nlogging: {}\n") == ("APIabc", "s3cret"))
check("livekit.yml key: quoted", first_livekit_key('keys:\n  "APIabc": "s3cret"\n') == ("APIabc", "s3cret"))
check("livekit.yml key: only top-level keys:", first_livekit_key("turn:\n  keys:\n    a: b\n") is None)
check("livekit.yml key: empty keys:", first_livekit_key("keys:\nlogging:\n  level: info\n") is None)
with open(os.path.join(ROOT, "server", "livekit.example.yml")) as f:
    check("livekit.example.yml is readable", first_livekit_key(f.read())[0] == "REPLACE_WITH_API_KEY")

with tempfile.TemporaryDirectory() as tmp:
    keys = os.path.join(tmp, "keys.json")
    with open(keys, "w") as f:
        json.dump({hashlib.sha256(KEY.encode()).hexdigest(): "alice"}, f)
    env = dict(os.environ, LIVEKIT_URL="wss://example.com/livekit", LIVEKIT_API_KEY="APItest",
               LIVEKIT_API_SECRET="secret" * 6, KEYS_FILE=keys)
    server = subprocess.Popen([sys.executable, os.path.join(ROOT, "server", "server.py")], env=env)
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", 8091), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)

        check("health answers", request("/health")[0] == 200)
        check("check accepts a valid key", request("/check", key=KEY, origin=None)[0] == 200)
        check("check refuses a wrong key", request("/check", key="nope", origin=None)[0] == 401)
        check("check refuses no key", request("/check", origin=None)[0] == 401)

        status, headers, body = request("/token", "POST", KEY, {"channelId": "123456789012345678", "userId": "223456789012345678", "name": "Alice"})
        check("token issued for a valid key", status == 200, status)
        reply = json.loads(body or b"{}")
        claims = json.loads(base64.urlsafe_b64decode(reply.get("token", "a.e30.c").split(".")[1] + "=="))
        check("token is for the channel's room", claims.get("video", {}).get("room") == "discord-123456789012345678")
        check("token carries the Discord user id", claims.get("attributes", {}).get("discordUserId") == "223456789012345678")
        check("token may only share screens", claims.get("video", {}).get("canPublishSources") == ["screen_share", "screen_share_audio"])
        check("token expires", claims.get("exp", 0) - time.time() <= 600)
        check("reply gives the LiveKit URL", reply.get("url") == "wss://example.com/livekit")
        check("CORS allows Discord", headers.get("Access-Control-Allow-Origin") == "https://discord.com")

        check("token refused for a wrong key", request("/token", "POST", "nope", {"channelId": "123456789012345678"})[0] == 401)
        check("token refused for another site", request("/token", "POST", KEY, {"channelId": "123456789012345678"}, origin="https://evil.example")[0] == 403)
        check("token refused for a bad channel", request("/token", "POST", KEY, {"channelId": "../x"})[0] == 400)
        check("preflight from Discord allowed", request("/token", "OPTIONS")[0] == 204)
        check("unknown paths are 404", request("/nope")[0] == 404)
    finally:
        server.terminate()
        server.wait()

# keys.py, on a copy of the server folder.
with tempfile.TemporaryDirectory() as tmp:
    import shutil
    shutil.copy(os.path.join(ROOT, "server", "keys.py"), tmp)
    with open(os.path.join(tmp, ".env"), "w") as f:
        f.write("LIVEKIT_URL=wss://streams.example.com/livekit\n")
    keys_py = [sys.executable, os.path.join(tmp, "keys.py")]
    added = subprocess.run(keys_py + ["add", "bob"], capture_output=True, text=True)
    key = re.search(r"Access key: (\S+)", added.stdout)
    stored = json.load(open(os.path.join(tmp, "data", "keys.json")))
    check("keys.py add prints a key and the server", key is not None and "Server: https://streams.example.com" in added.stdout)
    check("keys.py stores only the key's hash", key is not None and stored == {hashlib.sha256(key.group(1).encode()).hexdigest(): "bob"})
    check("keys.py keeps keys.json private", os.stat(os.path.join(tmp, "data", "keys.json")).st_mode & 0o077 == 0)
    subprocess.run(keys_py + ["add", "bob"], capture_output=True)
    check("keys.py add replaces the old key", len(json.load(open(os.path.join(tmp, "data", "keys.json")))) == 1)
    listed = subprocess.run(keys_py + ["list"], capture_output=True, text=True).stdout
    check("keys.py list shows names", listed.strip() == "bob")
    subprocess.run(keys_py + ["revoke", "bob"], capture_output=True)
    check("keys.py revoke removes it", json.load(open(os.path.join(tmp, "data", "keys.json"))) == {})
    check("keys.py rejects bad names", subprocess.run(keys_py + ["add", "../x"], capture_output=True).returncode == 2)

print(f"\n{failures} FAILED" if failures else "\nALL PASSED")
sys.exit(1 if failures else 0)
