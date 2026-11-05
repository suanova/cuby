"""Bounded Yeebo bilingual energy-table extraction from live, scoped KB evidence.

No expected metric values, source IDs, page numbers or conversion factors are inputs.
The supported FY2025/26 layout has consumption/intensity columns for two years.
"""
import csv
from datetime import date, datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlsplit

from emissions_baseline import finite, previous_year, precision_comparison, YEAR_PAIR
from financebuddy_workflow import export_csv

CARRIERS = {
    'natural_gas': (r'Natural\s+gas\s*#|天然氣\s*#', '天然氣', '#'),
    'diesel': (r'Diesel\s*\*|柴油\s*\*', '柴油', '*'),
    'petrol': (r'Petrol\s*#|汽油\s*#', '汽油', '#'),
    'self_generated_renewable': (r'Self-generated\s+renewable\s+energy\s*\*\*|自產再生能源\s*\*\*', '自產再生能源', '**'),
    'purchased_electricity': (r'Electricity\s*&|外購電力\s*&', '外購電力', '&'),
}
NUMBER = re.compile(r'(?<![\w./])[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w./])')


def parse_table(content, report_year, language):
    before_notes = re.split(r'Notes\s*:|附註\s*[:：]', content, maxsplit=1, flags=re.I)[0]
    marks = sorted((m.start(), m.end(), key) for key, (pattern, _, _) in CARRIERS.items()
                   for m in re.finditer(pattern, before_notes, re.I))
    if not marks:
        raise ValueError('No supported labelled energy table on this evidence page.')
    header = before_notes[:marks[0][0]]
    normalized = re.sub(r'財政年度', ' ', header)
    normalized = re.sub(r'\s+', ' ', normalized)
    headers = YEAR_PAIR.findall(normalized)
    if not headers or set(headers[-1]) != {report_year, previous_year(report_year)}:
        raise ValueError('Explicit energy table year headers are missing or ambiguous.')
    if language == 'en':
        columns_ok = re.search(r'Consumption\s+Intensity\s+Consumption\s+Intensity', header, re.I)
        units_ok = (len(re.findall(r'(?<![A-Za-z])kWh(?![A-Za-z])', header)) == 4 and
                    len(re.findall(r'kWh\s*/\s*m2', header)) == 2 and 'finished' in header and 'goods' in header)
        unit, intensity_unit = 'kWh', 'kWh/m2 finished goods'
        direct, indirect = r'Direct\s+Energy', r'Indirect\s+Energy'
    elif language == 'zh-Hant':
        columns_ok = re.search(r'消耗量\s+密度\s+消耗量\s+密度', header)
        units_ok = header.count('千瓦時') == 4 and header.count('每平方米製成品') == 2
        unit, intensity_unit = '千瓦時', '千瓦時╱每平方米製成品'
        direct, indirect = '直接能源', '間接能源'
    else:
        raise ValueError('Unsupported table language.')
    indirect_mark = re.search(indirect, before_notes, re.I)
    if not columns_ok or not units_ok or not re.search(direct, header, re.I) or not indirect_mark:
        raise ValueError('Energy column order, units or direct/indirect labels are incomplete.')
    years = headers[-1]
    rows = {}
    for i, (start, end, carrier) in enumerate(marks):
        segment = before_notes[start:marks[i + 1][0] if i + 1 < len(marks) else len(before_notes)].strip()
        values = NUMBER.findall(segment[end - start:])
        if len(values) != 4:
            raise ValueError(f'{carrier}: expected four values in explicit consumption/intensity order.')
        values = [str(finite(v)) for v in values]
        group = 'direct' if start < indirect_mark.start() else 'indirect'
        if (carrier == 'purchased_electricity') != (group == 'indirect'):
            raise ValueError('Energy carrier and original direct/indirect group disagree.')
        row = {'values': {year: {'consumption': values[j * 2], 'intensity': values[j * 2 + 1]}
                          for j, year in enumerate(years)}, 'energy_group': group,
               'unit_as_reported': unit, 'intensity_unit_as_reported': intensity_unit,
               'row_quote': segment, 'unit_header_quote': header.strip()}
        if carrier in rows and (rows[carrier]['values'] != row['values'] or rows[carrier]['energy_group'] != group):
            raise ValueError(f'{carrier}: conflicting duplicate energy rows require review.')
        if carrier not in rows or len(segment) > len(rows[carrier]['row_quote']):
            rows[carrier] = row
    if set(rows) != set(CARRIERS):
        raise ValueError('Incomplete five-carrier energy table; no missing values were filled.')
    return rows


