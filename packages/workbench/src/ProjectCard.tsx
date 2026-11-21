"use client";

import type { ResceneClient } from "@rescene/api-client";
import { JOB_STATUS_LABELS, RECONSTRUCTION_PROFILES, type Project, type ProjectSummary } from "@rescene/schemas";
import { useEffect, useRef, useState } from "react";
import { AssetPreview } from "./AssetPreview";

export function ProjectCard({ client, project, summary, onOpen }: {
  client: ResceneClient; project: Project; summary?: ProjectSummary; onOpen: () => void;
}) {
  const [fetched, setFetched] = useState<ProjectSummary | null>(null);
  const host = useRef<HTMLElement>(null);
  const needsSummary = summary === undefined;
  useEffect(() => {
    if (!needsSummary) return;
    let active = true;
    const load = () => { void client.getProjectSummary(project.id).then((value) => { if (active) setFetched(value); }).catch(() => undefined); };
    if (typeof IntersectionObserver === "undefined" || !host.current) { load(); return () => { active = false; }; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { load(); observer.disconnect(); }
    });
    observer.observe(host.current);
    return () => { active = false; observer.disconnect(); };
  }, [client, needsSummary, project.id]);
  const detail = summary ?? fetched;
  const cover = detail?.cover;
  const job = detail?.latest_job;
  return <article className="project-card" ref={host}>
    <div className="project-cover">{cover ? <AssetPreview client={client} id={cover.id} filename={cover.filename} ready /> : <span>ReScene</span>}</div>
    <div className="project-card-body">
      <h2>{project.name}</h2>
      <p>{project.effective_role} · {detail ? `${detail.asset_count} 个素材 · ${detail.job_count} 个任务` : "打开项目查看素材"}</p>
      {job ? <p className="project-last-job">{RECONSTRUCTION_PROFILES[job.profile].title} · {JOB_STATUS_LABELS[job.status]}</p> : null}
      <button type="button" onClick={onOpen}>打开项目 <span aria-hidden="true">↗</span></button>
    </div>
  </article>;
}
