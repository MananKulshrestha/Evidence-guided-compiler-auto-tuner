"""Bounded local tuning and paired runtime measurements for one submitted C file."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import signal
import select
import statistics
import subprocess
import tempfile
import time

from .actions import compose
from .config import DATA_DIR
from .features import summarize_ir
from .inspection import InspectionError, MAX_SOURCE_BYTES
from .policies import GuidedPolicy, Proposal


def run_program(binary: Path, args: list[str], stdin: Path, directory: Path, label: str, timeout: float = 2) -> dict:
    stdout_path, stderr_path = directory / f"{label}.stdout", directory / f"{label}.stderr"
    started = time.perf_counter_ns()
    with stdin.open("rb") as inp, stdout_path.open("wb") as out, stderr_path.open("wb") as err:
        # Programs receive their explicit input, not server API credentials or
        # an inherited interactive stdin. communicate avoids wait() polling bins.
        proc = subprocess.Popen([str(binary), *args], stdin=inp, stdout=out, stderr=err,
                                cwd=directory, start_new_session=True,
                                env={key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL") if key in os.environ})
        timed_out = False
        process_fd = None
        try:
            # Linux pidfd signals actual exit. Popen.wait(timeout) polls with
            # increasing sleeps, which would quantize short program timings.
            process_fd = os.pidfd_open(proc.pid)
            ready, _, _ = select.select([process_fd], [], [], timeout)
            if not ready:
                timed_out = True
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            proc.wait()
        except BaseException:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.communicate()
            raise
        finally:
            if process_fd is not None:
                os.close(process_fd)
    duration = time.perf_counter_ns() - started
    digest = hashlib.sha256()
    with stdout_path.open("rb") as output:
        for chunk in iter(lambda: output.read(65536), b""):
            digest.update(chunk)
    with stdout_path.open("rb") as output:
        preview = output.read(65536).decode("utf-8", "replace")
    with stderr_path.open("rb") as error:
        error.seek(max(0, stderr_path.stat().st_size - 4096))
        diagnostics = error.read(4096).decode("utf-8", "replace")
    return {"duration_ns": duration, "returncode": proc.returncode, "timed_out": timed_out,
            "stdout_sha256": digest.hexdigest(), "stdout_bytes": stdout_path.stat().st_size,
            "stdout": preview, "stderr": diagnostics}


def stats(samples: list[dict]) -> dict:
    values = [row["duration_ns"] for row in samples]
    median = int(statistics.median(values))
    return {"median_ns": median, "mad_ns": int(statistics.median(abs(x - median) for x in values)),
            "min_ns": min(values), "max_ns": max(values), "samples_ns": values}


def compare_code(source: str, tc, catalog: dict, *, args: list[str] | None = None,
                 stdin: str = "", max_passes: int = 4) -> dict:
    if not source.strip() or len(source.encode()) > MAX_SOURCE_BYTES or "\x00" in source:
        raise ValueError("Provide non-empty C source at most 64 KiB without NUL characters")
    args = [] if args is None else args
    if (not isinstance(args, list) or len(args) > 32 or any(not isinstance(x, str) or "\x00" in x or len(x) > 1024 for x in args)
            or len(stdin.encode()) > 65536 or type(max_passes) is not int or not 1 <= max_passes <= 4):
        raise ValueError("Invalid arguments, stdin, or maximum pass count")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter_ns()
    commands, samples, candidates = [], [], []
    with tempfile.TemporaryDirectory(prefix="code-run-", dir=DATA_DIR) as directory:
        scratch = Path(directory)
        src, input_file = scratch / "source.c", scratch / "stdin.txt"
        src.write_text(source, encoding="utf-8")
        input_file.write_text(stdin, encoding="utf-8")

        def check_budget():
            if time.perf_counter_ns() - started > 30e9:
                raise InspectionError("CODE_RUN_BUDGET", "This quick comparison exceeded 30 seconds. Use a smaller input or fewer program repetitions.")

        def checked(result):
            commands.append({"args": result.args, "duration_ns": result.duration_ns,
                             "returncode": result.returncode, "timed_out": result.timed_out})
            if not result.ok:
                raise InspectionError("COMPILER_TIMEOUT" if result.timed_out else "CODE_BUILD_FAILED",
                                      "Could not build the submitted program. Provide a complete C program with main.",
                                      result.stderr_excerpt.replace(str(scratch), "code-run"))

        def run(binary, label, phase, expected=None):
            check_budget()
            result = run_program(binary, args, input_file, scratch, label)
            result.update({"phase": phase, "label": label})
            samples.append(result)
            if result["timed_out"]:
                raise InspectionError("PROGRAM_TIMEOUT", "A program execution exceeded 2 seconds. Reduce its input size or repetition count.", result["stderr"])
            if result["returncode"] != 0:
                raise InspectionError("PROGRAM_FAILED", "The program returned a nonzero exit code. Check the program arguments and stdin.", result["stderr"] + "\n" + result["stdout"])
            if expected is not None and result["stdout_sha256"] != expected:
                raise InspectionError("OUTPUT_MISMATCH", "Program stdout differs between executions or compiler variants. Use deterministic output and defined C behavior.")
            return result

        o0, o3, seed = scratch / "o0", scratch / "o3", scratch / "seed.bc"
        checked(tc.compile_direct(src, "-O0", o0, scratch, "build-o0"))
        checked(tc.compile_direct(src, "-O3", o3, scratch, "build-o3"))
        o3_build_ns = commands[-1]["duration_ns"]
        reference = run(o0, "reference", "correctness")
        expected = reference["stdout_sha256"]
        run(o3, "o3-warmup", "correctness", expected)
        checked(tc.emit_seed(src, seed, scratch))
        seed_ns = commands[-1]["duration_ns"]
        features = summarize_ir(tc.textual_ir(seed, scratch, "seed-ir"))
        available = tuple(item["id"] for item in catalog["items"] if item["available"])
        policy = GuidedPolicy(available, max_passes, 29, features)
        # General loop/memory hypotheses, not a lookup of a stored benchmark win.
        probes = []
        if features["loop_present"] and "loop-fusion" in available:
            probes.append(("loop-fusion",))
            if max_passes >= 2 and "slp-vectorizer" in available:
                probes.append(("loop-fusion", "slp-vectorizer"))
        seen, history, winner = set(), [], None
        for index in range(4):
            check_budget()
            proposal = (Proposal(probes.pop(0), "feature_prior", "Loop/memory-traffic hypothesis; measured before selection.")
                        if probes else policy.propose(seen, history))
            if proposal is None:
                break
            seen.add(proposal.action_ids)
            bc, binary = scratch / f"candidate-{index}.bc", scratch / f"candidate-{index}"
            command_start = len(commands)
            row = {"id": str(index), "action_ids": list(proposal.action_ids), "pipeline": compose(proposal.action_ids),
                   "reason": proposal.reason, "status": "invalid", "search_median_ns": None}
            candidates.append(row)
            try:
                checked(tc.optimize(seed, proposal.action_ids, bc, scratch, f"opt-{index}"))
                for command in tc.object_and_link(bc, binary, scratch, f"candidate-{index}"):
                    checked(command)
                run(binary, f"candidate-{index}-check", "correctness", expected)
                measured = [run(binary, f"candidate-{index}-search-{r}", "search", expected) for r in range(3)]
                row.update(status="valid", search_median_ns=stats(measured)["median_ns"],
                           build_ns=seed_ns + sum(x["duration_ns"] for x in commands[command_start:]))
                if winner is None or row["search_median_ns"] < winner[0]["search_median_ns"]:
                    winner = row, binary, bc
            except InspectionError as exc:
                row.update(error_code=exc.code, error=str(exc))
                if exc.code in {"CODE_RUN_BUDGET", "PROGRAM_TIMEOUT"}:
                    raise
            history.append(row)
        if winner is None:
            raise InspectionError("NO_VALID_CANDIDATE", "No guided candidate passed build and output checks.", str(candidates))
        selected, guided, guided_bc = winner
        confirmation = {"o3": [], "guided": []}
        for round_number in range(5):
            for name in (("o3", "guided") if round_number % 2 == 0 else ("guided", "o3")):
                result = run(o3 if name == "o3" else guided, f"{name}-round-{round_number}", "confirmation", expected)
                result.update(round=round_number, variant=name)
                confirmation[name].append(result)
        a, b = stats(confirmation["o3"]), stats(confirmation["guided"])
        wins = sum(g["duration_ns"] < o["duration_ns"] for o, g in zip(confirmation["o3"], confirmation["guided"]))
        return {"status": "completed", "mode": "code_runtime", "executed": True, "llm_mode": "off",
                "source": source, "args": args, "stdin": stdin, "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
                "correctness": "stdout_matches_o0_and_o3_on_supplied_input", "output": reference["stdout"],
                "stdout_sha256": expected, "stdout_bytes": reference["stdout_bytes"],
                "guided": {**b, "build_ns": selected["build_ns"], "action_ids": selected["action_ids"],
                           "pipeline": selected["pipeline"], "executable_bytes": guided.stat().st_size},
                "o3": {**a, "build_ns": o3_build_ns, "executable_bytes": o3.stat().st_size},
                "speedup": a["median_ns"] / b["median_ns"],
                "runtime_reduction_percent": 100 * (a["median_ns"] - b["median_ns"]) / a["median_ns"],
                "paired_wins": wins, "paired_rounds": 5, "candidates": candidates, "samples": samples,
                "commands": commands, "wall_ns": time.perf_counter_ns() - started,
                "notice": "Fresh execution timings of this submitted source on these arguments/stdin. Four local candidates, three search samples each, five alternating confirmation rounds. Process startup and I/O are included. Output agreement on this input is not proof of equivalence; this quick observation has no held-out claim. Compilation/search cost is separate from runtime."}
