#!/usr/bin/env python3
"""Read and update dotenv files without executing their contents.

Usage: origin VALUE | mcp-url API_ORIGIN OVERRIDE | read KEY PATH | upsert KEY VALUE PATH | remove PATH KEY...

Supports single-line assignments, export, quotes, whitespace, inline comments,
CRLF and Compose escapes. The last assignment wins. Interpolation and multiline
values are rejected without printing configuration values. For literal dollars,
use single quotes, $$ or \\$.
"""

import argparse
import ipaddress
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from typing import NamedTuple, Optional
from urllib.parse import urlsplit

KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
ASSIGNMENT = re.compile(r"[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)\Z")
SAFE_VALUE = re.compile(r"[A-Za-z0-9_./:@,+%=-]*\Z")
LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\Z")


class ConfigError(ValueError):
    """An error safe to print: never include configuration values."""


class Line(NamedTuple):
    raw: str
    key: Optional[str]
    value: Optional[str]


def validate_key(key: str) -> None:
    if not KEY.fullmatch(key):
        raise ConfigError("invalid environment variable name")


def validate_value(value: str) -> None:
    if any((ord(c) < 32 and c != "\t") or 127 <= ord(c) <= 159 for c in value):
        raise ConfigError("multiline/control characters are unsupported")


def _dollar(text: str, index: int):
    if text[index:index + 2] == "$$":
        return "$", index + 2
    if index + 1 < len(text) and (text[index + 1] in "{(" or re.match(r"[A-Za-z_]", text[index + 1])):
        raise ConfigError("interpolation/substitution is unsupported; single-quote literal values")
    return "$", index + 1


def parse_value(text: str) -> str:
    validate_value(text)
    if not text:
        return ""
    quote = text[0] if text[0] in "\"'" else None
    if quote is None:
        text = re.split(r"(?:(?<=[ \t])|^)#", text, maxsplit=1)[0].strip(" \t")
        result = []
        i = 0
        while i < len(text):
            if text[i] == "$":
                value, i = _dollar(text, i)
                result.append(value)
            else:
                result.append(text[i])
                i += 1
        return "".join(result)

    result = []
    i = 1
    while i < len(text):
        char = text[i]
        if char == quote:
            suffix = text[i + 1:].lstrip(" \t")
            if suffix and not suffix.startswith("#"):
                raise ConfigError("unexpected text after quoted value")
            value = "".join(result)
            validate_value(value)
            return value
        if char == "\\" and i + 1 < len(text):
            next_char = text[i + 1]
            if quote == "'":
                # Compose keeps pairs of literal backslashes in single quotes.
                if next_char == "\\":
                    result.append("\\\\")
                    i += 2
                    continue
                if next_char == "'":
                    result.append("'")
                    i += 2
                    continue
            else:
                escapes = {"\\": "\\", '"': '"', "$": "$", "t": "\t",
                           "n": "\n", "r": "\r", "a": "\a", "b": "\b", "f": "\f", "v": "\v"}
                if next_char in escapes:
                    result.append(escapes[next_char])
                    i += 2
                    continue
                raise ConfigError("unsupported double-quoted escape; single-quote literal values")
        if quote == '"' and char == "$":
            value, i = _dollar(text, i)
            result.append(value)
            continue
        result.append(char)
        i += 1
    raise ConfigError("unterminated quote; multiline values are unsupported")


def load_lines(path: Path):
    if path.is_symlink():
        raise ConfigError("symlink environment files are unsupported")
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return []
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ConfigError("environment file must be UTF-8") from None
    lines = []
    # Do not use splitlines(): it silently consumes non-newline control bytes.
    physical = text.split("\n")
    if physical and physical[-1] == "":
        physical.pop()
    for number, body in enumerate(physical, 1):
        original = body + ("\n" if number < len(physical) or text.endswith("\n") else "")
        if body.endswith("\r") and original.endswith("\n"):
            body = body[:-1]
        try:
            validate_value(body)
            if not body.strip(" \t") or body.lstrip(" \t").startswith("#"):
                lines.append(Line(original, None, None))
                continue
            match = ASSIGNMENT.fullmatch(body)
            if not match:
                raise ConfigError("unsupported syntax; expected KEY=value")
            key, value = match.groups()
            lines.append(Line(original, key, parse_value(value)))
        except ConfigError as error:
            raise ConfigError(f"line {number}: {error}") from None
    return lines


def read_env(key: str, path: Path) -> str:
    validate_key(key)
    found = ""
    for line in load_lines(path):
        if line.key == key:
            found = line.value
    return found


def encode_value(value: str) -> str:
    validate_value(value)
    if SAFE_VALUE.fullmatch(value):
        return value
    # Double quotes plus explicit escaping round-trip arbitrary single-line secrets.
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$").replace("\t", "\\t") + '"'


