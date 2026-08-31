// Pipeline settings composer (CONSOLE_SPEC.md §3): edit -> Zod-validate ->
// mandatory dry run -> activate, plus reset-to-defaults. Activate stays
// disabled until a dry run has succeeded against the *exact* values
// currently in the form — any edit after a dry run invalidates it, so the
// operator can never activate a form state they haven't previewed.
import { dryRunSettings, getSettings, putSettings, resetSettingsToDefaults } from "../lib/api.ts";
import { DEFAULT_DIRECTIVE, DirectiveSchema, type DirectiveFormValues } from "../lib/schema.ts";
import { redirectIfUnauthorized } from "../lib/session-guard.ts";
import type { DryRunResult } from "../lib/types.ts";

function form(): HTMLFormElement {
  const node = document.getElementById("settings-form");
  if (!(node instanceof HTMLFormElement)) throw new Error("settings-form not found");
  return node;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readValues(): DirectiveFormValues | { error: string } {
  const f = form();
  const data = new FormData(f);
  const rateMin = String(data.get("ttsRateMin") ?? "").trim();
  const rateMax = String(data.get("ttsRateMax") ?? "").trim();
  if (rateMin.length > 0 !== rateMax.length > 0) {
    return { error: "Rate range needs both a min and a max, or neither." };
  }

  const toneRaw = String(data.get("tone") ?? "");
  const minOriginalityRaw = String(data.get("minOriginalityScore") ?? "");
  const maxUploadsRaw = String(data.get("maxUploadsPerDay") ?? "");

  return {
    focusGames: splitList(String(data.get("focusGames") ?? "")),
    excludeTopics: splitList(String(data.get("excludeTopics") ?? "")),
    preferredSourceIds: splitList(String(data.get("preferredSourceIds") ?? "")),
    minOriginalityScore: minOriginalityRaw === "" ? 0.5 : Number(minOriginalityRaw),
    maxUploadsPerDay: maxUploadsRaw === "" ? 3 : Number(maxUploadsRaw),
    tone: toneRaw === "" ? null : (toneRaw as DirectiveFormValues["tone"]),
    editorialNote: (() => {
      const note = String(data.get("editorialNote") ?? "").trim();
      return note.length > 0 ? note : null;
    })(),
    voicePool: (() => {
      const voices = data.getAll("voicePool").map(String);
      return voices.length > 0 ? voices : null;
    })(),
    ttsRateRange: rateMin.length > 0 ? [rateMin, rateMax] : null,
    diversityMode: data.get("diversityMode") === "on",
  };
}

// getElementById + instanceof, not `elements.namedItem(name) as T` — the
// latter's return type (Element | RadioNodeList | null) doesn't overlap
// cleanly with a concrete input type, and settings.astro already gives
// every field a stable id.
function inputById(id: string): HTMLInputElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLInputElement)) throw new Error(`#${id} is not an input`);
  return node;
}

function textareaById(id: string): HTMLTextAreaElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLTextAreaElement)) throw new Error(`#${id} is not a textarea`);
  return node;
}

function populateForm(directive: DirectiveFormValues): void {
  inputById("focus-games").value = directive.focusGames.join(", ");
  inputById("exclude-topics").value = directive.excludeTopics.join(", ");
  inputById("preferred-sources").value = directive.preferredSourceIds.join(", ");
  inputById("min-originality").value = String(directive.minOriginalityScore);
  inputById("max-uploads").value = String(directive.maxUploadsPerDay);
  textareaById("editorial-note").value = directive.editorialNote ?? "";
  inputById("rate-min").value = directive.ttsRateRange?.[0] ?? "";
  inputById("rate-max").value = directive.ttsRateRange?.[1] ?? "";
  inputById("diversity-mode").checked = directive.diversityMode;

  const toneSelect = document.getElementById("tone");
  if (toneSelect instanceof HTMLSelectElement) toneSelect.value = directive.tone ?? "";

  for (const checkbox of form().querySelectorAll<HTMLInputElement>('input[name="voicePool"]')) {
    checkbox.checked = directive.voicePool?.includes(checkbox.value) ?? false;
  }
}

function showValidationErrors(messages: string[]): void {
  const node = document.getElementById("validation-errors");
  if (!node) return;
  if (messages.length === 0) {
    node.classList.add("hidden");
    node.textContent = "";
    return;
  }
  node.classList.remove("hidden");
  node.textContent = messages.join(" · ");
}

