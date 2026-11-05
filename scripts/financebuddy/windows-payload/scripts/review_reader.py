"""Local report review workbench: immutable evidence, separate reviewer notes."""
import argparse
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid

import pymupdf
ROOT = Path(os.environ.get('FINANCEBUDDY_PACKAGED_WORKSPACE') or Path(__file__).resolve().parents[1]).resolve()
ASSET_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'cuby/service'))
from c2_review import norm
from review_suggestions import finding, RevisionDraft

DECISIONS = {'open', 'confirmed_gap', 'needs_data', 'not_an_issue', 'resolved'}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def quote_rects(words, quote):
    """Exact normalized text only; never invent a rectangle for a missing claim."""
    text, positions = '', []
    for word in words:
        token = norm(word[4])
        text += token
        positions.extend([tuple(word[:4])] * len(token))
    needle = norm(quote)
    starts = [m.start() for m in re.finditer(re.escape(needle), text)] if len(needle) >= 12 else []
    groups = []
    for start in starts:
        rectangles = list(dict.fromkeys(positions[start:start + len(needle)]))
        lines = []
        for x0, y0, x1, y1 in rectangles:
            if lines and abs(lines[-1][1] - y0) < 3 and x0 - lines[-1][2] < 18:
                line = lines[-1]
                lines[-1] = [min(line[0], x0), min(line[1], y0), max(line[2], x1), max(line[3], y1)]
            else:
                lines.append([x0, y0, x1, y1])
        groups.extend(lines)
    return groups, len(starts)


