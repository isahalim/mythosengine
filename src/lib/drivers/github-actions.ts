import { fetchWithRetry } from "./http.ts";
import type { DriverError } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * GitHub Actions `workflow_dispatch` — the one thing that turns the
 * console's "Deploy agents" button into a pipeline run.
 *
 * ARCHITECTURE.md §0: everything compute-heavy runs in GitHub Actions,
 * because a Cloudflare Worker cannot run FFmpeg or spawn `edge_tts`. The
 * Worker's whole role in starting a run is this one POST.
 *
 * WHAT THIS DELIBERATELY IS NOT: a general GitHub client. It can trigger a
 * workflow and nothing else — no repo reads, no issue writes, no artifact
 * downloads. The token it holds is scoped to Actions on one repository, and
 * a driver with one method is the shape that keeps a widened token from
 * quietly becoming a widened blast radius later.
 *
 * Same contract as every other driver in this directory: `Result<T,
 * DriverError>`, `fetchWithRetry` with a hard `AbortSignal` timeout, and no
 * throw across the boundary.
 */

const API_BASE = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * `owner/repo`, validated before it reaches a URL.
 *
 * This comes from `GITHUB_REPOSITORY` in `wrangler.toml`'s `[vars]`, which
 * is operator-set config rather than user input — but it is interpolated
 * into a path, so it is checked rather than trusted. A malformed value
 * fails loudly here instead of producing a 404 from a URL nobody meant to
 * build.
 */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** A workflow is addressed by its file name (`render.yml`) or its numeric id. */
const WORKFLOW_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface WorkflowDispatchOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface WorkflowDispatchRequest {
  /** Workflow file name, e.g. `render.yml`. */
  workflow: string;
  /** The git ref the workflow runs from — the branch whose `render.yml` and pipeline code the run uses. */
  ref: string;
  /**
   * `workflow_dispatch` inputs. GitHub types every input as a string on the
   * wire regardless of the `type:` declared in the YAML, so the caller hands
   * strings and the workflow parses them.
   */
  inputs: Record<string, string>;
}

export class GithubActionsDriver {
  constructor(
    private readonly token: string,
    private readonly repository: string,
    private readonly options: WorkflowDispatchOptions = {},
  ) {}

  /**
   * Triggers one workflow run.
   *
   * GitHub answers `204 No Content` on success and returns no run id — the
   * REST API genuinely does not tell you which run it just created. That is
   * why the pipeline is handed its `trace_id` as an input rather than being
   * asked for one afterwards: the console decides the identifier, passes it
   * down, and both ends agree on it without a lookup that could race.
   */
  async dispatchWorkflow(request: WorkflowDispatchRequest, options: WorkflowDispatchOptions = {}): Promise<Result<void, DriverError>> {
    if (!REPO_PATTERN.test(this.repository)) {
      return err({
        kind: "policy_violation",
        message: `GITHUB_REPOSITORY must be "owner/repo"; got ${JSON.stringify(this.repository)}`,
        retryable: false,
      });
    }
    if (!WORKFLOW_PATTERN.test(request.workflow)) {
      return err({
        kind: "policy_violation",
        message: `workflow must be a file name like "render.yml"; got ${JSON.stringify(request.workflow)}`,
        retryable: false,
      });
    }

    const url = `${API_BASE}/repos/${this.repository}/actions/workflows/${request.workflow}/dispatches`;

    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
          // GitHub rejects an API request with no User-Agent outright.
          "user-agent": "mythosengine-worker",
        },
        body: JSON.stringify({ ref: request.ref, inputs: request.inputs }),
      },
      {
        timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        // One attempt. A retried dispatch that succeeded the first time
        // starts a SECOND run against the same trace, and both would claim
        // run picks — the same reason src/app/api.ts never retries a POST.
        maxAttempts: 1,
        baseDelayMs: 0,
        fetchImpl: options.fetchImpl ?? this.options.fetchImpl,
      },
    );
    if (!response.ok) return response;

    // 204 is the documented success. Anything else 2xx is not something
    // this endpoint does, and treating it as success would report a run
    // that may not exist.
    if (response.value.status !== 204) {
      return err({
        kind: "invalid_response",
        message: `workflow_dispatch answered HTTP ${response.value.status}, expected 204`,
        retryable: false,
      });
    }

    return ok(undefined);
  }
}

/**
 * Builds the driver, or returns null when no dispatch credential is
 * configured.
 *
 * Null is a real, expected state, not an error: until `GITHUB_DISPATCH_TOKEN`
 * exists the console records runs it cannot start and says so
 * (src/server/console/dispatch.ts). Reporting that honestly is the whole
 * point — a dispatch that silently no-ops leaves the operator watching a
 * waiting screen for a run that is never coming.
 *
 * The token is read straight from the Worker env rather than from the
 * vault: it is infrastructure credentials for this deployment, in the same
 * class as `SESSION_SIGNING_KEY`, not a rotatable provider key the operator
 * manages through the console.
 */
export function createGithubActionsDriver(token: string | undefined, repository: string | undefined): GithubActionsDriver | null {
  if (token === undefined || token.length === 0) return null;
  if (repository === undefined || repository.length === 0) return null;
  return new GithubActionsDriver(token, repository);
}
