"""Supplement historical sources without changing a review's original snapshot."""
import copy
import hashlib
import json
from pathlib import Path
import re
import shutil
import uuid

import pymupdf


def sha(raw): return hashlib.sha256(raw).hexdigest()


def apply_history(folder, report, manifest):
    path = folder/'history-supplement.json'
    if not path.exists(): return report, manifest
    value = json.loads(path.read_text(encoding='utf-8'))
    if value['base_sha256'] != manifest['report_sha256']: raise ValueError('補交文件與審閱版本不符。')
    from report_consistency_bundle import extract_facts, restatement_checks, SLOTS
    report, manifest = copy.deepcopy(report), copy.deepcopy(manifest)
    facts, texts = {}, {}
    for doc in [*report['documents'], *value['documents']]:
        slot = doc['slot']
        if slot in facts: raise ValueError('補交文件位置重複。')
        raw = (folder/(slot+'.pdf')).read_bytes()
        if sha(raw) != doc['sha256']: raise ValueError('補交文件或原件已改動，請重新開啟審閱。')
        with pymupdf.open(stream=raw, filetype='pdf') as pdf:
            texts[slot] = [p.get_text(sort=True) for p in pdf]
            facts[slot], _ = extract_facts(slot.removeprefix('prior_'), pdf, value['fiscal_year'] if slot.startswith('prior_') else report['fiscal_year'])
            for fact in facts[slot].values(): fact['ref']['slot'] = slot
    report['documents'] += value['documents']
    for doc in value['documents']: manifest['sources'][doc['slot']] = doc['sha256']
    manifest['history_recovery_revision'] = value['revision']
    report['history'] = {'status':'ready', 'source':'項目補交文件', 'fiscal_year':value['fiscal_year'],
                         'missing_slots':['prior_'+s for s in SLOTS if s in facts and 'prior_'+s not in facts]}
    report['checks'] = [c for c in report['checks'] if c['category'] != 'restatement']
    report['checks'] += restatement_checks(facts, texts, value['fiscal_year'])
    for slot in report['history']['missing_slots']:
        report['checks'].append({'id':'historical-missing-'+slot, 'category':'restatement', 'status':'pending',
            'review_state':'not_checked', 'title':'欠去年'+SLOTS[slot[6:]][0], 'reason':'未補交相同種類及語言的上年度報告，這部分未能核對。', 'refs':[]})
    report['coverage']['historical_pages'] = sum(d['page_count'] for d in report['documents'] if d['slot'].startswith('prior_'))
    report['coverage']['restatement_checks'] = sum(c['category']=='restatement' for c in report['checks'])
    return report, manifest