def parse_notes(content):
    parts = re.split(r'Notes\s*:|附註\s*[:：]', content, maxsplit=1, flags=re.I)
    if len(parts) != 2:
        raise ValueError('Energy table notes were not recovered.')
    text = re.split(r'To reduce energy consumption|為減少能源消耗', parts[1], maxsplit=1, flags=re.I)[0]
    marks = list(re.finditer(r'\((#|\*\*|\*|&)\)', text))
    notes = {}
    for i, mark in enumerate(marks):
        quote = text[mark.start():marks[i + 1].start() if i + 1 < len(marks) else len(text)].strip()
        key = mark[1]
        if key in notes and re.sub(r'\s+', ' ', notes[key]) != re.sub(r'\s+', ' ', quote):
            raise ValueError('Conflicting duplicate energy footnotes require review.')
        notes[key] = quote
    if set(notes) != {'#', '*', '**', '&'}:
        raise ValueError('All four energy footnotes are required; none was guessed.')
    return notes


class Evidence:
    """Same fail-closed source/revision/locator contract as the GHG baseline."""
    def __init__(self, client):
        self.client = client
        self.catalog = client.call('list_documents', {'entity': 'yeebo'})
        self.pages = {}
        self.trace = []

    def fetch(self, doc, number):
        key = (doc['source_id'], number)
        if key not in self.pages:
            p = self.client.call('read_source_page', {'source_id': key[0], 'actual_pdf_page': number})
            if (p.get('status') != 'ok' or not p.get('complete_index_scan') or p.get('response_truncated') or
                    p.get('source_sha256') != doc['sha256'] or p.get('source_id') != key[0] or
                    p.get('actual_pdf_page') != number or p.get('language') != doc['language'] or
                    p.get('report_fiscal_year') != doc['report_fiscal_year'] or not p.get('backing_evidence_ids')):
                raise ValueError('Incomplete, unauthorized or changed source evidence; no energy baseline published.')
            if not all(re.fullmatch(re.escape(key[0]) + r':[0-9a-f-]{36}', e) for e in p['backing_evidence_ids']):
                raise ValueError('Malformed source evidence IDs.')
            if not re.fullmatch(r'[a-f0-9]{32}', p.get('source_revision_md5', '')) or any(
                    v['source_revision_md5'] != p['source_revision_md5'] for k, v in self.pages.items() if k[0] == key[0]):
                raise ValueError('Source revision changed during energy collection.')
            self.pages[key] = p
        return self.pages[key]

    def search(self, doc):
        query = ('Energy consumption Electricity Natural gas Diesel Petrol Intensity' if doc['language'] == 'en'
                 else '能源消耗 外購電力 天然氣 柴油 汽油 密度')
        r = self.client.call('search_evidence', {'entity': 'yeebo', 'source_ids': [doc['source_id']], 'query': query, 'top_k': 3})
        rerank = r.get('retrieval', {}).get('rerank', [])
        if (r.get('status') != 'ok' or r.get('selected_source_ids') != [doc['source_id']] or not rerank or
                any(not item.get('applied') or item.get('outcome') != 'ok' for item in rerank)):
            raise ValueError('Scoped energy retrieval and mandatory ReRank must succeed.')
        candidates = []
        for e in r.get('evidence', []):
            if e.get('source_id') != doc['source_id'] or e.get('source_sha256') != doc['sha256'] or not e.get('locator_revision_verified'):
                raise ValueError('Energy search source or revision mismatch.')
            for number in e.get('actual_pdf_pages', []):
                if number not in candidates:
                    candidates.append(number)
        self.trace.append({'source_id': doc['source_id'], 'query': query, 'actual_candidate_pages': candidates, 'retrieval': r.get('retrieval')})
        return candidates[:6]

    def period(self, doc):
        period = doc['report_period']
        if doc['source_id'] not in period['source_evidence']['source_ids'] or date.fromisoformat(period['start']) >= date.fromisoformat(period['end']):
            raise ValueError('Report dates lack their actual source document or are invalid.')
        page = self.fetch(doc, period['source_evidence']['actual_pdf_page'])
        return period, {'source_id': doc['source_id'], 'actual_pdf_page': page['actual_pdf_page'],
                        'source_sha256': doc['sha256'], 'evidence_ids': page['backing_evidence_ids'], 'quote': page['content']}

    def source_url(self, doc, page):
        e = self.client.call('read_evidence', {'evidence_id': page['backing_evidence_ids'][0]})['evidence']
        if e['source_sha256'] != doc['sha256'] or e['source_id'] != doc['source_id'] or not e['locator_revision_verified']:
            raise ValueError('Source URL evidence revision mismatch.')
        url = e['source_url']
        p = urlsplit(url)
        if p.scheme != 'http' or p.hostname not in ('localhost', '127.0.0.1') or not p.path.startswith('/platform/knowledge-bases/'):
            raise ValueError('Unexpected authenticated source URL.')
        if doc.get('knowledge_id') and parse_qs(p.query).get('knowledge_id') != [doc['knowledge_id']]:
            raise ValueError('Source URL points to another catalog document.')
        return url


