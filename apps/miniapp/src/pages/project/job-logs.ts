import type { JobLog } from "@rescene/schemas";

type Level = "" | "debug" | "info" | "warning" | "error";
type FetchLogs = (jobId: string, options: { limit: number; afterId?: number; beforeId?: number; level?: Exclude<Level, ""> }) => Promise<JobLog[]>;

export interface JobLogReader {
  context(jobId: string, level: Level, visible: boolean): void;
  poll(): Promise<void>;
  earlier(): Promise<void>;
  canLoadEarlier(): boolean;
}

// Shared by the page and its isolated regression fixture.
export function createJobLogReader(
  fetchLogs: FetchLogs,
  onRows: (rows: JobLog[]) => void,
  onError: (reason: unknown, older: boolean) => void,
): JobLogReader {
  let jobId = "";
  let level: Level = "";
  let visible = false;
  let generation = 0;
  let rows: JobLog[] = [];
  let earlierAvailable = false;
  const pageSize = 200;
  const pending = new Set<string>();

  function context(nextJob: string, nextLevel: Level, nextVisible: boolean) {
    const changed = jobId !== nextJob || level !== nextLevel;
    if (changed || visible !== nextVisible) generation += 1;
    jobId = nextJob;
    level = nextLevel;
    visible = nextVisible;
    if (changed) {
      rows = [];
      earlierAvailable = false;
      onRows(rows);
    }
  }

  async function read(older: boolean) {
    if (!visible || !jobId) return;
    const first = rows[0];
    if (older && (!earlierAvailable || !first)) return;
    const selectedJob = jobId;
    const selectedLevel = level;
    const selectedGeneration = generation;
    const key = JSON.stringify([selectedJob, selectedLevel, older]);
    if (pending.has(key)) return;
    pending.add(key);
    const last = rows[rows.length - 1];
    try {
      const batch = await fetchLogs(selectedJob, {
        limit: pageSize,
        ...(older && first ? { beforeId: first.id } : last ? { afterId: last.id } : {}),
        ...(selectedLevel ? { level: selectedLevel } : {}),
      });
      if (!visible || generation !== selectedGeneration || jobId !== selectedJob || level !== selectedLevel) return;
      if (older || !last) earlierAvailable = batch.length === pageSize;
      if (!batch.length) return;
      const known = new Set(rows.map((row) => row.id));
      const added = batch.filter((row) => {
        if (known.has(row.id)) return false;
        known.add(row.id);
        return true;
      });
      if (added.length) {
        rows = older ? [...added, ...rows] : [...rows, ...added];
        onRows(rows);
      }
    } catch (reason) {
      if (visible && generation === selectedGeneration && jobId === selectedJob && level === selectedLevel) onError(reason, older);
    } finally {
      pending.delete(key);
      if (!older && visible && generation !== selectedGeneration && jobId === selectedJob && level === selectedLevel) void read(false);
    }
  }

  return { context, poll: () => read(false), earlier: () => read(true), canLoadEarlier: () => earlierAvailable };
}
