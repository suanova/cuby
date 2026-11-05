"""Source-linked bilingual GHG table baseline, from live scoped WeKnora evidence.

This bounded extractor supports the paired-year FY2025/26 Yeebo table layout.
It contains no expected metric values, source IDs, page numbers, or model key.
Original PDFs, independent gold answers and old curated facts are not its input.
"""
import csv
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import html
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlsplit
from financebuddy_workflow import export_csv

METRICS = {
    'scope1': r'(?:Scope\s*1\s*[:：]|範圍\s*1\s*[:：])',
    'scope2': r'(?:Scope\s*2\s*[:：]|範圍\s*2\s*[:：])',
    'scope3': r'(?:Scope\s*3\s*[:：]|範圍\s*3\s*[:：])',
    'total_ghg': r'(?:Total\s+GHG\s+emissions|溫室氣體排放總量)',
    'ghg_intensity': r'(?:\bIntensity\b|密度)',
}
LABELS = {'scope1': '範圍一', 'scope2': '範圍二', 'scope3': '範圍三',
          'total_ghg': '排放總量', 'ghg_intensity': '排放密度'}
DECIMAL = re.compile(r'(?<![\d.])[+−-]?\d[\d,]*\.\d+(?!\d)')
YEAR_PAIR = re.compile(r'(?:FY)?(20\d{2}/\d{2})\s+(?:FY)?(20\d{2}/\d{2})')


def finite(value):
    try:
        number = Decimal(str(value).replace(',', '').replace('−', '-'))
    except (InvalidOperation, ValueError):
        raise ValueError('Source value is not numeric.') from None
    if not number.is_finite() or number < 0:
        raise ValueError('Non-finite or negative source value needs review.')
    return number


def previous_year(year):
    start, end = year.split('/')
    return f'{int(start) - 1}/{(int(end) - 1) % 100:02d}'


def parse_table(content, report_year):
    """Read labelled rows only, mapped by the table's last adjacent year header."""
    text = re.split(r'Remarks\s*:|註\s*[:：]', content, maxsplit=1, flags=re.I)[0]
    text = re.sub(r'#+', ' ', text)
    marks = sorted((m.start(), m.end(), key) for key, pattern in METRICS.items()
                   for m in re.finditer(pattern, text, re.I))
    if not marks:
        raise ValueError('No supported labelled emissions table on this evidence page.')
    headers = YEAR_PAIR.findall(re.sub(r'\s+', ' ', text[:marks[0][0]]))
    if not headers or set(headers[-1]) != {report_year, previous_year(report_year)}:
        raise ValueError('Explicit current/comparative table headers are missing or ambiguous.')
    years = headers[-1]
    rows = {}
    for i, (start, end, metric) in enumerate(marks):
        segment = text[start:marks[i + 1][0] if i + 1 < len(marks) else len(text)].strip()
        values = DECIMAL.findall(segment[end - start:])
        if len(values) != 2:
            raise ValueError(f'{metric}: expected exactly two source decimals, not a guessed column.')
        language = 'zh-Hant' if '噸二氧化碳當量' in segment else 'en'
        if language == 'zh-Hant':
            unit_ok = '噸二氧化碳當量' in segment
            unit = '噸二氧化碳當量'
        else:
            unit_ok = bool(re.search(r'tCO2\s*e', segment))
            unit = 'tCO2 e'
        if metric == 'ghg_intensity':
            if language == 'zh-Hant':
                unit_ok = unit_ok and '每平方米製成品' in segment
                unit += '╱每平方米製成品'
            else:
                unit_ok = unit_ok and bool(re.search(r'/\s*m2\s*finished', segment)) and 'goods' in segment
                unit += '/m2 finished goods'
        if not unit_ok:
            raise ValueError(f'{metric}: unsupported or incomplete original unit.')
        row = {'values': {y: str(finite(v)) for y, v in zip(years, values)},
               'unit_as_reported': unit, 'canonical_unit': 'tCO2e/m2_finished_goods'
               if metric == 'ghg_intensity' else 'tCO2e', 'row_quote': segment}
        if metric in rows and rows[metric]['values'] != row['values']:
            raise ValueError(f'{metric}: conflicting duplicate indexed rows require source review.')
        if metric not in rows or len(segment) > len(rows[metric]['row_quote']):
            rows[metric] = row
    if set(rows) != set(METRICS):
        raise ValueError('Incomplete five-metric emissions table; no missing values were filled.')
    return rows


