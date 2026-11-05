"""Register the Windows-installed FinanceBuddy runtime for the active Cuby workspace."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

import yaml

PAYLOAD = Path(__file__).resolve().parent
REVISION = PAYLOAD / "payload-manifest.json"
TOOLS = [
    "manage_finance_project", "edit_consistency_draft", "start_consistency_semantic",
    "build_consistency_review", "read_consistency_review", "read_consistency_issue",
    "read_consistency_page", "read_public_report", "export_peer_comparison",
    "read_project_report", "list_c2_reviews", "open_c2_reader", "start_c2_disclosure_review",
    "read_c2_rule_page",
]


class BootstrapError(ValueError):
    pass


def register(config_path, workspace):
    server = PAYLOAD / "cuby/service/local_server.py"
    catalogue = PAYLOAD / "cuby/config/yeebo-public-reports.json"
    if not server.is_file() or not catalogue.is_file() or not REVISION.is_file():
        raise BootstrapError("payload_invalid")
    raw = config_path.read_bytes()
    try:
        config = yaml.safe_load(raw.decode("utf-8-sig"))
    except (UnicodeError, yaml.YAMLError):
        raise BootstrapError("config_invalid") from None
    if not isinstance(config, dict):
        raise BootstrapError("config_invalid")
    tools = config.setdefault("tools", {})
    if not isinstance(tools, dict):
        raise BootstrapError("config_invalid")
    servers = tools.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        raise BootstrapError("config_invalid")
    wanted = {
        "type": "stdio",
        "command": sys.executable,
        "args": ["-B", "-X", "utf8", "-u", str(server)],
        "env": {
            "FINANCEBUDDY_PACKAGED_WORKSPACE": str(workspace),
            "FINANCEBUDDY_MODEL_CONFIG": str(config_path),
            "FINANCEBUDDY_REPORTS_REVISION": hashlib.sha256(REVISION.read_bytes()).hexdigest(),
        },
        "toolTimeout": 120,
        "enabledTools": TOOLS,
    }
    existing = servers.get("financebuddy_reports")
    if existing == wanted:
        return
    if existing:
        args = existing.get("args", []) if isinstance(existing, dict) else []
        known_paths = {server, workspace / "cuby/service/local_server.py"}
        if not isinstance(args, list) or not any(isinstance(arg, str) and Path(arg) in known_paths for arg in args):
            raise BootstrapError("workspace_conflict")
    servers["financebuddy_reports"] = wanted

    # Cuby and its gateway share the profile. Replace only after the original bytes
    # still match, and leave the previous configuration intact on write failure.
    text = yaml.safe_dump(config, allow_unicode=True, sort_keys=False)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=config_path.parent, prefix=".financebuddy-",
                                         suffix=".tmp", delete=False) as temp:
            temp_path = Path(temp.name)
            temp.write(text.encode("utf-8"))
            temp.flush()
            os.fsync(temp.fileno())
        if config_path.read_bytes() != raw:
            raise BootstrapError("config_changed")
        os.replace(temp_path, config_path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    args = parser.parse_args()
    try:
        register(args.config.resolve(strict=True), args.workspace.resolve(strict=True))
    except BootstrapError as error:
        print(json.dumps({"error_code": str(error)}))
        return 1
    except Exception:
        print(json.dumps({"error_code": "install_failed"}))
        return 1
    print(json.dumps({"installed": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