function renderDryRun(result: DryRunResult): void {
  const node = document.getElementById("dry-run-result");
  if (!node) return;
  node.classList.remove("hidden");
  node.replaceChildren();
  const summary = document.createElement("p");
  summary.textContent = `Against the last 20 signals: ${result.wouldPick.length} would be picked, ${result.wouldSkip.length} would be skipped.`;
  node.appendChild(summary);
  if (result.wouldSkip.length > 0) {
    const list = document.createElement("ul");
    list.className = "mt-2 flex flex-col gap-1 text-mercury/50";
    for (const skip of result.wouldSkip.slice(0, 10)) {
      const item = document.createElement("li");
      item.textContent = `${skip.title} — ${skip.reason}`;
      list.appendChild(item);
    }
    node.appendChild(list);
  }
}

function setStatus(message: string): void {
  const node = document.getElementById("settings-status");
  if (node) node.textContent = message;
}

export function initSettingsForm(): void {
  const f = form();
  const dryRunButton = document.getElementById("dry-run-button");
  const activateButton = document.getElementById("activate-button");
  const resetButton = document.getElementById("reset-defaults-button");

  let lastDryRunSnapshot: string | null = null;

  function invalidateDryRun(): void {
    lastDryRunSnapshot = null;
    if (activateButton instanceof HTMLButtonElement) activateButton.disabled = true;
  }

  f.addEventListener("input", invalidateDryRun);
  f.addEventListener("change", invalidateDryRun);

  dryRunButton?.addEventListener("click", () => {
    void (async () => {
      const values = readValues();
      if ("error" in values) {
        showValidationErrors([values.error]);
        return;
      }
      const parsed = DirectiveSchema.safeParse(values);
      if (!parsed.success) {
        showValidationErrors(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
        return;
      }
      showValidationErrors([]);

      if (dryRunButton instanceof HTMLButtonElement) dryRunButton.disabled = true;
      const result = await dryRunSettings(parsed.data);
      if (dryRunButton instanceof HTMLButtonElement) dryRunButton.disabled = false;

      if (!result.ok) {
        if (redirectIfUnauthorized(result.error)) return;
        setStatus(`Dry run failed: ${result.error.message}`);
        return;
      }
      renderDryRun(result.value);
      lastDryRunSnapshot = JSON.stringify(parsed.data);
      if (activateButton instanceof HTMLButtonElement) activateButton.disabled = false;
      setStatus("Dry run complete — Activate is now available for these exact settings.");
    })();
  });

  f.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const values = readValues();
      if ("error" in values) return;
      const parsed = DirectiveSchema.safeParse(values);
      if (!parsed.success || JSON.stringify(parsed.data) !== lastDryRunSnapshot) {
        setStatus("Run a dry run against the current settings first.");
        return;
      }
      if (activateButton instanceof HTMLButtonElement) activateButton.disabled = true;
      const result = await putSettings(parsed.data);
      if (!result.ok) {
        if (redirectIfUnauthorized(result.error)) return;
        setStatus(`Activation failed: ${result.error.message}`);
        if (activateButton instanceof HTMLButtonElement) activateButton.disabled = false;
        return;
      }
      setStatus(`Activated as directive v${result.value.version}.`);
      invalidateDryRun();
    })();
  });

  resetButton?.addEventListener("click", () => {
    void (async () => {
      if (resetButton instanceof HTMLButtonElement) resetButton.disabled = true;
      const result = await resetSettingsToDefaults();
      if (resetButton instanceof HTMLButtonElement) resetButton.disabled = false;
      if (!result.ok) {
        if (redirectIfUnauthorized(result.error)) return;
        setStatus(`Reset failed: ${result.error.message}`);
        return;
      }
      populateForm(result.value.compiled);
      invalidateDryRun();
      setStatus(`Reset to defaults — activated as directive v${result.value.version}.`);
    })();
  });

  void (async () => {
    const result = await getSettings();
    if (!result.ok) {
      if (redirectIfUnauthorized(result.error)) return;
      /*
        This is the one place the banner was load-bearing rather than
        redundant, and dropping it without a replacement would have been the
        worst outcome of this change. The form falls back to the defaults so
        it is still usable — but defaults are indistinguishable from real
        saved settings once they are in the fields, so an operator would be
        looking at values that are NOT what the pipeline is running and have
        no way to tell. Say it in the loudest state this page has.
      */
      populateForm(DEFAULT_DIRECTIVE);
      showValidationErrors([
        `Couldn't load the active directive (${result.error.kind}). These are the defaults, not what the pipeline is running — reload before changing anything.`,
      ]);
      return;
    }
    showValidationErrors([]);
    populateForm(result.value.compiled);
  })();
}
