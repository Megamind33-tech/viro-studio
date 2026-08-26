/**
 * Project persistence seam (ADR 0004).
 *
 * One canonical path for reading/writing projects (GOVERNOR.md §74). Today the
 * only implementation is local (IndexedDB); when `platform.cloud` is enabled and
 * Supabase is provisioned, a `SupabaseProjectProvider` implements the same
 * interface and the app code above it does not change.
 */
import { flag } from "./flags";
import {
  deleteProject as dbDeleteProject,
  getProject as dbGetProject,
  listProjectSummaries as dbListProjectSummaries,
  putProject as dbPutProject,
  type ProjectRecord,
  type ProjectSummary,
} from "../library/store";

export type { ProjectRecord, ProjectSummary } from "../library/store";

export interface ProjectProvider {
  /** Where projects currently live, for honest UI copy. */
  readonly kind: "local" | "cloud";
  list(): Promise<ProjectSummary[]>;
  get(id: string): Promise<ProjectRecord | undefined>;
  save(record: ProjectRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

class LocalProjectProvider implements ProjectProvider {
  readonly kind = "local" as const;
  list(): Promise<ProjectSummary[]> {
    return dbListProjectSummaries();
  }
  get(id: string): Promise<ProjectRecord | undefined> {
    return dbGetProject(id);
  }
  save(record: ProjectRecord): Promise<void> {
    return dbPutProject(record);
  }
  remove(id: string): Promise<void> {
    return dbDeleteProject(id);
  }
}

let provider: ProjectProvider | null = null;

/**
 * The active project provider. Cloud sync is gated on `platform.cloud` AND a
 * configured backend; until ADR 0004's provisioning lands, this is always local
 * — and we never pretend otherwise in the UI.
 */
export function projects(): ProjectProvider {
  if (!provider) provider = new LocalProjectProvider();
  // `platform.cloud` is reserved for the Supabase provider; it is intentionally
  // not yet wired, so we stay local rather than fake a cloud path.
  void flag;
  return provider;
}

/** Test hook. */
export function resetProjectsProvider(): void {
  provider = null;
}
