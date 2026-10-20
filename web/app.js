const $ = (id) => document.getElementById(id);
const state = { benchmarks: [], activeId: null, poller: null, viewVersion: 0, detailVersion: 0, savedOffset: 0 };
const ms = (ns) => ns == null ? "—" : `${(ns / 1e6).toFixed(2)} ms`;

async function getJSON(url, options = {}) {
  const response = await fetch(url, options);
  // Preserve exact large integers in saved CLI/API runs, including uint64 seeds.
  const data = JSON.parse(await response.text(), (_key, value, context) => {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (context?.source) return context.source;
      throw new Error("This browser cannot display large saved integers exactly; use a current browser or download the raw JSON.");
    }
    return value;
  });
  if (!response.ok) {
    const diagnostics = data.error?.details?.diagnostics;
    throw new Error((data.error?.message || `HTTP ${response.status}`) + (diagnostics ? `\n\n${diagnostics}` : ""));
  }
  return data;
}

function showError(message) { $("form-error").textContent = message; $("form-error").hidden = false; }
function clearError() { $("form-error").hidden = true; }

function selectedBenchmark() { return state.benchmarks.find((item) => item.id === $("benchmark").value); }
function applyDefaults() {
  const item = selectedBenchmark();
  if (!item) return;
  const workload = $("mode").value === "quick" ? item.quick_input : item.tuning_input;
  $("size").value = workload.size;
  $("seed").value = workload.seed;
  $("repeat").value = workload.repeat;
  $("budget").value = $("mode").value === "quick" ? 5 : 20;
  $("search-repetitions").value = $("mode").value === "quick" ? 3 : 5;
  $("confirmation-rounds").value = $("mode").value === "quick" ? 3 : 10;
  $("holdout-fields").hidden = $("mode").value !== "full";
  for (const key of ["size", "seed", "repeat"]) $("holdout-" + key).value = item.holdout_input[key];
  $("holdout-size").max = item.size_max;
  $("size").max = item.size_max;
  $("benchmark-description").textContent = `${item.description} Supported size: ${item.size_min.toLocaleString()}–${item.size_max.toLocaleString()}.`;
}

async function loadSetup() {
  const [health, benchmarks] = await Promise.all([getJSON("/v1/health"), getJSON("/v1/benchmarks")]);
  $("health").textContent = health.toolchain_ready ? "Toolchain ready" : "Toolchain unavailable";
  $("health").className = `health ${health.toolchain_ready ? "ready" : "degraded"}`;
  $("health").title = health.toolchain_error || "LLVM actions, compilation, linking, and checksum validation passed";
  if (health.llm) {
    const llm = health.llm;
    $("health").textContent += llm.error ? " · OpenAI configuration error" : llm.mode === "openai" ? ` · OpenAI: ${llm.model}` : " · Local guided search";
    if (llm.error) $("health").title += `; ${llm.error}`;
  }
  $("run-button").disabled = !health.toolchain_ready;
  $("inspect-button").disabled = !health.toolchain_ready;
  state.benchmarks = benchmarks.items;
  for (const item of benchmarks.items) {
    const option = document.createElement("option"); option.value = item.id; option.textContent = item.display_name;
    $("benchmark").append(option);
  }
  applyDefaults();
  await Promise.all([loadSaved().catch((error) => showError(error.message)), loadBundled()]);
}

async function loadBundled() {
  const container = $("bundled-runs"); container.replaceChildren();
  try {
    const index = await getJSON("/examples/index.json");
    for (const item of index.items) {
      const button = document.createElement("button"); button.className = "saved-run"; button.type = "button";
      const title = document.createElement("span"); title.textContent = `${item.benchmark_id} · saved full`;
      const detail = document.createElement("small"); detail.textContent = "Portable evidence";
      button.append(title, detail);
      button.addEventListener("click", async () => {
        clearTimeout(state.poller); state.activeId = null;
        const version = ++state.viewVersion;
        $("results").hidden = true;
        $("cancel-run").hidden = true; $("retry-run").hidden = true;
        try {
          const bundle = await getJSON(`/examples/${item.name}/bundle.json`);
          if (version !== state.viewVersion) return;
          $("empty-state").hidden = true; $("run-status").hidden = false;
          $("status-badge").textContent = "saved full"; $("status-badge").className = "badge";
          $("run-id").textContent = item.experiment_id;
          $("progress-fill").style.width = "100%";
          $("progress-text").textContent = `${bundle.summary.trial_count} previously measured candidate proposals`;
          $("run-message").textContent = "Bundled evidence from an earlier run. No compiler or benchmark process was started.";
          renderResults(bundle.summary, bundle.trials, `/examples/${item.name}`, bundle.details);
        } catch (error) { if (version === state.viewVersion) showError(error.message); }
      });
      container.append(button);
    }
    if (!index.items.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "No bundled examples."; container.append(p); }
  } catch (_) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "Bundled examples are unavailable."; container.append(p); }
}