def write_lines(path: Path, content: str) -> None:
    """Replace atomically, preserving owner and restrictive mode; new files are 0600."""
    if path.is_symlink():
        raise ConfigError("symlink environment files are unsupported")
    existing = path.stat() if path.exists() else None
    if existing and not stat.S_ISREG(existing.st_mode):
        raise ConfigError("environment path must be a regular file")
    data = content.encode("utf-8")
    if existing and path.read_bytes() == data:
        return
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            if existing:
                current = os.fstat(stream.fileno())
                if (current.st_uid, current.st_gid) != (existing.st_uid, existing.st_gid):
                    os.fchown(stream.fileno(), existing.st_uid, existing.st_gid)
                os.fchmod(stream.fileno(), stat.S_IMODE(existing.st_mode) & 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def upsert_env(key: str, value: str, path: Path) -> None:
    validate_key(key)
    encoded = encode_value(value)
    lines = load_lines(path)
    newline = "\r\n" if any(line.raw.endswith("\r\n") for line in lines) else "\n"
    replacement = f"{key}={encoded}{newline}"
    output = []
    inserted = False
    for line in lines:
        if line.key == key:
            if not inserted:
                output.append(replacement)
                inserted = True
        else:
            output.append(line.raw)
    if not inserted:
        if output and not output[-1].endswith("\n"):
            output.append(newline)
        output.append(replacement)
    write_lines(path, "".join(output))


def remove_env(path: Path, keys) -> None:
    for key in keys:
        validate_key(key)
    lines = load_lines(path)
    if not path.exists():
        return
    write_lines(path, "".join(line.raw for line in lines if line.key not in keys))


def normalize_origin(value: str) -> str:
    """Validate a single HTTP(S) origin without fixing malformed authority tokens."""
    # Trim user prompt padding only, not CR/LF (urlsplit otherwise hides these).
    value = value.strip(" \t")
    if not value or any(c.isspace() or ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
        raise ConfigError("origin must not contain whitespace/control characters")
    if not value.startswith(("http://", "https://")):
        raise ConfigError("origin must start with http:// or https://")
    if any(c in value for c in ("\\", "?", "#", ",")):
        raise ConfigError("origin must not contain backslashes, lists, query, or fragment")
    try:
        parsed = urlsplit(value)
        if not parsed.netloc or parsed.path not in ("", "/"):
            raise ConfigError("origin must have a host and no path")
        if "@" in parsed.netloc or parsed.username is not None or parsed.password is not None:
            raise ConfigError("origin must not include credentials")
        authority = parsed.netloc
        if authority.startswith("["):
            end = authority.index("]")
            host = authority[1:end]
            if "%" in host:
                raise ConfigError("scoped/escaped IP addresses are unsupported")
            ipaddress.IPv6Address(host)
            suffix = authority[end + 1:]
            if suffix and not suffix.startswith(":"):
                raise ConfigError("invalid origin authority")
            port = suffix[1:] if suffix else None
        else:
            if authority.count(":") > 1:
                raise ConfigError("IPv6 addresses require brackets")
            host, colon, port = authority.partition(":")
            port = port if colon else None
            if not host or len(host) > 253 or any(ord(char) > 127 for char in host):
                raise ConfigError("invalid hostname; use ASCII/punycode domains")
            labels = host[:-1].split(".") if host.endswith(".") else host.split(".")
            if not all(LABEL.fullmatch(label) for label in labels):
                raise ConfigError("invalid hostname")
            if re.fullmatch(r"[0-9.]+", host):
                ipaddress.IPv4Address(host)
        if port is not None and (not re.fullmatch(r"[0-9]+", port) or not 1 <= int(port) <= 65535):
            raise ConfigError("port must be an integer from 1 to 65535")
    except (ValueError, IndexError):
        raise ConfigError("invalid HTTP(S) origin authority or port") from None
    return value[:-1] if value.endswith("/") else value


def resolve_mcp_url(api_origin: str, override: str) -> str:
    value = override.strip(" \t") if override else normalize_origin(api_origin) + "/mcp"
    validate_value(value)
    if any(c.isspace() for c in value):
        raise ConfigError("MCP_PUBLIC_URL must not contain whitespace")
    try:
        parsed = urlsplit(value)
        normalize_origin(f"{parsed.scheme}://{parsed.netloc}")
    except ValueError:
        raise ConfigError("MCP_PUBLIC_URL must have a valid HTTP(S) origin") from None
    if parsed.scheme != "https" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        if not override:
            # Keep HTTP-only installations usable without enabling remote MCP.
            return ""
        raise ConfigError("MCP_PUBLIC_URL requires HTTPS except on loopback")
    if parsed.query or parsed.fragment or not parsed.path.endswith("/mcp"):
        raise ConfigError("MCP_PUBLIC_URL must end in /mcp without a query or fragment")
    return value


def main(argv=None) -> int:
    # Explicit arity lets upsert accept secret values beginning with '-' and keeps
    # argparse's "unrecognized arguments" diagnostics from exposing secrets.
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(description=__doc__)
    if argv in (["--help"], ["-h"]):
        parser.print_help()
        return 0
    command = argv[0] if argv else ""
    expected = {"origin": 2, "mcp-url": 3, "read": 3, "upsert": 4}
    valid = (command in expected and len(argv) == expected[command]) or (command == "remove" and len(argv) >= 3)
    if not valid:
        print("usage: install-config.py origin VALUE | mcp-url API_ORIGIN OVERRIDE | read KEY PATH | upsert KEY VALUE PATH | remove PATH KEY...", file=sys.stderr)
        return 2
    try:
        if command == "origin":
            print(normalize_origin(argv[1]))
        elif command == "mcp-url":
            print(resolve_mcp_url(argv[1], argv[2]))
        elif command == "read":
            print(read_env(argv[1], Path(argv[2])))
        elif command == "upsert":
            upsert_env(argv[1], argv[2], Path(argv[3]))
        else:
            remove_env(Path(argv[1]), argv[2:])
    except (ConfigError, OSError) as error:
        message = str(error) if isinstance(error, ConfigError) else "unable to read/write environment file"
        print(f"配置错误 / configuration error: {message}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