def build(client, report_year):
    if report_year != '2025/26':
        raise ValueError('This release supports Yeebo ESG FY2025/26 energy layout only.')
    evidence = Evidence(client)
    documents = evidence.catalog['documents']
    docs = [d for d in documents if d.get('report_kind') == 'esg' and d.get('report_fiscal_year') == report_year
            and d.get('ingestion_status') == 'completed']
    if (len(docs) != 2 or {d['language'] for d in docs} != {'en', 'zh-Hant'} or
            not all(d.get('translation_pair_id') for d in docs) or len({d['translation_pair_id'] for d in docs}) != 1):
        raise ValueError('A single authorized, completed bilingual translation pair is required.')
    facts, scope_notes = [], []
    for doc in sorted(docs, key=lambda d: d['language']):
        tables = []
        for number in evidence.search(doc):
            page = evidence.fetch(doc, number)
            try:
                table = parse_table(page['content'], report_year, doc['language'])
                notes = parse_notes(page['content'])
            except ValueError:
                continue
            tables.append((page, table, notes))
        if not tables:
            raise ValueError(f'{doc["source_id"]}: no complete supported energy table and notes found.')
        signature = lambda table: {k: (v['values'], v['energy_group'], v['unit_as_reported'], v['intensity_unit_as_reported']) for k, v in table.items()}
        if any(signature(item[1]) != signature(tables[0][1]) or item[2] != tables[0][2] for item in tables[1:]):
            raise ValueError('Conflicting energy candidate tables require original review.')
        page, table, notes = tables[0]
        current_dates, current_context = evidence.period(doc)
        prior = [d for d in documents if d.get('report_kind') == 'esg' and d.get('language') == doc['language']
                 and d.get('report_fiscal_year') == previous_year(report_year) and d.get('ingestion_status') == 'completed']
        if len(prior) != 1:
            raise ValueError('Comparative report period lacks a unique authorized source.')
        prior_dates, prior_context = evidence.period(prior[0])
        url = evidence.source_url(doc, page)
        note_ref = lambda symbol: {'symbol': symbol, 'quote': notes[symbol], 'source_id': doc['source_id'],
                                   'actual_pdf_page': page['actual_pdf_page'], 'evidence_ids': page['backing_evidence_ids']}
        scope_notes.append(note_ref('&'))
        for carrier, row in table.items():
            for year, values in row['values'].items():
                current = year == report_year
                dates, context = (current_dates, current_context) if current else (prior_dates, prior_context)
                for quantity, value in values.items():
                    is_intensity = quantity == 'intensity'
                    facts.append({'id': f'{doc["source_id"]}-{carrier}-{quantity}-{year.replace("/", "-")}',
                        'entity': 'yeebo', 'metric': carrier + '_' + quantity, 'energy_carrier': carrier,
                        'metric_label': CARRIERS[carrier][1] + ('密度' if is_intensity else '消耗量'),
                        'quantity_kind': quantity, 'energy_group': row['energy_group'], 'value': value,
                        'unit_as_reported': row['intensity_unit_as_reported'] if is_intensity else row['unit_as_reported'],
                        'canonical_unit': 'kWh/m2_finished_goods' if is_intensity else 'kWh',
                        'denominator': 'm2 finished goods' if is_intensity else 'not_applicable',
                        'unit_header_quote': row['unit_header_quote'], 'data_fiscal_year': year,
                        'source_report_fiscal_year': report_year, 'column_role': 'current' if current else 'comparative',
                        'language': doc['language'], 'period_start': dates['start'], 'period_end': dates['end'],
                        'period_provenance': context, 'report_boundary_provenance': current_context,
                        'boundary_status': 'current_report_as_disclosed' if current else 'comparative_boundary_not_independently_confirmed',
                        'source_id': doc['source_id'], 'file_name': doc['file_name'], 'source_sha256': doc['sha256'],
                        'source_revision_md5': page['source_revision_md5'], 'source_url': url,
                        'actual_pdf_page': page['actual_pdf_page'], 'evidence_ids': page['backing_evidence_ids'],
                        'row_quote': row['row_quote'], 'method_notes': [note_ref(CARRIERS[carrier][2])],
                        'method_applicability': 'current_report_note' if current else 'current_report_note; comparative_method_not_independently_confirmed',
                        'conversion_status': 'reported_kWh_preserved; underlying_fuel_conversion_not_verified' if carrier in ('natural_gas', 'diesel', 'petrol') else 'reported_value_preserved',
                        'status': 'proposed', 'review_status': 'pending_source_and_business_review'})
    checks, findings = [], []
    for metric in sorted({f['metric'] for f in facts}):
        for year in (report_year, previous_year(report_year)):
            pair = [f for f in facts if f['metric'] == metric and f['data_fiscal_year'] == year]
            if len(pair) != 2 or len({(f['canonical_unit'], f['period_start'], f['period_end'], f['energy_group']) for f in pair}) != 1:
                raise ValueError('Bilingual energy periods, units or source coverage are incomplete.')
            status = precision_comparison(pair[0]['value'], pair[1]['value'])
            check = {'kind': 'bilingual_numeric', 'metric': metric, 'data_fiscal_year': year,
                     'fact_ids': [f['id'] for f in pair], 'values': [f['value'] for f in pair], 'status': status}
            checks.append(check)
            if status != 'matched':
                findings.append(check.copy())
    checks += [{'kind': 'density_recalculation', 'fact_id': f['id'], 'status': 'not_recomputed_missing_activity_denominator'}
               for f in facts if f['quantity_kind'] == 'intensity']
    findings += [{'kind': 'boundary_notes_require_review', 'status': 'pending_business_review', 'evidence': scope_notes,
                  'note': 'Preserve current scope notes; do not infer like-for-like year-on-year performance.'},
                 {'kind': 'underlying_activity_data_not_verified', 'status': 'pending_authorized_inputs',
                  'note': 'Reported kWh and densities are preserved; no fuel conversion, area or GHG recalculation was performed.'}]
    requests = data_requests(facts)
    return {'schema_version': 'energy-baseline-1', 'generated_at': datetime.now(timezone.utc).isoformat(),
            'entity': evidence.catalog.get('entity_profile'), 'report_fiscal_year': report_year,
            'catalog_revision': evidence.catalog['catalog_revision'], 'facts': facts, 'checks': checks,
            'findings': findings, 'data_requests': requests, 'source_pages': list(evidence.pages.values()),
            'retrieval_trace': evidence.trace, 'status': 'source_linked_pending_review', 'independent_reconstruction': False,
            'limits': ['Forty disclosed table values for five carriers, two quantity kinds, two data years and two languages; only this layout is validated.',
                       'Published-report reorganization, not independent reconstruction, source-ledger audit or compliance approval.',
                       'No underlying fuel-volume-to-kWh conversion, finished-goods area, energy intensity or GHG emissions recalculation.',
                       'No total energy, like-for-like performance, saving-project narrative or target achievement is inferred from these rows.',
                       'Comparative method and boundary are not independently confirmed; current notes are not automatically applied to prior-year data.',
                       'Data requests describe inputs not verified by this public-report workflow, not a claim the company lacks them.',
                       'No private Excel/database authorization is expanded.']}