def note(content, language, number):
    marker = (rf'(?:^|\s){number}\.\s*Scope\s*{number}\s*[–—-]'
              if language == 'en' else rf'(?:^|\s){number}\s+範圍\s*{number}\s*[－–—-]')
    match = re.search(marker, content, re.I)
    if not match:
        return None
    rest = content[match.start():].strip()
    if number < 3:
        stop = (rf'(?:^|\s){number + 1}\.\s*Scope\s*{number + 1}\s*[–—-]'
                if language == 'en' else rf'(?:^|\s){number + 1}\s+範圍\s*{number + 1}\s*[－–—-]')
        rest = re.split(stop, rest, maxsplit=1, flags=re.I)[0]
    else:
        rest = re.split(r'Distributions of Scope 3|範圍3的溫室氣體\s*排放分佈', rest, maxsplit=1, flags=re.I)[0]
    rest = re.split(r'\nYeebo\s*\(', rest, maxsplit=1)[0]
    return rest.strip()


def precision_comparison(left, right):
    a, b = finite(left), finite(right)
    if a == b:
        return 'matched'
    places = min(max(0, -a.as_tuple().exponent), max(0, -b.as_tuple().exponent))
    quantum = Decimal(1).scaleb(-places)
    from decimal import ROUND_HALF_UP
    return 'rounding_consistent_requires_review' if a.quantize(quantum, rounding=ROUND_HALF_UP) == b.quantize(quantum, rounding=ROUND_HALF_UP) else 'different_requires_review'


