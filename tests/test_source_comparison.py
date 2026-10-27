from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from autotuner import api
from autotuner.registry import benchmark
from autotuner.source_comparison import match_source


@pytest.mark.parametrize("benchmark_id", ["dot", "matmul", "histogram", "pipeline", "skew_histogram"])
def test_exact_source_selects_full_local_benchmark(benchmark_id):
    entry = benchmark(benchmark_id)
    source = Path(entry["source_path"]).read_text()
    matched = match_source("\ufeff" + source.replace("\n", "\r\n") + "\n")
    assert matched["benchmark_id"] == benchmark_id
    assert matched["source_sha256"] == entry["source_sha256"]
    assert matched["request"]["mode"] == "full"
    assert matched["request"]["llm_mode"] == "off"
    assert matched["request"]["budget_per_strategy"] == 20
    assert matched["request"]["confirmation_rounds"] == 10


def test_pipeline_reproduces_discussed_measured_preset():
    source = Path(benchmark("pipeline")["source_path"]).read_text()
    matched = match_source(source)
    assert matched["preset"] == "pipeline-8m-r24-s79"
    assert matched["request"]["tuning_input"] == {"size": 8000000, "seed": 79, "repeat": 24}
    assert matched["request"]["holdout_input"] == {"size": 8500000, "seed": 2079, "repeat": 24}
    assert match_source(source.replace("return 0;", "return 7;")) is None
    assert match_source("int main(void) { return 0; }") is None


def test_source_api_delegates_to_existing_experiment_worker(monkeypatch):
    calls = []
    def create(body, request, response):
        calls.append(body.model_dump(exclude_none=True))
        response.headers["Location"] = "/v1/experiments/test-id"
        return {"id": "test-id", "status": "queued"}
    monkeypatch.setattr(api, "create_experiment", create)
    with TestClient(api.app) as client:
        source = client.get("/v1/benchmarks/pipeline/source").json()["source"]
        result = client.post("/v1/source-comparisons", json={"source": source})
        assert result.status_code == 202
        assert result.headers["Location"].endswith("test-id")
        assert result.json()["matched"] is True
        assert calls[0]["llm_mode"] == "off"
        assert calls[0]["tuning_input"]["seed"] == 79
        unmatched = client.post("/v1/source-comparisons", json={"source": "int x;"})
        assert unmatched.json()["matched"] is False
        assert len(calls) == 1
        assert client.get("/v1/benchmarks/not-a-benchmark/source").status_code == 404
        assert client.post("/v1/source-comparisons", json={"source": "\x00"}).status_code == 422
