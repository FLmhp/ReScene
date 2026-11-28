"""Disposable loopback SMTP sink for the production transport and outbox."""

from __future__ import annotations

import email
import socketserver
import threading
from email.policy import default


def decode_captured_message(raw: str) -> tuple[str, str]:
    """Return the decoded subject and body of a captured SMTP message."""
    msg = email.message_from_string(raw, policy=default)
    subject = str(msg["Subject"] or "")
    payload = msg.get_payload(decode=True)
    body = payload.decode("utf-8") if payload else ""
    return subject, body


class _SmtpHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        server = self.server
        try:
            self.wfile.write(b"220 ReScene test sink ESMTP\r\n")
            sender: str | None = None
            recipient: str | None = None
            while True:
                line = self.rfile.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").rstrip("\r\n")
                upper = text.upper()
                if upper.startswith("EHLO") or upper.startswith("HELO"):
                    self.wfile.write(b"250-Hello\r\n250 SIZE 10485760\r\n")
                elif upper.startswith("MAIL FROM:"):
                    sender = text[10:].split(">", 1)[0].strip().lstrip("<")
                    self.wfile.write(b"250 OK\r\n")
                elif upper.startswith("RCPT TO:"):
                    if server.rcpt_status != 250:
                        self.wfile.write(f"{server.rcpt_status} Recipient rejected\r\n".encode("ascii"))
                    else:
                        recipient = text[8:].strip().strip("<>")
                        self.wfile.write(b"250 OK\r\n")
                elif upper.startswith("DATA"):
                    if sender is None or recipient is None:
                        self.wfile.write(b"503 MAIL and RCPT required\r\n")
                        continue
                    self.wfile.write(b"354 End data with <CR><LF>.<CR><LF>\r\n")
                    chunks: list[bytes] = []
                    while True:
                        data_line = self.rfile.readline()
                        if not data_line:
                            return
                        if data_line == b".\r\n":
                            break
                        if data_line.startswith(b".."):
                            data_line = data_line[1:]
                        chunks.append(data_line)
                    raw = b"".join(chunks)
                    server.messages.append(
                        {"from": sender, "to": recipient, "data": raw.decode("utf-8", errors="replace")}
                    )
                    if server.disconnect_after_data:
                        return
                    self.wfile.write(b"250 OK queued\r\n")
                elif upper.startswith("QUIT"):
                    self.wfile.write(b"221 Bye\r\n")
                    break
                elif upper.startswith("RSET"):
                    sender = None
                    recipient = None
                    self.wfile.write(b"250 OK\r\n")
                elif upper.startswith("NOOP"):
                    self.wfile.write(b"250 OK\r\n")
                else:
                    self.wfile.write(b"500 Command not recognized\r\n")
        except (ConnectionResetError, BrokenPipeError):
            pass


class SmtpSink(socketserver.ThreadingTCPServer):
    """A minimal loopback SMTP server for outbox tests."""

    allow_reuse_address = True

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        super().__init__((host, port), _SmtpHandler)
        self.messages: list[dict[str, str]] = []
        self.rcpt_status = 250
        self.disconnect_after_data = False
        self._thread: threading.Thread | None = None

    @property
    def host(self) -> str:
        return self.server_address[0]

    @property
    def port(self) -> int:
        return self.server_address[1]

    def start(self) -> None:
        self._thread = threading.Thread(target=self.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self.shutdown()
        self.server_close()
        if self._thread:
            self._thread.join(timeout=2)
