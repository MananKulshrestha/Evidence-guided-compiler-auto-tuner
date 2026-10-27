"""Match pasted bundled source to a reproducible, freshly measured experiment.

Never infer runtime from an inspection or execute arbitrary pasted code. Only
the registered source and its existing correctness harness can use this path.
"""
from pathlib import Path

from .models import ExperimentRequest
from .registry import registry
from .showcase import screening_cases


def canonical_source(source: str) -> str:
    return source.removeprefix("\ufeff").replace("\r\n", "\n").replace("\r", "\n").strip()


def match_source(source: str) -> dict | None:
    normalized = canonical_source(source)
    for entry in registry().values():
        bundled = Path(entry["source_path"]).read_text(encoding="utf-8")
        if normalized != canonical_source(bundled):
            continue
        # Explicit demo preset, not a selection based on the new run's results.
        # Reproduce the settings of the previously discussed pipeline evidence.
        preset = next((case for case in screening_cases() if entry["id"] == "pipeline"
                       and case["id"] == "pipeline-8m-r24-s79"), None)
        settings = preset["request"] if preset else ExperimentRequest.parse(
            {"benchmark_id": entry["id"], "mode": "full", "llm_mode": "off"}).as_dict()
        return {"benchmark_id": entry["id"], "display_name": entry["display_name"],
                "source_sha256": entry["source_sha256"],
                "preset": preset["id"] if preset else "default-full",
                "request": settings}
    return None