async function loadSaved(append = false) {
  const offset = append ? state.savedOffset : 0;
  const data = await getJSON(`/v1/experiments?limit=20&offset=${offset}`);
  const container = $("saved-runs"); if (!append) container.replaceChildren();
  state.savedOffset = offset + data.items.length;
  $("load-more-saved").hidden = state.savedOffset >= data.total;
  if (!data.items.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "No saved experiments yet."; container.append(p); return; }
  for (const item of data.items) {
    const button = document.createElement("button"); button.className = "saved-run"; button.type = "button";
    const title = document.createElement("span"); title.textContent = `${item.benchmark_id} · ${item.mode}`;
    const detail = document.createElement("small"); detail.textContent = `${item.status} · ${new Date(item.created_at).toLocaleString()}`;
    button.append(title, detail); button.addEventListener("click", () => { clearError(); watchRun(item.id); }); container.append(button);
  }
}

async function startRun(event) {
  event.preventDefault(); clearError();
  const button = $("run-button"); button.disabled = true;
  const body = { benchmark_id: $("benchmark").value, mode: $("mode").value,
    tuning_input: { size: Number($("size").value), seed: Number($("seed").value), repeat: Number($("repeat").value) },
    budget_per_strategy: Number($("budget").value), max_sequence_length: Number($("max-length").value),
    search_repetitions: Number($("search-repetitions").value), confirmation_rounds: Number($("confirmation-rounds").value) };
  if (body.mode === "full") body.holdout_input = Object.fromEntries(["size", "seed", "repeat"].map((key) => [key, Number($("holdout-" + key).value)]));
  const numbers = [...Object.values(body.tuning_input), ...Object.values(body.holdout_input || {})];
  if (!numbers.every(Number.isSafeInteger)) { showError("Workload values must be exact integers; browser seeds are limited to 9007199254740991."); button.disabled = false; return; }
  try {
    const data = await getJSON("/v1/experiments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await watchRun(data.id);
  } catch (error) { showError(error.message); }
  finally { button.disabled = false; }
}

async function watchRun(id) {
  state.activeId = id; clearTimeout(state.poller); $("results").hidden = true;
  const version = ++state.viewVersion;
  $("cancel-run").hidden = true; $("retry-run").hidden = true;
  $("empty-state").hidden = true; $("run-status").hidden = false;
  await updateRun(id, version);
}

async function updateRun(id, version) {
  if (version !== state.viewVersion || state.activeId !== id) return;
  try {
    const run = await getJSON(`/v1/experiments/${id}`);
    if (version !== state.viewVersion) return;
    $("status-badge").textContent = run.status; $("status-badge").className = `badge ${run.status === "failed" ? "failed" : ""}`;
    $("run-id").textContent = run.id;
    const p = run.progress; const fraction = p.planned_candidates ? Math.min(100, Math.round(100 * p.attempted_candidates / p.planned_candidates)) : 0;
    $("progress-fill").style.width = `${fraction}%`;
    $("progress-text").textContent = `${p.attempted_candidates}/${p.planned_candidates} candidate proposals · ${p.valid_candidates} valid · ${run.stage}`;
    $("run-message").textContent = run.error_message || (run.cancellation_requested ? "Cancellation requested. Waiting for the current compiler stage or execution to finish." : run.status === "completed" ? "Experiment finished. Fresh confirmation measurements are shown below." : "Measurements are saved after each trial.");
    const terminal = ["completed", "failed", "interrupted", "cancelled"].includes(run.status);
    $("cancel-run").hidden = terminal; $("cancel-run").disabled = Boolean(run.cancellation_requested);
    $("retry-run").hidden = !terminal;
    if (terminal) {
      state.poller = null;
      if (run.status === "completed") await loadResults(run.id, version);
      else await loadPartialResults(run, version);
      await loadSaved();
    } else {
      state.poller = setTimeout(() => updateRun(id, version), 2500);
    }
  } catch (error) { if (version === state.viewVersion) { showError(`${error.message}. Select the saved run to retry.`); clearTimeout(state.poller); } }
}

async function loadPartialResults(run, version) {
  const trials = await getJSON(`/v1/experiments/${run.id}/trials?limit=100`);
  if (version !== state.viewVersion) return;
  $("results").hidden = false;
  for (const id of ["metrics", "comparison-panel", "charts", "downloads"]) $(id).hidden = true;
  $("result-label").textContent = run.status; $("result-label").className = "badge failed";
  $("result-note").textContent = "Partial evidence only. This experiment did not complete confirmation and has no final performance claim.";
  renderTrials(trials.items, null, run.id);
}

function addMetric(container, label, value, detail, kind = "") {
  const card = document.createElement("div"); card.className = `metric ${kind}`;
  const title = document.createElement("small"); title.textContent = label;
  const number = document.createElement("strong"); number.textContent = value;
  const caption = document.createElement("span"); caption.textContent = detail;
  card.append(title, number, caption); container.append(card);
}

async function loadResults(id, version) {
  const [report, trials] = await Promise.all([getJSON(`/v1/experiments/${id}/report`), getJSON(`/v1/experiments/${id}/trials?limit=100`)]);
  if (version === state.viewVersion) renderResults(report, trials.items, `/v1/experiments/${id}/artifacts`, null, id);
}

function renderResults(report, trials, artifactBase, bundledDetails = null, liveId = null) {
  $("results").hidden = false;
  for (const id of ["metrics", "comparison-panel", "charts", "downloads"]) $(id).hidden = false;
  const strategy = report.request.strategies.includes("guided") ? "guided" : "random";
  const comparison = report.comparisons.tuning[`${strategy}_vs_o3`];
  const label = comparison.label || "unavailable";
  $("result-label").textContent = label.replaceAll("_", " ");
  $("result-label").className = `badge ${label === "demo_only" ? "demo" : label === "loss" ? "failed" : ""}`;
  $("result-note").textContent = `${report.mode === "quick" ? "Quick demo" : "Full run"}: ${report.request.confirmation_rounds} confirmation rounds, ${report.request.search_repetitions} search repetitions per initial sample set. ${report.mode === "quick" ? "One input; demo only." : "Tuning and held-out inputs; observations on this machine."}`;
  const metrics = $("metrics"); metrics.replaceChildren();
  addMetric(metrics, "Clang -O3 confirmed", ms(comparison.comparator_median_ns), "Median runtime on tuning input");
  addMetric(metrics, `${strategy === "guided" ? "Guided" : "Random"} winner confirmed`, ms(comparison.candidate_median_ns), (report.winners[strategy]?.action_ids || []).join(" → ") || "No valid confirmed trial");
  addMetric(metrics, "Versus -O3", comparison.runtime_reduction_percent == null ? "—" : `${comparison.runtime_reduction_percent.toFixed(1)}%`, "Positive means faster", comparison.label === "win" ? "good" : comparison.label === "loss" ? "bad" : "");
  renderComparisons(report);
  $("search-chart").src = `${artifactBase}/search.svg`;
  $("pareto-chart").src = `${artifactBase}/pareto.svg`;
  for (const [link, name] of [["summary-link", "summary.json"], ["trials-link", "trials.csv"], ["samples-link", "samples.csv"], ["environment-link", "environment.json"]]) $(link).href = `${artifactBase}/${name}`;
  renderTrials(trials, bundledDetails, liveId);
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderTrials(trials, bundledDetails, liveId) {
  const body = $("trial-rows"); body.replaceChildren(); $("trial-detail").hidden = true;
  for (const trial of trials) {
    const row = document.createElement("tr");
    row.tabIndex = 0; row.setAttribute("role", "button"); row.setAttribute("aria-label", `Inspect ${trial.strategy} trial ${trial.ordinal}`);
    row.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); row.click(); } });
    for (const value of [trial.ordinal, trial.strategy, trial.action_ids.join(" → "), trial.status, ms(trial.search_median_ns), trial.executable_bytes == null ? "—" : `${trial.executable_bytes.toLocaleString()} B`]) {
      const cell = document.createElement("td"); cell.textContent = String(value); row.append(cell);
    }
    row.addEventListener("click", async () => {
      const version = state.viewVersion, detailVersion = ++state.detailVersion;
      try { const detail = bundledDetails ? bundledDetails[trial.id] : await getJSON(`/v1/experiments/${liveId}/trials/${trial.id}`); if (version !== state.viewVersion || detailVersion !== state.detailVersion) return; $("trial-detail").hidden = false; $("trial-detail").textContent = JSON.stringify(detail, null, 2); }
      catch (error) { if (version === state.viewVersion && detailVersion === state.detailVersion) showError(error.message); }
    });
    body.append(row);
  }
}

