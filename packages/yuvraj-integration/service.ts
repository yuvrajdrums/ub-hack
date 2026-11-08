import { AsyncLocalStorage } from "node:async_hooks";
import {
  cvSessionRuntime as upstreamService,
  type CvStoreData as UpstreamState,
  type CvStore,
} from "./session-runtime";
import { DomainError as UpstreamError } from "../../references/yuvraj/camera-to-text-371198e/source/packages/platform/json-store";
import type { CvRepAnalysisResponse } from "./contracts";
import { domainStore } from "../platform/domain-store";
import { DomainError, dataFile } from "../platform/json-store";
import { connected, getCare } from "../platform/peers";
import { pandaCoachingFetcher } from "./coaching-provider";
import { requireRole } from "../platform/production/context";
import type { CareSnapshot } from "../contracts/care";
import type {
  CvSession,
  CvReport,
  CvCareReference,
  CvExerciseId,
} from "../contracts/rehab-cv";
import { CvStartSchema } from "../contracts/rehab-cv";
import { resolvePlanExercise } from "../rehab-bridge/plan-assignment";
import { geminiFlashFetch } from "./gemini-model.mjs";

type Metadata = {
  careReference?: CvCareReference;
  analysisMethod?: "gemini_landmark_analysis";
  analysisAcceptedAt?: string;
  analysisControlRevision?: number;
  analysisLastOffsetMs?: number;
  analysisIncomplete?: boolean;
};
export type CvStoreData = Omit<UpstreamState, "sessions"> & {
  sessions: (UpstreamState["sessions"][number] & Metadata)[];
};
export type { CvStore };
export type CalibrationRecord = {
  calibrationId: string;
  result: import("./contracts").CvCalibrationAssistResponse;
  exerciseId: string;
  side: "left" | "right";
  acceptedAt: string;
  careReference?: CvCareReference;
};
function enforceAssignedExercise(
  care: CareSnapshot,
  owner: string,
  exerciseId: CvExerciseId,
  side: "left" | "right",
) {
  if (care.patientId !== owner || care.plan?.status !== "approved")
    throw new DomainError(
      "FORBIDDEN",
      "A current approved patient context is required.",
      403,
    );
  const resolved = resolvePlanExercise(care.plan);
  if (!resolved.assignment)
    throw new DomainError("PLAN_EXERCISE_UNAVAILABLE", resolved.message, 409);
  if (
    resolved.assignment.exerciseId !== exerciseId ||
    resolved.assignment.side !== side
  )
    throw new DomainError(
      "PLAN_EXERCISE_MISMATCH",
      "This set must use the exercise and side in the current approved plan.",
      409,
    );
}
export function cvService(
  file = dataFile("rehab-cv"),
  options: {
    now?: () => Date;
    fetcher?: typeof fetch;
    store?: CvStore;
    care?: () => Promise<CareSnapshot | undefined>;
  } = {},
) {
  const backing =
    options.store ||
    domainStore<CvStoreData>("cv", file, () => ({
      sessions: [],
      receipts: {},
    }));
  const binding = new AsyncLocalStorage<CvCareReference | undefined>();
  const store: CvStore = {
    snapshot: () => backing.snapshot(),
    update: (fn) =>
      backing.update(async (raw) => {
        const state = raw as CvStoreData;
        for (const s of state.sessions) {
          s.analysis ??= null;
          s.analysisBatchSequence ??= 0;
        }
        const ids = new Set(state.sessions.map((s) => s.id));
        const result = await fn(state);
        for (const s of state.sessions)
          if (!ids.has(s.id)) {
            const ref = binding.getStore();
            if (ref) s.careReference = ref;
            if (s.evidence === "camera_estimated")
              s.measurementMethod = "local_pose_engine";
          }
        return result;
      }),
  };
  const sourceFetcher = options.fetcher || fetch;
  const providerFetcher: typeof fetch = (input, init) => {
    if (typeof input !== "string" || !input.startsWith("https://generativelanguage.googleapis.com/v1beta/models/"))
      return sourceFetcher(input, init);
    const apiKey = process.env.REHAB_GEMINI_API_KEY || "";
    if (!apiKey)
      throw new DomainError(
        "NOT_CONFIGURED",
        "Set REHAB_GEMINI_API_KEY on the Rehab server.",
        503,
      );
    const headers = new Headers(init?.headers);
    headers.set("x-goog-api-key", apiKey);
    return geminiFlashFetch(
      input,
      { ...init, headers },
      apiKey,
      sourceFetcher,
    );
  };
  const upstream = upstreamService(file, { ...options, fetcher: pandaCoachingFetcher(providerFetcher), store });
  async function safely<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof UpstreamError) {
        throw new DomainError(error.code, error.message, error.status);
      }
      throw error;
    }
  }
  async function stored(owner: string, id: string) {
    await safely(() => upstream.get(owner, id));
    return (await backing.snapshot()).sessions.find(
      (s) => s.id === id && s.owner === owner,
    ) as CvStoreData["sessions"][number];
  }
  function decorate(
    s: Awaited<ReturnType<typeof stored>>,
    value: CvSession,
  ): CvSession {
    return {
      ...value,
      ...(s.careReference ? { careReference: s.careReference } : {}),
      ...(s.analysisMethod ? { analysisMethod: s.analysisMethod } : {}),
      report: value.report ? decorateReport(s, value.report) : null,
    };
  }
  function decorateReport(
    s: Awaited<ReturnType<typeof stored>>,
    value: CvReport,
  ): CvReport {
    return {
      ...value,
      ...(s.careReference ? { careReference: s.careReference } : {}),
      ...(s.analysisMethod ? { analysisMethod: s.analysisMethod } : {}),
      ...(s.analysisMethod &&
      (s.analysisIncomplete || value.timingQuality === "partial")
        ? {
            trackingQuality: s.analysisBatchSequence
              ? ("partial" as const)
              : ("unavailable" as const),
          }
        : {}),
    };
  }
  return {
    async start(owner: string, raw: unknown) {
      requireRole("patient");
      const input = CvStartSchema.parse(raw);
      const care = options.care
        ? await options.care()
        : connected()
          ? await getCare()
          : undefined;
      if (care)
        enforceAssignedExercise(care, owner, input.exerciseId, input.side);
      const ref = care?.plan
        ? {
            patientId: care.patientId,
            planId: care.plan.id,
            planVersion: care.plan.version,
          }
        : undefined;
      const result = await binding.run(ref, () =>
        safely(() => upstream.start(owner, input)),
      );
      return decorate(await stored(owner, result.id), result);
    },
    async get(owner: string, id: string) {
      const s = await stored(owner, id);
      return decorate(s, await safely(() => upstream.get(owner, id)));
    },
    async reports(owner: string) {
      const results = await safely(() => upstream.reports(owner));
      const state = (await backing.snapshot()) as CvStoreData;
      return results.map((report) =>
        decorateReport(
          state.sessions.find(
            (s) => s.id === report.sessionId && s.owner === owner,
          )!,
          report,
        ),
      );
    },
    async feedback(owner: string, id: string, eventId: string) {
      const s = await stored(owner, id);
      const cue = s.feedback.find((f) => f.eventId === eventId);
      if (!cue) throw new DomainError("NOT_FOUND", "Feedback not found", 404);
      return structuredClone(cue);
    },
    async events(owner: string, id: string, raw: unknown) {
      requireRole("patient");
      const result = await safely(() => upstream.events(owner, id, raw));
      return {
        ...result,
        session: decorate(await stored(owner, id), result.session),
      };
    },
    changes: (owner: string, id: string, after = 0) =>
      safely(() => upstream.changes(owner, id, after)),
    async finish(owner: string, id: string, raw: unknown) {
      requireRole("patient");
      const report = await safely(() => upstream.finish(owner, id, raw));
      return decorateReport(await stored(owner, id), report);
    },
    async generate(owner: string, id: string, eventId: string, raw: unknown) {
      requireRole("patient");
      return safely(() => upstream.generate(owner, id, eventId, raw));
    },
    async calibrate(_owner: string, _raw: unknown): Promise<import("./contracts").CvCalibrationAssistResponse> {
      requireRole("patient");
      throw new DomainError(
        "MANUAL_CALIBRATION_REQUIRED",
        "Automatic calibration is disabled. Capture your resting position and comfortable target in the exercise view.",
        409,
      );
    },
    async calibration(owner: string, id: string) {
      const receipt = (await backing.snapshot()).receipts[
        `${owner}:calibration:${id}`
      ];
      if (!receipt)
        throw new DomainError(
          "NOT_FOUND",
          "Calibration is not available.",
          404,
        );
      return receipt.result as CalibrationRecord;
    },
    async analyze(owner: string, id: string, _raw: unknown): Promise<Omit<CvRepAnalysisResponse, "session"> & { session: CvSession }> {
      requireRole("patient");
      await stored(owner, id);
      throw new DomainError("LOCAL_MEASUREMENTS_ONLY", "Camera sets measure locally. Recover any older unfinished set before starting a new local set.", 409);
    },
    async analysis(owner: string, id: string) {
      const s = await stored(owner, id);
      if (!s.analysis)
        throw new DomainError(
          "NOT_FOUND",
          "No movement analysis is available yet.",
          404,
        );
      return {
        batchSequence: s.analysisBatchSequence,
        analysis: structuredClone(s.analysis),
        session: decorate(s, await safely(() => upstream.get(owner, id))),
        sessionControlRevision:
          s.analysisControlRevision ?? s.sessionControlRevision,
        acceptedAt: s.analysisAcceptedAt ?? s.serverReceivedAtUtc,
      };
    },
  };
}
