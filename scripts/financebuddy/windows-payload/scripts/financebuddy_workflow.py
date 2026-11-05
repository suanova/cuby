"""Evidence-driven workpapers and historical report reconstruction, stdlib only.

The agent extracts and proposes facts, disclosures and rule mappings. This
runner validates their provenance, computes comparisons, and assembles drafts.
It does not independently establish legal applicability or approve prose.
"""
import argparse
import csv
import hashlib
import html
import json
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

VERSION = '0.1.0'
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8')

SECTIONS = {
    'annual': ['corporate_information', 'chairman_statement', 'management_discussion',
               'corporate_governance', 'directors_report', 'financial_statements', 'financial_notes'],
    'esg': ['reporting_scope', 'governance', 'stakeholders_materiality', 'environment',
            'climate', 'employment', 'operating_practices', 'community', 'disclosure_index'],
}


def decimal(value):
    if isinstance(value, bool):
        raise ValueError('Boolean is not a numeric fact')
    try:
        result = Decimal(str(value).replace(',', ''))
    except InvalidOperation as e:
        raise ValueError('Invalid numeric fact') from e
    if not result.is_finite():
        raise ValueError('Fact must be finite')
    return result


def validate(data):
    for field in ('entity', 'fiscal_year', 'period_start', 'period_end'):
        if not data.get(field):
            raise ValueError(f'Missing {field}')
    if date.fromisoformat(data['period_start']) >= date.fromisoformat(data['period_end']):
        raise ValueError('Invalid target period')
    sources = {s['id']: s for s in data.get('sources', [])}
    if len(sources) != len(data.get('sources', [])):
        raise ValueError('Duplicate source IDs')
    for source in sources.values():
        if not source.get('title') or not re.fullmatch(r'[0-9a-f]{64}', source.get('sha256', '')):
            raise ValueError('Sources need title and SHA-256 revision')
    facts = data.get('facts', [])
    if len({f['id'] for f in facts}) != len(facts):
        raise ValueError('Duplicate fact IDs')
    for fact in facts:
        for field in ('entity', 'metric', 'period_start', 'period_end', 'unit', 'source_id', 'location', 'boundary'):
            if not fact.get(field):
                raise ValueError(f"Fact {fact['id']} missing {field}")
        if fact['source_id'] not in sources:
            raise ValueError('Unknown fact source')
        if date.fromisoformat(fact['period_start']) >= date.fromisoformat(fact['period_end']):
            raise ValueError('Invalid fact period')
        decimal(fact['value'])
        if fact.get('status') not in ('proposed', 'reviewed'):
            raise ValueError('Fact status must be proposed or reviewed')
    ids = {f['id'] for f in facts}
    disclosures = {d['id']: d for d in data.get('disclosures', [])}
    for d in disclosures.values():
        if d.get('source_id') not in sources or not d.get('location') or not d.get('text'):
            raise ValueError('Disclosure needs source, location and text')
    for rule in data.get('rules', []) + data.get('previous_rules', []):
        if rule.get('verified') and (not rule.get('version') or rule.get('source_id') not in sources):
            raise ValueError('Verified rule needs a known source and version')
        if any(fid not in disclosures or disclosures[fid].get('status') != 'reviewed'
               for fid in rule.get('reviewed_narrative_evidence', [])):
            raise ValueError('Unknown reviewed disclosure evidence')
    for section in data.get('sections', []):
        if section.get('report') not in SECTIONS:
            raise ValueError('Unknown report kind')
        if any(fid not in ids for fid in section.get('fact_ids', [])):
            raise ValueError('Report section references unknown fact')
        for paragraph in section.get('paragraphs', []):
            if not paragraph.get('source_ids') or any(s not in sources for s in paragraph['source_ids']):
                raise ValueError('Narrative paragraph needs known sources')
            if paragraph.get('status') not in ('draft', 'approved'):
                raise ValueError('Narrative status must be draft or approved')
    return sources


def is_current(data, fact):
    return (fact['entity'], fact['period_start'], fact['period_end']) == (
        data['entity'], data['period_start'], data['period_end'])


def baseline(data):
    return [{**f, 'target_period': is_current(data, f)} for f in data.get('facts', [])]


