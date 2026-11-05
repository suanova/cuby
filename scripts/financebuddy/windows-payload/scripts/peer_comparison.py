"""Bounded, reproducible 2025 peer comparison: live KB + pinned official PDFs.

Values are parsed from verified source tables, never stored in the catalog.
The supported two-company workflow exports and reads back before returning.
Other years/layouts require a separately reviewed catalog/parser, not guesses.
"""
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re

from emissions_baseline import build as build_baseline
from read_public_pdf import download_pdf, read_report

NUMBER = r'(\d[\d,]*\.\d+)'
LIMITS = [
    'FY2025/26 與 2025 年度期間不同；絕對量僅並列，不作排名或效能推斷。',
    '密度分母及涵蓋範圍不同，不換算貨幣、不推算產量、不作直接排名。',
    'Scope 2 依據只記錄原文；未明示雙軌不等於已證實不合規。',
    '僅支援已核對的兩家 2025 報告、三項指標；全部仍待業務覆核。',
]


def numbers(text, pattern, count):
    matches = list(re.finditer(pattern + r'[ \t]*$', text, re.M))
    if len(matches) != 1 or len(matches[0].groups()) != count:
        raise ValueError('Official table layout is missing or ambiguous; no values were guessed.')
    return [Decimal(v.replace(',', '')) for v in matches[0].groups()]


def parse_truly(table, context):
    required = ['2025', '2024', 'HK', 'PRC', 'Total', 'HK$’000 revenue',
                'Scope 1', 'Scope 2']
    if any(s not in table for s in required) or not re.search(r'2025\s+2024', table) or not re.search(
            r'1 January 2025\s+to\s+31 December 2025', context):
        raise ValueError('Truly identity, period or table headings need review.')
    values, calculations = {}, {}
    for metric, scope in [('scope1', 1), ('scope2', 2)]:
        result = numbers(table, rf'^\s*Scope {scope}\s+tonnes of CO2e\s+' +
                         r'\s+'.join([NUMBER] * 4), 4)
        if result[0] + result[1] != result[2]:
            raise ValueError('Truly regional values do not reconcile to the reported total.')
        values[metric] = str(result[2])
    combined = numbers(table, r'^\s*GHG emission \(Scope 1 \+ Scope 2\)\s+tonnes of CO2e\s+' +
                       r'\s+'.join([NUMBER] * 4), 4)
    if Decimal(values['scope1']) + Decimal(values['scope2']) != combined[2]:
        raise ValueError('Truly Scope 1/2 total does not reconcile.')
    intensity = numbers(table, r'^\s*GHG emission \(Scope 1 \+ Scope 2\)\s+tonnes of CO2e/\s+' +
                        r'\s+'.join([NUMBER] * 2), 2)
    values['ghg_intensity'] = str(intensity[0])
    return values, calculations


def parse_solomon(table, context):
    if not re.search(r'2025\s+2024', table) or any(s not in table for s in ['2025', '2024', 'ex-Dongguan', 'Packing Centre',
                                    'tCO2e/million', 'revenue (US$)']):
        raise ValueError('Solomon table headings or intensity units need review.')
    if ('year ended 31 December 2025' not in context or
            'operational control approach' not in context):
        raise ValueError('Solomon reporting period or boundary needs review.')
    values, calculations = {}, {}
    for metric, label in [('scope1', r'Scope 1 — Direct'), ('scope2', r'Scope 2 — Energy indirect')]:
        result = numbers(table, rf'^\s*{label}\s+tCO2e\*?\s+' + r'\s+'.join([NUMBER] * 4), 4)
        values[metric] = str(result[0] + result[1])
        calculations[metric] = {'operation': 'sum', 'inputs': [
            {'label': 'Group ex-Dongguan Testing and Packing Centre', 'value': str(result[0]), 'unit': 'tCO2e'},
            {'label': 'Dongguan Testing and Packing Centre', 'value': str(result[1]), 'unit': 'tCO2e'},
        ]}
    combined = numbers(table, r'^\s*Total GHG emissions\s+tCO2e\s+' +
                       r'\s+'.join([NUMBER] * 2) + r'[ \t]*\n\s*\(Scope 1 and 2\)', 2)
    if Decimal(values['scope1']) + Decimal(values['scope2']) != combined[0]:
        raise ValueError('Solomon calculated Scope 1/2 totals do not reconcile to the reported total.')
    intensity = numbers(table, r'^\s*Total GHG emissions\s+tCO2e/million\s+' +
                        r'\s+'.join([NUMBER] * 2), 2)
    values['ghg_intensity'] = str(intensity[0])
    return values, calculations


