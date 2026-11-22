"use client";

import type { ResceneClient } from "@rescene/api-client";
import {
  JOB_STATUS_LABELS, RECONSTRUCTION_PROFILES, type EffectiveRole, type Project, type ProjectSummary,
} from "@rescene/schemas";
import { useEffect, useRef, useState } from "react";
import { AssetPreview } from "./AssetPreview";

const ROLE_LABELS: Record<EffectiveRole, string> = {
  owner: "所有者", admin: "管理员", member: "成员", viewer: "只读成员",
};

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
  return <article className={`project-card${cover ? " has-cover" : ""}`} ref={host}>
    {cover ? <div className="project-cover"><AssetPreview client={client} id={cover.id} filename={cover.filename} ready /></div> : null}
    <div className="project-card-body">
      <h2><button type="button" onClick={onOpen}>{project.name}</button></h2>
      <p>{ROLE_LABELS[project.effective_role]} · {detail ? `${detail.asset_count} 个素材 · ${detail.job_count} 个任务` : "查看素材"}</p>
      {job ? <p className="project-last-job">{RECONSTRUCTION_PROFILES[job.profile].title} · {JOB_STATUS_LABELS[job.status]}</p> : null}
    </div>
  </article>;
}
