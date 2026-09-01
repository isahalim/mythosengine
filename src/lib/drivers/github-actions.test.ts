import { describe, expect, it } from "vitest";
import { createGithubActionsDriver, GithubActionsDriver } from "./github-actions.ts";

interface SeenRequest {
  url: string;
  init: RequestInit | undefined;
}

function recordingFetch(response: Response, seen: SeenRequest[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return response.clone();
  }) as unknown as typeof fetch;
}

const REQUEST = { workflow: "render.yml", ref: "main", inputs: { trace_id: "trace-1", count: "3" } };

describe("GithubActionsDriver", () => {
  it("posts to the workflow's dispatches endpoint with the ref and inputs", async () => {
    const seen: SeenRequest[] = [];
    const driver = new GithubActionsDriver("tok", "isahalim/mythosengine", {
      fetchImpl: recordingFetch(new Response(null, { status: 204 }), seen),
    });

    const result = await driver.dispatchWorkflow(REQUEST);

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.github.com/repos/isahalim/mythosengine/actions/workflows/render.yml/dispatches");
    expect(seen[0].init?.method).toBe("POST");
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({ ref: "main", inputs: { trace_id: "trace-1", count: "3" } });
  });

  it("sends the token as a bearer credential with the pinned API version", async () => {
    const seen: SeenRequest[] = [];
    const driver = new GithubActionsDriver("tok-abc", "o/r", { fetchImpl: recordingFetch(new Response(null, { status: 204 }), seen) });

    await driver.dispatchWorkflow(REQUEST);

    const headers = seen[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-abc");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
    // GitHub rejects an API request with no User-Agent.
    expect(headers["user-agent"]).toBe("mythosengine-worker");
  });

  it("never dispatches twice: a failing call is not retried, because a retry would start a second run", async () => {
    const seen: SeenRequest[] = [];
    const driver = new GithubActionsDriver("tok", "o/r", {
      fetchImpl: recordingFetch(new Response("boom", { status: 500 }), seen),
    });

    const result = await driver.dispatchWorkflow(REQUEST);

    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("treats a 2xx that is not 204 as an invalid response rather than as a started run", async () => {
    const seen: SeenRequest[] = [];
    const driver = new GithubActionsDriver("tok", "o/r", {
      fetchImpl: recordingFetch(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }), seen),
    });

    const result = await driver.dispatchWorkflow(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_response");
    expect(result.error.message).toContain("expected 204");
  });

  it("refuses a malformed repository before it reaches a URL", async () => {
    const seen: SeenRequest[] = [];
    const driver = new GithubActionsDriver("tok", "../../etc", { fetchImpl: recordingFetch(new Response(null, { status: 204 }), seen) });

    const result = await driver.dispatchWorkflow(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("policy_violation");
    expect(seen).toHaveLength(0);
  });

  it("refuses a workflow name that is a path rather than a file name", async () => {
    const seen: SeenRequest[] = [];
    const driver = new GithubActionsDriver("tok", "o/r", { fetchImpl: recordingFetch(new Response(null, { status: 204 }), seen) });

    const result = await driver.dispatchWorkflow({ ...REQUEST, workflow: "../../secrets" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("policy_violation");
    expect(seen).toHaveLength(0);
  });

  it("builds no driver when either half of the credential is missing", () => {
    expect(createGithubActionsDriver(undefined, "o/r")).toBeNull();
    expect(createGithubActionsDriver("", "o/r")).toBeNull();
    expect(createGithubActionsDriver("tok", undefined)).toBeNull();
    expect(createGithubActionsDriver("tok", "")).toBeNull();
    expect(createGithubActionsDriver("tok", "o/r")).toBeInstanceOf(GithubActionsDriver);
  });
});
