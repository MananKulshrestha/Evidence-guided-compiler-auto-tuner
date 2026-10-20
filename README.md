# Evidence-Guided LLVM Pass Tuner

A local, correctness-checked experiment for choosing short LLVM optimization-pass sequences for three C17 programs. It compares an IR-guided search (OpenAI-assisted when configured, otherwise rule-based) with an equal-budget random search, an empty-action control, and direct `clang -O3`. The tool records failures and raw timing samples, then remeasures finalists on tuning and held-out workloads. A speedup is an observation, not a guarantee.

## Requirements

- Ubuntu 26.04 WSL2 or a comparable Linux environment on x86-64
- Matching `clang-21`, `opt-21`, `llc-21`, and `llvm-dis-21`
- Python 3.11 or newer; the verified machine uses Python 3.14.4

On the verified Windows machine, the default WSL distribution is `docker-desktop`; explicitly use `wsl -d Ubuntu`. The compiler binaries and experiment database are created under Ubuntu's Linux filesystem. The source checkout may be on Windows, but measurements run from `~/.local/share/compiler-autotuner/runs/` inside Ubuntu.

```bash
sudo apt-get update
sudo apt-get install clang-21 llvm-21 python3-venv
python3 -m venv ~/.venvs/compiler-autotuner
~/.venvs/compiler-autotuner/bin/pip install -c constraints.txt -e '.[web,test,graph]'
```

The `graph` extra is optional. The default engine uses the same service loop without LangGraph. Local rule-based search works without an LLM key, cloud account, Docker container, or frontend build.

## OpenAI setup

The checkout includes an ignored `.env` file. Add your key there:

```dotenv
OPENAI_API_KEY=your-key-here
```

For a fresh clone, copy `.env.example` to `.env` first. Install/update dependencies using the install command above. The existing WSL virtual environment is already updated on this machine. Restart a running server after editing `.env`.

That single key enables OpenAI proposals in new experiments started through the CLI, API, webpage, and LangGraph. Configuration is loaded from the project directory even when launched elsewhere; process environment variables take precedence. Installed-wheel users can set `AUTOTUNER_ENV_FILE` to an absolute `.env` path or export the variables directly.

Optional settings: `OPENAI_MODEL` (default `gpt-6-luna`), `OPENAI_REASONING_EFFORT` (default `low` for GPT-6), `OPENAI_MAX_OUTPUT_TOKENS` (default `4096`, shared by reasoning and visible output), `OPENAI_TIMEOUT_SECONDS` (default `30`), and `AUTOTUNER_LLM_MODE` (`auto`, `off`, or `openai`; default `auto`). Low reasoning suits short, bounded pass proposals. Raise it to `medium` for a deliberate quality comparison if needed; also allow enough output tokens for reasoning. An empty reasoning setting omits the parameter for models that do not support it. `auto` uses OpenAI when a key is present and local rules otherwise. Use `--llm-mode off` for an offline CLI run, or send `"llm_mode": "off"` in an API request. Explicit `openai` mode requires a key. Inspect configuration without a network call or charge:

```bash
python -m autotuner llm-status
```

To verify the actual key/model and optionally run small live compiler experiments (uses API credits):

```bash
python scripts/check_openai.py
python scripts/check_openai.py --workflows
```

The live checker uses a disposable database and saves a safe summary in `test-results/openai-live.json`. Normal Python/browser regression tests stay offline. The exact model and reasoning level are saved with each experiment. GPT-6 Luna supports `none`, `low`, `medium`, `high`, `xhigh`, and `max` reasoning; see the [model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).

The real-browser workflow can also explicitly use your key: set `AUTOTUNER_LIVE_OPENAI=1` when running `npm run test:live`. That opt-in uses credits for six guided proposals across the three benchmarks; leave it unset for the usual offline regression run.

