"""Model registry + selection.

The registry (config/models.json) is the static list of available models per
stage with cost bands — what the admin picker renders. The *selection* (which
model is active for a stage) lives in the DB settings, written by the admin and
read by the pipeline. No API keys here; keys stay in the environment.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from pipeline import store

REGISTRY_PATH = Path(__file__).resolve().parent.parent / "config" / "models.json"


def registry() -> dict:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def list_models(stage: str) -> list[dict]:
    return registry().get(stage, {}).get("options", [])


def default_model(stage: str) -> str:
    return registry().get(stage, {}).get("default", "")


def get_selected(stage: str) -> str:
    """Active model for a stage: the admin-set DB value, else the registry default."""
    return store.get_setting(f"model.{stage}") or default_model(stage)


def set_selected(stage: str, model_id: str) -> None:
    valid = {o["id"] for o in list_models(stage)}
    if model_id not in valid:
        raise ValueError(f"{model_id!r} is not in the registry for {stage}. Options: {sorted(valid)}")
    store.set_setting(f"model.{stage}", model_id)


def _cli() -> None:
    store.init()
    args = sys.argv[1:]
    if not args or args[0] == "list":
        for stage in registry():
            if stage.startswith("_"):
                continue
            selected = get_selected(stage)
            print(f"[{stage}] active: {selected}")
            for o in list_models(stage):
                mark = "*" if o["id"] == selected else " "
                note = "" if o.get("wired") else "  (adapter not wired yet)"
                print(f"   {mark} {o['id']}  {o.get('cost', '')}{note}")
    elif args[0] == "set" and len(args) == 3:
        set_selected(args[1], args[2])
        print(f"set model.{args[1]} = {args[2]}")
    else:
        print("usage: python -m pipeline.models [list | set <stage> <model_id>]")


if __name__ == "__main__":
    _cli()