class ReviewReader:
    def __init__(self, root, review_path):
        self.root = Path(root).resolve()
        self.path = (self.root / review_path).resolve()
        if not self.path.is_relative_to(self.root / 'outputs/c2-reviews') or self.path.name != 'review.json':
            raise ValueError('Choose a finalized C2 review inside workspace outputs/c2-reviews/.')
        if self.path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('Review exceeds the supported size.')
        manifest = json.loads((self.path.parent / 'final-manifest.json').read_text(encoding='utf-8'))
        if digest(self.path) != manifest['files'].get('review.json'):
            raise ValueError('Review no longer matches its finalized manifest.')
        self.report = json.loads(self.path.read_text(encoding='utf-8'))
        self.review_sha = digest(self.path)
        source = self.report['source']
        if source.get('synthetic'):
            if source['file_name'] != 'TEST_ONLY_deliberate_errors.pdf':
                raise ValueError('Synthetic review must use the fixed labelled test PDF.')
            test_source = (self.path.parent / source['file_name']).resolve()
            if test_source.parent != self.path.parent:
                raise ValueError('Synthetic source must stay beside its finalized review.')
            matches = [test_source] if test_source.is_file() else []
        else:
            matches = list((self.root / 'dataset/reports').rglob(source['file_name']))
        if len(matches) != 1 or digest(matches[0]) != source['sha256']:
            raise ValueError('Original source PDF does not match the reviewed revision.')
        self.source = matches[0].resolve()
        if not source.get('synthetic') and not self.source.is_relative_to(self.root / 'dataset/reports'):
            raise ValueError('Original PDF must remain in the source dataset.')
        if self.source.stat().st_size > 30 * 1024 * 1024:
            raise ValueError('Original report exceeds 30 MiB.')
        self.source_bytes = self.source.read_bytes()
        if hashlib.sha256(self.source_bytes).hexdigest() != source['sha256']:
            raise ValueError('Source changed while opening the review.')
        self.rule_path = (self.root / self.report['catalog']['local_rule_file']).resolve()
        if not self.rule_path.is_relative_to(self.root / 'dataset/rules') or digest(self.rule_path) != self.report['catalog']['local_rule_sha256']:
            raise ValueError('Original rule PDF revision differs.')
        self.rule_bytes = self.rule_path.read_bytes()
        if hashlib.sha256(self.rule_bytes).hexdigest() != self.report['catalog']['local_rule_sha256']:
            raise ValueError('Rule source changed while opening the review.')
        self.lock = threading.Lock()
        self.image_lock = threading.Lock()
        self.images = {}
        self.state_path = self.path.parent / 'reader-state.json'
        self.data = self.build_data()
        self.draft = RevisionDraft(self)

    def build_data(self):
        pages, anchors = [], {}
        checks = self.report['checks'] + self.report.get('document_checks', [])
        original_pages = {p['evidence_id']: p for p in self.report['report_pages']}
        with pymupdf.open(stream=self.source_bytes, filetype='pdf') as pdf:
            for i, page in enumerate(pdf):
                pages.append({'number': i + 1, 'width': page.rect.width, 'height': page.rect.height})
            for check in checks:
                refs = []
                for index, evidence in enumerate(check['evidence']):
                    record = original_pages[evidence['evidence_id']]
                    number = record['actual_pdf_page']
                    page = pdf[number - 1]
                    rects, occurrences = quote_rects(page.get_text('words', sort=True), evidence['quote'])
                    ref = {'id': f"{check['id']}:{index}", 'page': number, 'quote': evidence['quote'],
                           'evidence_id': evidence['evidence_id'], 'rects': rects, 'occurrences': occurrences,
                           'location_status': 'exact_text_match' if occurrences else 'unlocated',
                           'context_only': check['status'] in ('not_found_pending_review', 'partial_or_not_found_pending_review')}
                    refs.append(ref)
                anchors[check['id']] = refs
            findings = {}
            for c in checks:
                if c['kind'] == 'document_consistency':
                    item = {**c['finding'], 'marks': []}
                    for a in anchors[c['id']]:
                        if a['quote'] == c.get('conflict_quote'):
                            item['marks'].append({'page': a['page'], 'rects': a['rects']})
                    findings[c['id']] = item
                else:
                    findings[c['id']] = finding(c, self.report, anchors[c['id']], pdf)
        return {'schema_version': 'financebuddy-reader-1', 'review_sha256': self.review_sha,
                'source': {**{k: self.report['source'][k] for k in ('file_name', 'report_fiscal_year', 'sha256', 'language')},
                           'synthetic': bool(self.report['source'].get('synthetic'))},
                'target_period': self.report['target_period'], 'mode': self.report['mode'],
                'rules': self.report['rule_verification'], 'status_counts': self.report['status_counts'],
                'checks': [{**{k: c[k] for k in ('id', 'label', 'status', 'reason', 'next_action', 'clause', 'rule_quote', 'actual_pdf_page', 'kind')}, 'finding': findings[c['id']]} for c in checks],
                'anchors': anchors, 'pages': pages, 'rule_url': self.report['catalog']['official_current_url'],
                'exclusions': self.report['catalog']['exclusions'],
                'human_review_notice': '高亮是核對依據／相關段落，並不表示該句錯誤。缺少披露的項目不會虛構錯句位置。審閱標記不等於合規批准。'}

    def state(self):
        if self.state_path.exists():
            value = json.loads(self.state_path.read_text(encoding='utf-8'))
            if value.get('review_sha256') != self.review_sha:
                raise ValueError('Reviewer notes belong to another review revision.')
            return value
        return {'review_sha256': self.review_sha, 'revision': 0, 'decisions': {}, 'history': []}

    def update(self, value):
        if set(value) != {'expected_revision', 'check_id', 'decision', 'note'}:
            raise ValueError('Unexpected review-note fields.')
        if value['check_id'] not in {c['id'] for c in self.data['checks']} or value['decision'] not in DECISIONS:
            raise ValueError('Unknown checklist item or review decision.')
        if not isinstance(value['note'], str) or len(value['note']) > 2000 or type(value['expected_revision']) is not int:
            raise ValueError('Invalid note or expected revision.')
        with self.lock:
            state = self.state()
            if value['expected_revision'] != state['revision']:
                raise FileExistsError('Notes changed in another tab. Reload before saving.')
            entry = {k: value[k] for k in ('check_id', 'decision', 'note')}
            entry['updated_at'] = datetime.now(timezone.utc).isoformat()
            state['revision'] += 1
            state['decisions'][entry['check_id']] = entry
            state['history'].append({**entry, 'revision': state['revision']})
            data = json.dumps(state, ensure_ascii=False, indent=2) + '\n'
            if len(data.encode()) > 2 * 1024 * 1024:
                raise ValueError('Review history exceeds 2 MiB; export it before continuing.')
            temporary = self.state_path.with_suffix('.tmp')
            temporary.write_text(data, encoding='utf-8')
            os.replace(temporary, self.state_path)
            return state

    def image(self, kind, number):
        key = (kind, number)
        with self.image_lock:
            if key not in self.images:
                with pymupdf.open(stream=self.source_bytes if kind == 'page' else self.rule_bytes, filetype='pdf') as pdf:
                    if not 1 <= number <= len(pdf):
                        raise ValueError('Page is outside this original PDF.')
                    self.images[key] = pdf[number - 1].get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5), alpha=False).tobytes('png')
                if len(self.images) > 12:
                    self.images.pop(next(iter(self.images)))
            return self.images[key]


