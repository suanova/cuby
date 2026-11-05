"""Evidence-bounded reader findings and reversible text-draft edits."""
from datetime import datetime, timezone
import json
import os
import re
import uuid

LABELS = {'error': '明確問題', 'review': '待確認', 'suggestion': '改善建議', 'evidence': '已有資料'}
TEMPLATES = {
    'C2-28-S1': ('Scope 1 當期值待確認', 'Scope 1 direct emissions: 【待確認的當期數值】 tCO2e.'),
    'C2-28-S2': ('Scope 2 當期值待確認', 'Scope 2 indirect emissions: 【待確認的當期數值】 tCO2e.'),
    'C2-28-UNIT': ('排放單位待確認', 'Scope 1 direct emissions: 【待確認的當期數值】 tCO2e; 【待確認的比較年度數值】 tCO2e.'),
    'C2-28-PERIOD': ('報告期間待更新', 'This report covers the period from 【待確認開始日期】 to 【待確認結束日期】.'),
    'C2-28-GROSS': ('總排放口徑未說清楚', 'Scope 1 and Scope 2 are reported on an absolute gross basis, with 【待確認的抵銷及總量口徑說明】.'),
    'C2-29A': ('計量標準待確認', 'Scope 1 and Scope 2 emissions are measured using 【待確認的計量標準及版本】.'),
    'C2-29BI-APPROACH': ('計量方法不完整', 'Scope 1 emissions are calculated using 【待確認的計算方法】. Scope 2 emissions are calculated using 【待確認的計算方法】.'),
    'C2-29BI-INPUTS': ('計算輸入及假設待補', 'The calculation uses 【待確認的活動數據、排放因子、版本及範圍對應】. Key assumptions are 【待確認的假設】.'),
    'C2-29BII': ('未找到方法選擇原因', 'These methods, inputs and assumptions were selected because 【待確認的選擇原因】.'),
    'C2-29BIII': ('變更及原因待確認', 'Changes from the previous reporting period are 【待確認的變更或無變更聲明】, because 【待確認的原因及影響】.'),
    'C2-29C-BASIS': ('Scope 2 基準未說清楚', 'Location-based Scope 2 emissions for 【待確認年度】 were 【待確認的排放量】 tCO2e, calculated using 【待確認的電網因子及版本】.'),
    'C2-29C-CONTRACTS': ('合約資料適用性待確認', 'Contractual instruments relevant to Scope 2 emissions are 【待確認的合約資料或有依據的不適用說明】.'),
}


def span(text, quote):
    """Only one whitespace-normalized occurrence is replaceable; preserve raw offsets."""
    chars, offsets = [], []
    for i, char in enumerate(text):
        if not char.isspace(): chars.append(char); offsets.append(i)
    needle = ''.join(quote.split())
    if len(needle) < 12: return None
    matches = list(re.finditer(re.escape(needle), ''.join(chars)))
    if len(matches) != 1: return None
    m = matches[0]
    return offsets[m.start()], offsets[m.end() - 1] + 1


def blank_current_cell(page, metric, year):
    """Confirm an empty current-year cell geometrically, with a filled comparative cell."""
    words = page.get_text('words', sort=True)
    current = [w for w in words if w[4] == 'FY' + year]
    previous = [w for w in words if re.fullmatch(r'FY\d{4}/\d{2}', w[4]) and w[4] != 'FY' + year]
    starts = [w for w in words if w[4] == 'Scope']
    rows = []
    for start in starts:
        line = [w for w in words if abs(w[1] - start[1]) < 3 and w[0] >= start[0]]
        if len(line) > 1 and re.fullmatch(str(metric) + ':', line[1][4]): rows.append(line)
    if len(rows) != 1: return False
    pairs = [(c, p) for c in current for p in previous if abs(c[1] - p[1]) < 3 and c[1] < rows[0][0][1]]
    if not pairs: return False
    closest = max(c[1] for c, p in pairs)
    pairs = [(c, p) for c, p in pairs if c[1] == closest]
    if len(pairs) != 1: return False
    c, p = pairs[0]
    cx, px = (c[0] + c[2]) / 2, (p[0] + p[2]) / 2
    gap = abs(cx - px)
    if gap < 25: return False
    values = [w for w in rows[0] if re.fullmatch(r'[\d,]+\.\d+', w[4])]
    in_cell = lambda x: [w for w in values if abs((w[0] + w[2]) / 2 - x) < gap * .48]
    if not in_cell(cx) and len(in_cell(px)) == 1:
        return [cx - gap * .48, rows[0][0][1] - 2, cx + gap * .48, rows[0][0][3] + 2]
    return None