def disclosure_gaps(data):
    current = [f for f in data.get('facts', []) if is_current(data, f) and f['status'] == 'reviewed']
    result = []
    for rule in data.get('rules', []):
        applicability = rule.get('applicability', 'unconfirmed')
        matching = [f['id'] for f in current if f['metric'] in rule.get('metrics', [])]
        narrative = rule.get('reviewed_narrative_evidence', [])
        required = rule.get('requirement')
        if not rule.get('verified') or not rule.get('source_id'):
            status = 'rule_version_unverified'
        elif applicability == 'unconfirmed':
            status = 'applicability_unconfirmed'
        elif applicability == 'not_applicable':
            status = 'not_applicable_review_reason'
        elif rule.get('exemption_evidence'):
            status = 'exemption_or_explanation_review'
        elif required not in ('quantitative', 'qualitative', 'either'):
            status = 'requirement_mapping_unconfirmed'
        elif ((required == 'quantitative' and rule.get('metrics') and
               set(rule['metrics']).issubset({f['metric'] for f in current}))
              or (required == 'qualitative' and narrative)
              or (required == 'either' and (matching or narrative))):
            status = 'evidence_mapped_for_review'
        else:
            status = 'potential_gap_in_supplied_evidence'
        result.append({'rule_id': rule['id'], 'version': rule.get('version'),
                       'requirement': required, 'status': status, 'fact_ids': matching,
                       'source_id': rule.get('source_id'), 'reason': rule.get('applicability_reason', '')})
    return result


def quantitative_transition(data):
    previous = {r['id']: r for r in data.get('previous_rules', [])}
    current_facts = {f['metric']: f for f in data.get('facts', []) if is_current(data, f) and f['status'] == 'reviewed'}
    rows = []
    for rule in data.get('rules', []):
        old = previous.get(rule['id'])
        if not old or not old.get('verified') or not rule.get('verified'):
            status = 'requires_verified_old_and_new_rules'
        elif old.get('requirement') != 'quantitative' and rule.get('requirement') == 'quantitative':
            status = 'new_quantitative_requirement_for_applicability_review'
        elif rule.get('requirement') == 'quantitative':
            status = 'existing_quantitative_requirement'
        else:
            status = 'no_quantitative_transition_in_supplied_mapping'
        rows.append({'rule_id': rule['id'], 'old_version': old.get('version') if old else None,
                     'new_version': rule.get('version'), 'status': status,
                     'missing_metrics': [m for m in rule.get('metrics', []) if m not in current_facts],
                     'applicability': rule.get('applicability', 'unconfirmed'),
                     'owner': rule.get('owner', ''), 'source_id': rule.get('source_id')})
    return rows


def peer_comparison(data):
    own = [f for f in data.get('facts', []) if is_current(data, f) and f['status'] == 'reviewed']
    peers = [f for f in data.get('facts', []) if f['entity'] != data['entity']]
    result = []
    keys = ['period_start', 'period_end', 'unit', 'boundary', 'method', 'denominator', 'scope2_basis']
    for fact in own:
        for peer in (p for p in peers if p['metric'] == fact['metric']):
            differences = [k for k in keys if fact.get(k) != peer.get(k)]
            if not peer.get('comparability_approved') or not fact.get('comparability_approved'):
                differences.append('comparability_not_approved')
            if peer['status'] != 'reviewed':
                differences.append('peer_fact_not_reviewed')
            row = {'metric': fact['metric'], 'entity': peer['entity'], 'own_fact_id': fact['id'],
                   'peer_fact_id': peer['id'], 'own_value': fact['value'], 'peer_value': peer['value'],
                   'unit': fact['unit'], 'status': 'not_directly_comparable' if differences else 'comparable',
                   'differences': differences, 'difference_peer_minus_own': None}
            if not differences:
                row['difference_peer_minus_own'] = str(decimal(peer['value']) - decimal(fact['value']))
            result.append(row)
    return result


def consistency(data):
    groups = defaultdict(list)
    for fact in data.get('facts', []):
        groups[tuple(fact[k] for k in ('entity', 'metric', 'period_start', 'period_end'))].append(fact)
    rows = []
    for group in groups.values():
        for n, a in enumerate(group):
            for b in group[n + 1:]:
                if a['id'] == b['id']:
                    continue
                differing = [k for k in ('unit', 'boundary', 'method', 'denominator', 'scope2_basis') if a.get(k) != b.get(k)]
                av, bv = decimal(a['value']), decimal(b['value'])
                if differing:
                    status = 'basis_difference_for_review'
                elif av == bv:
                    status = 'values_equal'
                elif min(av.as_tuple().exponent, bv.as_tuple().exponent) < 0 and (
                        av.quantize(Decimal(1).scaleb(bv.as_tuple().exponent)) == bv
                        or bv.quantize(Decimal(1).scaleb(av.as_tuple().exponent)) == av):
                    status = 'display_precision_difference_for_review'
                else:
                    status = 'value_difference_for_review'
                rows.append({'fact_a': a['id'], 'fact_b': b['id'], 'metric': a['metric'],
                             'value_a': a['value'], 'value_b': b['value'], 'status': status,
                             'basis_differences': differing})
    return rows


