#!/usr/bin/env python3
"""Capture existing service responses and verify the public site deployment."""

import argparse
import hashlib
import json
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

BASELINE_URLS = (
    "https://app.rescene.xyz/",
    "https://api.rescene.xyz/health/ready",
    "https://soloeternity.me/",
)
SITE = "https://rescene.xyz"
TIMEOUT_SECONDS = 20
HOME_HEADING = "Reconstruct Reality in 3D."
DEMO_MODEL_PATH = "/assets/houseplant-ce9d490b18f1.splat"
DEMO_MODEL_BYTES = 3_636_736
DEMO_MODEL_SHA256 = "ce9d490b18f16d6730d832227bf541431b8b1a5d167c5a3fe89af4f324c0d8fd"


class NoRedirect(HTTPRedirectHandler):
    """Expose redirects so their status and location can be checked."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = build_opener(NoRedirect())


def fetch(url):
    """Fetch a URL without following redirects, using normal TLS verification."""
    request = Request(url, headers={"User-Agent": "ReScene-site-deploy-verifier/1.0"})
    try:
        response = OPENER.open(request, timeout=TIMEOUT_SECONDS)
    except HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def capture_baseline():
    results = {}
    for url in BASELINE_URLS:
        status, _, body = fetch(url)
        if url == BASELINE_URLS[1]:
            require(status == 200, f"{url}: expected 200, got {status}")
        results[url] = {"status": status, "sha256": hashlib.sha256(body).hexdigest()}
    return results


def check_existing(path):
    with path.open(encoding="utf-8") as file:
        baseline = json.load(file)
    require(isinstance(baseline, dict) and set(baseline) == set(BASELINE_URLS), "Invalid HTTP baseline")
    current = capture_baseline()
    for url in BASELINE_URLS:
        require(current[url] == baseline[url], f"{url}: HTTP status or body changed from baseline")


class SiteHTML(HTMLParser):
    """Extract the page heading and its stylesheet and script references."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_h1 = False
        self.heading = []
        self.stylesheets = []
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "h1":
            self.in_h1 = True
        elif tag == "link" and "stylesheet" in attributes.get("rel", "").lower().split():
            self.stylesheets.append(attributes.get("href", ""))
        elif tag == "script" and attributes.get("src"):
            self.scripts.append(attributes["src"])

    def handle_endtag(self, tag):
        if tag == "h1":
            self.in_h1 = False

    def handle_data(self, data):
        if self.in_h1:
            self.heading.append(data)


def check_response(url, expected_status, content_types=None):
    status, headers, body = fetch(url)
    require(status == expected_status, f"{url}: expected {expected_status}, got {status}")
    if content_types:
        content_type = headers.get_content_type().lower()
        require(content_type in content_types, f"{url}: unexpected Content-Type {content_type}")
    return headers, body


def content_security_policy(headers):
    """Return the response CSP as lowercase directive names mapped to sources."""
    directives = {}
    for directive in headers.get("Content-Security-Policy", "").split(";"):
        parts = directive.strip().split()
        if parts:
            directives[parts[0].lower()] = parts[1:]
    return directives


def check_fingerprinted_assets(page):
    """Require same-origin, immutable `/assets/` references for scripts and styles."""
    for references, content_types in (
        (page.stylesheets, {"text/css"}),
        (page.scripts, {"text/javascript", "application/javascript", "application/x-javascript"}),
    ):
        for reference in references:
            url = urljoin(SITE + "/", reference)
            parts = urlsplit(url)
            require(
                parts.scheme == "https" and parts.netloc == "rescene.xyz" and parts.path.startswith("/assets/"),
                f"Unexpected asset URL: {reference}",
            )
            asset_headers, _ = check_response(url, 200, content_types)
            cache = asset_headers.get("Cache-Control", "").lower()
            require(
                "immutable" in cache and "max-age=31536000" in cache,
                f"{url}: missing immutable long-lived Cache-Control",
            )


