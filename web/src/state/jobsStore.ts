/**
 * state/jobsStore — SERVER-side background AI jobs (image → SVG board).
 *
 * Each upload becomes a job on the server (POST /api/ai/jobs/image-to-svg):
 * a worker pool converts several users' uploads in PARALLEL and the finished
 * job carries the created board's id — so a page reload never loses a running
 * conversion, and history persists per user. This store is just the client
 * view: submit, poll while anything runs, and merge in the server history on
 * boot (JobsTray calls loadHistory once).
 *
 * Progress is time-based easing toward 90% (the API doesn't stream) computed
 * from the job's server `created_at`, snapping to 100% on completion.
 * Preview thumbnails are object URLs and exist only for THIS session's
 * uploads; history rows fall back to the created board's export.svg.
 */
import { create } from "zustand";
import { ApiError, api, type AiJobOut } from "../shared/api/client";
import { aiErrorMessage, withAiHints } from "../shared/aiError";
import { useEditorStore } from "./editorStore";

/** Submit with retries: a 502/503/504 (deploy-restart window at the edge) or
 * a network blip shouldn't cost the user their upload — the POST itself is
 * cheap, the conversion runs server-side once it lands. */
async function submitWithRetry(
  file: File,
  prompt: string,
): Promise<AiJobOut> {
  const delays = [2000, 5000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.createImageJob(file, prompt);
    } catch (err) {
      // Edge/restart errors carry no app detail — just the bare status text.
      // A REAL app 503 ("No API key configured…") must NOT retry.
      const msg = (err instanceof Error ? err.message : "").trim();
      const edgeText = /^(service unavailable|bad gateway|gateway time-?out|application failed to respond)?$/i;
      const transient =
        (err instanceof ApiError && [502, 503, 504].includes(err.status) && edgeText.test(msg)) ||
        err instanceof TypeError; // fetch network failure
      if (!transient || attempt >= delays.length) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

export type JobStatus = "queued" | "processing" | "done" | "error";

export interface Job {
  id: string;
  name: string;
  prompt: string;
  /** Object URL of the uploaded image — "" for jobs restored from history. */
  previewUrl: string;
  status: JobStatus;
  progress: number; // 0..1
  createdAt: number; // server epoch seconds
  docId?: string;
  error?: string;
}

interface JobsState {
  jobs: Job[];
  /** Queue an image→board job on the server (fire-and-forget). */
  enqueueImageJob: (file: File, prompt: string) => void;
  /** Merge the server-side job history in (called once by JobsTray). */
  loadHistory: () => Promise<void>;
  dismiss: (id: string) => void;
  clearFinished: () => void;
}

let seq = 0;
let poller: ReturnType<typeof setInterval> | null = null;
const POLL_MS = 2500;

function fromServer(j: AiJobOut, prev?: Job): Job {
  const running = j.status === "queued" || j.status === "processing";
  return {
    id: j.id,
    name: j.name,
    prompt: j.prompt,
    previewUrl: prev?.previewUrl ?? "",
    status: j.status,
    // ease toward 90% on wall-clock since the server accepted the job
    progress: running
      ? Math.min(0.9, 0.05 + (Date.now() / 1000 - j.created_at) / 60)
      : 1,
    createdAt: j.created_at,
    docId: j.doc_id || undefined,
    error: j.status === "error" ? withAiHints(j.error) : undefined,
  };
}

function mergeServerJobs(server: AiJobOut[]) {
  useJobsStore.setState((s) => {
    const byId = new Map(s.jobs.map((j) => [j.id, j]));
    const merged = server.map((j) => fromServer(j, byId.get(j.id)));
    // keep local-only rows (uploads still in flight / local failures) on top
    const serverIds = new Set(server.map((j) => j.id));
    const localOnly = s.jobs.filter((j) => !serverIds.has(j.id));
    return { jobs: [...localOnly, ...merged] };
  });
  ensurePolling();
}

function ensurePolling() {
  const anyRunning = useJobsStore
    .getState()
    .jobs.some((j) => j.status === "queued" || j.status === "processing");
  if (anyRunning && poller === null) {
    poller = setInterval(() => void poll(), POLL_MS);
  } else if (!anyRunning && poller !== null) {
    clearInterval(poller);
    poller = null;
  }
}

async function poll() {
  try {
    const before = useJobsStore.getState().jobs;
    const server = await api.listAiJobs();
    mergeServerJobs(server);
    // a job just finished → the new board should appear on the dashboard
    const after = useJobsStore.getState().jobs;
    const doneNow = after.some(
      (j) =>
        j.status === "done" &&
        before.find((b) => b.id === j.id && b.status !== "done"),
    );
    if (doneNow) void useEditorStore.getState().refreshDocs();
  } catch {
    // transient poll failure — keep the interval, next tick may succeed
  }
}

export const useJobsStore = create<JobsState>((set) => ({
  jobs: [],

  enqueueImageJob(file, prompt) {
    // optimistic row while the upload POST is in flight
    const localId = `local${++seq}-${Date.now().toString(36)}`;
    const previewUrl = URL.createObjectURL(file);
    set((s) => ({
      jobs: [
        {
          id: localId,
          name: file.name,
          prompt: prompt.trim(),
          previewUrl,
          status: "queued",
          progress: 0.02,
          createdAt: Date.now() / 1000,
        },
        ...s.jobs,
      ],
    }));
    submitWithRetry(file, prompt)
      .then((job) => {
        // swap the optimistic row for the server job, keeping the thumbnail
        set((s) => ({
          jobs: s.jobs.map((j) =>
            j.id === localId ? { ...fromServer(job), previewUrl } : j,
          ),
        }));
        ensurePolling();
      })
      .catch((err) => {
        set((s) => ({
          jobs: s.jobs.map((j) =>
            j.id === localId
              ? { ...j, status: "error" as const, progress: 1, error: aiErrorMessage(err) }
              : j,
          ),
        }));
      });
  },

  async loadHistory() {
    try {
      mergeServerJobs(await api.listAiJobs());
    } catch {
      // guests / transient failure — the tray just stays empty
    }
  },

  dismiss(id) {
    const job = useJobsStore.getState().jobs.find((j) => j.id === id);
    if (job?.previewUrl) URL.revokeObjectURL(job.previewUrl);
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
    if (job && !id.startsWith("local")) void api.deleteAiJob(id).catch(() => {});
    ensurePolling();
  },

  clearFinished() {
    const finished = useJobsStore
      .getState()
      .jobs.filter((j) => j.status === "done" || j.status === "error");
    for (const j of finished) {
      if (j.previewUrl) URL.revokeObjectURL(j.previewUrl);
      if (!j.id.startsWith("local")) void api.deleteAiJob(j.id).catch(() => {});
    }
    set((s) => ({
      jobs: s.jobs.filter((j) => j.status === "queued" || j.status === "processing"),
    }));
    ensurePolling();
  },
}));
