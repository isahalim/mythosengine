import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Download, type Page } from "playwright";
import { z } from "zod";
import type { DriverError, LlmDriver, LlmMessage, ToolDefinition } from "./types.ts";
import { err, ok, type Result } from "../result.ts";

const MODEL = "openai/gpt-oss-120b";
const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;

// Context budget. Every one of these numbers exists because this agent's
// prompt grows monotonically — each iteration appends a page snapshot or a
// link list and nothing is ever dropped — and groq.ts prices a request at
// `maxTokens + promptChars/4` against a 6000-tokens/minute bucket. Crossing
// ~20k characters therefore costs a full bucket per call (and, before
// rate-limiter.ts was fixed, hung forever). 80 links x 200 characters was
// on its own enough to blow past that on a YouTube results page.
const MAX_LINKS = 40;
const MAX_LINK_TEXT_CHARS = 100;
const MAX_SNAPSHOT_CHARS = 3_000;
/** Total characters of message content allowed before older tool results are elided (below). */
const MAX_HISTORY_CHARS = 14_000;
const ELIDED_TOOL_RESULT = '{"elided":"older tool result dropped to stay within the context budget; re-run the tool if you still need it"}';

// The only ARIA roles this agent is allowed to click/fill by name — a small,
// deliberate allowlist (not the full ARIA role set Playwright supports) so a
// confused model can't, say, target a "region" or "generic" node and hit
// whatever happens to be first in DOM order.
const CLICKABLE_ROLES = ["button", "link", "textbox", "combobox", "checkbox", "tab", "menuitem", "searchbox"] as const;
type ClickableRole = (typeof CLICKABLE_ROLES)[number];

/**
 * One page, scoped to a fixed allowlist of origins. `page.getByRole()` and
 * `page.locator("body").ariaSnapshot()` (default, non-"ai" mode) both only
 * ever see the main frame's own DOM — Playwright doesn't descend into
 * `<iframe>` content unless you explicitly ask for a `frameLocator()`, which
 * nothing here does. That's the "never a 3rd-party iframe" guarantee: it
 * falls out of which Playwright APIs this class chooses to call, not a
 * separate filter bolted on top.
 */
class PageAgentSession {
  // browser_click (which triggers a download) and browser_wait_for_download
  // are two separate, sequential tool calls, not one atomic action — if the
  // download fires between them, a bare `page.waitForEvent("download")`
  // called only once wait_for_download runs would miss it entirely (it only
  // sees events that fire *after* it's called). Listening from construction
  // and buffering means no download can ever be missed regardless of how
  // many tool-call round-trips happen in between.
  private readonly pendingDownloads: Download[] = [];
  private downloadWaiters: ((download: Download) => void)[] = [];

  constructor(
    private readonly page: Page,
    private readonly allowedOrigins: readonly string[],
    private readonly timeoutMs: number,
  ) {
    page.on("download", (download) => {
      const waiter = this.downloadWaiters.shift();
      if (waiter) waiter(download);
      else this.pendingDownloads.push(download);
    });
  }