function renderComparisons(report) {
  const container = $("comparisons"); container.replaceChildren();
  const readable = (name) => name.replaceAll("_vs_", " vs ").replaceAll("o3", "Clang -O3").replaceAll("empty", "empty control");
  for (const [input, comparisons] of Object.entries(report.comparisons)) {
    const heading = document.createElement("h3"); heading.textContent = `${input === "holdout" ? "Held-out" : "Tuning"} confirmation`;
    const workload = report.request[input === "holdout" ? "holdout_input" : "tuning_input"];
    const note = document.createElement("p"); note.className = "muted"; note.textContent = `Size ${workload.size}, seed ${workload.seed}, repeat ${workload.repeat}. Positive reduction means the first strategy is faster.`;
    const wrapper = document.createElement("div"); wrapper.className = "table-wrap";
    const table = document.createElement("table"), head = document.createElement("thead"), body = document.createElement("tbody");
    const header = document.createElement("tr");
    for (const label of ["Comparison", "Candidate median ± MAD", "Comparator median ± MAD", "Reduction", "Faster pairs", "Outcome"]) { const cell = document.createElement("th"); cell.textContent = label; header.append(cell); }
    head.append(header);
    for (const [name, value] of Object.entries(comparisons)) {
      if (name === "variants") continue;
      const row = document.createElement("tr");
      for (const text of [readable(name), `${ms(value.candidate_median_ns)} ± ${ms(value.candidate_mad_ns)}`, `${ms(value.comparator_median_ns)} ± ${ms(value.comparator_mad_ns)}`, value.runtime_reduction_percent == null ? "—" : `${value.runtime_reduction_percent.toFixed(2)}%`, value.paired_rounds == null ? "—" : `${value.paired_wins}/${value.paired_rounds}`, value.label.replaceAll("_", " ")]) { const cell = document.createElement("td"); cell.textContent = text; row.append(cell); }
      body.append(row);
    }
    table.append(head, body); wrapper.append(table); container.append(heading, note, wrapper);
  }
  const explanation = $("result-explanation"); explanation.replaceChildren();
  const notes = report.explanations || [report.mode === "quick" ? "Demo only; no held-out performance claim." : "Win/loss requires at least ten paired rounds, a 2% median difference, and agreement in at least 80% of pairs. Otherwise the outcome is inconclusive."];
  for (const text of notes) { const p = document.createElement("p"); p.textContent = text; explanation.append(p); }
  const failures = document.createElement("p"); failures.textContent = `Non-valid proposals: ${Object.entries(report.failure_counts).map(([key, count]) => `${key}: ${count}`).join(", ") || "none"}. No-IR-change proposals consume budget and are not correctness failures.`; explanation.append(failures);
  const tuning = report.comparisons.tuning, holdout = report.comparisons.holdout;
  if (holdout && Object.keys(tuning).some((key) => tuning[key]?.label === "win" && holdout[key]?.label !== "win")) { const p = document.createElement("p"); p.textContent = "A tuning win did not reproduce on holdout; treat it as workload-specific."; explanation.append(p); }
}

