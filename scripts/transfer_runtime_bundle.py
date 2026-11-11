"""Transfer a runtime bundle with a short-lived OSS grant supplied via stdin."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import oss2

FILES = ("source.tar", "runtime.tar.gz", "environment-lock.json", "checksums.sha256")
PREFIX = "projects/system/runtime-bundles/5090-cu130-v1/"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["publish", "publish-source", "fetch"])
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    grant = json.load(sys.stdin)
    auth = oss2.StsAuth(grant["access_key_id"], grant["access_key_secret"], grant["security_token"])
    bucket = oss2.Bucket(auth, grant["endpoint"], grant["bucket"], connect_timeout=20)
    if args.action == "fetch":
        args.directory.mkdir(parents=True, exist_ok=False)
    selected = ("source.tar", "checksums.sha256") if args.action == "publish-source" else FILES
    for filename in selected:
        path = args.directory / filename
        key = PREFIX + filename
        if args.action.startswith("publish"):
            progress_mark = -1

            def progress(done: int, total: int, name: str = filename) -> None:
                nonlocal progress_mark
                if total and done * 10 // total > progress_mark:
                    progress_mark = done * 10 // total
                    print(f"{name} transfer: {progress_mark * 10}%", flush=True)

            oss2.resumable_upload(
                bucket,
                key,
                str(path),
                multipart_threshold=64 * 1024**2,
                part_size=64 * 1024**2,
                num_threads=3,
                progress_callback=progress,
            )
            assert bucket.head_object(key).content_length == path.stat().st_size
        else:
            oss2.resumable_download(bucket, key, str(path), part_size=64 * 1024**2, num_threads=3)
        print(f"{args.action} {filename}: {path.stat().st_size} bytes", flush=True)


if __name__ == "__main__":
    main()