def build(adapter, client, root, stock_codes, output_name):
    root = Path(root)
    if (not isinstance(stock_codes, list) or not stock_codes or len(stock_codes) > 2 or
            len(set(stock_codes)) != len(stock_codes) or
            any(code not in ('00732', '02878') for code in stock_codes)):
        raise ValueError('Select one or both supported 2025 peers: 00732, 02878.')
    catalog = json.loads((root / 'cuby/config/peer-report-catalog.json').read_text(encoding='utf-8'))
    baseline = build_baseline(client, '2025/26')
    rows, sources, checks = [], [], []
    selected = [f for f in baseline['facts'] if f['language'] == 'en' and
                f['data_fiscal_year'] == '2025/26' and f['metric'] in ('scope1', 'scope2', 'ghg_intensity')]
    if len(selected) != 3 or len({f['metric'] for f in selected}) != 3:
        raise ValueError('Live knowledge baseline is incomplete; no peer file was published.')
    for fact in selected:
        row = {'company': 'Yeebo（億都）', 'stock_code': '00259', 'report_year': '2025/26',
               'period': fact['period_start'] + ' to ' + fact['period_end'],
               'metric': fact['metric'], 'value': fact['value'], 'unit': fact['unit_as_reported'],
               'boundary': '原報告集團匯報範圍；期間及邊界依據見 baseline.json',
               'denominator': '每平方米製成品；分子未另行明示' if fact['metric'] == 'ghg_intensity' else '',
               'scope2_basis': '外購電力；省級及香港公開因子；所讀原頁未明示 location-based/market-based',
               'source_url': fact['source_url'], 'evidence_id': fact['evidence_ids'][0],
               'actual_pdf_pages': sorted({fact['actual_pdf_page'], fact['period_provenance']['actual_pdf_page'],
                                           *(n['actual_pdf_page'] for n in fact.get('method_notes', []))}),
               'comparability': '不可直接比較：期間及密度分母不同；不排名',
               'notes': '保留原值；未推算製成品面積。因子題名英文 2003／中文 2023 文字差異仍待核。'}
        rows.append(row)
    sources.append({'stock_code': '00259', 'source_sha256': selected[0]['source_sha256'],
                    'source_url': selected[0]['source_url'],
                    'actual_pdf_pages': sorted({p['actual_pdf_page'] for p in baseline['source_pages']
                                               if p['source_id'] == selected[0]['source_id']}),
                    'verification': 'live scoped WeKnora, exact-page revision verified; bilingual checks in baseline.json'})

    for code in stock_codes:
        source = catalog['sources'][code]
        # Re-fetch the public URL once per run, then verify the approved revision.
        # Failed networking or a changed revision stops the run; cached data is not substituted.
        final_url, data = download_pdf(source['url'])
        if hashlib.sha256(data).hexdigest() != source['sha256']:
            raise ValueError(code + ': official report revision changed; review the new PDF before parsing.')
        import pymupdf
        with pymupdf.open(stream=data, filetype='pdf') as doc:
            title_text = '\n'.join(doc[i].get_text(sort=True) for i in range(min(len(doc), 3)))
            identity = 'Truly International' if code == '00732' else 'SOLOMON SYSTECH'
            if identity.casefold() not in title_text.casefold() or '2025' not in title_text:
                raise ValueError('Official PDF identity/year could not be confirmed.')
        pages = [source['table_page'], *source['context_pages']]
        evidence = {}
        for offset in range(0, len(pages), 2):
            result = adapter.read_public_report(source['url'], pages=pages[offset:offset + 2])
            if result['sha256'] != source['sha256']:
                raise ValueError('Cached and live source revisions disagree.')
            evidence.update({p['actual_pdf_page']: p['text'] for p in result['pages']})
        if set(evidence) != set(pages):
            raise ValueError('Full exact-page evidence was not returned; no file was published.')
        context = '\n'.join(evidence[p] for p in source['context_pages'])
        parser = parse_truly if code == '00732' else parse_solomon
        values, calculations = parser(evidence[source['table_page']], context)
        for metric in ('scope1', 'scope2', 'ghg_intensity'):
            intensity = metric == 'ghg_intensity'
            row = {'company': source['company'], 'stock_code': code, 'report_year': '2025',
                   'period': '2025-01-01 to 2025-12-31' if code == '00732' else
                             '2025 annual year ended 2025-12-31; start date not stated on cited period page',
                   'metric': metric, 'value': values[metric],
                   'unit': ("tonnes of CO2e/HK$'000 revenue" if code == '00732' else 'tCO2e/million revenue (US$)')
                           if intensity else 'tCO2e',
                   'boundary': '集團香港及中國製造及銷售業務' if code == '00732' else
                               '營運控制法；集團（除東莞測試包裝中心）與東莞中心分列',
                   'denominator': ("每千港元收益；分子 Scope 1+2" if code == '00732' else
                                   '每百萬美元收益；分子 Scope 1+2+3') if intensity else '',
                   'scope2_basis': '外購電力；所讀頁未明示 location-based/market-based' if code == '00732' else
                                   '外購電力；列中國 MEE 2023、台灣 MOEA 2023、香港 CLP 2024；未列雙軌數值',
                   'source_url': source['url'], 'actual_pdf_pages': pages,
                   'comparability': '不可直接比較：期間／邊界／密度分母及分子不同；不排名',
                   'notes': ('計算值：兩個營運組別合計；輸入及算式另存 calculation。' if metric in calculations else
                             '原表直接披露值。') + (' 2024 重列註5僅指 Scope 3 廢物數值，不概括為所有2024數據重列。'
                                                  if code == '02878' else '')}
            if metric in calculations:
                row['calculation'] = calculations[metric]
            rows.append(row)
        sources.append({'stock_code': code, 'title': source['title'], 'source_url': final_url,
                        'source_sha256': source['sha256'], 'actual_pdf_pages': pages,
                        'online_checked_at': datetime.now(timezone.utc).isoformat(),
                        'page_text': {str(p): t for p, t in evidence.items()}})
        checks.append({'stock_code': code, 'regional_scope12_reconciliation': 'matched',
                       'official_revision': 'matched'})

    # Export and full field read-back are mandatory before a success receipt exists.
    exported = adapter.export_peer_comparison(rows, output_name + '.csv')
    folder = Path(exported['file_path']).with_suffix('')
    folder.mkdir(exist_ok=False)
    baseline_path = folder / 'baseline.json'
    baseline_path.write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    report = {'schema_version': '0.1.0', 'generated_at': datetime.now(timezone.utc).isoformat(),
              'status': 'exported_pending_business_review', 'rows': rows, 'sources': sources,
              'checks': checks, 'calculation_checks': exported['calculation_checks'],
              'csv_sha256': hashlib.sha256(Path(exported['file_path']).read_bytes()).hexdigest(),
              'read_back_rows': exported['read_back_rows'], 'limits': LIMITS}
    report_path = folder / 'comparison.json'
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    summary = [{'company': next(r['company'] for r in rows if r['stock_code'] == code), 'stock_code': code,
                'metrics': {r['metric']: {'value': r['value'], 'unit': r['unit'], 'denominator': r['denominator']}
                            for r in rows if r['stock_code'] == code},
                'period': next(r['period'] for r in rows if r['stock_code'] == code),
                'boundary': next(r['boundary'] for r in rows if r['stock_code'] == code),
                'scope2_basis': next(r['scope2_basis'] for r in rows if r['stock_code'] == code),
                'source_url': next(r['source_url'] for r in rows if r['stock_code'] == code),
                'actual_pdf_pages': next(r['actual_pdf_pages'] for r in rows if r['stock_code'] == code)}
               for code in ['00259', *stock_codes]]
    return {**exported, 'status': report['status'], 'summary': summary, 'limits': LIMITS,
            'source_checks': checks, 'source_revision_policy': 'Fresh official URL fetch + approved SHA256; live KB read.',
            'supporting_paths': [str(report_path), str(baseline_path)]}