def data_requests(facts):
    specs = [
        ('finished_goods_area', '製成品產出面積', 'm2', '各年度、公司及生產區域的實際產出面積、統計定義及核准底稿；與密度分子邊界一致。', 'production / finance'),
        ('natural_gas_volume', '天然氣原始消耗量', '原始 m3 或供應商原單位', '發票／錶讀、月份、公司、地區及原始單位，不從 kWh 倒推。', 'facilities / finance'),
        ('diesel_volume', '柴油原始消耗量', '原始 L 或供應商原單位', '採購及期初期末庫存、實際使用量、用途／設施、公司與月份。', 'facilities / finance'),
        ('petrol_volume', '汽油原始消耗量', '原始 L 或供應商原單位', '油卡／發票、實際消耗、車輛／用途、公司與月份。', 'facilities / finance'),
        ('fuel_energy_conversion', '燃料轉 kWh 的換算依據', '原單位至 kWh', '各燃料熱值、換算公式、係數來源／版本及各年度適用方式；不套用模型記憶係數。', 'ESG preparer'),
        ('grid_electricity', '外購電力明細', 'kWh', '按月份／公司／設施拆分的錶讀、電費單、地區，保留彙總與調整紀錄。', 'facilities / finance'),
        ('renewable_energy', '光伏發電、自用及外送明細', 'kWh', '分開發電量、自用、外送、購電及錶號，核對是否有重複計量。', 'facilities'),
        ('reporting_boundary', '當期及比較年度營運邊界', '公司／設施清單', '兩年度納入公司、地區／設施、納入日期及範圍調整；確認能否同口徑比較。', 'ESG preparer / finance'),
    ]
    references = sorted({f'{f["source_id"]}:PDF{f["actual_pdf_page"]}' for f in facts})
    return [{'request_id': key, 'input': label, 'expected_unit': unit, 'required_detail': detail,
             'periods': ', '.join(sorted({f['data_fiscal_year'] for f in facts})), 'suggested_contact_role': role,
             'status': 'not_verified_by_public_report_workflow', 'related_report_evidence': references,
             'acceptance': '取得有來源及核准記錄的底稿後再接入；不以倒算或假設補數。'}
            for key, label, unit, detail, role in specs]


