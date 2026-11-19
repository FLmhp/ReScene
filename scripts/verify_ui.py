"""Check built Web/Desktop UI with isolated API fixtures and save screenshots."""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from PIL import Image
from playwright.sync_api import Browser, Page, expect, sync_playwright


def verify_media_selection(page: Page, output: Path, client: str) -> None:
    requests = []
    dialogs = []

    def record(request):
        if "/upload-session" in request.url:
            requests.append(request.url)

    page.on("request", record)
    upload = page.locator('input[type="file"]')
    upload.set_input_files({"name": "renamed.jpg", "mimeType": "image/jpeg", "buffer": b"not a JPEG"})
    expect(page.get_by_text("内容与扩展名不符", exact=False)).to_be_visible()
    page.screenshot(path=str(output / f"{client}-material-validation.png"))
    with io.BytesIO() as raw:
        Image.new("RGB", (96, 96), (128, 128, 128)).save(raw, format="JPEG")
        photo = raw.getvalue()

    def dismiss(dialog):
        dialogs.append(dialog.message)
        dialog.dismiss()

    page.once("dialog", dismiss)
    upload.set_input_files(
        [{"name": name, "mimeType": "image/jpeg", "buffer": photo} for name in ("blur.jpg", "copy.jpg")]
    )
    expect(upload).to_be_enabled()
    assert len(dialogs) == 1 and "可能模糊" in dialogs[0] and "可能重复" in dialogs[0], dialogs
    assert not requests, requests
    page.remove_listener("request", record)


def verify_project_sidebar(browser: Browser, desktop_url: str, output: Path) -> None:
    page = browser.new_page(viewport={"width": 1180, "height": 660}, color_scheme="dark")
    projects = [
        {"id": f"p{i}", "name": f"{i:02} ReScene 长项目名称与验收记录", "owner_id": "u1", "effective_role": "owner"}
        for i in range(24)
    ]
    fixtures = {
        "/v1/auth/me": {"id": "u1", "email": "demo@example.test", "is_admin": True},
        "/v1/projects": projects,
        "/v1/workers/status": {"online": False, "workers": []},
        "/v1/notifications/count": {"unread": 0},
    }
    page.route(
        "https://api.rescene.xyz/**",
        lambda route: route.fulfill(json=fixtures.get(urlsplit(route.request.url).path, [])),
    )
    page.add_init_script("localStorage.setItem('rescene-token','fixture');")
    page.goto(desktop_url, wait_until="domcontentloaded")
    nav = page.get_by_role("navigation", name="项目", exact=True)
    buttons = nav.get_by_role("button")
    expect(buttons).to_have_count(len(projects))
    assert buttons.evaluate_all("""items => items.every(button => {
      const bounds = button.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(button);
      const content = text.getBoundingClientRect();
      return bounds.height >= 40 && content.top >= bounds.top && content.bottom <= bounds.bottom;
    })""")
    buttons.last.scroll_into_view_if_needed()
    assert nav.evaluate("element => element.scrollTop > 0")
    nav.evaluate("element => { element.scrollTop = 0; }")
    page.locator("aside").evaluate("element => { element.scrollTop = 0; }")
    page.locator("aside").screenshot(path=str(output / "windows-project-sidebar.png"))
    page.close()


def verify_viewer(browser: Browser, web_url: str, output: Path, scene: Path) -> None:
    """Render a real SPZ after a mocked object URL expires."""
    page = browser.new_page(viewport={"width": 1100, "height": 790}, color_scheme="dark")
    project = {"id": "p1", "name": "结果验证", "owner_id": "u1", "effective_role": "owner"}
    job = {
        "id": "j1",
        "project_id": "p1",
        "profile": "balanced",
        "status": "SUCCEEDED",
        "progress": 1,
        "attempt": 1,
        "cancel_requested": False,
        "created_at": "2026-11-18T00:00:00Z",
        "updated_at": "2026-11-18T00:10:00Z",
        "reconstruction_id": "r1",
    }
    expired_requests = 0

    def api(route):
        path = urlsplit(route.request.url).path
        if path.endswith("/manifest"):
            key = "fresh" if expired_requests else "expired"
            route.fulfill(
                json={
                    "reconstruction_id": "r1",
                    "artifacts": [{"kind": "spz", "url": f"https://preview.test/{key}.spz"}],
                }
            )
            return
        route.fulfill(
            json={
                "/v1/auth/me": {"id": "u1", "email": "demo@example.test", "is_admin": False},
                "/v1/projects": [project],
                "/v1/projects/p1": {
                    **project,
                    "asset_count": 0,
                    "job_count": 1,
                    "has_active_jobs": False,
                    "cover": None,
                    "latest_job": job,
                },
                "/v1/projects/p1/assets": {"items": [], "next_cursor": None},
                "/v1/projects/p1/jobs": {"items": [job], "next_cursor": None},
                "/v1/jobs/j1": job,
                "/v1/jobs/j1/logs": {"items": []},
                "/v1/workers/status": {"online": False, "workers": []},
                "/v1/notifications/count": {"unread": 0},
            }.get(path, [])
        )

    def objects(route):
        nonlocal expired_requests
        if route.request.url.endswith("expired.spz"):
            expired_requests += 1
            route.fulfill(status=403)
        else:
            route.fulfill(body=scene.read_bytes(), content_type="application/octet-stream")

    page.route("https://api.rescene.xyz/**", api)
    page.route("https://preview.test/**", objects)
    page.add_init_script(
        "localStorage.setItem('rescene-token','fixture');localStorage.setItem('rescene-project','p1');"
    )
    page.goto(web_url, wait_until="domcontentloaded")
    page.get_by_role("navigation", name="项目工作区").get_by_role("button", name="结果").click()
    open_scene = page.get_by_role("button", name="打开场景", exact=True)
    open_scene.click()
    dialog = page.get_by_role("dialog", name="场景查看器")
    expect(dialog.get_by_role("alert")).to_contain_text("过期", timeout=30_000)
    page.screenshot(path=str(output / "web-viewer-expired.png"))
    dialog.get_by_role("button", name="重试", exact=True).click()
    expect(dialog.locator(".viewer[data-rendered=true]")).to_be_visible(timeout=60_000)
    expect(dialog.get_by_role("link", name="下载 SPZ")).to_have_attribute("href", "https://preview.test/fresh.spz")
    page.screenshot(path=str(output / "web-viewer-recovered.png"))
    page.keyboard.press("Escape")
    expect(dialog).to_have_count(0)
    page.close()


