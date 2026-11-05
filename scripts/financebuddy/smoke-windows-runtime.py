"""Exercise the bundled interpreter and packaged gateway using a disposable profile."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen


def free_ports():
    with socket.socket() as a, socket.socket() as b:
        a.bind(("127.0.0.1", 0))
        b.bind(("127.0.0.1", 0))
        return a.getsockname()[1], b.getsockname()[1]


def request(port, route, token, body=None, timeout=8):
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
    data = json.dumps(body).encode() if body is not None else None
    with urlopen(Request(f"http://127.0.0.1:{port}{route}", data=data, headers=headers), timeout=timeout) as response:
        return json.load(response)


def smoke(app):
    resources = app / "resources"
    bundle = resources / "financebuddy-runtime"
    python = bundle / "python/python.exe"
    payload = bundle / "payload"
    assert python.is_file()
    with tempfile.TemporaryDirectory(prefix="cuby-financebuddy-pilot-") as tmp:
        profile = Path(tmp)
        workspace = profile / "active workspace"
        workspace.mkdir()
        config = profile / "config.yaml"
        ws_port, health_port = free_ports()
        secret = secrets.token_hex(32)
        config.write_text(json.dumps({
            "agents": {"defaults": {"workspace": str(workspace)}},
            "channels": {"websocket": {"enabled": True, "host": "127.0.0.1", "port": ws_port,
                                       "tokenIssueSecret": secret, "websocketRequiresToken": True,
                                       "allowFrom": ["*"]}},
            "gateway": {"host": "127.0.0.1", "port": health_port, "heartbeat": {"enabled": False}},
            "heartbeat": {"enabled": False},
        }), encoding="utf-8")
        env = {**os.environ, "CUBY_HOME": str(profile), "CUBY_CONFIG": str(config),
               "CUBY_AGENT_DATA_DIR": str(profile), "CUBY_AGENT_WORKSPACE": str(workspace),
               "OPENCLAW_HOME": str(profile), "OPENCLAW_STATE_DIR": str(profile / "openclaw"),
               "PATH": str(Path(os.environ["SystemRoot"]) / "System32")}
        bootstrap = [str(python), "-B", "-X", "utf8", str(payload / "install_packaged.py"),
                     "--config", str(config), "--workspace", str(workspace)]
        for _ in range(2):
            result = subprocess.run(bootstrap, cwd=profile, env=env, capture_output=True, timeout=35)
            assert result.returncode == 0 and json.loads(result.stdout) == {"installed": True}
            if _ == 0:
                initial_config = config.read_bytes()
            else:
                assert config.read_bytes() == initial_config, "Bootstrap should be idempotent"
        with (profile / "gateway.log").open("wb") as log:
            command = [str(app / "Cuby.exe"),
                       str(resources / "app.asar/dist/runtime/memmy-agent/dist/main.js"),
                       "gateway", "--config", str(config), "--workspace", str(workspace)]
            gateway = subprocess.Popen(command, cwd=profile, env={**env, "ELECTRON_RUN_AS_NODE": "1"},
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            try:
                deadline = time.monotonic() + 40
                while True:
                    if gateway.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("The packaged Cuby gateway did not start.")
                    try:
                        boot = request(ws_port, "/webui/bootstrap", secret, timeout=2)
                        break
                    except OSError:
                        time.sleep(0.25)
                assert "mcp_financebuddy_reports_list_c2_reviews" in boot["tool_names"]
                token = boot["token"]
                assert request(ws_port, "/api/webui/finance/catalog", token)["reviews"] == []
                kb = request(ws_port, "/api/webui/finance/request", token, {
                    "action": "input-knowledge", "fiscal_year": "2026/27", "slots": ["esg_en", "annual_en"],
                }, timeout=50)
                assert kb["source_mode"] == "public_snapshot" and kb["previous_year"] == "2025/26"
                docs = kb["documents"]
                assert len(docs) == 12 and all(row["original_status"] == "verified" for row in docs)
                assert {row["source_id"] for row in docs if row["indexed_status"] == "local_verified"} == {"S23", "S29"}
                assert not any(row["indexed_status"] == "verified" for row in docs), "Local PDF must not imply live indexing"
            finally:
                gateway.terminate()
                gateway.wait(timeout=10)
    print(json.dumps({"bundled_interpreter": True, "idempotent_bootstrap": True,
                      "packaged_gateway": True, "saved_reviews": 0, "public_report_count": 12,
                      "exact_prior_sources": ["S23", "S29"], "ssh": False, "model_calls": 0}))


if __name__ == "__main__":
    smoke(Path(sys.argv[1]).resolve(strict=True))
