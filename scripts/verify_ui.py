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


FIXTURE_EMAIL = "demo@example.test"
FIXTURE_PASSWORD = "fixture-password"


def sign_in(page: Page, base: str) -> None:
    page.goto(base, wait_until="domcontentloaded")
    page.get_by_label("邮箱", exact=False).fill(FIXTURE_EMAIL)
    page.get_by_label("密码", exact=True).fill(FIXTURE_PASSWORD)
    page.get_by_role("button", name="登录", exact=True).click()
    expect(page.get_by_role("heading", name="项目列表", exact=True)).to_be_visible()


def respond_to_login(route) -> None:
    assert route.request.method == "POST"
    assert route.request.post_data_json == {"email": FIXTURE_EMAIL, "password": FIXTURE_PASSWORD}
    route.fulfill(json={"access_token": "fixture", "token_type": "bearer"})


def verify_project_library(browser: Browser, desktop_url: str, output: Path) -> None:
    page = browser.new_page(viewport={"width": 1180, "height": 660}, color_scheme="dark")
    projects = [
        {
            "id": f"p{i}",
            "name": f"{i:02} ReScene 长项目名称与验收记录",
            "owner_id": "u1",
            "effective_role": "owner",
            "asset_count": 0,
            "job_count": 0,
            "has_active_jobs": False,
            "cover": None,
            "latest_job": None,
        }
        for i in range(24)
    ]
    fixtures = {
        "/v1/auth/me": {"id": "u1", "email": "demo@example.test", "is_admin": True},
        "/v1/projects": projects,
        "/v1/workers/status": {"online": False, "workers": []},
        "/v1/notifications/count": {"unread": 0},
    }

    def api(route):
        path = urlsplit(route.request.url).path
        if path == "/v1/auth/login":
            respond_to_login(route)
        else:
            route.fulfill(json=fixtures.get(path, []))

    page.route("**/v1/**", api)
    sign_in(page, desktop_url)
    rows = page.get_by_role("button", name="ReScene 长项目名称与验收记录", exact=False)
    expect(rows).to_have_count(8)
    expect(page.locator("aside").get_by_role("button", name="ReScene 长项目名称与验收记录", exact=False)).to_have_count(
        0
    )
    assert rows.evaluate_all("""items => items.every(button => {
      const bounds = button.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(button);
      const content = text.getBoundingClientRect();
      return bounds.height >= 44 && content.top >= bounds.top && content.bottom <= bounds.bottom;
    })""")
    page.get_by_role("button", name="下一页", exact=True).click()
    expect(page.get_by_text("第 2 / 3 页", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name=projects[8]["name"], exact=True)).to_be_visible()
    page.screenshot(path=str(output / "windows-project-library.png"))
    page.close()