  private nextDownload(): Promise<Download> {
    const already = this.pendingDownloads.shift();
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.downloadWaiters = this.downloadWaiters.filter((w) => w !== waiter);
        reject(new Error(`Timeout ${this.timeoutMs}ms exceeded waiting for a download.`));
      }, this.timeoutMs);
      const waiter = (download: Download) => {
        clearTimeout(timer);
        resolve(download);
      };
      this.downloadWaiters.push(waiter);
    });
  }

  async navigate(url: string): Promise<unknown> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return { error: "invalid_url", url };
    }
    if (!this.allowedOrigins.includes(origin)) {
      return { error: "origin_not_allowed", origin, allowedOrigins: this.allowedOrigins };
    }
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
      return { ok: true, url: this.page.url() };
    } catch (cause) {
      return { error: describeError(cause) };
    }
  }

  async snapshot(): Promise<unknown> {
    try {
      const yaml = await this.page.locator("body").ariaSnapshot({ timeout: this.timeoutMs });
      const truncated = yaml.length > MAX_SNAPSHOT_CHARS ? `${yaml.slice(0, MAX_SNAPSHOT_CHARS)}\n... (truncated)` : yaml;
      return { url: this.page.url(), snapshot: truncated };
    } catch (cause) {
      return { error: describeError(cause) };
    }
  }

  async click(role: ClickableRole, name: string): Promise<unknown> {
    try {
      await this.page.getByRole(role, { name, exact: false }).first().click({ timeout: this.timeoutMs });
      return { ok: true };
    } catch (cause) {
      return { error: describeError(cause) };
    }
  }

  async fill(role: ClickableRole, name: string, value: string): Promise<unknown> {
    try {
      await this.page.getByRole(role, { name, exact: false }).first().fill(value, { timeout: this.timeoutMs });
      return { ok: true };
    } catch (cause) {
      return { error: describeError(cause) };
    }
  }

  async waitForDownload(destDir: string): Promise<unknown> {
    try {
      const download = await this.nextDownload();
      const filePath = join(destDir, download.suggestedFilename() || "download.mp4");
      await download.saveAs(filePath);
      return { ok: true, filePath };
    } catch (cause) {
      return { error: describeError(cause) };
    }
  }

  /**
   * ariaSnapshot() reports roles/names but not href attributes, and a result
   * link's accessible name is a video title, not its URL — the model has no
   * other way to learn which real URL a result points at. Reads anchors from
   * the main-frame DOM only (page.locator, not a frameLocator), same
   * no-iframe guarantee as everything else here.
   */
  async listLinks(): Promise<unknown> {
    try {
      const links = await this.page.locator("a").evaluateAll((elements) =>
        elements
          .map((el) => ({ text: (el.textContent ?? "").trim().slice(0, MAX_LINK_TEXT_CHARS), href: el.getAttribute("href") ?? "" }))
          .filter((l) => l.href.length > 0 && l.text.length > 0),
      );
      return { url: this.page.url(), links: links.slice(0, MAX_LINKS) };
    } catch (cause) {
      return { error: describeError(cause) };
    }
  }
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface ActionTool {
  definition: ToolDefinition;
  run(rawArgs: unknown): Promise<unknown>;
}

/** Same shape as src/server/agent/tools.ts's tool() builder: Zod-validate the model's raw args before an action ever touches the page, and never throw across the tool-call boundary — a bad call becomes an {error} result the model can read and correct, not a crashed run. */
function actionTool<TSchema extends z.ZodType>(
  definition: ToolDefinition,
  schema: TSchema,
  run: (args: z.infer<TSchema>) => Promise<unknown>,
): ActionTool {
  return {
    definition,
    async run(rawArgs) {
      const parsed = schema.safeParse(rawArgs ?? {});
      if (!parsed.success) return { error: "invalid_arguments", issues: parsed.error.issues };
      return run(parsed.data);
    },
  };
}

const RoleSchema = z.enum(CLICKABLE_ROLES);

function buildActionTools(session: PageAgentSession, downloadsDir: string): ActionTool[] {
  return [
    actionTool(
      {
        name: "browser_navigate",
        description: "Navigate the page to a URL. Refused if the URL's origin isn't on the allowed list for this task.",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      },
      z.object({ url: z.string() }),
      (args) => session.navigate(args.url),
    ),
    actionTool(
      {
        name: "browser_snapshot",
        description: "Read the current page: its URL and an accessibility-tree snapshot (roles + accessible names) of what's on it. Call this after every navigation and after any action that might have changed the page, before deciding what to click or fill.",
        parameters: { type: "object", properties: {} },
      },
      z.object({}),
      () => session.snapshot(),
    ),
    actionTool(
      {
        name: "browser_click",
        description: `Click the first element matching an accessible role and name (case-insensitive substring match). Allowed roles: ${CLICKABLE_ROLES.join(", ")}.`,
        parameters: {
          type: "object",
          properties: { role: { type: "string", enum: [...CLICKABLE_ROLES] }, name: { type: "string" } },
          required: ["role", "name"],
        },
      },
      z.object({ role: z.string(), name: z.string() }),
      (args) => {
        const role = RoleSchema.safeParse(args.role);
        return role.success ? session.click(role.data, args.name) : Promise.resolve({ error: "role_not_allowed", role: args.role, allowedRoles: CLICKABLE_ROLES });
      },
    ),
    actionTool(
      {
        name: "browser_fill",
        description: `Fill a form field matched by accessible role and name. Allowed roles: ${CLICKABLE_ROLES.join(", ")}.`,
        parameters: {
          type: "object",
          properties: { role: { type: "string", enum: [...CLICKABLE_ROLES] }, name: { type: "string" }, value: { type: "string" } },
          required: ["role", "name", "value"],
        },
      },
      z.object({ role: z.string(), name: z.string(), value: z.string() }),
      (args) => {
        const role = RoleSchema.safeParse(args.role);
        return role.success ? session.fill(role.data, args.name, args.value) : Promise.resolve({ error: "role_not_allowed", role: args.role, allowedRoles: CLICKABLE_ROLES });
      },
    ),
    actionTool(
      {
        name: "browser_wait_for_download",
        description: "Wait for a file download the last click triggered, and save it. Call this immediately after clicking whatever starts the download, not before.",
        parameters: { type: "object", properties: {} },
      },
      z.object({}),
      () => session.waitForDownload(downloadsDir),
    ),
    actionTool(
      {
        name: "browser_list_links",
        description: "List anchor links on the current page (visible text + href). Use this to find a real URL to report — e.g. a search result's actual video link — since browser_snapshot alone doesn't include hrefs.",
        parameters: { type: "object", properties: {} },
      },
      z.object({}),
      () => session.listLinks(),
    ),
  ];
}

