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
 * Shape of the facet stub returned by ctx.facets.get. Reflects what the
 * Cloudflare docs promise ("behaves like a Durable Object stub") without
 * tying to a specific types import.
 */
export interface FacetStub {
  fetch(request: Request): Promise<Response>;
}

/**
 * Shape of the Durable Object class returned by worker.getDurableObjectClass.
 * Not typed explicitly by @cloudflare/workers-types; we use `unknown` at the
 * boundary and cast because FacetStartupOptions.class accepts it.
 */
type DurableObjectClass = unknown;

/**
 * Shape of the Worker Loader binding (env.LOADER). Minimal interface
 * sufficient for what we use.
 */
export interface WorkerLoaderLike {
  get(
    id: string,
    callback: () => Promise<unknown>
  ): {
    getDurableObjectClass(className: string): DurableObjectClass;
  };
}

/**
 * Shape of this.ctx.facets on a Durable Object.
 */
export interface FacetsApi {
  get(
    name: string,
    callback: () =>
      | { class: DurableObjectClass }
      | Promise<{ class: DurableObjectClass }>
  ): FacetStub;
  abort(name: string, reason?: unknown): void;
  delete(name: string): void;
}

/**
 * Attach (or resume) the facet for a sync. The returned stub is ready
 * to receive .fetch() calls (e.g., from Phase 09's webhook route).
 *
 * The Worker Loader callback only runs if this codeId has not been
 * loaded yet; subsequent facets for the same sync+version reuse the
 * cached isolate. Bumping sync.version in update_sync forces a miss.
 */
export function attachFacet(
  env: { LOADER: WorkerLoaderLike },
  facets: FacetsApi,
  sync: Sync,
  userId: string
): FacetStub {
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
