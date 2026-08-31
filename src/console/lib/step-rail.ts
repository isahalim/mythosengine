/**
 * The five-step rail at the top of the run view (plan v2 §7).
 *
 * Two scripts drive it — the wizard owns steps 1-3
 * (src/console/scripts/run-plan-wizard.ts) and the run view owns 4-5
 * (run-flow.ts) — and the run view repaints every few seconds while
 * polling. If each simply wrote the active class, the poll would stamp on
 * the operator's place in the wizard four seconds after they got there.
 *
 * So neither writes the rail directly: each reports its own half, and the
 * rail derives one active step from both. A run that is actually working
 * wins, because that is where the operator's attention is; otherwise the
 * rail follows the plan they are building.
 */

type Step = 1 | 2 | 3 | 4 | 5;

let wizardStep: Step = 1;
let runStep: Step | null = null;

function paint(): void {
  const active = runStep ?? wizardStep;
  for (const node of document.querySelectorAll<HTMLElement>("[data-step]")) {
    const step = Number(node.dataset.step);
    const isActive = step === active;
    const isDone = step < active;
    node.classList.toggle("border-sodium/50", isActive);
    node.classList.toggle("text-mercury", isActive);
    node.classList.toggle("border-oxide/30", !isActive && isDone);
    node.classList.toggle("text-mercury/70", !isActive && isDone);
    node.classList.toggle("border-mercury/15", !isActive && !isDone);
    node.classList.toggle("text-mercury/45", !isActive && !isDone);
    node.setAttribute("aria-current", isActive ? "step" : "false");
  }
}

/** Where the operator is in the plan form: 1 = choosing a count, 2 = topics, 3 = ideas. */
export function setWizardStep(step: 1 | 2 | 3): void {
  wizardStep = step;
  paint();
}

/** 4 while a run is working, 5 when it has something to review, null when no run is in the foreground. */
export function setRunStep(step: 4 | 5 | null): void {
  runStep = step;
  paint();
}
