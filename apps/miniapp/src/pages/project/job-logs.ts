import type { JobLog } from "@rescene/schemas";

type Level = "" | "info" | "warning" | "error";
type FetchLogs = (jobId: string, options: { limit: number; afterId?: number; level?: Exclude<Level, ""> }) => Promise<JobLog[]>;

export interface JobLogReader {
  context(jobId: string, level: Level, visible: boolean): void;
  poll(): Promise<void>;
}

// Shared by the page and its isolated regression fixture.
export function createJobLogReader(fetchLogs: FetchLogs, onRows: (rows: JobLog[]) => void, onError: (reason: unknown) => void): JobLogReader {
  let jobId = "";
  let level: Level = "";
  let visible = false;
  let generation = 0;
  let rows: JobLog[] = [];
  const pending = new Set<string>();

  function context(nextJob: string, nextLevel: Level, nextVisible: boolean) {
    const changed = jobId !== nextJob || level !== nextLevel;
    if (changed || visible !== nextVisible) generation += 1;
    jobId = nextJob;
    level = nextLevel;
    visible = nextVisible;
    if (changed) {
      rows = [];
      onRows(rows);
    }
  }

  async function poll() {
    if (!visible || !jobId) return;
    const selectedJob = jobId;
    const selectedLevel = level;
    const selectedGeneration = generation;
    const key = JSON.stringify([selectedJob, selectedLevel]);
    if (pending.has(key)) return;
    pending.add(key);
    const last = rows[rows.length - 1];
    try {
      const batch = await fetchLogs(selectedJob, { limit: 200, ...(last ? { afterId: last.id } : {}), ...(selectedLevel ? { level: selectedLevel } : {}) });
      if (!visible || generation !== selectedGeneration || jobId !== selectedJob || level !== selectedLevel) return;
      const known = new Set(rows.map((row) => row.id));
      const added = batch.filter((row) => {
        if (known.has(row.id)) return false;
        known.add(row.id);
        return true;
      });
      if (added.length) {
        rows = [...rows, ...added].slice(-400);
        onRows(rows);
      }
    } catch (reason) {
      if (visible && generation === selectedGeneration && jobId === selectedJob && level === selectedLevel) onError(reason);
    } finally {
      pending.delete(key);
      if (visible && generation !== selectedGeneration && jobId === selectedJob && level === selectedLevel) void poll();
    }
  }

  return { context, poll };
}