def render_review(report):
    esc = lambda x: html.escape(str(x))
    result = '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>億都 ESG 能源基線</title><style>body{font:15px/1.6 system-ui;color:#19313d;max-width:1350px;margin:32px auto;padding:0 20px}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{padding:8px;border:1px solid #d4e0e5;text-align:left;vertical-align:top}th{background:#eaf3f3}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:650px}.notice{background:#fff4db;padding:14px;border-left:4px solid #c18a24}a{color:#126766}.scroll{overflow-x:auto}</style>'
    result += f'<h1>億都 {esc(report["report_fiscal_year"])} 中英文 ESG 能源基線</h1><p>{len(report["facts"])} 筆報告值；中英數值相符 {sum(c["kind"] == "bilingual_numeric" and c["status"] == "matched" for c in report["checks"])} 組。<a href="baseline.csv" download>下載主表 CSV</a> · <a href="data-requests.csv" download>下載原始數據補件清單</a></p>'
    result += '<p class="notice">待原件及業務覆核。燃料 kWh、原始體積及熱值換算未驗證；製成品面積尚未接入，密度不重算。當期與比較欄不直接作同口徑績效結論。這是公開報告值重組，並非獨立重建。</p>'
    result += '<h2>需覆核事項</h2>'
    for finding in report['findings']:
        result += '<details><summary>' + esc(finding['kind']) + '</summary><pre>' + esc(json.dumps(finding, ensure_ascii=False, indent=2)) + '</pre></details>'
    result += '<h2>指標主表</h2><div class="scroll"><table><tr>' + ''.join('<th>' + x + '</th>' for x in ('語言', '數據財年', '來源欄', '指標', '原值', '原單位', '能源分類', '來源及定位')) + '</tr>'
    for fact in report['facts']:
        result += '<tr>' + ''.join('<td>' + esc(fact[k]) + '</td>' for k in ('language', 'data_fiscal_year', 'column_role', 'metric_label', 'value', 'unit_as_reported', 'energy_group'))
        result += '<td><a href="' + esc(fact['source_url']) + '">' + esc(fact['file_name']) + ' · PDF ' + str(fact['actual_pdf_page']) + '</a><details><summary>原文／欄頭／註腳／日期來源</summary><pre>' + esc(json.dumps({k: fact[k] for k in ('row_quote', 'unit_header_quote', 'method_notes', 'period_provenance', 'evidence_ids')}, ensure_ascii=False, indent=2)) + '</pre></details></td></tr>'
    result += '</table></div><h2>原始數據補件清單</h2><p>以下是本流程尚未核實的輸入，並非認定公司沒有收集。未指定個別同事負責，角色建議待確認。</p><table><tr><th>輸入</th><th>需要明細</th><th>單位</th></tr>'
    for item in report['data_requests']:
        result += '<tr><td>' + esc(item['input']) + '</td><td>' + esc(item['required_detail']) + '</td><td>' + esc(item['expected_unit']) + '</td></tr>'
    result += '</table><h2>本次範圍</h2><ul>' + ''.join('<li>' + esc(limit) + '</li>' for limit in report['limits']) + '</ul></html>'
    return result