def make_server(reader, port=0):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def allowed(self):
            origin = f'http://127.0.0.1:{self.server.server_port}'
            return (self.headers.get('Host') == origin.removeprefix('http://')
                    and self.headers.get('Sec-Fetch-Site', 'same-origin') in ('same-origin', 'none')
                    and self.headers.get('Origin', origin) == origin)

        def send(self, status, body, mime='application/json; charset=utf-8', download=False):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            if download:
                self.send_header('Content-Disposition', 'attachment; filename="reviewer-notes.json"')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self.allowed():
                return self.send(403, {'error': 'Local same-origin access required.'})
            route = urlsplit(self.path).path
            try:
                if route == '/api/health':
                    return self.send(200, {'app': 'financebuddy-review-reader', 'review_sha256': reader.review_sha})
                if route == '/api/review':
                    return self.send(200, reader.data)
                if route == '/api/drafts':
                    return self.send(200, reader.draft.state())
                if route == '/api/draft-export':
                    return self.send(200, reader.draft.export())
                if route in ('/api/decisions', '/api/notes-export'):
                    return self.send(200, reader.state(), download=route.endswith('export'))
                if route in ('/api/checklist-export', '/api/requests-export'):
                    filename = 'checklist.csv' if route == '/api/checklist-export' else 'data-requests.csv'
                    return self.send(200, (reader.path.parent / filename).read_bytes(), 'text/csv; charset=utf-8')
                match = re.fullmatch(r'/api/(page|rule)/(\d{1,3})\.png', route)
                if match:
                    return self.send(200, reader.image(match[1], int(match[2])), 'image/png')
                static = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8')}.get(route)
                if static:
                    return self.send(200, ((ASSET_ROOT if os.environ.get('FINANCEBUDDY_PACKAGED_WORKSPACE') else reader.root) / 'cuby/reader' / static[0]).read_bytes(), static[1])
                return self.send(404, {'error': 'Not found.'})
            except (ValueError, OSError, KeyError) as error:
                return self.send(400, {'error': str(error)})

        def do_POST(self):
            if not self.allowed() or self.headers.get('X-Reader-Request') != '1':
                return self.send(403, {'error': 'Same-origin review request required.'})
            if self.path not in ('/api/decisions', '/api/drafts'):
                return self.send(404, {'error': 'Not found.'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 16384 or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                    raise ValueError('Use a JSON review note smaller than 16 KiB.')
                value = json.loads(self.rfile.read(length))
                return self.send(200, reader.draft.update(value) if self.path == '/api/drafts' else reader.update(value))
            except FileExistsError as error:
                return self.send(409, {'error': str(error)})
            except (ValueError, TypeError, OSError) as error:
                return self.send(400, {'error': str(error)})

    return ThreadingHTTPServer(('127.0.0.1', port), Handler)


def launch(root, review_path):
    """Start or reuse a local workbench; no browser commands or model credentials."""
    root = Path(root).resolve()
    reader = ReviewReader(root, review_path)
    runtime = root / 'runtime'
    runtime.mkdir(exist_ok=True)
    for record in runtime.glob('c2-reader-*.json'):
        try:
            value = json.loads(record.read_text(encoding='utf-8'))
            if (value.get('reader_revision') != reader_revision() or value.get('review_sha256') != reader.review_sha or value.get('review_path') != str(reader.path)
                    or type(value.get('port')) is not int):
                continue
            url = f"http://127.0.0.1:{value['port']}"
            with urllib.request.urlopen(url + '/api/health', timeout=1) as response:
                health = json.load(response)
            if health == {'app': 'financebuddy-review-reader', 'review_sha256': reader.review_sha}:
                return {**value, 'url': url, 'reused': True}
        except (ValueError, OSError, urllib.error.URLError):
            continue
    receipt = runtime / f'c2-reader-{uuid.uuid4().hex}.json'
    log = runtime / 'c2-reader.log'
    with log.open('ab') as errors:
        process = subprocess.Popen([sys.executable, '-u', str(Path(__file__).resolve()), '--review', str(reader.path), '--receipt', str(receipt)],
                                   cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    for _ in range(80):
        if receipt.exists():
            value = json.loads(receipt.read_text(encoding='utf-8'))
            return {**value, 'url': f"http://127.0.0.1:{value['port']}", 'reused': False}
        if process.poll() is not None:
            raise ValueError('Reader startup failed; inspect runtime/c2-reader.log.')
        time.sleep(.1)
    raise ValueError('Reader startup is still pending; inspect runtime/ before retrying.')


def reader_revision():
    return hashlib.sha256(Path(__file__).read_bytes() + Path(__file__).with_name('review_suggestions.py').read_bytes()).hexdigest()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--review', required=True)
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--receipt')
    args = parser.parse_args()
    reader = ReviewReader(ROOT, args.review)
    server = make_server(reader, args.port)
    receipt = {'port': server.server_port, 'pid': os.getpid(), 'review_sha256': reader.review_sha, 'review_path': str(reader.path), 'reader_revision': reader_revision()}
    if args.receipt:
        path = Path(args.receipt).resolve()
        if not path.is_relative_to(ROOT / 'runtime'):
            raise ValueError('Startup receipt must be under workspace runtime/.')
        path.write_text(json.dumps(receipt) + '\n', encoding='utf-8')
    print(json.dumps({**receipt, 'url': f'http://127.0.0.1:{server.server_port}'}), flush=True)
    server.serve_forever()