def finding(check, report, anchors, pdf):
    cid, status = check['id'], check['status']
    title, template = TEMPLATES.get(cid, (check['label'], '【待確認的披露內容】'))
    level = 'evidence' if status in ('evidence_present', 'evidence_found_pending_review', 'explanation_claim_pending_review') else 'review'
    summary = '未找到充分依據，需核對原件或補充資料。'
    if level == 'evidence': title, summary = check['label'], '已找到披露；數據真實性仍待業務覆核。'
    if status == 'partially_disclosed': summary = '已有部分披露，仍需補充方法或依據。'
    if status == 'applicability_pending_review': summary = '先確認此要求是否適用，再決定是否補充。'
    if status == 'prior_period_reference_requires_update': summary = '這是上一年度資料，不能直接作今年披露。'
    if status == 'rule_version_unconfirmed': summary = '規則版本未核實，暫不判定錯漏。'
    marks, target = [], None
    usable = [a for a in anchors if 1 <= a['page'] <= len(pdf)]
    # No escalation based merely on a model's "not found" judgement.
    if report['mode'] == 'same_year' and report['rule_verification']['status'] == 'selected_text_matches':
        if cid == 'C2-28-S2' and status == 'partial_or_not_found_pending_review':
            for a in usable:
                gap = blank_current_cell(pdf[a['page'] - 1], 2, report['source']['report_fiscal_year'])
                if gap:
                    level, title, summary = 'error', 'Scope 2 當期欄空白', '本稿同頁比較欄有數值，當期欄空白。'
                    marks.append({'page': a['page'], 'rects': [gap], 'empty': True})
        if cid == 'C2-28-UNIT' and status == 'partial_or_not_found_pending_review':
            for a in usable:
                if re.search(r'kgCO2\s*e', a['quote']):
                    metric = re.search(r'Scope\s*([12])', a['quote'], re.I)
                    level, title, summary = 'error', f'Scope {metric.group(1) if metric else "1/2"} 單位不符', '本稿用 kgCO2e；此項要求以 tCO2e 披露，須核實換算。'
                    marks += [{'page': a['page'], 'rects': [list(r) for r in pdf[a['page'] - 1].search_for('kgCO2e')]}]
                    target = a
        if cid == 'C2-29C-BASIS':
            for a in usable:
                text = pdf[a['page'] - 1].get_text(sort=True)
                match = re.search(r'(?:Only\s+market-based\s+Scope\s+2\s+emissions\s+are\s+reported\.\s*)?Location-based\s+Scope\s+2\s+emissions\s+are\s+not\s+provided\s+in\s+this\s+report\.', text, re.I)
                if match:
                    level, title, summary = 'error', '缺少 location-based Scope 2', '原文明示未提供，market-based 不能代替。'
                    target = {**a, 'quote': match.group(0)}
                    marks += [{'page': a['page'], 'rects': [list(r) for r in pdf[a['page'] - 1].search_for(match.group(0))]}]
    # A partial clarity finding is a writing suggestion, not a proven disclosure error.
    if cid == 'C2-28-GROSS' and status == 'partially_disclosed':
        level, summary = 'suggestion', '建議說明是否為未扣抵銷的總排放量。'
    edit = None
    if level != 'evidence' and usable:
        if target is None and cid in ('C2-28-S1', 'C2-28-S2'): target = usable[0]
        page_number = (target or usable[0])['page']
        original = (target or {}).get('quote', '')
        if len(original) > 1200 or not span(pdf[page_number - 1].get_text(sort=True), original): original = ''
        if original and cid in ('C2-28-S1', 'C2-28-S2', 'C2-28-UNIT'):
            source_metric = re.search(r'Scope\s*([12])', original, re.I)
            metric = 'Scope ' + (source_metric.group(1) if source_metric else ('2' if cid == 'C2-28-S2' else '1'))
            year = report['source']['report_fiscal_year']
            template = metric + ' emissions (tCO2e): 【待確認的當期數值】 (FY' + year + '); 【待確認的比較年度數值及年份】.'
        edit = {'kind': 'replace' if original else 'insert', 'page': page_number,
                'evidence_id': (target or usable[0])['evidence_id'], 'original': original,
                'suggested': template, 'requires_confirmation': True}
    return {'level': level, 'title': title, 'summary': summary, 'marks': marks, 'edit': edit}