/**
 * Caps the prompt by replacing the *content* of the oldest tool results with
 * a short marker, oldest first, until the whole conversation fits in
 * `maxChars`. Deliberately never deletes a message: the OpenAI tool-calling
 * wire format requires every assistant `tool_call` to be answered by a
 * matching `tool` message, so dropping either half of a pair produces a 400
 * from Groq. Eliding content keeps the structure intact and the pairing
 * valid while releasing almost all of the bytes.
 *
 * The system prompt and the user's goal (indices 0 and 1) are never touched
 * — they are what the agent is *for* — and the most recent exchange is left
 * whole so the model can always still see the page it just looked at.
 */
export function trimAgentHistory(messages: LlmMessage[], maxChars: number = MAX_HISTORY_CHARS): void {
  const total = () => messages.reduce((sum, m) => sum + m.content.length, 0);
  if (total() <= maxChars) return;

  const KEEP_RECENT = 2; // the last assistant/tool pair
  for (let i = 2; i < messages.length - KEEP_RECENT; i++) {
    if (total() <= maxChars) return;
    const message = messages[i];
    if (message.role !== "tool" || message.content === ELIDED_TOOL_RESULT) continue;
    message.content = ELIDED_TOOL_RESULT;
  }
}

export interface FinishToolSpec<TResult> {
  name: string;
  description: string;
  parameters: object;
  schema: z.ZodType<TResult>;
}

export interface BrowserAgentTaskOptions {
  llm: LlmDriver;
  page: Page;
  allowedOrigins: readonly string[];
  systemPrompt: string;
  userGoal: string;
  downloadsDir: string;
  maxIterations?: number;
  actionTimeoutMs?: number;
}

/**
 * Runs a bounded Groq tool-calling loop (same shape as
 * src/server/agent/loop.ts's runAgentTurn: iterate until the model stops or
 * hits a hard cap, Result<T,DriverError> across the boundary, never throws)
 * against one Playwright page, restricted to `allowedOrigins`. The loop ends
 * when the model calls `finishTool` with arguments that validate against its
 * schema — there's no human to notice an assistant message and stop typing,
 * so termination has to be a structured tool call, not "no more tool calls."
 */
