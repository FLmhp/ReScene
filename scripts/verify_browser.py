"""Exercise the deployed browser workflow with a fixed video input."""

from __future__ import annotations

import argparse
import base64
import io
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright

APP = "https://app.rescene.xyz"
API = "https://api.rescene.xyz"
PROJECT = "Release V1 Video Acceptance"


def admin_token() -> str:
    """Retrieve a short-lived token over SSH without logging it."""
    helper = Path("infra/deploy/issue_admin_token.py").read_bytes()
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "soloeternity-root", "docker exec -i rescene-api python -"],
        input=helper,
        capture_output=True,
        check=True,
        timeout=30,
    )
    return base64.b64decode(result.stdout.strip(), validate=True).decode()


def verify(
    video: Path,
    interrupt_upload: bool,
    browser_executable: Path | None = None,
    *,
    pixels: bool = False,
    sign_in: bool = False,
) -> None:
    """Verify multipart upload, Job completion, actual SPZ rendering and sharing."""
    token = "" if sign_in else admin_token()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=browser_executable, args=["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]
        )
        context = browser.new_context(
            viewport={"width": 820, "height": 650}, permissions=["clipboard-read", "clipboard-write"]
        )
        page = context.new_page()
        if token:
            page.add_init_script(script=f"localStorage.setItem('rescene-token', {json.dumps(token)})")
        page.goto(APP, wait_until="domcontentloaded")
        if sign_in:
            password = (
                subprocess.check_output(
                    [
                        "ssh",
                        "-o",
                        "BatchMode=yes",
                        "soloeternity-root",
                        "cat /opt/rescene/infra/secrets/admin_password",
                    ],
                    timeout=20,
                )
                .decode()
                .strip()
            )
            page.locator('input[name="email"]').fill("admin@rescene.xyz")
            page.locator('input[name="password"]').fill(password)
            del password
            page.get_by_role("button", name="进入工作台").click()
            expect(page.get_by_placeholder("新项目名称")).to_be_visible(timeout=30000)
            token = page.evaluate("localStorage.getItem('rescene-token')")
            assert token
            print("browser login form verified", flush=True)
        projects = page.get_by_role("button", name=PROJECT, exact=True)
        expect(page.get_by_placeholder("新项目名称")).to_be_visible(timeout=30000)
        response = context.request.get(f"{API}/v1/projects", headers={"Authorization": f"Bearer {token}"})
        assert response.ok
        exists = any(project["name"] == PROJECT for project in response.json())
        if exists:
            projects.first.click()
        else:
            page.get_by_placeholder("新项目名称").fill(PROJECT)
            page.get_by_role("button", name="创建项目").click()
        expect(page.get_by_role("heading", name=PROJECT, exact=True)).to_be_visible(timeout=30000)
        print("workspace ready", flush=True)

        item = page.get_by_role("checkbox", name=video.name, exact=False)
        if not item.count() or item.first.is_disabled():
            file_input = page.locator('input[type="file"]')
            if interrupt_upload:
                blocked = []

                def interrupt(route) -> None:
                    if "partNumber=" in route.request.url and route.request.method == "PUT":
                        blocked.append(True)
                        route.abort()
                    else:
                        route.continue_()

                pattern = "**/*oss-cn-beijing.aliyuncs.com/**"
                page.route(pattern, interrupt)
                file_input.set_input_files(str(video))
                expect(page.get_by_text("上传中断", exact=False)).to_be_visible(timeout=120000)
                assert blocked, "No multipart request was interrupted"
                page.unroute(pattern, interrupt)
                print("multipart interruption observed", flush=True)
            file_input.set_input_files(str(video))
            expect(item.first).to_be_enabled(timeout=150000)
        print("browser multipart upload complete", flush=True)

        if not page.locator(".job-head").count():
            item.first.check()
            page.get_by_role("button", name="FAST", exact=False).click()
            page.get_by_role("button", name="开始三维重建").click()
            expect(page.locator(".job-head")).to_be_visible(timeout=20000)
        print("video job submitted", flush=True)
        expect(page.locator(".job-head strong")).to_have_text("SUCCEEDED", timeout=480000)
        print("video job succeeded", flush=True)
        page.get_by_role("button", name="打开 SPZ 场景").click()
        canvas = page.locator(".viewer canvas")
        expect(canvas).to_be_visible(timeout=45000)
        print("WebGL canvas attached", flush=True)
        expect(page.get_by_text("正在加载 SPZ", exact=True)).to_have_count(0, timeout=120000)
        assert not page.get_by_text("SPZ 加载失败", exact=False).count()
        print("SPZ decoded", flush=True)
        expect(page.locator(".viewer")).to_have_attribute("data-rendered", "true", timeout=30000)
        if pixels:
            canvas.scroll_into_view_if_needed(timeout=30000)
            bounds = canvas.bounding_box(timeout=30000)
            assert bounds
            screenshot = page.screenshot(timeout=60000, clip=bounds, scale="css")
            with Image.open(io.BytesIO(screenshot)) as frame:
                assert len(frame.convert("RGB").resize((80, 60)).getcolors(4800) or []) > 24, "Canvas is visually empty"
        page.get_by_role("button", name="关闭查看器").click()
        for name in ("PLY", "SPZ", "METRICS", "REPORT", "MANIFEST"):
            link = page.get_by_role("link", name=name, exact=True)
            result = context.request.get(link.get_attribute("href"), headers={"Range": "bytes=0-0"})
            assert result.status == 206 and len(result.body()) == 1
        print("SPZ render loop and five downloads verified", flush=True)

        page.get_by_role("button", name="复制分享链接").click()
        expect(page.get_by_text("分享链接已复制")).to_be_visible(timeout=15000)
        share_url = page.evaluate("navigator.clipboard.readText()")
        share_token = share_url.rsplit("/", 1)[-1]
        assert context.request.get(f"{API}/v1/public/shares/{share_token}").ok
        page.get_by_role("button", name="撤销分享").click()
        expect(page.get_by_text("分享链接已撤销")).to_be_visible(timeout=15000)
        assert context.request.get(f"{API}/v1/public/shares/{share_token}").status == 404
        print("share creation and revocation verified", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--interrupt-upload", action="store_true")
    parser.add_argument("--browser-executable", type=Path)
    parser.add_argument("--pixels", action="store_true")
    parser.add_argument("--sign-in", action="store_true")
    args = parser.parse_args()
    try:
        verify(args.video, args.interrupt_upload, args.browser_executable, pixels=args.pixels, sign_in=args.sign_in)
    except Exception as error:
        print(f"Browser acceptance failed: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
