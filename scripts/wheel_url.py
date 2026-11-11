"""Print the mirror URL for one pinned CPython 3.11 Linux wheel."""

from __future__ import annotations

import sys
import urllib.request
from html.parser import HTMLParser
from urllib.parse import unquote, urljoin, urlparse


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            self.links.extend(value for name, value in attrs if name == "href" and value)


package, version = sys.argv[1:]
index = f"https://mirrors.aliyun.com/pypi/simple/{package}/"
with urllib.request.urlopen(index) as response:
    parser = LinkParser()
    parser.feed(response.read().decode())
for link in parser.links:
    filename = unquote(urlparse(link).path.rsplit("/", 1)[-1])
    compatible_python = "cp311" in filename or "py3-none" in filename
    compatible_linux = "manylinux" in filename and ("x86_64" in filename or "any.whl" in filename)
    if f"-{version}-" in filename and filename.endswith(".whl") and compatible_python and compatible_linux:
        print(urljoin(index, link), filename)
        break
else:
    raise SystemExit(f"No compatible wheel for {package}=={version}")