Keys stay on the Python server. Only IR feature counts, allowed passes, previously attempted sequences, and the guided strategy's measured history are sent to OpenAI. Source code and holdout results are not sent. OpenAI uses [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs); proposals still pass local allowlist, uniqueness, compilation, checksum, and timing checks. Incomplete/refused/invalid/repeated proposals fall back to local rules and are labeled `llm_fallback`. Provider failures stop the experiment with a safe error instead of silently treating local search as an LLM result. Each guided candidate makes at most one logical API request (with one transient retry); random search never calls OpenAI. The resolved mode and model are saved with each experiment; model outputs are not deterministic.

Set `AUTOTUNER_ORCHESTRATOR=graph` before starting the CLI or service to run the proposal/compile/evaluate loop through LangGraph nodes. The compiler, policies, budgets, and measurements are unchanged; the run stores `graph_state.json` for inspection.

## Start in two minutes

```bash
python -m autotuner doctor
python -m autotuner benchmarks
python -m autotuner tune --benchmark dot --mode quick
python -m autotuner serve --host 127.0.0.1 --port 8000
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) for the local page or [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs) for the API. A quick run proposes five guided candidates, measures each three times, and performs three tuning-input confirmation rounds. Its report is labeled `demo_only`. A full run proposes 20 guided and 20 random candidates per benchmark, measures each valid candidate five times, and confirms finalists in ten interleaved rounds on tuning and held-out inputs.

```bash
python -m autotuner tune --benchmark matmul --mode full
python -m autotuner status <experiment-id>
python -m autotuner trials <experiment-id>
python -m autotuner report <experiment-id>
python -m autotuner report <experiment-id> --output-dir ./exported-report
python -m autotuner cancel <experiment-id>
python -m autotuner retry <experiment-id>
```

Before a formal run, inspect the workload calibration:

```bash
python -m autotuner calibrate
```

The default full workloads were calibrated on a 13th Gen Intel Core i7-13650HX under WSL2. Different hardware should repeat calibration and adjust `benchmarks/manifest.json` before collecting final results.

## What is recorded

The default data directory is `~/.local/share/compiler-autotuner`; set `AUTOTUNER_DATA_DIR` to change it. SQLite stores experiment status, trial decisions, variants, all executions, and artifact metadata. Each run directory stores a source snapshot, compiler command logs, IR features, expected checksums, `summary.json`, `trials.csv`, `samples.csv`, `environment.json`, and two SVG charts. `report` reads saved records without compiling again. Compiled candidate bitcode/binaries may be reused only under a full build-key match; timing samples are always fresh.

The webpage also offers three **bundled full experiments** under `examples/`. They open without LLVM or a local database and are clearly marked as previously measured. To refresh a bundle after a new full run, use `python -m autotuner.examples <experiment-id> full-dot` (or `full-matmul` / `full-histogram`).

The candidate path is:

```text
C17 source → clang -O1 bitcode → validated opt pass pipeline
           → llc -O3 object → clang link → correctness gate → timing