def supplement(root, run_id, documents, confirmed, retry=False):
    from report_consistency_bundle import load, previous_year, resolve_sources, SLOTS
    from consistency_semantic import read_state, checkpoint_jobs, write_json, now, VERSION
    from finance_projects import locked
    folder, report, manifest = load(root, run_id)
    if report.get('compliance') or 'restatement' not in report['comparisons']:
        raise ValueError('請在已選跨年比較的一致性審閱補交去年文件。')
    if read_state(folder) and report.get('semantic',{}).get('status') == 'running':
        raise ValueError('內文核對進行中，請完成後再補交。')
    if type(confirmed) is not bool or not confirmed: raise ValueError('請確認這是本項目的上年度報告。')
    if not isinstance(documents,list) or not 1 <= len(documents) <= 4: raise ValueError('請選1至4份去年報告。')
    year = previous_year(report['fiscal_year'])
    sources = resolve_sources(Path(root),documents,year)
    existing_path = folder/'history-supplement.json'
    existing = json.loads(existing_path.read_text(encoding='utf-8')) if existing_path.exists() else None
    added, raw_files, seen = [], {}, set()
    current_slots = {d['slot'] for d in report['documents'] if d['slot'] in SLOTS}
    originals = json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
    for document in documents:
        slot = document.get('slot')
        if slot not in current_slots or slot in seen: raise ValueError('請選與本年文件對應的種類及語言，每個位置一份。')
        seen.add(slot); prior = 'prior_'+slot
        raw = sources[slot].read_bytes()
        if not raw or len(raw)>30*1024*1024: raise ValueError('每份 PDF 上限30 MB。')
        name = document.get('file_name') or Path(document['path']).name
        if not isinstance(name,str) or len(name)>200 or Path(name).name!=name or '/' in name or '\\' in name: raise ValueError('文件名稱無效。')
        with pymupdf.open(stream=raw,filetype='pdf') as pdf:
            if pdf.needs_pass or not 1<=len(pdf)<=300: raise ValueError('去年 PDF 須未加密，最多300頁。')
            pages = [p.get_text(sort=True) for p in pdf]
            if not any(year in text or year.replace('/', '-') in text for text in pages[:3]):
                raise ValueError(f'{name}：封面未能確認 FY{year}，請選正確年度的報告。')
            doc = {'slot':prior,'label':'去年 '+SLOTS[slot][0]+' · FY'+year,'file_name':name,'sha256':sha(raw),
                'page_count':len(pdf),'cover_year_found':True,'identity_confirmed':True,'fiscal_year':year,
                'authority':'User supplied for this project; entity/year confirmation recorded, not a WeKnora attestation.',
                'textless_pages':[i+1 for i,t in enumerate(pages) if not t.strip()]}
        if prior in originals['sources']: raise ValueError('本審閱已有已核實的去年原件，不會替換。')
        prior_path = folder/(prior+'.pdf')
        if prior_path.exists() and sha(prior_path.read_bytes()) != doc['sha256']:
            raise ValueError('此位置已有另一份去年原件；請另開審閱，避免替換既有來源。')
        added.append(doc); raw_files[prior] = raw
    with locked(folder,'semantic-start.lock'), locked(folder/'history-recovery-lock'):
        if read_state(folder) and read_state(folder).get('status')=='running': raise ValueError('核對進行中，請稍後再補交。')
        # Another browser may have supplemented documents since this request began.
        latest = json.loads(existing_path.read_text(encoding='utf-8')) if existing_path.exists() else None
        if (latest or {}).get('revision') != (existing or {}).get('revision'): raise ValueError('文件已在另一視窗更新，請重新載入。')
        prior_docs = {d['slot']:d for d in (existing or {}).get('documents',[])}
        prior_docs.update({d['slot']:d for d in added})
        for slot, raw in raw_files.items():
            dest=folder/(slot+'.pdf')
            if not dest.exists(): dest.write_bytes(raw)
        value={'base_sha256':originals['report_sha256'],'fiscal_year':year,'revision':uuid.uuid4().hex,
               'confirmed_at':now(),'documents':list(prior_docs.values())}
        state=read_state(folder)
        if state:
            # A reused review receives its own checkpoints; never modify its origin.
            if state.get('reused_run_id'):
                origin=folder.parent/state['reused_run_id']; original_state=read_state(origin)
                for job in checkpoint_jobs(original_state):
                    for source in (origin/('semantic-'+job)).glob('*.json'):
                        if source.stem not in ('bilingual','cross_report','internal'): continue
                        dest=folder/('semantic-'+job);dest.mkdir(exist_ok=True)
                        shutil.copyfile(source,dest/source.name)
                state={**original_state,'base_sha256':originals['report_sha256']}
            frozen=[c for c in report['checks'] if c.get('semantic_kind') and c['semantic_kind']!='restatement']
            frozen_result={'version':VERSION,'base_sha256':originals['report_sha256'],'checks':frozen}
            write_json(folder/'semantic-result.json',frozen_result)
            state.pop('reused_run_id',None);state.pop('pid',None);state.pop('error',None)
            state.update(status='partial',history_revision=value['revision'],preserve_completed=True,
                result_sha256=sha((folder/'semantic-result.json').read_bytes()),updated_at=now(),gaps=[])
            for task in state['tasks']:
                if task['id']=='restatement': task.update(status='pending',submitted_pages=0);task.pop('error',None)
            state['completed_tasks']=sum(t['status']=='completed' for t in state['tasks'])
            state['findings_count']=sum(c['review_state']!='matched' for c in frozen)
            state['matched_count']=sum(c['review_state']=='matched' for c in frozen)
            # Original report, manifest and editor decisions remain byte-identical.
            write_json(folder/'semantic-state.json',state)
        write_json(existing_path,value)
    if retry:
        from consistency_semantic import start
        return start(root,run_id)
    return load(root,run_id)[1]