def verify_viewer(browser: Browser, web_url: str, output: Path, scene: Path) -> None:
    """Render a real SPZ after a mocked object URL expires."""
    page = browser.new_page(viewport={"width": 1280, "height": 790}, color_scheme="dark")
    project = {
        "id": "p1",
        "name": "结果验证",
        "owner_id": "u1",
        "effective_role": "owner",
        "asset_count": 0,
        "job_count": 1,
        "has_active_jobs": False,
        "cover": None,
    }
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
    project["latest_job"] = job
    expired_requests = 0
    digest = "c0ffee12" * 8

    def api(route):
        path = urlsplit(route.request.url).path
        if path == "/v1/auth/login":
            respond_to_login(route)
            return
        if path.endswith("/manifest"):
            key = "fresh" if expired_requests else "expired"
            route.fulfill(
                json={
                    "reconstruction_id": "r1",
                    "artifacts": [
                        {"kind": kind, "url": f"https://preview.test/{key}.{kind}", "size": size, "sha256": digest}
                        for kind, size in (("spz", 2_000_000), ("ply", 200_000_000), ("metrics", 1100), ("report", 500))
                    ],
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

    page.route("**/v1/**", api)
    page.route("https://preview.test/**", objects)
    sign_in(page, web_url)
    page.get_by_role("button", name=project["name"], exact=True).click()
    page.get_by_role("navigation", name="项目工作区").get_by_role("button", name="结果").click()
    page.get_by_role("button", name="均衡重建", exact=False).click()
    expect(page.get_by_role("heading", name="成果详情", exact=True)).to_be_visible()
    downloads_entry = page.get_by_role("button", name="下载与校验", exact=True)
    downloads_entry.click()
    downloads = page.get_by_role("region", name="产物下载")
    expect(downloads.get_by_role("link", name="METRICS 下载")).to_be_visible()
    expect(downloads.get_by_text("1.1 KiB", exact=True)).to_be_visible()
    expect(downloads.get_by_text(digest).first).to_be_hidden()
    assert downloads.locator(".artifact-list li").evaluate_all("""items => items.every((row, index) => {
      const box = row.getBoundingClientRect();
      const button = row.querySelector('a').getBoundingClientRect();
      const previous = items[index - 1]?.getBoundingClientRect();
      return button.top >= box.top && button.bottom <= box.bottom && (!previous || previous.bottom < box.top);
    })""")
    downloads.screenshot(path=str(output / "desktop-result-layout.png"))
    page.get_by_role("button", name="← 返回成果", exact=True).click()
    page.get_by_role("button", name="打开三维场景", exact=True).click()
    dialog = page.get_by_role("dialog", name="场景查看器")
    expect(dialog.get_by_role("alert")).to_contain_text("过期", timeout=30_000)
    assert expired_requests > 0
    page.screenshot(path=str(output / "web-viewer-expired.png"))
    dialog.get_by_role("button", name="重试", exact=True).click()
    expect(dialog.locator(".viewer[data-rendered=true]")).to_be_visible(timeout=60_000)
    expect(dialog.get_by_role("link", name="下载 SPZ")).to_have_attribute("href", "https://preview.test/fresh.spz")
    page.screenshot(path=str(output / "web-viewer-recovered.png"))
    page.keyboard.press("Escape")
    expect(dialog).to_have_count(0)
    page.set_viewport_size({"width": 390, "height": 790})
    downloads_entry.click()
    downloads.get_by_text("校验值（SHA-256）", exact=True).click()
    expect(downloads.get_by_text(digest).first).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
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
    project.update(
        {
            "asset_count": 500,
            "job_count": 1,
            "has_active_jobs": True,
            "cover": assets[0],
            "latest_job": base_job,
        }
    )
    results = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            channel="msedge", args=["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]
        )
        verify_project_library(browser, desktop_url, output)
        results.append({"client": "windows-ui", "check": "paged long project names remain readable", "status": "PASS"})
        for client, base, widths in [
            ("web", web_url, [1440, 1024, 390, 320]),
            ("windows-ui", desktop_url, [1280, 960]),
        ]:
            for width in widths:
                for appearance in ("light", "dark"):
                    page = browser.new_page(viewport={"width": width, "height": 960}, color_scheme=appearance)
                    errors = []
                    posts = []
                    attempted_pages = []
                    jobs = [base_job.copy()]
                    page.on("pageerror", lambda error, errors=errors: errors.append(str(error)))

                    def api(route, request, *, jobs=jobs, posts=posts, attempted_pages=attempted_pages):
                        url = urlsplit(route.request.url)
                        path = url.path
                        if path == "/v1/auth/login":
                            respond_to_login(route)
                        elif path.endswith("/events"):
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
                            if page_two:
                                attempted_pages.append("a7")
                                if len(attempted_pages) == 1:
                                    route.fulfill(status=503, json={"detail": "分页暂时不可用"})
                                    return
                            items = [{**assets[0], "id": "a7", "filename": "厨房视角-07.jpg"}] if page_two else assets
                            route.fulfill(json={"items": items, "next_cursor": None if page_two else "page2"})
                        elif path == "/v1/projects/p1/jobs" and route.request.method == "POST":
                            posts.append((route.request.headers.get("idempotency-key"), route.request.post_data_json))
                            if len(posts) == 1:
                                route.fulfill(status=503, json={"detail": "创建暂时不可用"})
                                return
                            job = {**base_job, "id": "new-job", "profile": posts[-1][1]["profile"]}
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

                    page.route("**/v1/**", api)
                    page.route(
                        "https://preview.test/**",
                        lambda route: route.fulfill(body=image.read_bytes(), content_type="image/jpeg"),
                    )
                    sign_in(page, base)
                    page.screenshot(path=str(output / f"{client}-{width}-{appearance}-projects.png"), full_page=True)
                    page.get_by_role("button", name=project["name"], exact=True).click()
                    expect(page.get_by_role("heading", name=project["name"])).to_be_visible()
                    if width <= 1024:
                        drawer = page.locator("aside")
                        toggle = page.locator(".nav-toggle")
                        expect(drawer).to_have_attribute("inert", "")
                        expect(toggle).to_have_attribute("aria-expanded", "false")
                        toggle.focus()
                        page.keyboard.press("Tab")
                        assert not drawer.evaluate("element => element.contains(document.activeElement)")
                        toggle.click()
                        expect(toggle).to_have_attribute("aria-expanded", "true")
                        expect(drawer).not_to_have_attribute("inert", "")
                        assert drawer.evaluate("element => element.contains(document.activeElement)")
                        page.keyboard.press("Escape")
                        expect(toggle).to_be_focused()
                        expect(toggle).to_have_attribute("aria-expanded", "false")
                        expect(drawer).to_have_attribute("inert", "")
                    panes = page.get_by_role("navigation", name="项目工作区")
                    expect(page.locator(".upload-panel")).to_have_count(1)
                    expect(page.locator(".task-detail, .result-panel")).to_have_count(0)
                    panes.get_by_role("button", name="任务", exact=True).click()
                    page.get_by_role("button", name="均衡重建", exact=False).click()
                    expect(page.get_by_role("heading", name="任务详情", exact=True)).to_be_visible()
                    expect(page.locator(".upload-panel, .route-panel, .result-panel")).to_have_count(0)
                    page.get_by_role("button", name="← 返回任务", exact=True).click()
                    panes.get_by_role("button", name="结果", exact=True).click()
                    expect(page.get_by_text("本页暂无重建结果", exact=False)).to_be_visible()
                    expect(page.locator(".upload-panel, .route-panel, .task-detail")).to_have_count(0)
                    panes.get_by_role("button", name="素材", exact=True).click()
                    expect(page.locator(".upload-panel")).to_have_count(1)
                    expect(page.locator(".task-detail, .result-panel")).to_have_count(0)
                    if width >= 1280 and appearance == "light":
                        verify_media_selection(page, output, client)
                        results.append(
                            {"client": client, "check": "format, blur, duplicate preflight", "status": "PASS"}
                        )
                    start = page.get_by_role("button", name="开始重建", exact=True)
                    expect(start).to_have_count(0)
                    expect(page.get_by_role("checkbox", name="正在上传", exact=False)).to_be_disabled()
                    page.get_by_role("button", name="全选本页图片", exact=True).click()
                    action_bar = page.locator(".material-actions")
                    config = action_bar.get_by_role("button", name="配置重建", exact=True)
                    expect(config).to_be_enabled()
                    expect(action_bar).to_contain_text("已选 6 个")
                    first_asset = page.get_by_role("checkbox", name="厨房视角-01.jpg", exact=False)
                    first_asset.uncheck()
                    expect(action_bar).to_contain_text("已选 5 个")
                    config.click()
                    expect(page.get_by_role("heading", name="配置重建", exact=True)).to_be_focused()
                    expect(panes).to_have_count(0)
                    expect(page.locator(".upload-panel")).to_have_count(0)
                    expect(page.get_by_text("计算节点离线", exact=False)).to_be_visible()
                    quality = page.get_by_role("button", name="精细重建", exact=False)
                    quality.click()
                    expect(quality).to_have_attribute("aria-pressed", "true")
                    assert page.locator(".profiles button").evaluate_all("""items => items.every((button, index) => {
                      const box = button.getBoundingClientRect();
                      const previous = items[index-1]?.getBoundingClientRect();
                      return box.height >= 44 && (!previous || previous.bottom <= box.top);
                    })""")
                    page.screenshot(path=str(output / f"{client}-{width}-{appearance}-configure.png"))
                    page.get_by_role("button", name="返回素材", exact=True).click()
                    expect(action_bar).to_contain_text("已选 5 个")
                    assert not posts
                    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                    expect(page.locator("html")).to_have_attribute("data-theme", appearance)
                    if width <= 390:
                        page.evaluate("window.scrollTo(0, 0)")
                        expect(action_bar.get_by_role("button")).to_have_count(1)
                        assert action_bar.evaluate(
                            "element => Math.abs(element.getBoundingClientRect().bottom - innerHeight) <= 1"
                        )
                        page.screenshot(path=str(output / f"{client}-{width}-{appearance}-workspace.png"))
                        page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
                        last_asset = page.locator(".asset-row").last.bounding_box()
                        pager = page.get_by_role("navigation", name="素材分页").bounding_box()
                        bar = action_bar.bounding_box()
                        top = page.locator(".mobile-bar").bounding_box()
                        assert last_asset and pager and bar and top
                        assert last_asset["y"] >= top["y"] + top["height"]
                        assert pager["y"] + pager["height"] < bar["y"]
                        page.screenshot(path=str(output / f"{client}-{width}-{appearance}-workspace-end.png"))
                    else:
                        page.screenshot(
                            path=str(output / f"{client}-{width}-{appearance}-workspace.png"), full_page=True
                        )
                    if width >= 1280:
                        page.get_by_role("button", name="设置", exact=True).click()
                        page.get_by_role("button", name="外观", exact=True).click()
                        opposite = "dark" if appearance == "light" else "light"
                        page.get_by_label("外观主题", exact=True).select_option(opposite)
                        expect(page.locator("html")).to_have_attribute("data-theme", opposite)
                        page.get_by_role("button", name="← 返回设置", exact=True).click()
                        page.get_by_role("button", name="返回项目", exact=True).click()
                        expect(action_bar).to_contain_text("已选 5 个")
                    asset_pages = page.get_by_role("navigation", name="素材分页")
                    asset_pages.get_by_role("button", name="下一页").click()
                    expect(page.get_by_role("alert").filter(has_text="无法加载第 2 页")).to_be_visible()
                    expect(asset_pages.get_by_text("第 1 页", exact=True)).to_be_visible()
                    expect(first_asset).to_be_visible()
                    page.get_by_role("button", name="重试翻页", exact=True).click()
                    additional = page.get_by_role("checkbox", name="厨房视角-07.jpg", exact=False)
                    expect(additional).to_be_visible()
                    expect(asset_pages.get_by_text("第 2 页", exact=True)).to_be_visible()
                    additional.check()
                    asset_pages.get_by_role("button", name="上一页").click()
                    expect(page.get_by_role("checkbox", name="厨房视角-02.jpg", exact=False)).to_be_checked()
                    config.click()
                    expect(quality).to_have_attribute("aria-pressed", "true")
                    assert not posts
                    start.click()
                    expect(page.get_by_text("创建暂时不可用", exact=False)).to_be_visible()
                    assert len(posts) == 1
                    start.evaluate("el => { el.click(); el.click(); }")
                    expect(page.get_by_role("heading", name="任务详情", exact=True)).to_be_visible()
                    assert len(posts) == 2 and posts[0][0] and posts[0] == posts[1], posts
                    assert posts[0][1]["profile"] == "quality", posts
                    assert set(posts[0][1]["asset_ids"]) == {f"a{index}" for index in range(2, 8)}, posts
                    expect(page.locator(".job-state")).to_have_text("排队中")
                    page.screenshot(path=str(output / f"{client}-{width}-{appearance}-offline-queue.png"))
                    page.get_by_role("button", name="← 返回任务", exact=True).click()
                    expect(start).to_have_count(0)
                    expect(panes.get_by_role("button", name="任务", exact=True)).to_have_attribute(
                        "aria-pressed", "true"
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
    parser.add_argument("--web-url", default="http://localhost:4310")
    parser.add_argument("--desktop-url", default="http://localhost:4311")
    parser.add_argument("--output", type=Path, default=Path(".cache/ui-review-0.4.0"))
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--scene", type=Path, help="Optional local SPZ fixture for the Viewer recovery check")
    args = parser.parse_args()
    verify(args.web_url, args.desktop_url, args.output, args.image, args.scene)