def export_csv(path, rows):
    fields = list(dict.fromkeys(k for row in rows for k in row)) or ['status']
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            safe = {}
            for k, value in row.items():
                s = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else ('' if value is None else str(value))
                safe[k] = "'" + s if s[:1] in ('=', '+', '-', '@') and not s.lstrip('-').replace('.', '', 1).isdigit() else s
            writer.writerow(safe)


def report_html(data, report, source_map):
    esc = lambda x: html.escape(str(x))
    facts = {f['id']: f for f in data.get('facts', [])}
    sections = {s['id']: s for s in data.get('sections', []) if s['report'] == report}
    missing = [s for s in SECTIONS[report] if s not in sections or
               not (sections[s].get('fact_ids') or sections[s].get('paragraphs'))]
    title = f"{data['entity']} {data['fiscal_year']} {'年報' if report == 'annual' else 'ESG 報告'} 草稿"
    body = [f'<h1>{esc(title)}</h1>', '<p class="notice">歷史資料重建草稿　待業務復核及批准</p>',
            f"<p>報告期 {esc(data['period_start'])} 至 {esc(data['period_end'])}。未提供資料以待補標示。此草稿不代表已完成法定披露或審計。</p>"]
    for sid in list(dict.fromkeys(SECTIONS[report] + list(sections))):
        section = sections.get(sid)
        body.append(f'<h2>{esc(section.get("title", sid) if section else sid)}</h2>')
        if not section:
            body.append('<p class="missing">待補　此章節尚未提供輸入資料</p>')
            continue
        for para in section.get('paragraphs', []):
            body.append(f'<p>{esc(para["text"])}</p><p class="source">{esc(para["status"])} · 來源 {esc(", ".join(para["source_ids"]))}</p>')
        selected = [facts[fid] for fid in section.get('fact_ids', [])]
        if selected:
            body.append('<table><thead><tr><th>指標</th><th>期間</th><th>原值</th><th>原單位</th><th>來源及位置</th></tr></thead><tbody>')
            for f in selected:
                body.append('<tr>' + ''.join(f'<td>{esc(v)}</td>' for v in [f['metric'], f['period_start'] + ' — ' + f['period_end'], f['value'], f['unit'], f['source_id'] + ' · ' + f['location'] + ' · ' + f['status']]) + '</tr>')
            body.append('</tbody></table>')
        if not selected and not section.get('paragraphs'):
            body.append('<p class="missing">待補　章節沒有指標或敘述資料</p>')
    body.append('<h2>來源與修訂記錄</h2>')
    for s in source_map.values():
        body.append(f'<p class="source">{esc(s["id"])}　{esc(s["title"])}<br>SHA256 {esc(s["sha256"])}<br>{esc(s.get("url", ""))}</p>')
    style = 'body{font:15px "Microsoft JhengHei",sans-serif;max-width:1000px;margin:48px auto;color:#172b37;line-height:1.6}h1{font-size:28px;color:#000}h2{font-size:20px;color:#000;margin-top:32px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #ccd5da;padding:9px;text-align:left;vertical-align:top}th{background:#e7eff2}.notice,.missing{background:#fff4d9;padding:12px}.source{font-size:11px;overflow-wrap:anywhere;color:#4d5e68}@media print{body{margin:20px}h2{break-after:avoid}tr{break-inside:avoid}}'
    return '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>' + esc(title) + '</title><style>' + style + '</style>' + ''.join(body) + '</html>', missing