$("benchmark").addEventListener("change", applyDefaults);
$("mode").addEventListener("change", applyDefaults);
$("run-form").addEventListener("submit", startRun);
$("refresh-saved").addEventListener("click", () => loadSaved().catch((error) => showError(error.message)));
$("load-more-saved").addEventListener("click", async () => { $("load-more-saved").disabled = true; try { await loadSaved(true); } catch (error) { showError(error.message); } finally { $("load-more-saved").disabled = false; } });
$("cancel-run").addEventListener("click", async () => {
  const id = state.activeId;
  if (!id) return;
  $("cancel-run").disabled = true;
  try { await getJSON(`/v1/experiments/${id}/cancel`, { method: "POST" }); if (state.activeId === id) await watchRun(id); }
  catch (error) { showError(error.message); $("cancel-run").disabled = false; }
});
$("retry-run").addEventListener("click", async () => {
  const id = state.activeId;
  if (!id) return;
  $("retry-run").disabled = true;
  try { const run = await getJSON(`/v1/experiments/${id}/retry`, { method: "POST" }); await watchRun(run.id); }
  catch (error) { showError(error.message); }
  finally { $("retry-run").disabled = false; }
});
const inspectionExample = `int sum_positive(const int *values, int count) {
    int total = 0;
    for (int i = 0; i < count; ++i) {
        int value = values[i];
        int doubled = value * 2;
        if (value > 0) {
            total += doubled + 0;
        }
    }
    return total;
}
`;
let inspectionDownloadURL = null;
function inspectionError(message) {
  $("inspection-error").textContent = message;
  $("inspection-error").hidden = false;
}
function clearInspection() {
  $("inspection-results").hidden = true;
  $("inspection-error").hidden = true;
  if (inspectionDownloadURL) { URL.revokeObjectURL(inspectionDownloadURL); inspectionDownloadURL = null; }
}
$("source-code").addEventListener("input", clearInspection);
$("load-code-example").addEventListener("click", () => {
  clearInspection(); $("source-code").value = inspectionExample; $("source-file").value = "";
});
$("source-file").addEventListener("change", async () => {
  clearInspection();
  const file = $("source-file").files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".c") || file.size > 65536) { inspectionError("Choose a single .c file no larger than 64 KiB."); return; }
  try { $("source-code").value = await file.text(); }
  catch (_error) { inspectionError("Could not read the selected file."); }
});
$("inspection-form").addEventListener("submit", async (event) => {
  event.preventDefault(); clearInspection();
  const source = $("source-code").value;
  if (!source.trim() || new TextEncoder().encode(source).length > 65536) { inspectionError("Paste non-empty C source no larger than 64 KiB."); return; }
  const controls = ["inspect-button", "source-code", "source-file", "load-code-example", "inspection-max-passes"];
  controls.forEach((id) => { $(id).disabled = true; });
  $("inspection-progress").hidden = false;
  try {
    const data = await getJSON("/v1/inspections", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, max_passes: Number($("inspection-max-passes").value) }) });
    renderInspection(data);
  } catch (error) { inspectionError(error.message); }
  finally { controls.forEach((id) => { $(id).disabled = false; }); $("inspection-progress").hidden = true; }
});
function renderInspection(data) {
  const first = data.stages[0], last = data.stages[data.stages.length - 1];
  $("inspection-notice").textContent = data.notice;
  const selection = data.llm.mode === "openai" ? `${data.llm.model} · ${data.proposal.proposal_type}` : "Local feature-guided selection";
  $("inspection-proposal").textContent = `${selection}: ${data.proposal.reason}`;
  $("inspection-pipeline").textContent = `C → LLVM IR → mem2reg → ${data.proposal.action_ids.join(" → ")} → assembly`;
  const metrics = $("inspection-metrics"); metrics.replaceChildren();
  addMetric(metrics, "IR instructions before", first.features.instruction_count, "Approximate textual count");
  addMetric(metrics, "IR instructions after", last.features.instruction_count, "A count change does not establish a speedup");
  addMetric(metrics, "Suggested passes applied", data.proposal.action_ids.length, "LLVM verifier checked every transformation");
  $("inspection-before").textContent = first.ir;
  $("inspection-after").textContent = last.ir;
  const stages = $("inspection-stages"); stages.replaceChildren();
  data.stages.forEach((stage, index) => {
    const details = document.createElement("details"), summary = document.createElement("summary");
    summary.textContent = `${index + 1}. ${stage.title} · ${stage.features.instruction_count} instructions${stage.changed === null ? "" : stage.changed ? " · IR changed" : " · no IR change"}`;
    const pipeline = document.createElement("p"); pipeline.className = "muted"; pipeline.textContent = stage.pipeline;
    const counts = document.createElement("p"); counts.className = "note";
    counts.textContent = `Loads: ${stage.features.loads} · Stores: ${stage.features.stores} · Conditional branches: ${stage.features.conditional_branches} · Phi nodes: ${stage.features.phi_nodes}`;
    const code = document.createElement("pre"); code.textContent = index === 0 ? stage.ir : stage.diff || "No textual IR change. This pass found no applicable transformation at this stage.";
    details.append(summary, pipeline, counts, code); stages.append(details);
  });
  $("inspection-assembly").textContent = data.assembly;
  $("inspection-commands").textContent = JSON.stringify(data.commands, null, 2);
  inspectionDownloadURL = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  $("inspection-download").href = inspectionDownloadURL;
  $("inspection-results").hidden = false;
  $("inspection-results").scrollIntoView({ behavior: "smooth", block: "start" });
}
loadSetup().catch((error) => showError(error.message));
