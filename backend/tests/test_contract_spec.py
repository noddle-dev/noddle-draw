"""CI entry point for the contract guards.

The canonical guard module is <repo>/tests/test_spec.py (kept there so
`contract_audit.py` finds the covers() markers next to contracts/). CI runs
`python -m pytest backend/tests -q`, so this module executes that file and
re-exports its tests/fixtures into this namespace for pytest to collect —
one source of truth, two entry points.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_CANONICAL = Path(__file__).resolve().parents[2] / "tests" / "test_spec.py"

_spec = importlib.util.spec_from_file_location("contract_spec_guards", _CANONICAL)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)

globals().update(
    {
        name: obj
        for name, obj in vars(_module).items()
        if not name.startswith("__")
    }
)