def run(data, output):
    source_map = validate(data)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    workpapers = {'01-disclosure-gaps': disclosure_gaps(data), '02-quantitative-transition': quantitative_transition(data),
                  '03-metric-baseline': baseline(data), '04-peer-comparison': peer_comparison(data),
                  '05-consistency': consistency(data)}
    for name, rows in workpapers.items():
        export_csv(output / (name + '.csv'), rows)
    report_status = {}
    for report in SECTIONS:
        document, missing = report_html(data, report, source_map)
        (output / (report + '-draft.html')).write_text(document, encoding='utf-8')
        report_status[report] = {'missing_sections': missing, 'status': 'partial_draft' if missing else 'draft_requires_review'}
    result = {'version': VERSION, 'generated_at': datetime.now(timezone.utc).isoformat(),
              'entity': data['entity'], 'fiscal_year': data['fiscal_year'],
              'input_sha256': hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
              'input_source_hashes': [s['sha256'] for s in source_map.values()],
              'rule_catalog_complete': bool(data.get('rule_catalog_complete', False)),
              'data_gaps': data.get('missing_inputs', []) +
                           ([] if data.get('rules') else ['No target rule catalogue or disclosure mapping supplied.']) +
                           ([] if data.get('previous_rules') else ['No verified prior rule mapping supplied.']),
              'workpapers': workpapers, 'reports': report_status,
              'report_fact_ids': {kind: list(dict.fromkeys(fid for s in data.get('sections', [])
                                     if s['report'] == kind for fid in s.get('fact_ids', []))) for kind in SECTIONS},
              'limits': ['Rule applicability and evidence mappings require business review.',
                         'Narrative support is not established merely by supplying a source ID.',
                         'Complete section names do not establish a complete or compliant report.']}
    (output / 'run.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return result


def evaluate(run_result, reference):
    # Held-out facts must be prepared separately. Same-source reconstruction is
    # useful for plumbing tests, but cannot pass the independence criterion.
    overlap = sorted(set(run_result['input_source_hashes']) & set(reference.get('report_source_hashes', [])))
    actual = run_result['workpapers']['03-metric-baseline']
    report_kind = reference.get('report_kind')
    if report_kind:
        if report_kind not in SECTIONS:
            raise ValueError('Unknown reference report_kind')
        included = set(run_result.get('report_fact_ids', {}).get(report_kind, []))
        actual = [f for f in actual if f['id'] in included]
    rows = []
    for expected in reference.get('facts', []):
        candidates = [f for f in actual if all(f.get(k) == expected.get(k)
                      for k in ('entity', 'metric', 'period_start', 'period_end'))]
        for optional in ('language', 'denominator', 'method', 'boundary'):
            if expected.get(optional) is not None:
                candidates = [f for f in candidates if f.get(optional) == expected[optional]]
        if not candidates:
            status = 'missing'
        elif any(f.get('unit') != expected.get('unit') for f in candidates):
            status = 'basis_mismatch'
        elif any(abs(decimal(f['value']) - decimal(expected['value'])) > decimal(expected.get('tolerance', 0)) for f in candidates):
            status = 'value_mismatch'
        else:
            status = 'matched'
        rows.append({'id': expected['id'], 'status': status, 'generated_fact_ids': [f['id'] for f in candidates]})
    return {'independent_holdout': not overlap and bool(reference.get('report_source_hashes')),
            'source_overlap': overlap, 'facts': rows, 'matched': sum(r['status'] == 'matched' for r in rows),
            'evaluation_target': report_kind or 'baseline_fact_registry_only',
            'generation_report_status': run_result.get('reports', {}).get(report_kind) if report_kind else None,
            'total': len(rows), 'scope': 'Supplied labelled facts only; no full narrative or statutory completeness score.'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    generate = sub.add_parser('run')
    generate.add_argument('--input', required=True)
    generate.add_argument('--output', required=True)
    check = sub.add_parser('evaluate')
    check.add_argument('--run', required=True)
    check.add_argument('--reference', required=True)
    check.add_argument('--output', required=True)
    args = p.parse_args()
    if args.command == 'run':
        r = run(json.loads(Path(args.input).read_text(encoding='utf-8-sig')), args.output)
        print(json.dumps({'output': str(Path(args.output).resolve()), 'reports': r['reports'],
                          'workpaper_rows': {k: len(v) for k, v in r['workpapers'].items()}}, ensure_ascii=False))
    else:
        r = evaluate(json.loads(Path(args.run).read_text(encoding='utf-8-sig')),
                     json.loads(Path(args.reference).read_text(encoding='utf-8-sig')))
        Path(args.output).write_text(json.dumps(r, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(r, ensure_ascii=False))


if __name__ == '__main__':
    main()