def check_demo():
    """Require the isolated demo policy and the pinned, verified public model."""
    headers, body = check_response(SITE + "/demo/", 200, {"text/html"})
    require("no-cache" in headers.get("Cache-Control", "").lower(), "Demo page must use Cache-Control: no-cache")
    directives = content_security_policy(headers)
    require(
        directives.get("script-src") == ["'self'", "'wasm-unsafe-eval'"],
        "Demo CSP must allow self scripts and wasm",
    )
    require(directives.get("worker-src") == ["blob:"], "Demo CSP must allow blob workers")
    require(
        directives.get("connect-src") == [SITE + DEMO_MODEL_PATH],
        "Demo CSP must allow only the pinned model",
    )
    page = SiteHTML()
    page.feed(body.decode("utf-8"))
    require(page.stylesheets and page.scripts, "Demo page must reference both CSS and JavaScript assets")
    check_fingerprinted_assets(page)
    model_headers, model_body = check_response(SITE + DEMO_MODEL_PATH, 200, {"application/octet-stream"})
    cache = model_headers.get("Cache-Control", "").lower()
    require("immutable" in cache and "max-age=31536000" in cache, "Demo model must be immutable")
    require(
        model_headers.get("Content-Length") == str(DEMO_MODEL_BYTES),
        "Demo model length differs from the pinned size",
    )
    require(
        hashlib.sha256(model_body).hexdigest() == DEMO_MODEL_SHA256,
        "Demo model SHA-256 differs from the pinned digest",
    )


def check_site():
    headers, body = check_response(SITE + "/", 200, {"text/html"})
    require("no-cache" in headers.get("Cache-Control", "").lower(), "Homepage must use Cache-Control: no-cache")
    require(
        content_security_policy(headers).get("connect-src") == ["'none'"],
        "Homepage CSP must specify connect-src 'none'",
    )
    page = SiteHTML()
    page.feed(body.decode("utf-8"))
    require("".join(page.heading).strip() == HOME_HEADING, "Homepage H1 differs from expected text")
    require(page.stylesheets and page.scripts, "Homepage must reference both CSS and JavaScript assets")
    check_fingerprinted_assets(page)

    for path, content_type in (
        ("/favicon.svg", "image/svg+xml"),
        ("/social-card.png", "image/png"),
        ("/social-card.svg", "image/svg+xml"),
        ("/media/admin-console.webp", "image/webp"),
        ("/media/mobile-drawer.webp", "image/webp"),
        ("/media/demo-houseplant.webp", "image/webp"),
        ("/media/viewer-reconstruction.webp", "image/webp"),
        ("/robots.txt", "text/plain"),
        ("/sitemap.xml", "application/xml"),
    ):
        check_response(SITE + path, 200, {content_type, "text/xml"} if path == "/sitemap.xml" else {content_type})

    check_demo()

    for path in ("/does-not-exist", "/deployments/", "/.env", "/.git/config"):
        check_response(SITE + path, 404)

    query = "/?site-deploy-check=one%20two&value=1"
    for source, expected_statuses in (("https://www.rescene.xyz", {301}), ("http://rescene.xyz", {301, 308})):
        status, redirect_headers, _ = fetch(source + query)
        require(status in expected_statuses, f"{source}: unexpected redirect status {status}")
        require(
            redirect_headers.get("Location") == SITE + query,
            f"{source}: unexpected redirect Location {redirect_headers.get('Location')!r}",
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("baseline", "existing", "verify"))
    parser.add_argument("baseline", type=Path, help="HTTP baseline JSON file")
    args = parser.parse_args()
    try:
        if args.command == "baseline":
            baseline = capture_baseline()
            args.baseline.write_text(json.dumps(baseline, indent=2) + "\n", encoding="utf-8")
        else:
            check_existing(args.baseline)
            if args.command == "verify":
                check_site()
    except (OSError, URLError, ValueError, UnicodeError, json.JSONDecodeError) as error:
        print(f"Site deployment verification failed: {error}", file=sys.stderr)
        return 1
    print(f"Site deployment {args.command} succeeded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
