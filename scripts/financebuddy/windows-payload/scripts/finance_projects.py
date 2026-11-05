"""Local FinanceBuddy projects with immutable, reusable report versions."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import uuid

from consistency_semantic import write_json

SLOTS = ('esg_zh', 'esg_en', 'annual_zh', 'annual_en')


def stamp(): return datetime.now(timezone.utc).isoformat()
def sha(raw): return hashlib.sha256(raw).hexdigest()


@contextmanager
def locked(folder, filename='write.lock'):
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / filename
    try: fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError: raise ValueError('另一個視窗正在儲存，請稍後重試。') from None
    try: yield
    finally: os.close(fd); path.unlink(missing_ok=True)


class Projects:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.base = self.root / 'runtime/finance-projects'

    def folder(self, project_id):
        if not isinstance(project_id, str) or not re.fullmatch(r'[a-f0-9]{32}', project_id):
            raise ValueError('項目編號無效。')
        return self.base / project_id

    def read(self, project_id):
        folder = self.folder(project_id)
        value = json.loads((folder/'project.json').read_text(encoding='utf-8'))
        if value['id'] != project_id: raise ValueError('項目版本不符。')
        # These summaries are derived locally. Keep legacy run IDs and snapshots
        # intact, while routing each workflow to its own saved result.
        for version in value['versions']:
            version['reviews'] = []
            for run in version['runs']:
                if not re.fullmatch(r'\d{8}T\d{6}-[a-f0-9]{8}', run): continue
                snapshot = self.root/'outputs/consistency'/run
                if not (snapshot/'report.json').is_file(): continue
                try:
                    marker = snapshot/'workflow.json'
                    kind = json.loads(marker.read_text(encoding='utf-8'))['kind'] if marker.exists() else 'consistency'
                    # Older C2 runs predate the explicit workflow marker.
                    if (snapshot/'c2-state.json').exists(): kind = 'c2'
                    if kind not in ('consistency', 'c2'): continue
                    if kind == 'c2':
                        from c2_disclosure import read_state
                    else:
                        from consistency_semantic import read_state
                    state = read_state(snapshot) or {}
                    reused = state.get('reused_run_id')
                    if kind == 'consistency' and reused:
                        if not re.fullmatch(r'\d{8}T\d{6}-[a-f0-9]{8}', reused): raise ValueError('Invalid reused run')
                        state = read_state(self.root/'outputs/consistency'/reused) or {'status':'failed'}
                    status = state.get('status', 'not_started')
                    if status not in ('not_started', 'running', 'completed', 'partial', 'failed'): status = 'failed'
                    summary={'run_id':run,'kind':kind,'status':status}
                    if not (snapshot/'manifest.json').exists():
                        version['reviews'].append(summary)
                        continue
                    raw=(snapshot/'report.json').read_bytes()
                    manifest=json.loads((snapshot/'manifest.json').read_text(encoding='utf-8'))
                    if sha(raw)!=manifest['report_sha256']:raise ValueError('Review changed')
                    base=json.loads(raw)
                    history=base.get('history',{})
                    extra=snapshot/'history-supplement.json'
                    if extra.exists():
                        supplement=json.loads(extra.read_text(encoding='utf-8'))
                        if supplement['base_sha256']!=manifest['report_sha256']:raise ValueError('Supplement changed')
                        current={d['slot'] for d in base['documents'] if d['slot'] in SLOTS}
                        supplied={d['slot'] for d in supplement['documents']}
                        history={'status':'ready','fiscal_year':supplement['fiscal_year'],'missing_slots':['prior_'+s for s in current if 'prior_'+s not in supplied]}
                    task=next((t for t in state.get('tasks',[]) if t['id']=='restatement'),{})
                    version['reviews'].append({**summary,
                        'history_status':history.get('status','not_requested'),'history_year':history.get('fiscal_year',''),
                        'missing_history_slots':history.get('missing_slots',[]),'restatement_status':task.get('status','not_started')})
                except (ValueError, KeyError, OSError):
                    continue
        return value

    def list(self):
        projects = [self.read(p.parent.name) for p in self.base.glob('*/project.json')]
        return {'projects': sorted(projects, key=lambda p:p['updated_at'], reverse=True)}

    def workspace(self, project_id):
        # Gateway-only receipt: the renderer never supplies a project directory.
        return {'project': self.read(project_id), 'root_path': str(self.folder(project_id).resolve())}

    def peers(self, project_id, expected_revision, companies):
        if not isinstance(companies, list) or len(companies) > 8:
            raise ValueError('每次最多八間同行公司。')
        normalized, seen = [], set()
        for company in companies:
            if not isinstance(company, dict) or set(company) - {'name', 'stock_code'}:
                raise ValueError('同行資料格式無效。')
            if not isinstance(company.get('name'), str) or not isinstance(company.get('stock_code', ''), str):
                raise ValueError('公司名稱及代號須為文字。')
            name = company['name'].strip()
            code = company.get('stock_code', '').strip()
            if not 1 <= len(name) <= 100 or any(ord(c) < 32 or ord(c) == 127 for c in name):
                raise ValueError('請填寫公司名稱，最多100字。')
            if code and not re.fullmatch(r'[A-Za-z0-9.:-]{1,20}', code):
                raise ValueError('公司代號格式無效。')
            identities = {'name:' + re.sub(r'\s+', '', name).casefold()}
            if code: identities.add('code:' + code.casefold())
            if identities & seen: raise ValueError('同行公司重複。')
            seen.update(identities)
            normalized.append({'name': name, **({'stock_code': code} if code else {})})
        with locked(self.folder(project_id)):
            project = self.read(project_id)
            if project['revision'] != expected_revision:
                raise ValueError('項目已在另一視窗更新，請重新載入。')
            project['peer_companies'] = normalized
            project['revision'] += 1; project['updated_at'] = stamp()
            write_json(self.folder(project_id)/'project.json', project)
            return self.read(project_id)

    def report_source(self, project_id, version_id, slot):
        if slot not in SLOTS: raise ValueError('報告種類無效。')
        project = self.read(project_id)
        version = next((v for v in project['versions'] if v['id'] == version_id), None)
        if not version: raise ValueError('找不到此報告版本。')
        document = next((d for d in version['documents'] if d['slot'] == slot), None)
        if not document: raise ValueError('此版本未有這份報告，請選已上載文件。')
        source = self.folder(project_id)/'versions'/version_id/(slot+'.pdf')
        data = source.read_bytes()
        if sha(data) != document['sha256']: raise ValueError('項目原件已改動，請重新上載。')
        return project, version, document, data

    def bind(self, project_id, external_id):
        if not isinstance(external_id, str) or not 1 <= len(external_id) <= 180:
            raise ValueError('Cuby 項目編號無效。')
        with locked(self.folder(project_id)):
            project = self.read(project_id)
            if project.get('external_id') == external_id: return project
            if project.get('external_id'): raise ValueError('此報告已連結另一個 Cuby 項目。')
            project['external_id'] = external_id
            project['revision'] += 1
            write_json(self.folder(project_id)/'project.json', project)
            return self.read(project_id)

    def create(self, title, external_id=None):
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 100:
            raise ValueError('請填寫項目名稱。')
        if external_id is not None and (not isinstance(external_id,str) or len(external_id)>180):
            raise ValueError('Cuby 項目編號無效。')
        with locked(self.base):
            if external_id:
                existing = next((p for p in self.list()['projects'] if p.get('external_id') == external_id), None)
                if existing: return existing
            pid = uuid.uuid4().hex
            value = {'id':pid, 'title':title.strip(), 'external_id':external_id,
                     'revision':0, 'versions':[], 'latest_run':None, 'created_at':stamp(), 'updated_at':stamp()}
            folder = self.folder(pid); folder.mkdir()
            write_json(folder/'project.json', value)
            return value

    def save(self, project_id, expected_revision, fiscal_year, documents=None, run_id=None):
        from report_consistency_bundle import resolve_sources, load
        if not re.fullmatch(r'20\d{2}/\d{2}', fiscal_year): raise ValueError('財年格式應為 2025/26。')
        folder = self.folder(project_id)
        with locked(folder):
            project = self.read(project_id)
            if project['revision'] != expected_revision: raise ValueError('項目已在另一視窗更新，請重新載入。')
            if run_id:
                run_folder, report, manifest = load(self.root, run_id)
                if report['fiscal_year'] != fiscal_year: raise ValueError('財年與核對版本不符。')
                sources = {d['slot']:run_folder/(d['slot']+'.pdf') for d in report['documents'] if d['slot'] in SLOTS}
                names = {d['slot']:d['file_name'] for d in report['documents'] if d['slot'] in SLOTS}
            else:
                sources = resolve_sources(self.root, documents, fiscal_year)
                names = {d['slot']:d.get('file_name') or Path(d['path']).name for d in documents} if documents else {s:p.name for s,p in sources.items()}
                if any(not isinstance(n,str) or len(n)>200 or '/' in n or '\\' in n for n in names.values()):raise ValueError('文件名稱無效。')
                # Adding a translation later creates a new immutable version,
                # retaining the other documents from this fiscal year.
                active=next((v for v in project['versions'] if v['id']==project.get('active_version') and v['fiscal_year']==fiscal_year),None)
                if documents and active:
                    for doc in active['documents']:
                        if doc['slot'] in sources:continue
                        existing=folder/'versions'/active['id']/(doc['slot']+'.pdf')
                        if sha(existing.read_bytes())!=doc['sha256']:raise ValueError('項目原件已改動，請重新上載。')
                        sources[doc['slot']]=existing;names[doc['slot']]=doc['file_name']
            raw = {s:p.read_bytes() for s,p in sources.items()}
            # Bind new inspected uploads to the exact bytes captured for this version,
            # including changes that occur after the gateway's earlier validation.
            for doc in documents or []:
                expected=doc.get('expected_sha256')
                if expected is not None and (not re.fullmatch(r'[a-f0-9]{64}',str(expected)) or sha(raw[doc['slot']])!=expected):
                    raise ValueError('文件在辨認後已變更，請重新加入；未儲存新版本。')
            import pymupdf
            for data in raw.values():
                if len(data)>30*1024*1024:raise ValueError('每份 PDF 上限30 MB。')
                with pymupdf.open(stream=data,filetype='pdf') as pdf:
                    if pdf.needs_pass or not 1<=len(pdf)<=300:raise ValueError('PDF 須為未加密文件，最多300頁。')
            hashes = {s:sha(data) for s,data in raw.items()}
            same = next((v for v in project['versions'] if v['fiscal_year']==fiscal_year and {d['slot']:d['sha256'] for d in v['documents']}==hashes), None)
            if same:
                project['active_version'] = same['id']
            else:
                vid = uuid.uuid4().hex
                dest = folder/'versions'/vid; dest.mkdir(parents=True)
                for slot,data in raw.items(): (dest/(slot+'.pdf')).write_bytes(data)
                version = {'id':vid, 'fiscal_year':fiscal_year, 'created_at':stamp(),
                           'documents':[{'slot':s, 'file_name':names[s], 'sha256':hashes[s], 'bytes':len(raw[s])} for s in SLOTS if s in raw],
                           'runs':[]}
                project['versions'].append(version);project['active_version']=vid
            if run_id:
                version = next(v for v in project['versions'] if v['id']==project['active_version'])
                if run_id not in version['runs']: version['runs'].append(run_id)
                project['latest_run'] = run_id
            project['revision'] += 1;project['updated_at']=stamp()
            write_json(folder/'project.json',project)
            return self.read(project_id)

    def build(self, project_id, version_id, comparisons, kind='consistency'):
        from report_consistency_bundle import build
        if kind not in ('consistency', 'c2'): raise ValueError('檢查種類無效。')
        folder = self.folder(project_id)
        # Hold the lock so a replaced document set cannot be mistaken for this run.
        with locked(folder):
            project = self.read(project_id)
            version = next((v for v in project['versions'] if v['id']==version_id), None)
            if not version: raise ValueError('找不到此報告版本。')
            documents = []
            for doc in version['documents']:
                source = folder/'versions'/version_id/(doc['slot']+'.pdf')
                if sha(source.read_bytes())!=doc['sha256']: raise ValueError('項目原件已改動，請重新上載。')
                documents.append({'slot':doc['slot'],'path':str(source),'file_name':doc['file_name']})
            report=build(self.root,version['fiscal_year'],documents,comparisons)
            write_json(self.root/'outputs/consistency'/report['run_id']/'workflow.json', {'kind':kind})
            version['runs'].append(report['run_id']);project['latest_run']=report['run_id']
            project['revision']+=1;project['updated_at']=stamp()
            write_json(folder/'project.json',project)
            return {'project':self.read(project_id),'report':report}

    def manage(self, operation, **kwargs):
        functions={'list':self.list,'create':self.create,'save':self.save,'build':self.build,'read':self.read,'workspace':self.workspace,'bind':self.bind,'peers':self.peers,'supplement':self.supplement}
        if operation not in functions: raise ValueError('不支援此項目操作。')
        return functions[operation](**kwargs)

    def supplement(self, project_id, run_id, documents, confirmed, retry=False):
        project=self.read(project_id)
        if not any(run_id in v['runs'] for v in project['versions']):raise ValueError('此審閱不屬於本項目。')
        from consistency_recovery import supplement
        report=supplement(self.root,run_id,documents,confirmed,retry)
        return {'project':self.read(project_id),'report':report}