```

An empty-action binary goes through the same bitcode/backend path. Direct `clang -O3` is a separate practical reference. All tools are version-pinned to LLVM 21, use x86-64 and PIE/PIC flags consistently, and are probed by `doctor`. Pass names are action IDs; the actual `-passes=` string appears in trial records.

## Benchmarks and interface

`dot`, `matmul`, and `histogram` accept `--size N --seed S --repeat R` and print exactly one `checksum:<16 lowercase hex digits>` line. The allowed size interval and quick/tuning/holdout defaults are listed by `benchmarks` and `/v1/benchmarks`. Small cases are checked against separate Python reference implementations. Larger workloads require exact agreement between `-O0`, direct `-O3`, and the empty-action binary before search. Every candidate and every timed execution must return the same checksum.

This version accepts only the built-in benchmarks. The HTTP service listens on `127.0.0.1` and has one worker, so concurrent experiments receive `409 RUN_IN_PROGRESS`. Do not expose the service on a public interface.

The results page shows all five comparisons on tuning and held-out inputs, including median/MAD and faster paired rounds. Measurement settings and held-out inputs are editable under **Measurement settings**. The browser limits seeds to `9007199254740991` to preserve integer precision; the CLI/API accept the full unsigned 64-bit range. Failed, interrupted, and cancelled runs retain inspectable partial trials without a final performance claim.

Cancel requests stop work at the next stage/execution boundary. An already running subprocess finishes or reaches its normal timeout before cancellation takes effect. **Run again with the same settings** creates a fresh experiment linked to its parent, recompares current controls, and collects fresh timings. It preserves the original evidence rather than resuming or overwriting it. Graceful API shutdown drains accepted work; forced termination is reconciled on restart using the process boot/start identity.

## API

Twelve business route operations are under `/v1`: health, benchmarks, actions, experiment list/create/detail, trial list/detail, report, whitelisted artifact retrieval, and `POST /v1/experiments/{id}/cancel` and `/retry`. FastAPI generates `/openapi.json` and `/docs`. A `POST /v1/experiments` or `/retry` returns `202` with a run ID and `Location`; poll the experiment route every 2–5 seconds. Workload JSON values must be integers, without string/boolean/float coercion. Health reports toolchain readiness only after version, pass, compile/link, and checksum checks succeed.

## Development and tests

```bash
python -m pytest -q
python -m autotuner doctor
```

Tests cover the independent C/Python oracle, malformed output, timeout cleanup, guided/random pipelines, confirmation filtering, startup cleanup, cancelled/retried work, restart identity, failed-command evidence, binary-independent reports, corrupt cache recovery, strict validation, and graph exhaustion.

The extended suite tests all three benchmarks in quick/full mode with both plain and graph orchestration, unsigned seed boundaries, a 40-proposal guided/random search, injected compile/runtime/checksum failures, concurrent ownership, legacy migrations, CLI/export behavior, and unavailable tools. Every Python test uses a disposable data directory.

To measure Python statement/branch coverage:

```bash
python -m coverage run -m pytest -q
python -m coverage report
```

Optional browser regression checks use intercepted API responses and require no listening server:

```bash
npm ci
npx playwright install chromium
npm test
npm run test:live
```

`npm test` checks UI edge cases with API fixtures. `npm run test:live` drives Chromium against the actual FastAPI worker and LLVM through a stdio ASGI adapter, including all three benchmarks, downloads, cancellation/retry, and saved runs. It uses no listening port. On Linux set `AUTOTUNER_TEST_PYTHON` to the project virtual environment's Python. On Windows the test defaults to the documented Ubuntu WSL environment; set `AUTOTUNER_TEST_PYTHON` and `AUTOTUNER_TEST_WSL_DISTRO` to override it. `BROWSER_EXECUTABLE` optionally selects an already installed Chromium executable.

The separate clean-install check builds an sdist, builds a wheel from it, and tests the installed CLI/resources/exports in a fresh virtual environment:

```bash
python scripts/check_package.py
```

This build check downloads declared build requirements through pip. The [test plan](docs/TEST_PLAN.md) and [20 October results](docs/TEST_RESULTS_2026-10-20.md) distinguish real compiler checks, injected failures, browser transport, and remaining verification limits.

Node/Playwright are development-only dependencies; the app still needs no frontend build. CI runs compiler integration, wheel installation, and browser checks. To build a distributable wheel, run `python -m pip wheel . --no-deps`; it includes the benchmark sources, page assets, and bundled evidence. See [current status](docs/PROJECT_STATUS.md), [methodology](docs/methodology.md), [limitations](docs/limitations.md), and the [demo script](docs/demo_script.md).

## Research context

AutoPass and Compiler-R1 motivate evidence-guided pass tuning, but this project does not reproduce their models or reported results. The local contribution is a small, auditable search with an equal-budget comparator and explicit correctness and measurement gates. LLVM's [new pass manager](https://llvm.org/docs/NewPassManager.html), [`opt` guide](https://llvm.org/docs/CommandGuide/opt.html), and [benchmarking guidance](https://llvm.org/docs/Benchmarking.html) define the relevant tool behavior.