class RevisionDraft:
    def __init__(self, reader):
        self.reader = reader
        self.path = reader.path.parent / 'reader-draft.json'

    def state(self):
        if not self.path.exists():
            return {'review_sha256': self.reader.review_sha, 'revision': 0, 'edits': [], 'history': []}
        value = json.loads(self.path.read_text(encoding='utf-8'))
        if value['review_sha256'] != self.reader.review_sha: raise ValueError('Draft belongs to a different review revision.')
        return value

    def pages(self, state=None):
        import pymupdf
        with pymupdf.open(stream=self.reader.source_bytes, filetype='pdf') as pdf:
            pages = [p.get_text(sort=True) for p in pdf]
        for edit in (state or self.state())['edits']:
            if not edit['active']: continue
            index = edit['page'] - 1
            if edit['kind'] == 'replace':
                location = span(pages[index], edit['original'])
                if not location: raise ValueError('Draft replacement is ambiguous or overlaps another edit.')
                start, end = location
                pages[index] = pages[index][:start] + edit['replacement'] + pages[index][end:]
            else:
                pages[index] += '\n\n[Proposed disclosure]\n' + edit['replacement'] + '\n'
        return [{'number': i + 1, 'text': text} for i, text in enumerate(pages)]

    def update(self, value):
        if not isinstance(value, dict) or set(value) - {'expected_revision', 'check_id', 'operation', 'replacement', 'facts_confirmed'}:
            raise ValueError('Unexpected draft fields.')
        if type(value.get('expected_revision')) is not int: raise ValueError('Invalid draft revision.')
        if value.get('operation') not in ('accept', 'undo'): raise ValueError('Invalid draft operation.')
        with self.reader.lock:
            state = self.state()
            if state['revision'] != value['expected_revision']: raise FileExistsError('Draft changed in another window. Reload before editing.')
            cid = value.get('check_id')
            check = next((c for c in self.reader.data['checks'] if c['id'] == cid), None)
            if not check: raise ValueError('Unknown check.')
            if value['operation'] == 'undo':
                edit = next((e for e in reversed(state['edits']) if e['check_id'] == cid and e['active']), None)
                if not edit: raise ValueError('No applied change to undo.')
                edit['active'] = False
            else:
                proposal = check.get('finding', {}).get('edit')
                replacement = value.get('replacement', '')
                if not proposal: raise ValueError('This item has no supported draft proposal.')
                if value.get('facts_confirmed') is not True: raise ValueError('Confirm the facts before adopting the wording.')
                if not isinstance(replacement, str) or not 12 <= len(replacement.strip()) <= 3000: raise ValueError('Use 12–3000 characters for the draft.')
                if re.search(r'【|】|\[\s*(?:TODO|TBC)|待確認|待填|待補', replacement, re.I): raise ValueError('Fill the placeholders before adopting the wording.')
                if any(e['check_id'] == cid and e['active'] for e in state['edits']): raise ValueError('Undo this item before replacing its draft again.')
                state['edits'].append({**proposal, 'id': uuid.uuid4().hex, 'check_id': cid,
                    'replacement': replacement.strip(), 'facts_confirmed': True, 'active': True,
                    'rule': 'C2 ' + check['clause'], 'review_sha256': self.reader.review_sha,
                    'source_sha256': self.reader.report['source']['sha256'],
                    'accepted_at': datetime.now(timezone.utc).isoformat()})
            # Validate all edits together, including overlapping replacements and dependent undo.
            self.pages(state)
            state['revision'] += 1
            state['history'].append({'revision': state['revision'], 'operation': value['operation'], 'check_id': cid,
                                     'at': datetime.now(timezone.utc).isoformat()})
            data = json.dumps(state, ensure_ascii=False, indent=2) + '\n'
            if len(data.encode()) > 2 * 1024 * 1024: raise ValueError('Draft history exceeds 2 MiB.')
            temporary = self.path.with_suffix('.tmp')
            temporary.write_text(data, encoding='utf-8'); os.replace(temporary, self.path)
            return state

    def export(self):
        state = self.state()
        title = 'TEST ONLY — 修訂草稿' if self.reader.report['source'].get('synthetic') else '修訂草稿 — 待業務覆核'
        text = title + '\n原件：' + self.reader.report['source']['file_name'] + '\n（PDF 文字重建；保留原頁編號，未重建版式。）\n'
        pages = self.pages(state)
        text += '\n\n'.join(f"--- PDF {p['number']} ---\n{p['text']}" for p in pages)
        return {'review_sha256': self.reader.review_sha, 'draft': state, 'text': text, 'pages': pages}
