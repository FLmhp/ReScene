"""Check built Web/Desktop UI with isolated API fixtures and save screenshots."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


def verify(web_url: str, desktop_url: str, output: Path, image: Path) -> None:
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
        browser = playwright.chromium.launch(channel="msedge")
        for client, base, widths in [("web", web_url, [1440, 1024, 768, 390]), ("windows-ui", desktop_url, [1280])]:
            for width in widths:
                for appearance in ("light", "dark"):
                    page = browser.new_page(viewport={"width": width, "height": 960}, color_scheme=appearance)
                    errors = []
                    posts = []
                    jobs = [base_job.copy()]
                    page.on("pageerror", lambda error, errors=errors: errors.append(str(error)))

                    def api(route, request, *, jobs=jobs, posts=posts):
                        path = urlsplit(route.request.url).path
                        if path.endswith("/events"):
                            route.fulfill(body="", content_type="text/event-stream")
                        elif path.endswith("/logs"):
                            route.fulfill(json={"items": []})
                        elif path.endswith("/preview"):
                            route.fulfill(
                                json={"url": "https://preview.test/fixture.jpg", "expires_at": "2099-01-01T00:00:00Z"}
                            )
                        elif path == "/v1/projects/p1":
                            route.fulfill(json={**project, "assets": assets, "jobs": jobs})
                        elif path == "/v1/projects/p1/jobs" and route.request.method == "POST":
                            posts.append(route.request.post_data_json)
                            job = {**base_job, "id": "new-job", "profile": posts[-1]["profile"]}
                            jobs.insert(0, job)
                            route.fulfill(status=201, json=job)
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
                    start = page.get_by_role("button", name="开始三维重建")
                    expect(start).to_be_disabled()
                    expect(page.get_by_role("checkbox", name="正在上传", exact=False)).to_be_disabled()
                    page.get_by_role("button", name="全选图片", exact=True).click()
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
                        page.get_by_role("button", name="全选图片", exact=True).click()
                        page.get_by_role("button", name="精细重建", exact=False).click()
                    start.click()
                    expect(page.get_by_role("status").filter(has_text="任务已进入队列")).to_be_visible()
                    assert (
                        len(posts) == 1 and posts[0]["profile"] == "quality" and "pending" not in posts[0]["asset_ids"]
                    )
                    assert not errors, errors
                    results.append({"client": client, "width": width, "theme": appearance, "status": "PASS"})
                    print(client, width, appearance, "PASS", flush=True)
                    page.close()
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
    args = parser.parse_args()
    verify(args.web_url, args.desktop_url, args.output, args.image)
