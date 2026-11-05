"""Candidate-only arithmetic checks. No filesystem, KB, expected values or answer key.

Supports one explicitly labelled paired-FY GHG table per text page. A consistent
table is not evidence that its figures agree with a ledger or reflect reality.
Ambiguous columns, units or components produce an untested result, not an error.
"""
from decimal import Decimal
import re

from emissions_baseline import DECIMAL, METRICS, YEAR_PAIR, finite, previous_year

UNIT = re.compile(r'(?<![A-Za-z])tCO2\s*e(?![A-Za-z])|噸二氧化碳當量')
COMPONENTS = ('scope1', 'scope2', 'scope3')


def check_ghg_totals(pages, fiscal_year):
    """Return independently scoped checks using ONLY rows in the submitted text."""
    results = []
    for page in pages:
        if page.get('is_disclosure_index'):
            continue
        text = re.split(r'Remarks\s*:|註\s*[:：]', page['text'], maxsplit=1, flags=re.I)[0]
        marks = sorted((m.start(), m.end(), key) for key, pattern in METRICS.items()
                       for m in re.finditer(pattern, text, re.I))
        if not marks or not any(key == 'total_ghg' for _, _, key in marks):
            continue
        headers = YEAR_PAIR.findall(re.sub(r'\s+', ' ', text[:marks[0][0]]))
        if not headers or set(headers[-1]) != {fiscal_year, previous_year(fiscal_year)}:
            continue
        years = headers[-1]
        rows, ambiguous = {}, False
        for index, (start, end, key) in enumerate(marks):
            if key not in (*COMPONENTS, 'total_ghg'):
                continue
            if key in rows:
                ambiguous = True
            quote = text[start:marks[index + 1][0] if index + 1 < len(marks) else len(text)].strip()
            values = DECIMAL.findall(quote[end - start:])
            rows[key] = {'quote': quote, 'values': values,
                         'supported': bool(UNIT.search(quote)) and len(values) == 2}
        reason = ''
        if ambiguous:
            reason = '本頁有重複標籤，無法確認屬同一張總量表。'
        elif any(key not in rows or not rows[key]['supported'] for key in (*COMPONENTS, 'total_ghg')):
            reason = '本稿範圍一至三及總量的欄位或單位未能完整對齊，暫不加總。'
        evidence = [{'evidence_id': page['evidence_id'], 'quote': row['quote']} for row in rows.values()]
        for column, year in enumerate(years):
            check = {'id': f"DOC-GHG-SUM-P{page['actual_pdf_page']}-{year.replace('/', '-')}",
                     'label': f'排放加總 · FY{year}', 'kind': 'document_consistency',
                     'clause': '本稿加總', 'rule_quote': '只核對本稿同表、同年、同單位的範圍一至三之和與列報總量；不驗證原始數據。',
                     'actual_pdf_page': page['actual_pdf_page'], 'evidence': evidence,
                     'status': 'internal_calculation_not_testable', 'reason': reason,
                     'next_action': '核實本稿組成、單位及欄位後重算；不能以未檢查當通過。'}
            if not reason:
                try:
                    values = {key: finite(rows[key]['values'][column]) for key in rows}
                    # Each printed value may be rounded independently. Allow the
                    # sum of half its displayed precision; never a relative %.
                    tolerance = sum((Decimal(1).scaleb(value.as_tuple().exponent) / 2 for value in values.values()), Decimal(0))
                    calculated = sum((values[key] for key in COMPONENTS), Decimal(0))
                    total = values['total_ghg']
                    conflict = abs(calculated - total) > tolerance
                    check.update(status='internal_calculation_conflict' if conflict else 'internal_calculation_matches',
                                 reason=f'本稿範圍一至三合計 {calculated}，列報總量 {total} tCO2e（四捨五入容差 {tolerance}）。',
                                 next_action='核對分項及總量底稿，不能直接假設某一個分項正確。' if conflict else '僅加總一致；數據真實性及邊界仍待底稿覆核。',
                                 calculation={'operation': 'sum_scope1_scope2_scope3', 'fiscal_year': year,
                                              'calculated': str(calculated), 'reported': str(total), 'tolerance': str(tolerance)})
                except ValueError:
                    check['reason'] = '本稿數值格式需要人工覆核，未執行加總。'
            conflict = check['status'] == 'internal_calculation_conflict'
            matched = check['status'] == 'internal_calculation_matches'
            check['finding'] = {'level': 'error' if conflict else ('evidence' if matched else 'review'),
                                'title': f"FY{year} 排放{'加總不一致' if conflict else ('加總一致' if matched else '加總未檢查')}",
                                'summary': check['reason'], 'marks': [], 'edit': None}
            if conflict:
                check['conflict_quote'] = rows['total_ghg']['quote']
            results.append(check)
    return results


def main():
    """Standalone check accepts a new draft without ever loading a KB report."""
    import argparse
    import hashlib
    import json
    from pathlib import Path
    import pymupdf

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', required=True, type=Path)
    parser.add_argument('--fiscal-year', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'20\d{2}/\d{2}', args.fiscal_year):
        parser.error('Use a fiscal year such as 2026/27.')
    if args.output.exists() or args.output.resolve() == args.pdf.resolve():
        parser.error('Choose a new output file; original evidence and prior results are preserved.')
    raw = args.pdf.read_bytes()
    if len(raw) > 30 * 1024 * 1024:
        parser.error('PDF exceeds 30 MiB.')
    digest = hashlib.sha256(raw).hexdigest()
    with pymupdf.open(stream=raw, filetype='pdf') as pdf:
        if pdf.is_encrypted or not 1 <= len(pdf) <= 200:
            parser.error('Use a readable PDF with 1–200 pages.')
        pages = []
        for number, page in enumerate(pdf, 1):
            text = page.get_text(sort=True)
            flat = re.sub(r'\s+', '', text).casefold()
            index = ('aspects' in flat and 'kpis' in flat and 'relevantsection' in flat) or ('關鍵績效指標' in flat and '相關章節' in flat and '層面' in flat)
            pages.append({'evidence_id': f'PDF:DRAFT-{digest[:16]}:{number}:{hashlib.sha256(text.encode()).hexdigest()[:16]}',
                          'actual_pdf_page': number, 'text': text, 'is_disclosure_index': index})
    result = {'schema_version': 'candidate-consistency-1', 'source_file': args.pdf.name, 'source_sha256': digest,
              'declared_fiscal_year': args.fiscal_year, 'current_year_answer_key_used': False,
              'prior_year_reference_provided': False, 'underlying_records_verified': False, 'rules_reviewed': False,
              'scope': 'Paired-FY, labelled Scope 1+2+3 arithmetic only; not full consistency or compliance review. No OCR.',
              'scanned_pages': len(pages), 'checks': check_ghg_totals(pages, args.fiscal_year)}
    result['status'] = 'bounded_checks_completed' if result['checks'] else 'no_supported_table_found_not_a_pass'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2); stream.write('\n')
    print(json.dumps({'output': str(args.output), 'checks': len(result['checks']), 'status': result['status']}))


if __name__ == '__main__':
    main()
