"""Runs a command in a pseudo-terminal and types one answer per prompt (a line ending
in ':'). Prints everything the command wrote and exits with its status.
    python3 test/answer-prompts.py <answers separated by |> <command...>"""
import os
import pty
import sys
import time

answers = sys.argv[1].split("|")
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])


def read():
    try:
        return os.read(fd, 1024)
    except OSError:  # the command exited
        return b""


output = b""
for answer in answers:
    deadline = time.time() + 15
    while not output.rstrip().endswith(b":") and time.time() < deadline:
        chunk = read()
        if not chunk:
            break
        output += chunk
    os.write(fd, answer.encode() + b"\n")
    output += read()
while chunk := read():
    output += chunk
sys.stdout.write(output.decode(errors="replace"))
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
