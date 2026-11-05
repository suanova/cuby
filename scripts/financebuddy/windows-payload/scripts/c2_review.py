"""Versioned, evidence-linked disclosure review; no automatic legal approval.

Bounded to the supplied Yeebo FY2025/26 ESG layout and twelve C2 GHG checks.
Four presence/period checks are deterministic. Eight semantic judgements require
exact original-page citations and always remain pending human review.
"""
import copy
import csv
from datetime import date, datetime, timezone
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import unicodedata
from collections import Counter

import pymupdf
from emissions_baseline import METRICS, DECIMAL, YEAR_PAIR, finite, previous_year
from energy_baseline import Evidence
from financebuddy_workflow import export_csv
from knowledge_client import KnowledgeClient
from read_public_pdf import rank_pages
from report_consistency import check_ghg_totals

RULE_BLOCK_START = '28.anissuershalldiscloseitsabsolutegross'
RULE_BLOCK_END = 'climate-relatedtransitionrisks30.'
SEMANTIC_STATUSES = {'evidence_found_pending_review', 'partially_disclosed',
                     'not_found_pending_review', 'explanation_claim_pending_review',
                     'applicability_pending_review'}


def norm(text):
    text = unicodedata.normalize('NFKC', text).replace('’', "'").replace('“', '"').replace('”', '"').replace('–', '-')
    return re.sub(r'\s+', '', text).casefold()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def block(text):
    text = norm(text)
    return text[text.index(RULE_BLOCK_START):text.index(RULE_BLOCK_END)]


class RuleHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def load_catalog(root):
    catalog = json.loads((root / 'cuby/config/c2-ghg-checklist.json').read_text(encoding='utf-8'))
    data = (root / catalog['local_rule_file']).read_bytes()
    if sha(data) != catalog['local_rule_sha256']:
        raise ValueError('Original rule PDF differs from the reviewed checklist source.')
    with pymupdf.open(stream=data, filetype='pdf') as pdf:
        selected = ' '.join(re.sub(r'AC2\s*[–-]\s*\d+', '', pdf[i].get_text()) for i in (21, 22, 23))
        if sha(block(selected).encode()) != catalog['selected_block_sha256']:
            raise ValueError('Checklist selected rule block differs from its approved revision.')
        for check in catalog['checks']:
            if norm(check['rule_quote']) not in norm(pdf[check['actual_pdf_page'] - 1].get_text()):
                raise ValueError('Checklist quote not present on its stated original rule page.')
        context = pdf[catalog['mandatory_context_actual_pdf_page'] - 1].get_text()
        if norm(catalog['mandatory_context_quote']) not in norm(context):
            raise ValueError('Mandatory-disclosure context source mismatch.')
    return catalog