export async function runBrowserAgentTask<TResult>(
  options: BrowserAgentTaskOptions,
  finishTool: FinishToolSpec<TResult>,
): Promise<Result<TResult, DriverError>> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

  const session = new PageAgentSession(options.page, options.allowedOrigins, actionTimeoutMs);
  const actionTools = buildActionTools(session, options.downloadsDir);
  const allToolDefinitions: ToolDefinition[] = [...actionTools.map((t) => t.definition), { name: finishTool.name, description: finishTool.description, parameters: finishTool.parameters }];

  const messages: LlmMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.userGoal },
  ];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    trimAgentHistory(messages);
    const completion = await options.llm.complete({
      model: MODEL,
      messages,
      tools: allToolDefinitions,
      toolChoice: "auto",
      maxTokens: 1024,
    });
    if (!completion.ok) return err(completion.error);

    const call = completion.value.toolCalls?.[0];
    if (!call) {
      messages.push({ role: "assistant", content: completion.value.content });
      messages.push({
        role: "user",
        content: `Call a tool — either continue investigating the page (${["browser_navigate", "browser_snapshot", "browser_list_links", "browser_click", "browser_fill", "browser_wait_for_download"].join(", ")}) or call ${finishTool.name} with your result. Do not just describe what you would do.`,
      });
      continue;
    }

    let args: unknown;
    try {
      args = JSON.parse(call.argumentsJson);
    } catch {
      args = {};
    }
    messages.push({ role: "assistant", content: "", toolCalls: [call] });

    if (call.name === finishTool.name) {
      const parsed = finishTool.schema.safeParse(args);
      if (parsed.success) return ok(parsed.data);
      messages.push({
        role: "tool",
        content: JSON.stringify({ error: "invalid_arguments", issues: parsed.error.issues }),
        toolCallId: call.id,
      });
      continue;
    }

    const matched = actionTools.find((t) => t.definition.name === call.name);
    const startedAt = Date.now();
    const toolResult = matched ? await matched.run(args) : { error: "unknown_tool" };
    const serialized = JSON.stringify(toolResult);
    // This job runs unattended in CI, where the only evidence of what
    // happened is stdout. Before this line, a stalled agent printed nothing
    // whatsoever for 30 minutes and then died to the job timeout, leaving no
    // way to tell a hang from slow progress. One line per action is cheap
    // and makes the next failure diagnosable from the run log alone.
    console.warn(`[browser-agent] ${iteration + 1}/${maxIterations} ${call.name} -> ${serialized.length}b in ${Date.now() - startedAt}ms`);
    messages.push({ role: "tool", content: serialized, toolCallId: call.id });
  }

  return err({
    kind: "invalid_response",
    message: `browser agent exceeded ${maxIterations} tool-call iterations without calling ${finishTool.name}`,
    retryable: true,
  });
}

export interface BrowserSessionHandle {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/**
 * Launches one headless Chromium page for a single acquisition attempt.
 * Popups are closed unopened (ad-site "open in new tab" is a common vector),
 * and any top-level document navigation to an origin outside `allowedOrigins`
 * is aborted before it loads — the mitigation for an ad redirect trying to
 * take the whole page somewhere else. Subresources (images, scripts, ad
 * iframes rendering) are left alone; the click/fill/snapshot guarantees above
 * are what keep the agent from ever acting on them.
 */
export async function launchBrowserSession(allowedOrigins: readonly string[]): Promise<BrowserSessionHandle> {
  // channel: "chromium" opts into Playwright's "new headless mode" (full
  // Chromium binary) instead of the default chrome-headless-shell, which
  // handles anchor-triggered (<a download>) file downloads unreliably --
  // confirmed live: a download that always landed locally intermittently
  // never fired on a GitHub Actions runner using the default shell. This
  // also makes the agent's real behavior against ytmp3.gg closer to an
  // actual browser, not just a test fix.
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  const context = await browser.newContext();

  // Only gate top-level document navigations (the frame has no parent) —
  // this is what stops an ad redirect from taking the whole page somewhere
  // outside allowedOrigins. Subresource/iframe-content requests pass through
  // untouched; those are contained instead by which Playwright APIs the
  // session ever calls (see PageAgentSession above).
  await context.route("**/*", (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame().parentFrame() === null) {
      let origin: string;
      try {
        origin = new URL(request.url()).origin;
      } catch {
        return route.abort();
      }
      if (!allowedOrigins.includes(origin)) return route.abort();
    }
    return route.continue();
  });

  // context.newPage() itself fires the context's "page" event, not just a
  // real popup — registering the popup-closer before creating the primary
  // page would close the primary page out from under itself the moment it's
  // created. Create it first, then only close pages that aren't it.
  const page = await context.newPage();
  context.on("page", (popup) => {
    if (popup !== page) popup.close().catch(() => {});
  });

  return {
    browser,
    context,
    page,
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
