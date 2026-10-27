from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from autotuner import api, code_run
from autotuner.inspection import InspectionError
from autotuner.registry import benchmark


PROGRAM = r'''
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
    int n = 0;
    if (scanf("%d", &n) != 1 || argc != 2) return 2;
    printf("%s:%d:%s\n", argv[1], n * 2, getenv("OPENAI_API_KEY") ? "leaked" : "local");
    return 0;
}
'''


def test_code_run_executes_actual_source_args_stdin_and_records_paired_evidence(llvm, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-reach-submitted-program")
    result = code_run.compare_code(PROGRAM, *llvm, args=["two words"], stdin="21\n")
    assert result["executed"] is True
    assert result["llm_mode"] == "off"
    assert result["output"] == "two words:42:local\n"
    assert len(result["candidates"]) == 4
    assert len(result["guided"]["samples_ns"]) == len(result["o3"]["samples_ns"]) == 5
    assert result["speedup"] == result["o3"]["median_ns"] / result["guided"]["median_ns"]
    assert all(row["stdout_sha256"] == result["stdout_sha256"] for row in result["samples"])
    confirmed = [row for row in result["samples"] if row["phase"] == "confirmation"]
    assert [x["variant"] for x in confirmed[:4]] == ["o3", "guided", "guided", "o3"]
    assert result["guided"]["build_ns"] > 0
    assert not list(code_run.DATA_DIR.glob("code-run-*"))


def test_submitted_pipeline_with_own_arguments_does_not_need_registry_matching(llvm):
    source = Path(benchmark("pipeline")["source_path"]).read_text() + "\n/* teacher edit */\n"
    result = code_run.compare_code(source, *llvm, args=["--size", "2000", "--seed", "17", "--repeat", "2"])
    assert result["source"] == source
    assert result["output"].startswith("checksum:")
    assert result["executed"] is True
    assert any("loop-fusion" in row["action_ids"] for row in result["candidates"])


@pytest.mark.parametrize("source,code", [
    ("int f(int x) { return x * 2; }", "CODE_BUILD_FAILED"),
    ("int main(void) { return 3; }", "PROGRAM_FAILED"),
    ('#include <stdio.h>\nint main(void) {\n#ifdef __OPTIMIZE__\nputs("optimized");\n#else\nputs("plain");\n#endif\n}', "OUTPUT_MISMATCH"),
])
def test_failures_do_not_claim_performance(source, code, llvm):
    with pytest.raises(InspectionError) as exc:
        code_run.compare_code(source, *llvm)
    assert exc.value.code == code
    assert not list(code_run.DATA_DIR.glob("code-run-*"))


def test_runtime_api_parses_arguments_and_does_not_create_benchmark_experiment(llvm):
    with TestClient(api.app) as client:
        api.app.state.service._toolchain, api.app.state.service._catalog = llvm
        result = client.post("/v1/code-runs", json={"source": PROGRAM, "arguments": '"two words"', "stdin": "21\n"})
        assert result.status_code == 200
        assert result.json()["output"] == "two words:42:local\n"
        assert client.get("/v1/experiments").json()["total"] == 0
        assert client.post("/v1/code-runs", json={"source": PROGRAM, "arguments": '"unterminated'}).status_code == 422
        assert client.post("/v1/code-runs", json={"source": PROGRAM, "llm_mode": "openai"}).status_code == 422


def test_runtime_timeout_kills_program(tmp_path):
    import sys
    if sys.platform != "linux":
        pytest.skip("Runner requires Linux")
    stdin = tmp_path / "stdin"
    stdin.write_text("")
    result = code_run.run_program(Path("/bin/sleep"), ["5"], stdin, tmp_path, "timeout", timeout=0.05)
    assert result["timed_out"] is True
    assert result["returncode"] != 0
    assert result["duration_ns"] < 1e9