def verify(web_url: str, desktop_url: str, output: Path, image: Path, scene: Path | None = None) -> None:
    output.mkdir(parents=True, exist_ok=True)
    project = {"id": "p1", "name": "厨房空间", "owner_id": "u1", "effective_role": "owner"}
    assets = [
        {"id": f"a{index}", "filename": f"厨房视角-{index:02}.jpg", "size": 890_000, "status": "READY"}
        for index in range(1, 7)
    ]
    assets.append(
        {"id": "pending", "filename": "正在上传的长文件名-厨房侧面.jpg", "size": 950_000, "status": "UPLOADING"}
    )
    base_job = {
        "id": "fixture-job",
        "project_id": "p1",
        "profile": "balanced",
        "status": "QUEUED",
        "progress": 0,
        "current_stage": "queued",
        "attempt": 0,
        "cancel_requested": False,
        "created_at": "2026-11-18T05:00:00Z",
        "updated_at": "2026-11-18T05:00:00Z",
    }
    results = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            channel="msedge", args=["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]
        )
        verify_project_sidebar(browser, desktop_url, output)
        results.append({"client": "windows-ui", "check": "long project names remain readable", "status": "PASS"})
        for client, base, widths in [("web", web_url, [1440, 1024, 768, 390]), ("windows-ui", desktop_url, [1280])]:
            for width in widths:
                for appearance in ("light", "dark"):
                    page = browser.new_page(viewport={"width": width, "height": 960}, color_scheme=appearance)
                    errors = []
                    posts = []
                    jobs = [base_job.copy()]
                    page.on("pageerror", lambda error, errors=errors: errors.append(str(error)))

                    def api(route, request, *, jobs=jobs, posts=posts):
                        url = urlsplit(route.request.url)
                        path = url.path
                        if path.endswith("/events"):
                            route.fulfill(body="", content_type="text/event-stream")
                        elif path.endswith("/logs"):
                            route.fulfill(json={"items": []})
                        elif path.endswith("/preview"):
                            route.fulfill(
                                json={"url": "https://preview.test/fixture.jpg", "expires_at": "2099-01-01T00:00:00Z"}
                            )
                        elif path == "/v1/projects/p1":
                            assert url.query == "view=summary", "Workspace requested the unbounded project detail"
                            route.fulfill(
                                json={
                                    **project,
                                    "asset_count": 500,
                                    "job_count": len(jobs),
                                    "has_active_jobs": True,
                                    "cover": assets[0],
                                    "latest_job": jobs[0],
                                }
                            )
                        elif path == "/v1/projects/p1/assets":
                            page_two = parse_qs(url.query).get("cursor") == ["page2"]
                            items = [{**assets[0], "id": "a7", "filename": "厨房视角-07.jpg"}] if page_two else assets
                            route.fulfill(json={"items": items, "next_cursor": None if page_two else "page2"})
                        elif path == "/v1/projects/p1/jobs" and route.request.method == "POST":
                            posts.append(route.request.post_data_json)
                            job = {**base_job, "id": "new-job", "profile": posts[-1]["profile"]}
                            jobs.insert(0, job)
                            route.fulfill(status=201, json=job)
                        elif path == "/v1/projects/p1/jobs":
                            route.fulfill(json={"items": jobs, "next_cursor": None})
                        elif path in {f"/v1/jobs/{item['id']}" for item in jobs}:
                            route.fulfill(json=next(item for item in jobs if path.endswith(f"/{item['id']}")))
                        else:
                            route.fulfill(
                                json={
                                    "/v1/auth/me": {"id": "u1", "email": "demo@example.test", "is_admin": False},
                                    "/v1/projects": [project],
                                    "/v1/projects/p1/members": [
                                        {"user_id": "u1", "email": "demo@example.test", "role": "owner"}
                                    ],
                                    "/v1/workers/status": {"online": False, "workers": []},
                                    "/v1/notifications/count": {"unread": 0},
                                }.get(path, [])
                            )

                    page.route("https://api.rescene.xyz/**", api)
                    page.route(
                        "https://preview.test/**",
                        lambda route: route.fulfill(body=image.read_bytes(), content_type="image/jpeg"),
                    )
                    page.add_init_script("localStorage.setItem('rescene-token','fixture');")
                    page.goto(base, wait_until="domcontentloaded")
                    expect(page.get_by_role("heading", name="我的项目")).to_be_visible()
                    page.screenshot(path=str(output / f"{client}-{width}-{appearance}-projects.png"), full_page=True)
                    page.get_by_role("button", name="打开项目").click()
                    expect(page.get_by_role("heading", name=project["name"])).to_be_visible()
                    if width >= 1280 and appearance == "light":
                        verify_media_selection(page, output, client)
                        results.append(
                            {"client": client, "check": "format, blur, duplicate preflight", "status": "PASS"}
                        )
                    start = page.get_by_role("button", name="开始三维重建")
                    expect(start).to_be_disabled()
                    expect(page.get_by_role("checkbox", name="正在上传", exact=False)).to_be_disabled()
                    page.get_by_role("button", name="全选本页图片", exact=True).click()
                    expect(start).to_be_enabled()
                    expect(page.get_by_text("已选 6 个素材", exact=False)).to_contain_text("离线")
                    quality = page.get_by_role("button", name="精细重建", exact=False)
                    quality.click()
                    expect(quality).to_have_attribute("aria-pressed", "true")
                    page.get_by_role("checkbox", name="厨房视角-01.jpg", exact=False).uncheck()
                    expect(page.get_by_text("已选 5 个素材", exact=False)).to_be_visible()
                    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                    expect(page.locator("html")).to_have_attribute("data-theme", appearance)
                    page.screenshot(path=str(output / f"{client}-{width}-{appearance}-workspace.png"), full_page=True)
                    if width >= 1280:
                        control = page.get_by_label("外观主题")
                        control.select_option("dark" if appearance == "light" else "light")
                        expect(page.get_by_text("已选 5 个素材", exact=False)).to_be_visible()
                        page.reload()
                        expect(page.locator("html")).to_have_attribute(
                            "data-theme", "dark" if appearance == "light" else "light"
                        )
                        page.get_by_role("button", name="全选本页图片", exact=True).click()
                        page.get_by_role("button", name="精细重建", exact=False).click()
                    asset_pages = page.get_by_role("navigation", name="素材分页")
                    asset_pages.get_by_role("button", name="下一页").click()
                    additional = page.get_by_role("checkbox", name="厨房视角-07.jpg", exact=False)
                    expect(additional).to_be_visible()
                    additional.check()
                    asset_pages.get_by_role("button", name="上一页").click()
                    expect(page.get_by_role("checkbox", name="厨房视角-02.jpg", exact=False)).to_be_checked()
                    start.click()
                    expect(page.get_by_role("status").filter(has_text="任务已进入队列")).to_be_visible()
                    assert (
                        len(posts) == 1
                        and posts[0]["profile"] == "quality"
                        and "pending" not in posts[0]["asset_ids"]
                        and "a7" in posts[0]["asset_ids"]
                    )
                    expect(page.locator(".job-state")).to_have_text("排队中")
                    if width == 390:
                        expect(
                            page.get_by_role("navigation", name="项目工作区").get_by_role("button", name="任务")
                        ).to_have_attribute("aria-pressed", "true")
                        page.screenshot(
                            path=str(output / f"{client}-{width}-{appearance}-offline-queue.png"), full_page=True
                        )
                    assert not errors, errors
                    results.append({"client": client, "width": width, "theme": appearance, "status": "PASS"})
                    print(client, width, appearance, "PASS", flush=True)
                    page.close()
        if scene:
            verify_viewer(browser, web_url, output, scene)
            results.append({"client": "web", "check": "expired SPZ link refreshed and rendered", "status": "PASS"})
            print("web Viewer refresh PASS", flush=True)
        browser.close()
    (output / "results.json").write_text(
        json.dumps({"data_source": "isolated API fixtures", "checks": results}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-url", default="http://127.0.0.1:4310")
    parser.add_argument("--desktop-url", default="http://127.0.0.1:4311")
    parser.add_argument("--output", type=Path, default=Path(".cache/ui-review-0.4.0"))
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--scene", type=Path, help="Optional local SPZ fixture for the Viewer recovery check")
    args = parser.parse_args()
    verify(args.web_url, args.desktop_url, args.output, args.image, args.scene)
