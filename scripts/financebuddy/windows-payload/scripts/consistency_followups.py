"""User-entered evidence follow-up, separate from PDF/editor decisions.

An evidence reference is an attribution entered by the user. This module neither
fetches that reference nor authenticates the named owner/reviewer.
"""
from contextlib import contextmanager
import copy
import csv
from datetime import date, datetime, timezone
import hashlib
from io import StringIO
import json
import os
from pathlib import Path
import re
import tempfile
import time

from finance_projects import Projects, locked, SLOTS
from report_consistency_bundle import load

SCHEMA = 'financebuddy-followups-1'
STATUSES = {'awaiting', 'received_pending_review', 'verified', 'reopened'}
OPERATIONS = {'save', 'receive', 'verify', 'reopen'}


class FollowupConflict(ValueError):
    """A fresh explicit reload is required; existing bytes must remain intact."""


def digest(value):
    if not isinstance(value, bytes):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(value).hexdigest()


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def text(value, name, limit, required=False, multiline=False):
    if not isinstance(value, str): raise ValueError(name + '須為文字。')
    value = value.strip()
    if (required and not value) or len(value.encode('utf-16-le')) // 2 > limit:
        raise ValueError(name + '未填寫或過長。')
    if any((ord(c) < 32 and (not multiline or c not in '\n\r\t')) or ord(c) == 127 for c in value):
        raise ValueError(name + '包含無效字元。')
    return value