def build(client, report_year):
    if report_year != '2025/26':
        raise ValueError('This release supports Yeebo ESG FY2025/26 only; other layouts need separate validation.')
    catalog = client.call('list_documents', {'entity': 'yeebo'})
    documents = catalog['documents']
    docs = [d for d in documents if d.get('report_kind') == 'esg' and
            d.get('report_fiscal_year') == report_year and d.get('ingestion_status') == 'completed']
    if (len(docs) != 2 or {d['language'] for d in docs} != {'zh-Hant', 'en'} or
            not all(d.get('translation_pair_id') for d in docs) or len({d['translation_pair_id'] for d in docs}) != 1):
        raise ValueError('A single authorized, completed Chinese/English translation pair is required.')
    pages, trace, facts, methods, contexts = {}, [], [], {}, {}

    def fetch(doc, page):
        key = (doc['source_id'], page)
        if key not in pages:
            data = client.call('read_source_page', {'source_id': key[0], 'actual_pdf_page': page})
            if (data.get('status') != 'ok' or not data.get('complete_index_scan') or data.get('response_truncated') or
                    data.get('source_sha256') != doc['sha256'] or data.get('source_id') != key[0] or
                    data.get('actual_pdf_page') != page or not data.get('backing_evidence_ids') or
                    data.get('language') != doc['language'] or data.get('report_fiscal_year') != doc['report_fiscal_year']):
                raise ValueError('Incomplete, unauthorized or changed source evidence; no baseline was published.')
            if not all(re.fullmatch(re.escape(key[0]) + r':[0-9a-f-]{36}', e) for e in data['backing_evidence_ids']):
                raise ValueError('Malformed evidence ID in source response.')
            if not re.fullmatch(r'[a-f0-9]{32}', data.get('source_revision_md5', '')) or any(
                    p['source_revision_md5'] != data['source_revision_md5'] for k, p in pages.items() if k[0] == key[0]):
                raise ValueError('Source revision changed during page collection.')
            pages[key] = data
        return pages[key]

    def search_pages(doc, query):
        result = client.call('search_evidence', {'entity': 'yeebo', 'source_ids': [doc['source_id']],
                                               'query': query, 'top_k': 3})
        if result.get('status') != 'ok' or result.get('selected_source_ids') != [doc['source_id']]:
            raise ValueError('Scoped source retrieval failed.')
        rerank = result.get('retrieval', {}).get('rerank', [])
        if not rerank or any(not r.get('applied') or r.get('outcome') != 'ok' for r in rerank):
            raise ValueError('Required ReRank did not complete; no fallback evidence was substituted.')
        candidates = []
        for e in result.get('evidence', []):
            if e.get('source_id') != doc['source_id'] or e.get('source_sha256') != doc['sha256'] or not e.get('locator_revision_verified'):
                raise ValueError('Search evidence scope/revision mismatch.')
            for p in e.get('actual_pdf_pages', []):
                if p not in candidates:
                    candidates.append(p)
        trace.append({'source_id': doc['source_id'], 'query': query,
                      'actual_candidate_pages': candidates, 'retrieval': result.get('retrieval')})
        return candidates[:6]

    for doc in sorted(docs, key=lambda d: d['language']):
        sid, lang = doc['source_id'], doc['language']
        query = ('Greenhouse Gas Scope 1 Scope 2 Scope 3 Total GHG emissions Intensity' if lang == 'en'
                 else '溫室氣體 範圍1 範圍2 範圍3 排放總量 密度')
        tables = []
        for p in search_pages(doc, query):
            page = fetch(doc, p)
            try:
                table = parse_table(page['content'], report_year)
            except ValueError:
                continue
            tables.append((page, table))
        if not tables:
            raise ValueError(f'{sid}: no complete supported table found; check the original document.')
        if any(t[1] != tables[0][1] for t in tables[1:]):
            raise ValueError(f'{sid}: multiple differing candidate tables require review.')
        table_page, table = tables[0]
        source_notes = {}
        for n in (1, 2, 3):
            for key, p in list(pages.items()):
                if key[0] == sid and (quote := note(p['content'], lang, n)):
                    source_notes[n] = {'quote': quote, 'actual_pdf_page': key[1], 'evidence_ids': p['backing_evidence_ids']}
            if n not in source_notes:
                query = ('Scope 3 note 3 Greenhouse Gas Protocol emission factors downstream transportation'
                         if lang == 'en' else '3 範圍3 溫室氣體盤查議定書 排放因子 下游運輸')
                for p in search_pages(doc, query):
                    data = fetch(doc, p)
                    if quote := note(data['content'], lang, n):
                        source_notes[n] = {'quote': quote, 'actual_pdf_page': p, 'evidence_ids': data['backing_evidence_ids']}
                        break
            if n not in source_notes:
                raise ValueError(f'{sid}: footnote {n} was not recovered; no method was guessed.')
        period = doc['report_period']
        period_ref = period['source_evidence']
        if sid not in period_ref['source_ids']:
            raise ValueError('Current report date provenance belongs to another document.')
        context = fetch(doc, period_ref['actual_pdf_page'])
        contexts[sid] = {'source_id': sid, 'report_period': period, 'context_page': context['actual_pdf_page'],
                         'period_and_boundary_quote': context['content'], 'evidence_ids': context['backing_evidence_ids']}
        methods[sid] = source_notes
        source_url = next(e['source_url'] for e in catalog.get('documents', []) if e.get('source_id') == sid and e.get('source_url')) if any(e.get('source_id') == sid and e.get('source_url') for e in documents) else None
        if source_url is None:
            # URL comes from a live evidence record, never from a guessed localhost path.
            e = client.call('read_evidence', {'evidence_id': table_page['backing_evidence_ids'][0]})['evidence']
            if e['source_sha256'] != doc['sha256'] or e['source_id'] != sid or not e['locator_revision_verified']:
                raise ValueError('Evidence URL revision mismatch.')
            source_url = e['source_url']
        parsed_url = urlsplit(source_url)
        if parsed_url.scheme != 'http' or parsed_url.hostname not in ('localhost', '127.0.0.1') or not parsed_url.path.startswith('/platform/knowledge-bases/'):
            raise ValueError('Unexpected authenticated document link.')
        if doc.get('knowledge_id') and parse_qs(parsed_url.query).get('knowledge_id') != [doc['knowledge_id']]:
            raise ValueError('Document link points to a different catalog document.')
        for metric, row in table.items():
            for data_year, value in row['values'].items():
                current = data_year == report_year
                dates = period if current else None
                date_ref = {'source_id': sid, 'actual_pdf_page': context['actual_pdf_page'], 'evidence_ids': context['backing_evidence_ids']}
                if not current:
                    prior = next((d for d in documents if d.get('report_kind') == 'esg' and d.get('language') == lang and
                                  d.get('report_fiscal_year') == data_year and d.get('ingestion_status') == 'completed'), None)
                    if prior:
                        dates = prior['report_period']
                        if prior['source_id'] not in dates['source_evidence']['source_ids']:
                            raise ValueError('Comparative date metadata lacks its real source document.')
                        prior_page = fetch(prior, dates['source_evidence']['actual_pdf_page'])
                        date_ref = {'source_id': prior['source_id'], 'actual_pdf_page': prior_page['actual_pdf_page'],
                                    'evidence_ids': prior_page['backing_evidence_ids']}
                    else:
                        raise ValueError('Comparative period dates lack an authorized source; no date was guessed.')
                notes = [source_notes[int(metric[-1])]] if metric.startswith('scope') else list(source_notes.values())
                facts.append({'id': f'{sid}-{metric}-{data_year.replace("/", "-")}', 'entity': 'yeebo',
                    'metric': metric, 'metric_label': LABELS[metric], 'value': value,
                    'unit_as_reported': row['unit_as_reported'], 'canonical_unit': row['canonical_unit'],
                    'data_fiscal_year': data_year, 'source_report_fiscal_year': report_year,
                    'column_role': 'current' if current else 'comparative', 'language': lang,
                    'period_start': dates['start'] if dates else None, 'period_end': dates['end'] if dates else None,
                    'period_provenance': date_ref, 'source_id': sid, 'file_name': doc['file_name'],
                    'source_sha256': doc['sha256'], 'source_url': source_url,
                    'actual_pdf_page': table_page['actual_pdf_page'], 'evidence_ids': table_page['backing_evidence_ids'],
                    'row_quote': row['row_quote'], 'method_notes': notes,
                    'method_applicability': 'current_report_footnotes' if current else 'current_report_footnotes; comparative_method_not_independently_confirmed',
                    'report_boundary_provenance': contexts[sid],
                    'boundary_status': 'current_report_as_disclosed' if current else 'comparative_boundary_not_independently_confirmed',
                    'denominator': 'm2 finished goods' if metric == 'ghg_intensity' else 'not_applicable',
                    'scope2_basis': 'not_explicitly_labelled_location_or_market_in_cited_notes' if metric == 'scope2' else 'not_applicable',
                    'status': 'proposed', 'review_status': 'pending_source_and_business_review'})
    checks, findings = validate_facts(facts, methods)
    return {'schema_version': 'ghg-baseline-1', 'generated_at': datetime.now(timezone.utc).isoformat(),
            'entity': catalog.get('entity_profile'), 'report_fiscal_year': report_year,
            'catalog_revision': catalog['catalog_revision'], 'facts': facts, 'checks': checks,
            'findings': findings, 'source_pages': list(pages.values()), 'retrieval_trace': trace,
            'status': 'source_linked_pending_review', 'independent_reconstruction': False,
            'limits': ['This is a published-report table baseline, not independent report reconstruction or compliance review.',
                       'Five principal metrics for two data years and two languages; excludes chart percentages, targets and carbon-pricing narrative.',
                       'Evidence is indexed text; independent original-PDF review remains required.',
                       'Current reporting scope expanded and factors changed; comparative-column operational boundaries/methods are not independently confirmed.',
                       'Density is preserved as disclosed; no finished-goods activity-area input is available to recompute it.',
                       'No internal Excel/database access or model API credentials are used.']}


