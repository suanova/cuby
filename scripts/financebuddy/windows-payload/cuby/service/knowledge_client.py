"""Bounded, read-only client for the project's existing scoped SSH MCP server."""
import json
import os
from pathlib import Path
import queue
import subprocess
import threading


class KnowledgeClient:
    ALLOWED = {'list_documents', 'search_evidence', 'read_evidence', 'read_source_page'}

    def __init__(self, root, timeout=35):
        self.timeout = timeout
        self.sequence = 0
        self.responses = queue.Queue()
        config = json.loads((Path(root) / 'cuby/config/cuby-mcp.json').read_text(encoding='utf-8'))
        entry = config['tools']['mcpServers']['financebuddy']
        environment = dict(os.environ)
        if os.name == 'nt':
            environment.setdefault('ProgramData', 'C:/ProgramData')
        # Only trusted project configuration supplies process arguments. No user shell input.
        self.process = subprocess.Popen([entry['command'], *entry['args']], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, encoding='utf-8', bufsize=1,
                                        env=environment,
                                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        threading.Thread(target=self._reader, daemon=True).start()
        try:
            self._request('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {},
                                        'clientInfo': {'name': 'financebuddy-baseline', 'version': '0.1.0'}})
            self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n')
            self.process.stdin.flush()
        except Exception:
            self.close()
            raise

    def _reader(self):
        for line in self.process.stdout:
            self.responses.put(line)
        self.responses.put(None)

    def _request(self, method, params):
        self.sequence += 1
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': self.sequence,
                                             'method': method, 'params': params}, ensure_ascii=False) + '\n')
        self.process.stdin.flush()
        try:
            line = self.responses.get(timeout=self.timeout)
        except queue.Empty:
            self.close()
            raise ValueError('Knowledge service timed out; no evidence was substituted.') from None
        if not line:
            raise ValueError('Knowledge service disconnected.')
        data = json.loads(line)
        if data.get('id') != self.sequence or 'error' in data:
            raise ValueError('Knowledge service rejected the request.')
        return data['result']

    def call(self, name, arguments):
        if name not in self.ALLOWED:
            raise ValueError('Only scoped read-only knowledge calls are allowed.')
        result = self._request('tools/call', {'name': name, 'arguments': arguments})
        if result.get('isError'):
            raise ValueError('Knowledge evidence request failed; check service/scope/revision.')
        return result.get('structuredContent') or json.loads(result['content'][0]['text'])

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.close()
                self.process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