def verify_online(root, output, catalog):
    """Fetch the fixed public official page using normal Windows TLS validation."""
    record = {'checked_at': datetime.now(timezone.utc).isoformat(), 'url': catalog['official_current_url'],
              'scope': 'Full normalized C2 paragraphs 28-29 block and 17(1) mandatory-context anchor; not all C2',
              'catalog_revision': catalog['revision'], 'approved_block_sha256': catalog['selected_block_sha256']}
    path = output / 'official-rulebook.html'
    try:
        executable = os.environ.get('FINANCEBUDDY_PWSH') or shutil.which('pwsh')
        if os.name != 'nt' or not executable:
            raise ValueError('This desktop verifier requires the Windows certificate-verified fetch helper.')
        subprocess.run([executable, '-NoProfile', '-NonInteractive', '-File', str(root / 'scripts/fetch_hkex_c2.ps1'),
                        '-OutputPath', str(path)], check=True, timeout=25, capture_output=True,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        raw = path.read_bytes()
        parser = RuleHTML()
        parser.feed(raw.decode('utf-8-sig'))
        text = ' '.join(parser.parts)
        selected_hash = sha(block(text).encode())
        context_ok = norm(catalog['mandatory_context_quote']) in norm(text)
        record.update(response_sha256=sha(raw), selected_block_sha256=selected_hash, mandatory_context_matches=context_ok,
                      status='selected_text_matches' if selected_hash == catalog['selected_block_sha256'] and context_ok else 'selected_rules_changed_review_required')
    except (OSError, ValueError, subprocess.SubprocessError, UnicodeError):
        record.update(status='not_verified', reason='Official live text could not be verified; no latest-rule claim or legal pass is available.')
    (output / 'rule-verification.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    if record['status'] == 'selected_rules_changed_review_required':
        raise ValueError('Official selected rules changed; rule-verification.json records the difference. Re-map the checklist before auditing.')
    return record


def is_index(text):
    text = norm(text)
    return ('aspects' in text and 'kpis' in text and 'relevantsection' in text) or ('關鍵績效指標' in text and '相關章節' in text and '層面' in text)


def page_record(source_id, number, text):
    return {'evidence_id': f'PDF:{source_id}:{number}:{sha(text.encode())[:16]}',
            'actual_pdf_page': number, 'text': text, 'is_disclosure_index': is_index(text)}


def load_source(root, language):
    client = KnowledgeClient(root)
    try:
        evidence = Evidence(client)
        docs = [d for d in evidence.catalog['documents'] if d.get('language') == language and d.get('report_kind') == 'esg'
                and d.get('report_fiscal_year') == '2025/26' and d.get('ingestion_status') == 'completed']
        if len(docs) != 1:
            raise ValueError('One authorized, completed source ESG report is required.')
        doc = docs[0]
        dates, period_ref = evidence.period(doc)
        authorized_page = evidence.fetch(doc, period_ref['actual_pdf_page'])
        source_url = evidence.source_url(doc, authorized_page)
        filename = doc['file_name']
        folder = (root / 'dataset/reports').resolve()
        path = (folder / filename).resolve()
        if Path(filename).name != filename or not path.is_relative_to(folder):
            raise ValueError('Source file must stay in the public-report folder.')
        raw = path.read_bytes()
        if len(raw) > 30 * 1024 * 1024 or sha(raw) != doc['sha256']:
            raise ValueError('Local original source differs from the authorized KB catalog revision.')
        with pymupdf.open(stream=raw, filetype='pdf') as pdf:
            if pdf.is_encrypted or len(pdf) > 200:
                raise ValueError('Unsupported original report.')
            pages = [page_record(doc['source_id'], i + 1, page.get_text(sort=True)) for i, page in enumerate(pdf)]
        return pages, {**doc, 'source_url': source_url, 'period': dates, 'period_provenance': period_ref,
                       'authority': 'Scoped KB read succeeded before full local original-PDF scan',
                       'text_extraction': 'PyMuPDF sorted text; images are not OCRed', 'page_count': len(pages)}
    finally:
        client.close()


def table_rows(pages, source_year):
    """A missing value/unit is a check finding, not an extractor fallback or guessed value."""
    found = {'scope1': [], 'scope2': []}
    for page in pages:
        if page['is_disclosure_index']:
            continue
        text = re.split(r'Remarks\s*:|註\s*[:：]', page['text'], maxsplit=1, flags=re.I)[0]
        marks = sorted((m.start(), m.end(), key) for key, pattern in METRICS.items() for m in re.finditer(pattern, text, re.I))
        if not marks:
            continue
        header = re.sub(r'財政年度', ' ', text[:marks[0][0]])
        years = YEAR_PAIR.findall(re.sub(r'\s+', ' ', header))
        if not years or set(years[-1]) != {source_year, previous_year(source_year)}:
            continue
        for i, (start, end, metric) in enumerate(marks):
            if metric not in found:
                continue
            quote = text[start:marks[i + 1][0] if i + 1 < len(marks) else len(text)].strip()
            values = DECIMAL.findall(quote[end - start:])
            valid = len(values) == 2
            if valid:
                try:
                    value = str(finite(values[years[-1].index(source_year)]))
                except ValueError:
                    valid = False
            found[metric].append({'evidence_id': page['evidence_id'], 'actual_pdf_page': page['actual_pdf_page'],
                                  'quote': quote, 'value': value if valid else None, 'unambiguous_value': valid,
                                  'reported_unit_supported': bool(re.search(r'(?<![A-Za-z])tCO2\s*e(?![A-Za-z])|噸二氧化碳當量', quote)),
                                  'header_years': years[-1]})
    return found


def automatic_checks(pages, source, catalog, target, freshness):
    rows = table_rows(pages, source['report_fiscal_year'])
    checks = []
    same_period = (source['period']['start'], source['period']['end']) == (target['start'], target['end'])
    for rule in (c for c in catalog['checks'] if c['kind'] == 'automatic'):
        evidence, ok, reason, action = [], False, '', ''
        if rule['id'] in ('C2-28-S1', 'C2-28-S2'):
            selected = rows['scope1' if rule['id'].endswith('S1') else 'scope2']
            evidence = [{'evidence_id': r['evidence_id'], 'quote': r['quote']} for r in selected]
            ok = bool(selected) and all(r['unambiguous_value'] for r in selected) and len({r['value'] for r in selected}) == 1
            reason = '已找到按明確當期／比較欄頭對應的報告數值；未核實 absolute gross 或原始帳冊。' if ok else '完整文字掃描未取得可無歧義對應當期的數值；不以比較欄或索引代替。'
            action = '原件覆核及核對原始帳冊；本項只測數值存在。' if ok else '查閱原始 PDF／影像或補充當期數值及欄頭。'
        elif rule['id'] == 'C2-28-UNIT':
            selected = rows['scope1'] + rows['scope2']
            evidence = [{'evidence_id': r['evidence_id'], 'quote': r['quote']} for r in selected]
            ok = all(rows[k] for k in rows) and all(r['reported_unit_supported'] for r in selected)
            reason = '兩個範圍原表均有 tCO2e／噸二氧化碳當量標籤；未驗證計量本身。' if ok else '未取得兩個範圍的完整受支援單位；不可默認單位或靜默換算。'
            action = '原件覆核。' if ok else '核實原單位及披露位置，必要時補列單位／換算依據。'
        else:
            reference = source['period_provenance']
            page = next(p for p in pages if p['actual_pdf_page'] == reference['actual_pdf_page'])
            evidence = [{'evidence_id': page['evidence_id'], 'quote': page['text']}]
            ok = same_period
            reason = '原件報告期與指定目標財年相同；數值是否實際屬此期間仍待底稿覆核。' if ok else '原件仍為上一年度資料，不能改標成目標年度的實際披露。'
            action = '核實資料期間。' if ok else '提供目標年度報告／數據，保留舊年度原文作參考。'
        status = 'evidence_present' if ok else 'partial_or_not_found_pending_review'
        if not same_period:
            status = 'prior_period_reference_requires_update'
        if freshness['status'] != 'selected_text_matches':
            status = 'rule_version_unconfirmed'
        checks.append({**rule, 'status': status, 'reason': reason, 'next_action': action, 'evidence': evidence})
    return checks


def eligible(page, check_id):
    if page['is_disclosure_index']:
        return False
    text = page['text']
    scope3_only = bool(re.search(r'Scope\s*3|範圍\s*3', text, re.I)) and not re.search(r'Scope\s*[12]|範圍\s*[12]', text, re.I)
    if scope3_only:
        return False
    return True


def candidates(pages, rule):
    ranking = rank_pages([p['text'] for p in pages], rule['query'])
    chosen = []
    for number in ranking:
        page = pages[number - 1]
        if not eligible(page, rule['id']) or not re.search(r'greenhouse|GHG|Scope\s*[12]|溫室氣體|範圍\s*[12]', page['text'], re.I):
            continue
        # Only candidate excerpts, never a claim these pages satisfy the rule.
        match = re.search(r'Scope\s*[12]\s*[–—-]|範圍\s*[12]\s*[－–—-]|greenhouse|GHG', page['text'], re.I)
        start = max(0, match.start() - 100) if match else 0
        chosen.append({'evidence_id': page['evidence_id'], 'actual_pdf_page': number, 'candidate_excerpt': page['text'][start:start + 900]})
        if len(chosen) == 1:
            break
    return chosen


def target_period(source, mode):
    dates = source['period']
    if mode == 'same_year':
        return {'fiscal_year': source['report_fiscal_year'], 'start': dates['start'], 'end': dates['end'], 'scenario_assumption': False}
    if mode != 'next_year_readiness':
        raise ValueError('Unsupported review mode.')
    start, end = date.fromisoformat(dates['start']), date.fromisoformat(dates['end'])
    year = source['report_fiscal_year']
    return {'fiscal_year': f'{int(year[:4]) + 1}/{(int(year[-2:]) + 1) % 100:02d}',
            'start': start.replace(year=start.year + 1).isoformat(), 'end': end.replace(year=end.year + 1).isoformat(),
            'scenario_assumption': True, 'assumption': 'Same year-end assumed for readiness exercise, not current-year issuer data.'}


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def file_manifest(directory, names):
    return {name: sha((directory / name).read_bytes()) for name in names}


def test_candidate_source(source, pages, name, raw_sha, source_url):
    """Keep fixture construction metadata out of the reviewer-facing package.

    Fiscal year/period are declared fixture parameters, not independent proof of
    reporting dates. All quoted evidence must come from the submitted candidate.
    This is input separation, not a filesystem sandbox around an LLM agent.
    """
    period_page = next(p for p in pages if p['actual_pdf_page'] == source['period_provenance']['actual_pdf_page'])
    return {'source_id': pages[0]['evidence_id'].split(':')[1], 'entity': source.get('entity', 'yeebo'),
            'file_name': name, 'report_fiscal_year': source['report_fiscal_year'], 'report_kind': 'esg',
            'language': source['language'], 'sha256': raw_sha, 'synthetic': True, 'source_url': source_url,
            'period': {k: source['period'][k] for k in ('start', 'end')},
            'period_provenance': {'actual_pdf_page': period_page['actual_pdf_page'],
                                  'source_sha256': raw_sha, 'evidence_ids': [period_page['evidence_id']],
                                  'quote': period_page['text']},
            'period_basis': 'Declared unchanged fixture dates; candidate text supplied for review, not independent date verification.',
            'authority': 'TEST ONLY candidate; no correct current-year reference supplied to review checks',
            'text_extraction': 'PyMuPDF sorted text; images are not OCRed', 'page_count': len(pages)}


def prepare(root, output, mode='same_year', language='en', source_variant='official'):
    if source_variant not in ('official', 'deliberate_errors') or (source_variant != 'official' and (mode != 'same_year' or language != 'en')):
        raise ValueError('The synthetic validation copy supports English same_year mode only.')
    catalog = load_catalog(root)
    output.mkdir(parents=True, exist_ok=False)
    freshness = verify_online(root, output, catalog)
    pages, source = load_source(root, language)
    test_names = []
    if source_variant == 'deliberate_errors':
        from c2_test_report import create
        test_name = 'TEST_ONLY_deliberate_errors.pdf'
        create(root / 'dataset/reports' / source['file_name'], output / test_name)
        with pymupdf.open(output / test_name) as pdf:
            pages = [page_record('TEST-' + source['source_id'], i + 1, p.get_text(sort=True)) for i, p in enumerate(pdf)]
        source = test_candidate_source(source, pages, test_name, sha((output / test_name).read_bytes()),
                                       (output / test_name).relative_to(root).as_posix())
        test_names.append(test_name)
    target = target_period(source, mode)
    if source['period']['start'] < catalog['effective_financial_year_start_from']:
        raise ValueError('The pinned Part D scope is not mapped to this earlier financial year.')
    auto = automatic_checks(pages, source, catalog, target, freshness)
    activity_pages = [p['evidence_id'] for p in pages if not p['is_disclosure_index']
                      and re.search(r'kWh|千瓦時|千瓦时', p['text'], re.I)
                      and re.search(r'consumption|消耗', p['text'], re.I)
                      and re.search(r'diesel|柴油', p['text'], re.I)
                      and re.search(r'electricity|電力|外購電', p['text'], re.I)]
    bundle = {'schema_version': 'c2-review-input-1', 'created_at': datetime.now(timezone.utc).isoformat(),
              'catalog': catalog, 'rule_verification': freshness, 'mode': mode, 'source': source, 'target_period': target,
              'report_pages': pages, 'related_activity_pages': activity_pages, 'automatic_checks': auto, 'all_c2_rules_reviewed': False,
              'legal_compliance_certified': False, 'underlying_data_verified': False}
    bundle['document_checks'] = check_ghg_totals(pages, source['report_fiscal_year'])
    bundle['review_basis'] = {'current_year_answer_key_provided': False,
                             'document_consistency': 'Paired-FY GHG table arithmetic only; not full narrative consistency.',
                             'rule_review': '12 selected C2 checks only.',
                             'prior_year_continuity': 'not_reviewed',
                             'data_truth': 'not_verified_without_underlying_records'}
    judgements = [{'check_id': c['id'], 'clause': c['clause'], 'label': c['label'], 'guidance': c['guidance'],
                   'rule_quote': c['rule_quote'], 'candidate_evidence': candidates(pages, c)}
                  for c in catalog['checks'] if c['kind'] == 'judgement']
    # Plain page files keep the model's normal file reader from loading a whole
    # JSON document whose individual escaped-text lines can exceed its limit.
    page_directory = output / 'original-pages'
    page_directory.mkdir()
    page_names = []
    for page in pages:
        name = f"original-pages/page-{page['actual_pdf_page']:03d}.txt"
        (output / name).write_text(page['evidence_id'] + '\n'
                                  + f"Disclosure index: {page['is_disclosure_index']}\n\n" + page['text'], encoding='utf-8')
        page_names.append(name)
    for judgement in judgements:
        for candidate in judgement['candidate_evidence']:
            candidate['original_page_file'] = str(page_directory / f"page-{candidate['actual_pdf_page']:03d}.txt")
    write_json(output / 'review-input.json', bundle)
    compact_auto = [{k: c[k] for k in ('id', 'label', 'status', 'reason', 'next_action')} for c in auto]
    write_json(output / 'review-brief.json', {'mode': mode, 'target_period': target, 'automatic_checks': compact_auto, 'judgements_to_review': judgements,
               'document_checks': bundle['document_checks'], 'review_basis': bundle['review_basis'],
               'original_pages_directory': str(page_directory),
               'related_activity_pages': [{'evidence_id': p['evidence_id'], 'actual_pdf_page': p['actual_pdf_page'], 'original_page_file': str(page_directory / f"page-{p['actual_pdf_page']:03d}.txt")} for p in pages if p['evidence_id'] in activity_pages],
               'note': 'Candidates are search aids. Read original_page_file, or page-NNN.txt for any other actual page. Avoid loading the entire review-input.json. Index pages and Scope-3-only references cannot prove Scope 1/2.'})
    write_json(output / 'rule-catalog.json', catalog)
    write_json(output / 'prepared-manifest.json', {'files': file_manifest(output, ['review-input.json', 'review-brief.json', 'rule-catalog.json', 'rule-verification.json'] + page_names + test_names)})
    return {'review_input': str(output / 'review-input.json'), 'review_brief': str(output / 'review-brief.json'),
            'original_pages_directory': str(page_directory),
            'checks_count': len(catalog['checks']), 'automatic_checks': compact_auto, 'semantic_checks_pending': len(judgements),
            'document_checks_count': len(bundle['document_checks']), 'review_basis': bundle['review_basis'],
            'source_variant': source_variant, 'synthetic': source_variant != 'official',
            'test_report_pdf': str(output / test_names[0]) if test_names else None,
            'scanned_pdf_pages': len(pages), 'excluded_index_pages': [p['actual_pdf_page'] for p in pages if p['is_disclosure_index']],
            'rule_verification': freshness, 'target_period': target, 'all_c2_rules_reviewed': False,
            'judgements_to_review': [{k: v for k, v in j.items() if k != 'candidate_evidence'} for j in judgements],
            'next_step': 'Read review-brief.json and original-page evidence; finalize_c2_review with exactly eight evidence-linked advisory judgements. No semantic item can be called legally passed.'}


def validate_judgements(bundle, judgements):
    rules = {c['id']: c for c in bundle['catalog']['checks'] if c['kind'] == 'judgement'}
    if (not isinstance(judgements, list) or len(judgements) != len(rules) or
            any(not isinstance(j, dict) for j in judgements) or {j.get('check_id') for j in judgements} != set(rules)):
        raise ValueError('Exactly one judgement is required for every semantic checklist item.')
    pages = {p['evidence_id']: p for p in bundle['report_pages']}
    checked = []
    for item in judgements:
        rule = rules[item['check_id']]
        if item.get('status') not in SEMANTIC_STATUSES or len(item.get('reason', '').strip()) < 10 or not item.get('next_action', '').strip():
            raise ValueError('Use an advisory status, a substantive reason and a follow-up action; no legal pass is supported.')
        evidence = item.get('evidence', [])
        if not isinstance(evidence, list) or len(evidence) > 8:
            raise ValueError('Invalid evidence references.')
        if item['status'] in ('evidence_found_pending_review', 'partially_disclosed', 'explanation_claim_pending_review') and not evidence:
            raise ValueError('This judgement requires original-report evidence.')
        for citation in evidence:
            page = pages.get(citation.get('evidence_id'))
            quote = citation.get('quote', '')
            if (page is None or not eligible(page, rule['id']) or len(norm(quote)) < 12 or
                    norm(quote) not in norm(page['text'])):
                raise ValueError('Unknown, index-only, wrong-scope or unsupported original-page citation.')
        evidence = copy.deepcopy(evidence)
        action = rule.get('workflow_follow_up') or item['next_action']
        if rule['id'] == 'C2-29BI-INPUTS' and bundle.get('related_activity_pages'):
            activity = [pages[eid] for eid in bundle['related_activity_pages']]
            numbers = ', '.join(str(p['actual_pdf_page']) for p in activity)
            action = f'能源消耗表已披露（原件 PDF {numbers}）；核對其與 Scope 1/2 計算的範圍／輸入對應及關鍵假設。需要原始量或台帳供核對，不等於條文要求公開全部台帳。'
            for p in activity:
                if not any(e['evidence_id'] == p['evidence_id'] for e in evidence):
                    evidence.append({'evidence_id': p['evidence_id'], 'quote': p['text'][:1200]})
        checked.append({**rule, 'status': item['status'], 'reason': item['reason'], 'next_action': action,
                        'model_proposed_next_action': item['next_action'], 'evidence': evidence,
                        'period_qualification': 'historical_reference_only_requires_target_year_confirmation' if bundle['mode'] == 'next_year_readiness' else 'current_report_text_review_only'})
    return checked


def render_review(report):
    esc = lambda x: html.escape(str(x))
    text = '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>億都 C2 披露核對</title><style>body{font:15px/1.6 system-ui;max-width:1400px;margin:30px auto;padding:0 20px;color:#19313d}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d4e0e5;padding:10px;vertical-align:top;text-align:left}th{background:#eaf3f3}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:650px}.notice{padding:14px;background:#fff4db;border-left:4px solid #c18a24}a{color:#126766}</style>'
    text += '<h1>億都 C2 排放披露核對</h1><p>模式：' + esc(report['mode']) + ' · 原件年度：' + esc(report['source']['report_fiscal_year']) + ' · 目標年度：' + esc(report['target_period']['fiscal_year']) + '</p>'
    if report['source'].get('synthetic'):
        text += '<p class="notice"><strong>TEST ONLY · 人為錯漏副本測試</strong>：以下發現只屬測試副本，不代表公司正式披露有這些錯漏。<a href="TEST_ONLY_deliberate_errors.pdf">查看標示測試 PDF</a></p>'
    text += '<p class="notice">只核對指定12項，並非整份 C2／年報合規批准。數值與單位存在不代表原始計量或 absolute gross 已驗證；語義判斷、例外及寬免均待人手覆核。下一年度模式保留舊數據，必須補當年輸入。</p>'
    text += '<p><a href="checklist.csv" download>下載核對底稿</a> · <a href="data-requests.csv" download>下載待補清單</a></p><p>狀態：' + esc(json.dumps(report['status_counts'], ensure_ascii=False)) + '</p><details><summary>規則版本與檢查範圍</summary><pre>' + esc(json.dumps(report['rule_verification'], ensure_ascii=False, indent=2)) + '</pre></details>'
    text += '<table><tr><th>項目／規則</th><th>狀態及原因</th><th>來源原文</th><th>建議跟進</th></tr>'
    pages = {p['evidence_id']: p for p in report['report_pages']}
    for check in report['checks']:
        cites = ''
        for citation in check['evidence']:
            p = pages[citation['evidence_id']]
            cites += '<details><summary>原件 PDF ' + str(p['actual_pdf_page']) + '</summary><pre>' + esc(citation['quote']) + '</pre></details>'
        text += '<tr><td>' + esc(check['label']) + '<br><a href="' + esc(report['catalog']['official_current_url']) + '">C2 ' + esc(check['clause']) + '</a><br>規則 PDF ' + str(check['actual_pdf_page']) + '</td><td>' + esc(check['status']) + '<br>' + esc(check['reason']) + '</td><td>' + (cites or '未取得支持原文；待原件／人工覆核') + '</td><td>' + esc(check['next_action']) + '</td></tr>'
    text += '</table><h2>本稿內部核對</h2><p>只核對同表排放加總；並非全文敘述檢查或台帳核實。去年報告銜接仍未檢查。<a href="document-checks.csv" download>下載內文核對</a></p><table>'
    for check in report.get('document_checks', []):
        text += '<tr><td>' + esc(check['label']) + '</td><td>' + esc(check['status']) + '</td><td>' + esc(check['reason']) + '</td></tr>'
    return text + '</table><h2>未覆蓋範圍</h2><ul>' + ''.join('<li>' + esc(x) + '</li>' for x in report['catalog']['exclusions']) + '</ul></html>'


def finalize(input_path, judgements):
    directory = input_path.parent
    manifest = json.loads((directory / 'prepared-manifest.json').read_text(encoding='utf-8'))
    for name, expected in manifest['files'].items():
        path = (directory / name).resolve()
        allowed = name in {'review-input.json', 'review-brief.json', 'rule-catalog.json', 'rule-verification.json', 'TEST_ONLY_deliberate_errors.pdf'} or re.fullmatch(r'original-pages/page-[0-9]{3}\.txt', name)
        if not allowed or not path.is_relative_to(directory.resolve()) or sha(path.read_bytes()) != expected:
            raise ValueError('Prepared evidence or rule revision changed; start a new review.')
    if (directory / 'review.json').exists():
        raise ValueError('This review has already been finalized; preserve its result and start a new run.')
    bundle = json.loads(input_path.read_text(encoding='utf-8'))
    test_name = 'TEST_ONLY_deliberate_errors.pdf'
    synthetic = bundle['source'].get('synthetic', False)
    if synthetic:
        if (bundle['source']['file_name'] != test_name or
                manifest['files'].get(test_name) != bundle['source']['sha256']):
            raise ValueError('Synthetic PDF must be fixed-labelled and match its prepared source revision.')
    elif test_name in manifest['files']:
        raise ValueError('Official review cannot include a synthetic PDF.')
    semantic = validate_judgements(bundle, judgements)
    checks = bundle['automatic_checks'] + semantic
    # Derive consistency again from manifest-protected candidate pages. Never
    # accept a model-supplied total, expected value or fabricated comparison.
    document_checks = check_ghg_totals(bundle['report_pages'], bundle['source']['report_fiscal_year'])
    report = {**bundle, 'checks': checks, 'status_counts': dict(Counter(c['status'] for c in checks)),
              'document_checks': document_checks,
              'status': 'advisory_disclosure_review_pending_human_review', 'completed_at': datetime.now(timezone.utc).isoformat()}
    rows = [{'check_id': c['id'], 'clause': c['clause'], 'label': c['label'], 'source_fiscal_year': bundle['source']['report_fiscal_year'],
             'target_fiscal_year': bundle['target_period']['fiscal_year'], 'mode': bundle['mode'], 'status': c['status'], 'reason': c['reason'],
             'next_action': c['next_action'], 'rule_quote': c['rule_quote'], 'rule_actual_pdf_page': c['actual_pdf_page'],
             'rule_url': bundle['catalog']['official_current_url'], 'rule_catalog_revision': bundle['catalog']['revision'],
             'rule_verification_status': bundle['rule_verification']['status'], 'report_file': bundle['source']['file_name'],
             'report_sha256': bundle['source']['sha256'], 'report_evidence': c['evidence'],
             'period_qualification': c.get('period_qualification', 'presence_check_only'), 'human_review': 'pending'} for c in checks]
    export_csv(directory / 'checklist.csv', rows)
    export_csv(directory / 'document-checks.csv', [{k: c[k] for k in ('id', 'label', 'status', 'reason', 'next_action', 'evidence')} for c in document_checks]
               or [{'id': 'DOC-GHG-SUM', 'label': '本稿排放加總', 'status': 'no_supported_table_found',
                    'reason': '未取得受支援的完整標籤及欄頭；並非通過。', 'next_action': '人工核對其他版式。', 'evidence': []}])
    export_csv(directory / 'data-requests.csv', [{'check_id': r['check_id'], 'input_needed': r['next_action'], 'reason': r['reason'],
                'target_fiscal_year': r['target_fiscal_year'], 'status': 'pending_review_not_assertion_company_lacks_data'}
                for r in rows if r['status'] != 'evidence_present'])
    with (directory / 'checklist.csv').open(encoding='utf-8-sig', newline='') as stream:
        readback = list(csv.DictReader(stream))
    if len(readback) != len(checks) or {r['check_id'] for r in readback} != {c['id'] for c in checks}:
        raise ValueError('Checklist CSV readback failed.')
    write_json(directory / 'review.json', report)
    (directory / 'review.html').write_text(render_review(report), encoding='utf-8')
    write_json(directory / 'final-manifest.json', {'prepared_manifest_sha256': sha((directory / 'prepared-manifest.json').read_bytes()),
               'files': file_manifest(directory, ['checklist.csv', 'document-checks.csv', 'data-requests.csv', 'review.json', 'review.html'] + ([test_name] if synthetic else []))})
    return {'output_directory': str(directory), 'checks_written': len(checks), 'read_back_rows': len(readback),
            'document_checks_written': len(document_checks),
            'document_check_status_counts': dict(Counter(c['status'] for c in document_checks)),
            'status_counts': report['status_counts'], 'source_fiscal_year': bundle['source']['report_fiscal_year'],
            'target_period': bundle['target_period'], 'rule_verification': bundle['rule_verification'],
            'all_c2_rules_reviewed': False, 'legal_compliance_certified': False,
            'target_year_confirmation_required': len(checks) if bundle['mode'] == 'next_year_readiness' else 0,
            'review_status': report['status'],
            'checklist_csv': str(directory / 'checklist.csv'), 'review_file': str(directory / 'review.html')}


def mutation_checks(bundle):
    """Redact in-memory synthetic text only; never edit an original PDF or its evidence."""
    pages, source, catalog, fresh, target = (bundle[k] for k in ('report_pages', 'source', 'catalog', 'rule_verification', 'target_period'))
    baseline = automatic_checks(pages, source, catalog, target, fresh)
    signatures = lambda checks: {c['id']: c['status'] for c in checks}
    tests = []
    for variant in ('remove_scope2_row', 'remove_current_scope2_value', 'remove_units', 'index_only'):
        altered = copy.deepcopy(pages)
        changed = False
        for page in altered:
            if variant == 'index_only':
                page['is_disclosure_index'] = True
                changed = True
                continue
            lines = page['text'].splitlines()
            for i, line in enumerate(lines):
                if re.search(METRICS['scope2'], line, re.I) and len(DECIMAL.findall(line)) == 2:
                    if variant == 'remove_scope2_row': lines[i] = ''
                    elif variant == 'remove_current_scope2_value': lines[i] = line.replace(DECIMAL.findall(line)[0], '[TEST-REDACTED]', 1)
                    changed = True
                if variant == 'remove_units' and re.search(METRICS['scope1'] + '|' + METRICS['scope2'], line, re.I):
                    lines[i] = re.sub(r'tCO2\s*e|噸二氧化碳當量', '[TEST-UNIT-REMOVED]', line)
                    changed = True
            page['text'] = '\n'.join(lines)
        if not changed:
            raise ValueError('Synthetic negative-case mutation did not touch an eligible table.')
        result = signatures(automatic_checks(altered, source, catalog, target, fresh))
        check = 'C2-28-UNIT' if variant == 'remove_units' else 'C2-28-S2'
        passed = result[check] == 'partial_or_not_found_pending_review'
        tests.append({'case': variant, 'synthetic': True, 'check_id': check, 'observed': result[check], 'passed': passed})
    restored = signatures(automatic_checks(copy.deepcopy(pages), source, catalog, target, fresh))
    tests.append({'case': 'original_restored', 'synthetic': True, 'passed': restored == signatures(baseline)})
    return {'tests': tests, 'passed': all(t['passed'] for t in tests), 'original_pdf_modified': False,
            'scope': 'Deterministic presence/unit checks only; not validation of all semantic or legal judgements.'}