def validate_facts(facts, methods):
    checks, findings = [], []
    for sid in sorted({f['source_id'] for f in facts}):
        for year in sorted({f['data_fiscal_year'] for f in facts if f['source_id'] == sid}):
            group = {f['metric']: f for f in facts if f['source_id'] == sid and f['data_fiscal_year'] == year}
            total = sum((finite(group[k]['value']) for k in ('scope1', 'scope2', 'scope3')), Decimal(0))
            reported = finite(group['total_ghg']['value'])
            check = {'kind': 'scope_sum', 'source_id': sid, 'data_fiscal_year': year,
                     'input_fact_ids': [group[k]['id'] for k in ('scope1', 'scope2', 'scope3')],
                     'calculated_value': str(total), 'reported_value': str(reported),
                     'status': 'matched' if total == reported else 'difference_requires_review'}
            checks.append(check)
            if check['status'] != 'matched':
                findings.append(check.copy())
            checks.append({'kind': 'density_recalculation', 'fact_id': group['ghg_intensity']['id'],
                           'status': 'not_recomputed_missing_activity_denominator'})
    for metric in METRICS:
        for year in sorted({f['data_fiscal_year'] for f in facts}):
            pair = [f for f in facts if f['metric'] == metric and f['data_fiscal_year'] == year]
            if len(pair) != 2 or len({f['canonical_unit'] for f in pair}) != 1:
                raise ValueError('Bilingual fact coverage or units are incomplete.')
            status = precision_comparison(pair[0]['value'], pair[1]['value'])
            check = {'kind': 'bilingual_numeric', 'metric': metric, 'data_fiscal_year': year,
                     'fact_ids': [f['id'] for f in pair], 'values': [f['value'] for f in pair], 'status': status}
            checks.append(check)
            if status != 'matched':
                findings.append(check.copy())
    years = []
    for sid, notes in methods.items():
        text = notes[2]['quote']
        for pattern, label in ((r'Provincial Electricity Average Carbon Emission Factors\s+(\d{4})', 'English title'),
                               (r'(\d{4})\s*年省級電力\s*平均二氧化碳排放因數', 'Chinese title')):
            for match in re.finditer(pattern, text, re.I):
                years.append({'source_id': sid, 'title_language': label, 'year_text': match[1],
                              'quote': match[0], 'actual_pdf_page': notes[2]['actual_pdf_page'], 'evidence_ids': notes[2]['evidence_ids']})
    if len({y['year_text'] for y in years}) > 1:
        findings.append({'kind': 'factor_title_year_text_difference', 'status': 'pending_business_review',
                         'evidence': years, 'note': 'Preserve literal titles; no correction or claim of calculation error.'})
    return checks, findings


