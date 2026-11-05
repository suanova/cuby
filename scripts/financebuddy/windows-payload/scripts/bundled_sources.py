"""Immutable sources supplied with the Windows installer."""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOGUE = ROOT / "cuby/config/yeebo-public-reports.json"
PUBLIC_SOURCE = "Yeebo public filings snapshot"


def packaged():
    return bool(os.environ.get("FINANCEBUDDY_PACKAGED_WORKSPACE"))


def read_root(workspace):
    return ROOT if packaged() else Path(workspace)


def public_catalogue():
    raw = CATALOGUE.read_bytes()
    data = json.loads(raw)
    if data.get("schema") != 1 or len(data["documents"]) != 12:
        raise ValueError("Bundled Yeebo public-report catalogue is invalid.")
    return data["documents"], hashlib.sha256(raw).hexdigest()


def report_file(workspace, name):
    root = (read_root(workspace) / "dataset/reports").resolve()
    target = (root / name).resolve()
    if Path(name).name != name or target.parent != root:
        raise ValueError("Historical source path is invalid.")
    return target
