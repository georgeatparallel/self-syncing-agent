import { buildFacetWorkerCode } from "./bundle";
import type { Sync } from "../db/types";

/**
 * codeId convention: `sync:<syncId>:v<version>` — bumps on every update
 * to force Worker Loader cache miss. See design doc §16.
 */
export function syncCodeId(sync: Pick<Sync, "id" | "version">): string {
  return `sync:${sync.id}:v${sync.version}`;
}

/**
 * Attach (or resume) the facet for a sync. The returned `Fetcher` is ready
 * to receive .fetch() calls (e.g., from Phase 09's webhook route).
 *
 * The Worker Loader callback only runs if this codeId has not been loaded
 * yet; subsequent attachments for the same sync+version reuse the cached
 * isolate. Bumping sync.version in update_sync forces a miss.
 *
 * Types: WorkerLoader / DurableObjectFacets / Fetcher all come from
 * @cloudflare/workers-types. The env.d.ts wires env.LOADER as WorkerLoader
 * after Phase 06's worker_loaders binding, and DurableObjectState.facets is
 * typed as DurableObjectFacets.
 */
export function attachFacet(
  env: { LOADER: WorkerLoader },
  facets: DurableObjectFacets,
  sync: Sync,
  userId: string
): Fetcher {
  const codeId = syncCodeId(sync);
  return facets.get(sync.name, async () => {
    const worker = env.LOADER.get(codeId, async () =>
      buildFacetWorkerCode({
        schemaDdl: sync.schema_ddl,
        handlerCode: sync.handler_code,
        userId
      })
    );
    return { class: worker.getDurableObjectClass("App") };
  });
}
