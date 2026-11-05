"""Bounded, model-free report identity and read-only scoped history preview.

The gateway authorizes paths. This module binds one bounded bytes snapshot to its
digest and parses that same snapshot; file names never supply identity fields.
"""
import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path

import pymupdf as fitz
import bundled_sources

MAX_BYTES = 30 * 1024 * 1024
MAX_PAGES = 300
SCAN_PAGES = 8
SLOTS = {'esg_en': ('esg', 'en'), 'esg_zh': ('esg', 'zh-Hant'),
         'annual_en': ('annual', 'en'), 'annual_zh': ('annual', 'zh-Hant')}
YEAR = re.compile(r'(?<!\d)(20\d{2})\s*[/\-–]\s*(20\d{2}|\d{2})(?!\d)')


def compact(text):
    return re.sub(r'[\s\x00-\x1f]+', '', text)


def field(status='unknown', value=None, evidence=None, candidates=None):
    result = {'status': status, 'value': value, 'evidence': evidence or []}
    if candidates:
        result['candidates'] = sorted(set(candidates))
    return result


def quote(page, text):
    return {'page': page, 'quote': text.strip()[:500]}


def canonical_year(value):
    if not isinstance(value, str):
        raise ValueError('Use an explicit fiscal year such as 2026/27.')
    match = YEAR.fullmatch(value.strip())
    if not match:
        raise ValueError('Use an explicit fiscal year such as 2026/27.')
    start, end = int(match[1]), int(match[2])
    if end < 100:
        end += (start // 100) * 100
        if end < start:
            end += 100
    if end != start + 1:
        raise ValueError('Fiscal year must span consecutive years.')
    return f'{start}/{end % 100:02d}'


def snapshot(path, expected_sha256=None):
    """One bounded read; the returned bytes are the only parser input."""
    if expected_sha256 is not None and not re.fullmatch(r'[a-fA-F0-9]{64}', str(expected_sha256)):
        raise ValueError('A SHA256 digest from the trusted gateway is required.')
    with Path(path).open('rb') as source:
        raw = source.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('PDF exceeds the 30 MiB inspection limit.')
    digest = hashlib.sha256(raw).hexdigest()
    if expected_sha256 is not None and digest != expected_sha256.lower():
        raise ValueError('PDF bytes changed; add the file again before continuing.')
    return raw, digest


def text_pages(raw):
    with fitz.open(stream=raw, filetype='pdf') as document:
        count = len(document)
        if document.needs_pass:
            raise ValueError('encrypted_pdf')
        if not 1 <= count <= MAX_PAGES:
            raise ValueError('pdf_page_limit')
        pages = [(index + 1, document[index].get_text()[:100000])
                 for index in range(min(count, SCAN_PAGES))]
    return count, pages


def _language(pages):
    # Covers may contain translated titles and company names. Use readable body.
    body = pages[1:] if len(pages) > 1 else pages
    text = '\n'.join(text for _, text in body)
    han = len(re.findall(r'[\u3400-\u9fff]', text))
    latin = len(re.findall(r'[A-Za-z]', text))
    sample = next(((p, t) for p, t in body if len(compact(t)) >= 80), None)
    if not sample or han + latin < 100:
        return field(), False
    p, t = sample
    evidence = [quote(p, t)]
    if han >= 100 and han >= latin * .7:
        if len(re.findall('[报国财环会业团]', text)) > 10 and len(re.findall('[報國財環會業團]', text)) < 3:
            return field('unsupported', 'zh-Hans', evidence), True
        return field('identified', 'zh-Hant', evidence), True
    if latin >= 100 and han < latin * .1:
        return field('identified', 'en', evidence), True
    return field('ambiguous', evidence=evidence, candidates=['en', 'zh-Hant']), True


def _issuer(pages):
    known = r'Yeebo\s*\(\s*International\s+Holdings\s*\)\s+Limited|億\s*都\s*[（(]\s*國\s*際\s*控\s*股\s*[）)]\s*有\s*限\s*公\s*司'
    legal = r'(?:' + known + r'|[A-Z][A-Za-z0-9 &\x27().-]{1,90}?(?:Limited|Ltd\.?|Corporation))'
    opening_roles = [r'(?:issued\s+by|issuer\s*:)\s*(?P<name>' + legal + ')',
                     r'(?P<name>' + legal + r')\s+presents\s+(?:this|its)\b.{0,160}?\breport',
                     r'本(?:ESG|環境、社會及管治)報告涵蓋\s*(?P<name>' + known + ')']
    roles = [r'to\s+the\s+shareholders\s+of\s*(?P<name>' + legal + ')',
             r'on\s+behalf\s+of\s+the\s+board\b.{0,100}?\bof\s+(?P<name>' + legal + ')',
             r'代表\s*(?P<name>' + known + r').{0,100}?董事會.{0,40}?提呈']
    identities = {}
    for page, text in pages:
        for pattern in roles + (opening_roles if page <= 2 else []):
            for match in re.finditer(pattern, text, re.I | re.S):
                name = match['name'].strip()
                identity = 'yeebo' if re.fullmatch(known, name, re.I) else re.sub(r'\s+', ' ', name)
                identities.setdefault(identity, quote(page, match[0]))
        # A standalone company line on the report cover is issuer evidence;
        # company names in later supplier/peer/subsidiary prose are not.
        if page == 1 and _kind([(page, text)])['status'] == 'identified':
            for line in text[:1000].splitlines():
                match = re.fullmatch(legal, line.strip(), re.I)
                if match:
                    name = match[0]
                    identity = 'yeebo' if re.fullmatch(known, name, re.I) else name
                    identities.setdefault(identity, quote(page, line))
    if len(identities) > 1:
        return field('ambiguous', evidence=list(identities.values())[:4], candidates=list(identities))
    if identities:
        identity = next(iter(identities))
        return field('identified' if identity == 'yeebo' else 'unsupported', identity, [identities[identity]])
    return field()


def _kind(pages):
    # Only opening document titles; a later separate-ESG-report reference is not identity.
    kinds = {}
    for p, text in pages[:2]:
        opening = compact(text[:1500]).lower()
        if p == 1 and re.search(r'reportingcode|報告守則', opening):
            return field('unsupported', 'regulatory', [quote(p, text[:400])])
        for kind, pattern in [('annual', r'annualreport(?!ing)|年報'),
                              ('esg', r'environmental,socialandgovernancereport(?!ing)|環境、社會及管治報告|esgreport(?!ing)')]:
            match = re.search(pattern, opening)
            if match:
                kinds.setdefault(kind, quote(p, text[:500]))
        if kinds and p == 1:
            break
    if len(kinds) == 1:
        kind = next(iter(kinds))
        return field('identified', kind, [kinds[kind]])
    if len(kinds) > 1:
        return field('ambiguous', evidence=list(kinds.values()), candidates=list(kinds))
    for p, text in pages[:2]:
        if re.search(r'reporting\s+code|報告守則|reporting\s+guide', text, re.I):
            return field('unsupported', 'regulatory', [quote(p, text[:400])])
    return field()


def _year(pages):
    candidates = {}
    # A cover label has priority over comparative-year mentions in ordinary body.
    # Opening body labels explicitly naming its financial year must agree.
    for p, text in pages[:2]:
        # Opening title/intro, rather than lower-cover comparative/source notes.
        region = text[:500] if p == 1 else text[:350]
        for match in YEAR.finditer(region):
            try:
                value = canonical_year(match[0])
            except ValueError:
                continue
            candidates.setdefault(value, quote(p, match[0]))
    if len(candidates) == 1:
        value = next(iter(candidates))
        return field('identified', value, [candidates[value]])
    if candidates:
        return field('ambiguous', evidence=list(candidates.values()), candidates=list(candidates))
    return field()


def _check_current_end(year, pages):
    """A directly stated current reporting end must agree with the title FY.

    Ordinary comparative dates elsewhere do not participate in identity.
    """
    if year['status'] != 'identified':
        return year
    expected = int(year['value'][:4]) + 1
    digits = '零一二三四五六七八九'
    for page, text in pages:
        patterns = [r'(?:present[^.]{0,650}?results|reporting period[^.]{0,150}?)\s*[^.]{0,100}?'
                    r'(?:year ended|to)\s+31\s+March\s+(20\d{2})',
                    r'提呈[^。]{0,120}?截至([二零〇一三四五六七八九]{4})年三月三十一日止年度']
        for pattern in patterns:
            match = re.search(pattern, text, re.I | re.S)
            if not match:
                continue
            value = match[1]
            if not value.isascii():
                value = ''.join(str(digits.index(char)) if char in digits else '0' for char in value)
            if int(value) != expected:
                return field('ambiguous', evidence=year['evidence'] + [quote(page, match[0])],
                             candidates=[year['value'], 'year ended 31 March ' + value])
            return year  # first explicit current period, not a later comparative
    return year


def _period(pages, year, kind):
    """Return only direct wording; annual starts are never inferred from FY."""
    result = {}
    if year['status'] != 'identified':
        return result
    end_year = int(year['value'][:4]) + 1
    digits = '零一二三四五六七八九'
    def chinese_year(number):
        return ''.join(digits[int(char)] for char in str(number))
    for _, text in pages:
        normalized = compact(text)
        zh_end = chinese_year(end_year) + '年三月三十一日'
        if re.search(rf'(?:year\s+ended\s+31\s+March\s+{end_year}|to\s+31\s+March\s+{end_year})', text, re.I) or ('截至' + zh_end + '止年度') in normalized or ('至' + zh_end) in normalized:
            result['period_end'] = f'{end_year}-03-31'
        start = end_year - 1
        if re.search(rf'(?:from|reporting\s+period\s*:)\s+1\s+April\s+{start}\s+to\s+31\s+March\s+{end_year}', text, re.I) or (chinese_year(start) + '年四月一日至' + zh_end) in normalized:
            result.update(period_start=f'{start}-04-01', period_end=f'{end_year}-03-31')
    return result


def inspect_input(path, sha256, file_name=''):
    raw, digest = snapshot(path, sha256)
    return _inspect_snapshot(raw, digest, file_name)


def _inspect_snapshot(raw, digest, file_name=''):
    """Shared classifier for exactly the bytes already bound to their digest."""
    result = {'sha256': digest, 'bytes': len(raw), 'pages': 0,
              'file_name': str(file_name)[:255],
              'fields': {key: field() for key in ('issuer', 'fiscal_year', 'kind', 'language')},
              'supported': False, 'test_only': False, 'scan_pages': [],
              'limits': ['Content inspection is limited to the first 8 PDF pages; no OCR or model is used.']}
    try:
        count, pages = text_pages(raw)
    except (ValueError, RuntimeError, fitz.FileDataError) as error:
        reason = str(error) if str(error) in ('encrypted_pdf', 'pdf_page_limit') else 'pdf_parse_failed'
        result['limits'].append(reason)
        return result
    result.update(pages=count, scan_pages=[p for p, _ in pages])
    combined = '\n'.join(text for _, text in pages)
    result['test_only'] = bool(re.search(r'TEST[\s_-]*ONLY', combined, re.I))
    language, readable = _language(pages)
    fields = {'issuer': _issuer(pages), 'fiscal_year': _check_current_end(_year(pages), pages),
              'kind': _kind(pages), 'language': language}
    if not readable:
        result['limits'].append('readable_body_not_found; supply a readable text PDF or confirm unresolved fields.')
    if re.search(r'not\s+a\s+company\s+report', combined, re.I):
        fields['kind'] = field('unsupported', 'technical_fixture', [quote(pages[0][0], pages[0][1])])
    result['fields'] = fields
    result['supported'] = readable and all(v['status'] == 'identified' for v in fields.values())
    if result['supported']:
        result['slot'] = fields['kind']['value'] + ('_en' if fields['language']['value'] == 'en' else '_zh')
    result.update(_period(pages, fields['fiscal_year'], fields['kind']))
    return result


def _local_original(root, document):
    name = document['file_name']
    folder = (bundled_sources.read_root(root) / 'dataset/reports').resolve()
    path = (folder / name).resolve()
    if Path(name).name != name or path.parent != folder:
        return 'unavailable', 'unsafe_catalogue_file_name'
    if not path.is_file():
        return 'missing', 'local_original_missing'
    try:
        raw, digest = snapshot(path)
        if digest != document['sha256']:
            return 'hash_mismatch', 'local_original_hash_changed'
        inspection = _inspect_snapshot(raw, digest, name)
        if not inspection['pages'] or any('readable_body_not_found' in limit for limit in inspection['limits']):
            return 'unreadable', 'readable_body_not_found_or_pdf_parse_failed'
        expected = {'issuer': 'yeebo', 'fiscal_year': document['fiscal_year'],
                    'kind': document['kind'], 'language': document['language']}
        mismatch = [key for key, value in expected.items()
                    if inspection['fields'][key]['value'] != value]
        unverified = [key for key in expected if inspection['fields'][key]['status'] != 'identified']
        if mismatch:
            return 'unavailable', 'local_original_identity_mismatch:' + ','.join(mismatch)
        if unverified or not inspection['supported']:
            return 'unavailable', 'local_original_identity_unverified:' + ','.join(unverified)
        return 'verified', None
    except (OSError, ValueError, RuntimeError):
        return 'unreadable', 'local_original_not_readable_within_limits'


def input_knowledge(root, fiscal_year=None, slots=None, client_factory=None):
    """List configured scope; only exact, unique requested prior slots get page reads."""
    result = {'entity_id': 'yeebo', 'entity_name': 'Yeebo (International Holdings) Limited',
              'observed_at': datetime.now(timezone.utc).isoformat(), 'catalog_revision': '', 'documents': []}
    if fiscal_year is not None:
        current = canonical_year(fiscal_year)
        start = int(current[:4]) - 1
        result['previous_year'] = f'{start}/{(start + 1) % 100:02d}'
    if slots is None:
        slots = []
    if not isinstance(slots, list) or len(slots) > 4 or len(set(slots)) != len(slots) or any(s not in SLOTS for s in slots):
        raise ValueError('Request at most four distinct supported report slots.')
    if slots and fiscal_year is None:
        raise ValueError('An explicit current fiscal year is required for prior-source checks.')
    client = None
    public = bundled_sources.packaged()
    if public:
        result['source_mode'] = 'public_snapshot'
    try:
        if public:
            rows, revision = bundled_sources.public_catalogue()
            catalog = {'documents': rows, 'catalog_revision': revision}
        else:
            if client_factory is None:
                from knowledge_client import KnowledgeClient
                client_factory = KnowledgeClient
            client = client_factory(root, timeout=18)
            catalog = client.call('list_documents', {'entity': 'yeebo'})
        rows = catalog.get('documents')
        if not isinstance(rows, list) or len(rows) > 64 or not isinstance(catalog.get('catalog_revision'), str):
            raise ValueError('invalid_catalogue')
        if any(not isinstance(row, dict) or row.get('entity') != 'yeebo' for row in rows):
            raise ValueError('mixed_or_invalid_entity_scope')
        result['catalog_revision'] = catalog['catalog_revision']
        selected = []
        for row in rows:
            if row.get('report_kind') is None:
                continue  # Rulebooks and source workbooks are not report originals.
            if row.get('report_kind') not in ('esg', 'annual') or row.get('language') not in ('en', 'zh-Hant'):
                raise ValueError('unsupported_catalogue_report')
            year = canonical_year(row.get('report_fiscal_year'))
            if not all(isinstance(row.get(k), str) and row[k] for k in ('source_id', 'file_name', 'sha256')) or not re.fullmatch('[a-f0-9]{64}', row['sha256']):
                raise ValueError('invalid_catalogue_report_identity')
            item = {'source_id': row['source_id'], 'file_name': row['file_name'], 'sha256': row['sha256'],
                    'fiscal_year': year, 'kind': row['report_kind'], 'language': row['language'],
                    'original_status': 'unavailable', 'indexed_status': 'not_checked'}
            item['original_status'], reason = _local_original(root, item)
            if reason:
                item['reason'] = reason
            selected.append((row, item))
        # Complete all catalogue validation before returning or issuing page reads.
        result['documents'] = [item for _, item in selected]
        for slot in slots:
            kind, language = SLOTS[slot]
            matches = [(row, item) for row, item in selected if item['fiscal_year'] == result['previous_year']
                       and item['kind'] == kind and item['language'] == language]
            if len(matches) != 1:
                for _, item in matches:
                    item.update(indexed_status='unavailable', reason='multiple_prior_versions_require_confirmation')
                continue
            row, item = matches[0]
            if item['original_status'] != 'verified':
                item['indexed_status'] = 'unavailable'
                continue  # Indexed metadata cannot overrule the actual original.
            if public:
                item['indexed_status'] = 'local_verified'
                continue
            if row.get('ingestion_status') != 'completed':
                item.update(indexed_status='unavailable', reason='index_not_completed')
                continue
            try:
                page = client.call('read_source_page', {'source_id': item['source_id'], 'actual_pdf_page': 1})
                valid = (page.get('status') == 'ok' and page.get('complete_index_scan') is True
                         and not page.get('response_truncated') and page.get('source_id') == item['source_id']
                         and page.get('source_sha256') == item['sha256'] and page.get('actual_pdf_page') == 1
                         and page.get('language') == language and page.get('report_fiscal_year') == result['previous_year']
                         and bool(page.get('backing_evidence_ids')) and bool(page.get('content')))
                item['indexed_status'] = 'verified' if valid else 'unavailable'
                if not valid:
                    item['reason'] = 'indexed_page_scope_or_revision_not_verified'
            except Exception:
                item.update(indexed_status='unavailable', reason='indexed_page_access_unavailable')
    except Exception:
        error = ('Bundled Yeebo public report catalogue is unavailable.' if public else
                 'Knowledge catalogue unavailable or its scope/metadata changed; retry after checking the connection.')
        result.update(documents=[], error=error)
    finally:
        if client is not None:
            client.close()
    return result