def publish(report, output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    data = {'baseline.json': report, 'checks.json': {'checks': report['checks'], 'findings': report['findings'], 'limits': report['limits']},
            'evidence.json': {'catalog_revision': report['catalog_revision'], 'source_pages': report['source_pages'], 'retrieval_trace': report['retrieval_trace']}}
    for name, value in data.items():
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for name, rows in [('baseline.csv', report['facts']), ('data-requests.csv', report['data_requests'])]:
        export_csv(output / name, rows)
        with (output / name).open(encoding='utf-8-sig', newline='') as stream:
            back = list(csv.DictReader(stream))
        if len(back) != len(rows) or (name == 'baseline.csv' and any(a['id'] != b['id'] or a['value'] != b['value'] for a, b in zip(back, rows))):
            raise ValueError('Energy CSV readback differs from validated rows.')
    (output / 'review.html').write_text(render_review(report), encoding='utf-8')
    manifest = {'schema_version': report['schema_version'], 'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in output.iterdir() if p.is_file()}}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return {'output_directory': str(output.resolve()), 'baseline_csv': str((output / 'baseline.csv').resolve()),
            'review_file': str((output / 'review.html').resolve()), 'baseline_json': str((output / 'baseline.json').resolve()),
            'data_requests_csv': str((output / 'data-requests.csv').resolve()), 'facts_written': len(report['facts']),
            'read_back_rows': len(report['facts']), 'data_requests_written': len(report['data_requests']),
            'bilingual_numeric_checks': sum(c['kind'] == 'bilingual_numeric' and c['status'] == 'matched' for c in report['checks']),
            'densities_recomputed': 0, 'findings': report['findings'], 'review_status': report['status'], 'limits': report['limits']}