def render_review(report):
    esc = lambda s: html.escape(str(s))
    source_facts = {f['source_id']: f for f in report['facts']}
    def source_link(sid, page):
        fact = source_facts[sid]
        return f'<a href="{esc(fact["source_url"])}">{esc(fact["file_name"])} · PDF {page}</a>'
    finding_html = ''
    for finding in report['findings']:
        if finding['kind'] == 'factor_title_year_text_difference':
            finding_html += '<p>排放因子題名年份文字有差異，保留原文待業務確認。此項不代表已判定排放計算錯誤。</p><table><tr><th>來源版本及頁碼</th><th>題名</th><th>原文年份</th></tr>'
            for item in finding['evidence']:
                finding_html += '<tr><td>' + source_link(item['source_id'], item['actual_pdf_page']) + '</td><td>' + esc(item['quote']) + '</td><td>' + esc(item['year_text']) + '</td></tr>'
            finding_html += '</table>'
        else:
            finding_html += '<details open><summary>數值核對差異待確認</summary><pre>' + esc(json.dumps(finding, ensure_ascii=False, indent=2)) + '</pre></details>'
    if not finding_html:
        finding_html = '<p>本次指定檢查未產生差異；仍需完成原件及業務覆核。</p>'
    table = ''
    for fact in report['facts']:
        labels = [fact['language'], fact['metric_label'], fact['data_fiscal_year'],
                  '當期' if fact['column_role'] == 'current' else '比較', fact['value'], fact['unit_as_reported']]
        table += '<tr>' + ''.join(f'<td>{esc(v)}</td>' for v in labels)
        table += '<td>' + source_link(fact['source_id'], fact['actual_pdf_page'])
        table += '<details><summary>原文、腳註及日期來源</summary><p>' + esc(fact['row_quote']) + '</p>'
        for item in fact['method_notes']:
            table += f'<p>PDF {item["actual_pdf_page"]}：{esc(item["quote"])}</p>'
        table += '<p>日期來源：' + esc(json.dumps(fact['period_provenance'], ensure_ascii=False)) + '</p>'
        table += '<p>來源報告範圍（比較欄不可直接套用當期邊界）：' + esc(fact['report_boundary_provenance']['period_and_boundary_quote']) + '</p>'
        table += '<details><summary>完整片段 ID</summary><pre>' + esc(json.dumps(fact['evidence_ids'], indent=2)) + '</pre></details></details></td></tr>'
    sums = [c for c in report['checks'] if c['kind'] == 'scope_sum']
    languages = [c for c in report['checks'] if c['kind'] == 'bilingual_numeric']
    sum_table = '<table><tr><th>來源</th><th>數據財年</th><th>工具加總</th><th>原件總量</th><th>結果</th></tr>'
    for c in sums:
        sum_table += '<tr>' + ''.join('<td>' + esc(v) + '</td>' for v in (c['source_id'], c['data_fiscal_year'], c['calculated_value'], c['reported_value'], '相符' if c['status'] == 'matched' else '差異待核')) + '</tr>'
    sum_table += '</table>'
    bilingual_ok = sum(c['status'] == 'matched' for c in languages)
    review = '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>億都 ESG 排放基線</title><style>body{font:15px/1.6 system-ui;max-width:1300px;margin:32px auto;padding:0 20px;color:#19313d}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{padding:9px;border:1px solid #d4e0e5;text-align:left;vertical-align:top}th{background:#eaf3f3}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:700px}details{margin:8px 0}a{color:#126766}.notice{background:#fff4db;padding:14px;border-left:4px solid #c18a24}</style>'
    review += f'<h1>億都 {esc(report["report_fiscal_year"])} ESG 溫室氣體排放基線</h1><p>{len(report["facts"])} 筆主表事實，中英文及當期／比較欄分列。來源連結需登入本機 WeKnora。<a href="baseline.csv" download>下載 CSV 底稿</a></p><p class="notice">待原件及業務覆核。密度按原文保留，缺少製成品面積活動數據，未重新計算。比較欄方法及營運邊界亦需另核。</p>'
    review += '<h2>需覆核差異</h2>' + finding_html
    review += f'<h2>計算核對</h2><p>中英數值：{bilingual_ok}／{len(languages)} 組完全相符。數值相同不代表全部計算方法相同。</p>' + sum_table
    review += '<h2>指標事實</h2><table><thead><tr>' + ''.join(f'<th>{s}</th>' for s in ('語言', '指標', '數據財年', '來源欄', '原值', '原單位', '原件及定位')) + '</tr></thead><tbody>' + table + '</tbody></table>'
    review += '<h2>本次範圍</h2><p>只處理五項排放主表指標的兩個年度及兩種語言。不包含範圍三圖表百分比、全部 ESG 章節、目標或內部碳價敘述。這是公開報告數據重組，並非從獨立原始資料重建報告或法規審核。</p></html>'
    return review


