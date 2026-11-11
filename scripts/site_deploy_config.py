#!/usr/bin/env python3
"""Prepare isolated Caddy configuration candidates and deployment records."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

BEGIN = b"# BEGIN RESCENE PUBLIC SITE"
END = b"# END RESCENE PUBLIC SITE"
DOMAIN = re.compile(r"(?<![a-z0-9_.-])(?:www\.)?rescene\.xyz(?=$|[:/])", re.IGNORECASE)
TOKEN = re.compile(r'"(?:\\.|[^"\\])*"|`[^`]*`|[^\s,]+|,')
IMPORT = re.compile(rb"(?m)^[ \t]*import[ \t]+rescene\.caddy[ \t]*(?=\r?$)")


def _block_span(data: bytes, required: bool) -> tuple[int, int] | None:
    """Locate one complete, line-delimited managed block, rejecting malformed markers."""
    markers = []
    offset = 0
    for line in data.splitlines(keepends=True):
        content = line.rstrip(b"\r\n")
        if BEGIN in content or END in content:
            if content not in (BEGIN, END) or not line.endswith(b"\n"):
                raise ValueError("malformed public site marker")
            markers.append((content, offset, offset + len(line)))
        offset += len(line)
    if not markers and not required:
        return None
    if len(markers) != 2 or markers[0][0] != BEGIN or markers[1][0] != END:
        raise ValueError("expected exactly one complete public site block")
    return markers[0][1], markers[1][2]


def _reject_site_declarations(data: bytes, source: str) -> None:
    """Reject public-site addresses in top-level Caddy site headers.

    Braces inside tokens such as Caddy placeholders are not block delimiters.
    Comments and quoted strings are tokenized without treating their contents
    as braces; a header is never carried across an unrelated block.
    """
    depth = 0
    header = []
    continuation = False
    for line in data.decode("latin-1").splitlines():
        tokens = []
        for match in TOKEN.finditer(line):
            token = match.group()
            if token.startswith("#"):
                break
            tokens.append(token)
        if depth == 0 and not continuation:
            header = []
        for token in tokens:
            if token == "{":
                if depth == 0:
                    if any(DOMAIN.search(part.strip('"`')) for part in header):
                        raise ValueError(f"unmanaged public site declaration in {source}")
                    header = []
                depth += 1
            elif token == "}":
                depth -= 1
                if depth < 0:
                    raise ValueError(f"unbalanced Caddy braces in {source}")
                header = []
            elif depth == 0:
                header.append(token)
        continuation = depth == 0 and bool(tokens) and tokens[-1] == ","
    if depth:
        raise ValueError(f"unbalanced Caddy braces in {source}")


def _extract(repo_caddy: str, output: str) -> None:
    data = Path(repo_caddy).read_bytes()
    start, end = _block_span(data, required=True)
    Path(output).write_bytes(data[start:end])


def _compose(server_caddy: str, main_caddy: str, block_path: str, output: str, main_output: str) -> None:
    server = Path(server_caddy).read_bytes()
    main = Path(main_caddy).read_bytes()
    block = Path(block_path).read_bytes()
    block_span = _block_span(block, required=True)
    if block_span != (0, len(block)):
        raise ValueError("block input must contain only the managed block")
    span = _block_span(server, required=False)
    _block_span(main, required=False)
    outside = server if span is None else server[: span[0]] + b"\n" + server[span[1] :]
    _reject_site_declarations(outside, server_caddy)
    _reject_site_declarations(main, main_caddy)
    imports = list(IMPORT.finditer(main))
    if len(imports) != 1:
        raise ValueError("main Caddyfile must contain exactly one standalone import rescene.caddy line")
    name = os.path.basename(output)
    if not name or re.search(r'[\s"`#{}]', name):
        raise ValueError("candidate Caddyfile basename is not a safe Caddy token")
    replacement = b"import " + os.fsencode(name)
    candidate_main = main[: imports[0].start()] + replacement + main[imports[0].end() :]
    if span is None:
        candidate = server + (b"\n" if server and not server.endswith(b"\n") else b"") + block
    else:
        candidate = server[: span[0]] + block + server[span[1] :]
    Path(output).write_bytes(candidate)
    Path(main_output).write_bytes(candidate_main)


def _invalid_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


def _record(path: str, entries: list[str]) -> None:
    target = Path(path)
    if target.exists():
        with target.open("r", encoding="utf-8") as stream:
            record = json.load(stream)
        if not isinstance(record, dict):
            raise ValueError("existing record must be a JSON object")
    else:
        record = {}
    for entry in entries:
        key, separator, value = entry.partition("=")
        if not separator or not key:
            raise ValueError("record entries must have the form key=value")
        try:
            record[key] = json.loads(value, parse_constant=_invalid_json_constant)
        except ValueError:
            record[key] = value
    serialized = json.dumps(record, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        if target.exists():
            os.chmod(temporary, target.stat().st_mode & 0o777)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            fd = -1
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if fd != -1:
            os.close(fd)
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> int:
    """Run the requested deployment helper command."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    extract = commands.add_parser("extract")
    extract.add_argument("repo_caddy")
    extract.add_argument("output")
    compose = commands.add_parser("compose")
    compose.add_argument("server_caddy")
    compose.add_argument("main_caddy")
    compose.add_argument("block")
    compose.add_argument("output")
    compose.add_argument("main_output")
    record = commands.add_parser("record")
    record.add_argument("path")
    record.add_argument("entries", nargs="*")
    args = parser.parse_args()
    try:
        if args.command == "extract":
            _extract(args.repo_caddy, args.output)
        elif args.command == "compose":
            _compose(args.server_caddy, args.main_caddy, args.block, args.output, args.main_output)
        else:
            _record(args.path, args.entries)
    except (OSError, ValueError) as exc:
        print(f"site_deploy_config: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
