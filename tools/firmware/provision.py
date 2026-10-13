"""USB console client. Secrets use hidden prompts and never enter arguments/history."""

import argparse
import getpass
import hashlib
import hmac
import json
import secrets
import time

from codec import public_stm


class Console:
    def __init__(self, transport, events=None):
        self.transport = transport
        self.events = events or (lambda event: None)

    def request(self, command, timeout=10):
        # Do not print outgoing commands: the secret prompt shares this transport.
        self.transport.write(command.encode("ascii") + b"\n")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.transport.readline(1025)
            if len(line) > 1024:
                raise ValueError("Console line exceeds 1024 bytes")
            if not line or line.startswith(b"log:"):
                continue
            try:
                reply = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            if "event" in reply:
                self.events(reply)
                continue
            if "ok" in reply:
                return reply
        raise TimeoutError(
            "Unknown command outcome. Reconnect and run command status; do not issue a replacement write."
        )

    def group_key(self):
        reply = self.request("config secret group_key")
        if not reply.get("secret"):
            return reply
        value = bytearray.fromhex(
            getpass.getpass("Group key (64 hex digits, hidden): ")
        )
        try:
            if len(value) != 32 or not any(value):
                raise ValueError("Use a nonzero 32-byte group key")
            return self.request(value.hex())
        finally:
            value[:] = bytes(len(value))

    def key_check(self):
        settings = self.request("config get stm")
        if not settings.get("ok"):
            return settings
        public = public_stm(bytes.fromhex(settings["record_hex"]))
        nonce = secrets.token_bytes(16)
        key = bytearray.fromhex(getpass.getpass("Expected group key (hidden): "))
        try:
            if len(key) != 32:
                raise ValueError("Use 32 key bytes")
            reply = self.request(f"key check {nonce.hex()}")
            data = bytes.fromhex(reply.get("data_hex", ""))
            message = (
                b"SC-KEYCHECK-V1\0"
                + public["group_id"].to_bytes(4, "little")
                + public["key_id"].to_bytes(4, "little")
                + nonce
            )
            expected = hmac.new(key, message, hashlib.sha256).digest()[:16]
            passed = (
                reply.get("ok")
                and len(data) == 20
                and int.from_bytes(data[:4], "little") == public["key_id"]
                and hmac.compare_digest(data[4:], expected)
            )
            return {
                "ok": bool(passed),
                "group_id": public["group_id"],
                "key_id": public["key_id"],
            }
        finally:
            key[:] = bytes(len(key))


def main():
    import serial

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--baud", type=int, default=115200)
    args = parser.parse_args()
    with serial.Serial(args.port, args.baud, timeout=0.25) as transport:
        client = Console(transport)
        while True:
            try:
                command = input("> ").strip()
                if command in ("quit", "exit"):
                    return
                if command == "config secret group_key":
                    reply = client.group_key()
                elif command == "key check":
                    reply = client.key_check()
                else:
                    reply = client.request(command)
                if reply.get("owner") == "stm" and "record_hex" in reply:
                    reply["settings"] = public_stm(bytes.fromhex(reply["record_hex"]))
                print(json.dumps(reply))
            except EOFError:
                return
            except (ValueError, TimeoutError) as error:
                print(str(error))


if __name__ == "__main__":
    main()
