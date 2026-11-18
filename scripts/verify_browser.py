"""Exercise deployed Web or Tauri workflows with a frozen image or video fixture."""

from __future__ import annotations

import argparse
import base64
import io
import json
import re
import subprocess
import sys
import traceback
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

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
    image_dir: Path | None = None,
    project: str = PROJECT,
    screenshots: Path | None = None,
    desktop_cdp: str | None = None,
    cancel_running: bool = False,
    new_job: bool = False,
    upload_only: bool = False,
) -> None:
    """Verify multipart upload, Job completion, actual SPZ rendering and sharing."""
    token = "" if sign_in else admin_token()
    with sync_playwright() as playwright:
        if desktop_cdp:
            browser = playwright.chromium.connect_over_cdp(desktop_cdp)
            context = browser.contexts[0]
            page = context.pages[0]
        else:
            browser = playwright.chromium.launch(
                executable_path=browser_executable, args=["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]
            )
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            page = context.new_page()
        if token:
            page.add_init_script(script=f"localStorage.setItem('rescene-token', {json.dumps(token)})")
        if not desktop_cdp:
            page.goto(APP, wait_until="domcontentloaded")

        def capture(name: str, selector: str | None = None) -> None:
            if screenshots is None:
                return
            screenshots.mkdir(parents=True, exist_ok=True)
            target = page.locator(selector) if selector else page
            target.screenshot(
                path=str(screenshots / f"{'desktop' if desktop_cdp else 'web'}-{name}.png"),
                animations="disabled",
                mask=[page.locator("aside")],
            )

        if sign_in and (not desktop_cdp or not page.evaluate("localStorage.getItem('rescene-token')")):
            expect(page.locator('input[name="email"]')).to_be_visible(timeout=30000)
            capture("01-login")
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
            print("browser login form verified", flush=True)
        if sign_in:
            token = page.evaluate("localStorage.getItem('rescene-token')")
            assert token
        projects = page.get_by_role("navigation", name="项目").get_by_role(
            "button", name=re.compile(rf"^{re.escape(project)}(?: · .+)?$")
        )
        expect(page.get_by_placeholder("新项目名称")).to_be_visible(timeout=30000)
        response = context.request.get(f"{API}/v1/projects", headers={"Authorization": f"Bearer {token}"})
        assert response.ok
        existing = next((entry for entry in response.json() if entry["name"] == project), None)
        if existing:
            projects.first.click()
        else:
            page.get_by_placeholder("新项目名称").fill(project)
            page.get_by_role("button", name="创建项目").click()
        expect(page.get_by_role("heading", name=project, exact=True)).to_be_visible(timeout=30000)
        response = context.request.get(f"{API}/v1/projects", headers={"Authorization": f"Bearer {token}"})
        assert response.ok
        project_id = next(entry["id"] for entry in response.json() if entry["name"] == project)
        print(f"project_id={project_id}", flush=True)
        print("workspace ready", flush=True)

        item = page.get_by_role("checkbox", name=video.name, exact=False)
        if not item.count() or item.first.is_disabled():
            file_input = page.locator('input[type="file"]')
            if interrupt_upload:
                blocked: set[str] = set()

                def upload_id(request) -> str | None:
                    query = parse_qs(urlsplit(request.url).query)
                    if request.method == "PUT" and "partNumber" in query:
                        return query.get("uploadId", [None])[0]
                    return None

                def interrupt(route) -> None:
                    part = parse_qs(urlsplit(route.request.url).query).get("partNumber", ["0"])[0]
                    key = upload_id(route.request)
                    if key and int(part) > 1:
                        blocked.add(key)
                        route.abort()
                    else:
                        route.continue_()

                pattern = "**/*oss-cn-beijing.aliyuncs.com/**"
                page.route(pattern, interrupt)
                file_input.set_input_files(str(video))
                retry = page.get_by_role("button", name="重试上传", exact=True)
                expect(retry).to_be_visible(timeout=120000)
                assert blocked, "No multipart request was interrupted"
                page.unroute(pattern, interrupt)
                with page.expect_request(lambda request: upload_id(request) in blocked, timeout=90000):
                    retry.click()
                print("multipart retry reused the original upload session", flush=True)
            elif image_dir is None:
                file_input.set_input_files(str(video))
            if image_dir is None:
                expect(item.first).to_be_enabled(timeout=150000)
        files = sorted(image_dir.glob("*.png"))[:8] if image_dir else [video]
        assert image_dir is None or len(files) == 8
        missing = []
        if image_dir is not None:
            missing = [str(file) for file in files if not page.get_by_role("checkbox", name=file.name).count()]
            if missing:
                page.locator('input[type="file"]').set_input_files(missing)
        for file in files:
            expect(page.get_by_role("checkbox", name=file.name).first).to_be_enabled(timeout=150000)
        capture("08-upload-recovered" if interrupt_upload else "02-upload-ready")
        print("browser upload complete", flush=True)
        if upload_only:
            return

        submitted = bool(new_job or cancel_running or missing or not page.locator(".job-head").count())
        if submitted:
            for file in files:
                page.get_by_role("checkbox", name=file.name).first.check()
            page.get_by_role("button", name="FAST", exact=False).click()
            with page.expect_response(
                lambda response: response.url.endswith("/jobs") and response.request.method == "POST"
            ) as job_response:
                page.get_by_role("button", name="开始三维重建").click()
            assert job_response.value.ok
            print(f"job_id={job_response.value.json()['id']}", flush=True)
            expect(page.locator(".job-head")).to_be_visible(timeout=20000)
        if cancel_running:
            expect(page.locator(".job-head strong")).to_have_text("RUNNING", timeout=90000)
            expect(page.locator(".job-head small")).to_have_text(re.compile("^(geometry|training)$"), timeout=90000)
            capture("06-cancel-running", ".job-head")
            page.get_by_role("button", name="取消任务", exact=True).click()
            expect(page.locator(".job-head strong")).to_have_text("CANCELLED", timeout=120000)
            expect(page.locator(".result-actions")).to_have_count(0)
            capture("07-cancelled", ".job-head")
            print("running job cancelled and never published", flush=True)
            return
        if submitted:
            capture("03-job-submitted", ".job-head")
        print("browser job submitted", flush=True)
        expect(page.locator(".job-head strong")).to_have_text("SUCCEEDED", timeout=480000)
        print("browser job succeeded", flush=True)
        page.get_by_role("button", name="打开场景", exact=True).click()
        canvas = page.locator(".viewer canvas")
        expect(canvas).to_be_visible(timeout=45000)
        print("WebGL canvas attached", flush=True)
        expect(page.get_by_text("正在加载 SPZ", exact=True)).to_have_count(0, timeout=120000)
        assert not page.get_by_text("SPZ 加载失败", exact=False).count()
        print("SPZ decoded", flush=True)
        expect(page.locator(".viewer")).to_have_attribute("data-rendered", "true", timeout=30000)
        capture("04-viewer", ".viewer canvas")
        if pixels:
            canvas.scroll_into_view_if_needed(timeout=30000)
            bounds = canvas.bounding_box(timeout=30000)
            assert bounds
            screenshot = page.screenshot(timeout=60000, clip=bounds, scale="css")
            with Image.open(io.BytesIO(screenshot)) as frame:
                assert len(frame.convert("RGB").resize((80, 60)).getcolors(4800) or []) > 24, "Canvas is visually empty"
        page.get_by_role("button", name="关闭查看器").click()
        for name in ("PLY", "SPZ", "METRICS", "REPORT", "MANIFEST"):
            link = page.get_by_role("link", name=f"{name} 下载", exact=True)
            result = context.request.get(link.get_attribute("href"), headers={"Range": "bytes=0-0"})
            assert result.status == 206 and len(result.body()) == 1
        print("SPZ render loop and five downloads verified", flush=True)

        page.get_by_text("管理分享", exact=True).click()
        page.get_by_role("button", name="创建分享", exact=True).click()
        share_input = page.get_by_role("textbox", name="新分享链接")
        expect(share_input).to_be_visible(timeout=15000)
        share_url = share_input.input_value()
        share_token = share_url.rsplit("/", 1)[-1]
        assert context.request.get(f"{API}/v1/public/shares/{share_token}").ok
        page.once("dialog", lambda dialog: dialog.accept())
        page.get_by_role("button", name="撤销", exact=True).click()
        expect(page.get_by_text("已撤销", exact=False)).to_be_visible(timeout=15000)
        assert context.request.get(f"{API}/v1/public/shares/{share_token}").status == 404
        capture("05-share-revoked", ".result-actions")
        print("share creation and revocation verified", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--interrupt-upload", action="store_true")
    parser.add_argument("--browser-executable", type=Path)
    parser.add_argument("--pixels", action="store_true")
    parser.add_argument("--sign-in", action="store_true")
    parser.add_argument("--image-dir", type=Path)
    parser.add_argument("--project", default=PROJECT)
    parser.add_argument("--screenshots", type=Path)
    parser.add_argument("--desktop-cdp", choices=["http://127.0.0.1:9223"])
    parser.add_argument("--cancel-running", action="store_true")
    parser.add_argument("--new-job", action="store_true", help="submit another job with the existing ready fixture")
    parser.add_argument("--upload-only", action="store_true")
    args = parser.parse_args()
    try:
        verify(
            args.video,
            args.interrupt_upload,
            args.browser_executable,
            pixels=args.pixels,
            sign_in=args.sign_in,
            image_dir=args.image_dir,
            project=args.project,
            screenshots=args.screenshots,
            desktop_cdp=args.desktop_cdp,
            cancel_running=args.cancel_running,
            new_job=args.new_job,
            upload_only=args.upload_only,
        )
    except Exception as error:
        location = next(
            frame for frame in reversed(traceback.extract_tb(error.__traceback__)) if frame.filename == __file__
        )
        print(f"Browser acceptance failed: {type(error).__name__} ({location.name}:{location.lineno})", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