def fields(owner, due_date, evidence_reference, note):
    if due_date is not None:
        if not isinstance(due_date, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', due_date):
            raise ValueError('期限須為 YYYY-MM-DD 或留空。')
        try: date.fromisoformat(due_date)
        except ValueError: raise ValueError('期限日期無效。') from None
    return {'owner': text(owner, '負責人', 100, True), 'due_date': due_date,
            'evidence_reference': text(evidence_reference, '證據參考', 1000),
            'note': text(note, '跟進備註', 2000, multiline=True)}


@contextmanager
def write_lock(folder, filename):
    deadline = time.monotonic() + 5
    while True:
        guard = locked(folder, filename)
        try: guard.__enter__(); break
        except (ValueError, PermissionError):
            if time.monotonic() >= deadline: raise FollowupConflict('另一個視窗正在儲存，請重新載入。') from None
            time.sleep(.02)
    try: yield
    finally: guard.__exit__(None, None, None)


class Followups:
    def __init__(self, root, project_id, version_id, run_id):
        self.root = Path(root).resolve()
        if not isinstance(project_id, str) or not re.fullmatch(r'[a-f0-9]{32}', project_id): raise ValueError('項目編號無效。')
        if not isinstance(version_id, str) or not re.fullmatch(r'[a-f0-9]{32}', version_id): raise ValueError('文件版本編號無效。')
        if not isinstance(run_id, str) or not re.fullmatch(r'\d{8}T\d{6}-[a-f0-9]{8}', run_id): raise ValueError('審閱編號無效。')
        self.project_id, self.version_id, self.run_id = project_id, version_id, run_id
        self.project_folder = Projects(self.root).folder(project_id)
        self.folder = self.root / 'outputs/consistency' / run_id
        self.path = self.folder / 'followups' / project_id / (version_id + '.json')

    def membership(self):
        # Read the persisted membership directly: derived review summaries are unnecessary.
        project = json.loads((self.project_folder / 'project.json').read_text(encoding='utf-8'))
        if project.get('id') != self.project_id: raise FollowupConflict('項目識別已改變，請重新載入。')
        matches = [v for v in project['versions'] if v['id'] == self.version_id]
        if len(matches) != 1 or self.run_id not in matches[0]['runs']:
            raise FollowupConflict('此審閱不屬於所選項目的文件版本。')
        return matches[0]

    def current(self):
        version = self.membership()
        try:
            folder, report, manifest = load(self.root, self.run_id)
            if folder != self.folder or report['run_id'] != self.run_id or report['fiscal_year'] != version['fiscal_year']:
                raise FollowupConflict('審閱與文件版本不符。')
            sources = manifest['sources']
            docs = {d['slot']: d for d in report['documents']}
            version_docs = {d['slot']: d for d in version['documents']}
            if len(docs) != len(report['documents']) or len(version_docs) != len(version['documents']) or set(docs) != set(sources):
                raise FollowupConflict('原件資料不完整或重複。')
            if {s for s in sources if s in SLOTS} != set(version_docs):
                raise FollowupConflict('審閱原件與所選文件版本不同。')
            for slot, sha in sources.items():
                if not re.fullmatch(r'(?:prior_)?(?:esg|annual)_(?:zh|en)', slot) or not re.fullmatch(r'[a-f0-9]{64}', sha):
                    raise FollowupConflict('來源識別無效。')
                if docs[slot].get('sha256', sha) != sha or digest((folder / (slot + '.pdf')).read_bytes()) != sha:
                    raise FollowupConflict('審閱原件已改變。')
                if slot in version_docs:
                    raw = (self.project_folder / 'versions' / self.version_id / (slot + '.pdf')).read_bytes()
                    if version_docs[slot]['sha256'] != sha or digest(raw) != sha or len(raw) != version_docs[slot]['bytes']:
                        raise FollowupConflict('項目原件已改變。')
            issues, fingerprints = {}, {}
            for check in report['checks']:
                check_id = text(check['id'], '問題編號', 180, True)
                if check_id in fingerprints: raise FollowupConflict('問題編號重複，不能唯一連結。')
                refs = []
                for ref in check.get('refs', []):
                    if ref['slot'] not in sources or type(ref['page']) is not int or not 1 <= ref['page'] <= docs[ref['slot']]['page_count']:
                        raise FollowupConflict('問題引用的原頁無效。')
                    refs.append({k: v for k, v in ref.items() if k != 'highlight_texts'} | {'source_sha256': sources[ref['slot']]})
                identity = {k: check.get(k) for k in ('id', 'category', 'status', 'review_state', 'title', 'reason', 'regulatory', 'recommendation')}
                identity['refs'] = refs
                fingerprints[check_id] = digest(identity)
                if check.get('review_state') in ('difference', 'needs_confirmation') and check['category'] != 'page_numbers':
                    issues[check_id] = {'check_id': check_id, 'issue_sha256': fingerprints[check_id], 'title': check['title'],
                                        'category': check['category'], 'refs': refs}
            review_sha = digest({'checks': fingerprints, 'history': report.get('history'), 'comparisons': report.get('comparisons')})
            binding = {'project_id': self.project_id, 'version_id': self.version_id, 'run_id': self.run_id,
                       'fiscal_year': version['fiscal_year'], 'version_documents': version['documents'],
                       'base_report_sha256': manifest['report_sha256'], 'review_sha256': review_sha, 'source_sha256': sources}
            state = {k: binding[k] for k in ('project_id', 'version_id', 'run_id', 'base_report_sha256', 'review_sha256', 'source_sha256')}
            return {**state, 'schema_version': SCHEMA, 'binding_status': 'current', 'binding_sha256': digest(binding),
                    'revision': 0, 'issues': issues, 'records': {}, 'history': []}, report
        except FollowupConflict: raise
        except (ValueError, KeyError, OSError, TypeError) as error:
            raise FollowupConflict('審閱或來源已改變，請重新載入；舊跟進紀錄保留。') from error

    def stored(self):
        if not self.path.exists(): return None
        value = json.loads(self.path.read_text(encoding='utf-8'))
        if value.get('schema_version') != SCHEMA or any(value.get(k) != getattr(self, k) for k in ('project_id', 'version_id', 'run_id')):
            raise FollowupConflict('跟進紀錄與所選項目／版本不符。')
        if type(value.get('revision')) is not int or value['revision'] < 0 or len(value['history']) != value['revision']:
            raise FollowupConflict('跟進歷史版本無效，原紀錄保留。')
        replay = {}
        for revision, event in enumerate(value['history'], 1):
            key, record = event['check_id'], event['record']
            if event['revision'] != revision or event['previous'] != replay.get(key) or record['check_id'] != key or record['status'] not in STATUSES:
                raise FollowupConflict('跟進歷史不一致，原紀錄保留。')
            if record['issue_sha256'] != value['issues'][key]['issue_sha256'] or fields(**{k: record[k] for k in ('owner', 'due_date', 'evidence_reference', 'note')}) != {k: record[k] for k in ('owner', 'due_date', 'evidence_reference', 'note')}:
                raise FollowupConflict('跟進資料無效，原紀錄保留。')
            if record['status'] == 'verified' and (not record['evidence_reference'] or not record['reviewer'] or not record['verified_at']):
                raise FollowupConflict('核實紀錄缺少證據、核實人或時間。')
            if record['status'] == 'received_pending_review' and not record['evidence_reference']:
                raise FollowupConflict('已收到紀錄缺少證據參考；原紀錄保留，不能當作目前收件。')
            replay[key] = record
        if replay != value['records']: raise FollowupConflict('跟進現況與歷史不同。')
        return value

    def read(self, history_only=False):
        if type(history_only) is not bool: raise ValueError('歷史模式無效。')
        if history_only:
            self.membership()
            value = self.stored()
            if value is None: raise ValueError('此版本尚未有跟進歷史。')
            return {**value, 'binding_status': 'historical_unvalidated'}
        current, _ = self.current()
        value = self.stored()
        if value is not None and value['binding_sha256'] != current['binding_sha256']:
            raise FollowupConflict('來源或問題版本已改變，不能把舊核實當作目前結果；舊歷史保留。')
        return {**(value or current), 'binding_status': 'current'}

    def publish(self, value):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        name = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent, prefix='.followups-', suffix='.tmp', delete=False) as stream:
                name = stream.name
                json.dump(value, stream, ensure_ascii=False, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
            os.replace(name, self.path)
        finally:
            if name is not None: Path(name).unlink(missing_ok=True)

    def update(self, check_id, expected_revision, expected_binding_sha256, followup_operation, owner, due_date, evidence_reference, note, reviewer=None):
        if followup_operation not in OPERATIONS: raise ValueError('跟進操作無效。')
        if reviewer is not None and followup_operation != 'verify': raise ValueError('只有明確核實操作可填寫核實人。')
        entered = fields(owner, due_date, evidence_reference, note)
        # Validate before locks: a misspelled context cannot create a project/run directory.
        self.current()
        with write_lock(self.project_folder, 'write.lock'), write_lock(self.folder, 'followups-write.lock'):
            value = self.read()
            if type(expected_revision) is not int or value['revision'] != expected_revision:
                raise FollowupConflict('跟進已在另一視窗更新，請重新載入。')
            if expected_binding_sha256 != value['binding_sha256']:
                raise FollowupConflict('所選來源版本已改變，請重新載入。')
            issue = value['issues'].get(check_id)
            if not issue: raise ValueError('此項不是可跟進的實際問題。')
            previous = value['records'].get(check_id)
            changed = previous is not None and any(previous[k] != entered[k] for k in entered)
            stamp = utc_now()
            record = {'check_id': check_id, 'issue_sha256': issue['issue_sha256'], **entered,
                      'status': previous['status'] if previous else 'awaiting', 'reviewer': None, 'verified_at': None, 'updated_at': stamp}
            if followup_operation == 'verify':
                if not previous or previous['status'] != 'received_pending_review' or changed:
                    raise ValueError('請先儲存並標示已收到證據，再另行核實；核實時不能同時修改資料。')
                if not entered['evidence_reference']: raise ValueError('核實需要證據參考。')
                record.update(status='verified', reviewer=text(reviewer, '核實人', 100, True), verified_at=stamp)
            elif previous and previous['status'] == 'verified':
                if changed or followup_operation == 'reopen': record['status'] = 'reopened'
                elif followup_operation == 'receive': raise ValueError('已核實項目須先重新開啟。')
                else: return value
            elif followup_operation == 'receive':
                if not entered['evidence_reference']: raise ValueError('標示已收到需要證據參考。')
                record['status'] = 'received_pending_review'
            elif followup_operation == 'reopen':
                if not previous: raise ValueError('尚未有可重新開啟的紀錄。')
                record['status'] = 'reopened'
            elif previous and previous['status'] == 'received_pending_review' and entered['evidence_reference'] != previous['evidence_reference']:
                # A prior receipt cannot describe a cleared or replaced reference.
                record['status'] = 'reopened'
            if previous and not changed and record['status'] == previous['status'] and followup_operation == 'save': return value
            updated = copy.deepcopy(value); updated['revision'] += 1
            updated['records'][check_id] = record
            updated['history'].append({'revision': updated['revision'], 'check_id': check_id, 'operation': followup_operation,
                                       'at': stamp, 'previous': previous, 'record': record})
            latest, _ = self.current()
            if latest['binding_sha256'] != value['binding_sha256']:
                raise FollowupConflict('儲存前來源已改變，未覆寫原跟進。')
            self.publish(updated)
            return updated

    def export(self, expected_revision, expected_binding_sha256, check_ids=None):
        value = self.read(); _, report = self.current()
        if type(expected_revision) is not int or value['revision'] != expected_revision or value['binding_sha256'] != expected_binding_sha256:
            raise FollowupConflict('跟進或來源已更新，請重新載入再匯出。')
        if check_ids is None: check_ids = list(value['records'])
        if not isinstance(check_ids, list) or len(check_ids) > 1000 or len(set(check_ids)) != len(check_ids) or any(i not in value['issues'] for i in check_ids):
            raise ValueError('匯出問題清單無效。')
        checks = {c['id']: c for c in report['checks']}
        columns = ['項目', '條款', '義務', '結果', '原因', '補充建議', '缺少要素', '規則頁碼', '原文與頁碼',
                   '補料要求', '問題ID', '項目ID', '文件版本ID', '審閱ID', '來源SHA256', '負責人', '期限', '證據參考', '跟進備註', '跟進狀態', '跟進狀態代碼', '核實人', '核實時間', '跟進修訂', '變更歷史']
        buffer = StringIO(newline=''); writer = csv.writer(buffer, lineterminator='\r\n'); writer.writerow(columns)
        labels = {'matched': '已核對一致', 'difference': '發現差異', 'needs_confirmation': '待確認', 'not_checked': '未檢查'}
        regulatory_labels = {'not_reviewed': '尚未核對', 'disclosed': '有披露證據', 'partially_disclosed': '披露未完整', 'not_located': '未找到披露', 'conflict': '與條款有直接衝突', 'explanation_claim': '有解釋，待核實', 'not_applicable': '有不適用依據', 'applicability_pending': '適用性待確認', 'external_evidence_needed': '需補外部資料'}
        status_labels = {'awaiting': '等待補料', 'received_pending_review': '已收到，待覆核', 'verified': '已核實', 'reopened': '重新開啟'}
        for key in check_ids:
            check = checks[key]; regulatory = check.get('regulatory') or {}; record = value['records'].get(key, {})
            request = (check.get('reader_copy') or {}).get('next_step') or regulatory.get('action') or check['reason']
            result_label = regulatory_labels.get(regulatory.get('outcome'), '') if regulatory else labels.get(check['review_state'], check['review_state'])
            row = [check['title'], regulatory.get('clause', check['category']), regulatory.get('obligation', ''), result_label, check['reason'], regulatory.get('action', ''), '；'.join(regulatory.get('missing_elements', [])), regulatory.get('rule_page', ''), check['refs'], request, key, self.project_id, self.version_id, self.run_id, {r['slot']: r['source_sha256'] for r in value['issues'][key]['refs']}, record.get('owner', ''), record.get('due_date'), record.get('evidence_reference', ''), record.get('note', ''), status_labels.get(record.get('status'), ''), record.get('status', ''), record.get('reviewer'), record.get('verified_at'), value['revision'], [h for h in value['history'] if h['check_id'] == key]]
            def cell(item):
                s = json.dumps(item, ensure_ascii=False, separators=(',', ':')) if isinstance(item, (dict, list)) else '' if item is None else str(item)
                return "'" + s if s.lstrip().startswith(('=', '+', '-', '@', '\t', '\r')) else s
            writer.writerow([cell(item) for item in row])
        # An export cannot silently mix rows with another saved revision.
        latest = self.read()
        if latest['revision'] != value['revision'] or latest['binding_sha256'] != value['binding_sha256']:
            raise FollowupConflict('匯出期間跟進已更新，請重試。')
        return {'file_name': 'FinanceBuddy-followups-' + report['fiscal_year'].replace('/', '-') + '.csv',
                'mime': 'text/csv;charset=utf-8', 'text': '\ufeff' + buffer.getvalue(), 'revision': value['revision'], 'binding_sha256': value['binding_sha256']}


def manage(root, run_id, command, project_id, version_id, **kwargs):
    service = Followups(root, project_id, version_id, run_id)
    methods = {'read': service.read, 'update': service.update, 'export': service.export}
    if command not in methods: raise ValueError('跟進操作無效。')
    return methods[command](**kwargs)