def publish(report, output):
    """Write a new run, CSV/JSON plus a readable review; never overwrite an old run."""
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    files = {'baseline.json': report, 'checks.json': {'checks': report['checks'], 'findings': report['findings'], 'limits': report['limits']},
             'evidence.json': {'catalog_revision': report['catalog_revision'], 'source_pages': report['source_pages'], 'retrieval_trace': report['retrieval_trace']}}
    for name, data in files.items():
        (output / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    export_csv(output / 'baseline.csv', report['facts'])
    with (output / 'baseline.csv').open(encoding='utf-8-sig', newline='') as f:
        readback = list(csv.DictReader(f))
    if len(readback) != len(report['facts']) or any(a['value'] != b['value'] or a['id'] != b['id'] for a, b in zip(readback, report['facts'])):
        raise ValueError('Baseline CSV readback differs from validated facts.')
    (output / 'review.html').write_text(render_review(report), encoding='utf-8')
    manifest = {'schema_version': report['schema_version'], 'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in output.iterdir() if p.is_file()}}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return {'output_directory': str(output.resolve()), 'review_file': str((output / 'review.html').resolve()),
            'baseline_csv': str((output / 'baseline.csv').resolve()), 'baseline_json': str((output / 'baseline.json').resolve()),
            'facts_written': len(report['facts']), 'read_back_rows': len(readback),
            'scope_sum_checks': sum(c['kind'] == 'scope_sum' and c['status'] == 'matched' for c in report['checks']),
            'bilingual_numeric_checks': sum(c['kind'] == 'bilingual_numeric' and c['status'] == 'matched' for c in report['checks']),
            'findings': report['findings'], 'review_status': report['status'], 'limits': report['limits']}
