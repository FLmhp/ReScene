"use client";

import type { ResceneClient } from "@rescene/api-client";
import { JOB_STATUS_LABELS, RECONSTRUCTION_PROFILES, type Project, type ProjectDetail } from "@rescene/schemas";
import { useEffect, useRef, useState } from "react";
import { AssetPreview } from "./AssetPreview";

export function ProjectCard({ client, project, onOpen }: { client: ResceneClient; project: Project; onOpen: () => void }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const host = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    const load = () => { void client.getProject(project.id).then((value) => { if (active) setDetail(value); }).catch(() => undefined); };
    if (typeof IntersectionObserver === "undefined" || !host.current) { load(); return () => { active = false; }; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { load(); observer.disconnect(); }
    });
    observer.observe(host.current);
    return () => { active = false; observer.disconnect(); };
  }, [client, project.id]);
  const cover = detail?.assets.find((item) => item.status === "READY" && /\.(jpg|png|jpeg)$/i.test(item.filename));
  const job = detail?.jobs[0];
  return <article className="project-card" ref={host}>
    <div className="project-cover">{cover ? <AssetPreview client={client} id={cover.id} filename={cover.filename} ready /> : <span>ReScene</span>}</div>
    <div className="project-card-body">
      <h2>{project.name}</h2>
      <p>{detail ? `${detail.assets.length} 个素材 · ${detail.jobs.length} 个任务` : "打开项目查看素材"}</p>
      {job ? <p className="project-last-job">{RECONSTRUCTION_PROFILES[job.profile].title} · {JOB_STATUS_LABELS[job.status]}</p> : null}
      <button type="button" onClick={onOpen}>打开项目 <span aria-hidden="true">↗</span></button>
    </div>
  </article>;
}
