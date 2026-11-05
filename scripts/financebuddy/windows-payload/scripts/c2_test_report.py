"""Create clearly labelled negative-control PDFs; never overwrite issuer sources.

This generator knows which changes to inject. The production C2 checker receives
only the resulting PDF text and normal checklist, not this answer manifest.
"""
from decimal import Decimal
import hashlib
from pathlib import Path
import pymupdf

ORIGINAL_SHA = 'e4823c8f1f883b0ba8a29f9928e81806960ce29a701539ff9771f34929b4f832'
CASES = ('missing_scope2_current', 'scope1_wrong_unit', 'scope2_market_only', 'wrong_total', 'combined', 'control')


def create(source_path, destination, case='combined'):
    source_path, destination = Path(source_path).resolve(), Path(destination).resolve()
    raw = source_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != ORIGINAL_SHA or source_path == destination or destination.exists():
        raise ValueError('Use the approved original revision and a new, separate test output.')
    if case not in CASES:
        raise ValueError('Unknown bounded PDF test case.')
    changes = []
    with pymupdf.open(stream=raw, filetype='pdf') as pdf:
        page = pdf[40]
        def one(text):
            rectangles = page.search_for(text)
            if len(rectangles) != 1:
                raise ValueError('The approved fixture layout has changed: ' + text)
            return rectangles[0]
        inserts = []
        if case in ('missing_scope2_current', 'combined'):
            page.add_redact_annot(one('18,760.00'), fill=(1, 1, 1))
            changes.append({'id': 'missing_scope2_current', 'page': 41, 'expected_check': 'C2-28-S2'})
        if case in ('scope1_wrong_unit', 'combined'):
            value_box = one('1,477.36')
            words = [w for w in page.get_text('words') if 260 < w[0] < 310 and
                     w[1] < value_box.y1 and w[3] > value_box.y0]
            if not words:
                raise ValueError('Original Scope 1 unit cell was not located.')
            box = pymupdf.Rect(min(w[0] for w in words), min(w[1] for w in words),
                              max(w[2] for w in words), max(w[3] for w in words))
            page.add_redact_annot(box, fill=(1, 1, 1))
            inserts.append(((box.x0, value_box.y1 - 3), 'kgCO2e', 8))
            changes.append({'id': 'scope1_wrong_unit', 'page': 41, 'expected_check': 'C2-28-UNIT'})
        if case in ('scope2_market_only', 'combined'):
            start = one('Scope 2 – Indirect')
            words = [w for w in page.get_text('words') if w[1] >= start.y0 - 1 and w[3] < page.rect.height - 80]
            box = pymupdf.Rect(110, start.y0 - 1, page.rect.width - 35, max(w[3] for w in words) + 2)
            page.add_redact_annot(box, fill=(1, 1, 1))
            inserts.extend([((113, box.y0 + 12), '2. Scope 2 - Only market-based Scope 2 emissions are reported.', 8),
                            ((113, box.y0 + 25), 'Location-based Scope 2 emissions are not provided in this report.', 8)])
            changes.append({'id': 'scope2_market_only', 'page': 41, 'expected_check': 'C2-29C-BASIS'})
        if case in ('wrong_total', 'combined'):
            box = one('20,860.79')
            page.add_redact_annot(box, fill=(1, 1, 1))
            inserts.append(((box.x0, box.y1 - 3), format(Decimal('20860.79') + 1, ',.2f'), 8))
            changes.append({'id': 'wrong_total', 'page': 41, 'expected_check': 'not_covered_by_four_presence_checks'})
        page.apply_redactions(images=0, graphics=0)
        for point, text, size in inserts:
            page.insert_text(point, text, fontsize=size, fontname='helv', color=(0.05, 0.08, 0.08))
        for page in pdf:
            page.draw_rect(pymupdf.Rect(0, 0, page.rect.width, 18), color=None, fill=(1, .94, .82), overlay=True)
            page.insert_text((18, 12), 'TEST ONLY - SYNTHETIC VALIDATION COPY - NOT AN ISSUER DISCLOSURE',
                             fontsize=7.4, fontname='hebo', color=(.55, .18, .04), overlay=True)
        pdf.set_metadata({'title': 'TEST ONLY - deliberately flawed ESG validation copy',
                          'subject': 'Synthetic negative control; not issuer data and not for publication',
                          'author': 'FinanceBuddy validation harness'})
        destination.parent.mkdir(parents=True, exist_ok=True)
        pdf.save(destination, garbage=4, deflate=True)
    with pymupdf.open(destination) as check:
        if len(check) != 49 or any('TEST ONLY' not in p.get_text() for p in check):
            raise ValueError('Test PDF labelling or original page count was not preserved.')
    if hashlib.sha256(source_path.read_bytes()).hexdigest() != ORIGINAL_SHA:
        raise ValueError('Original source was modified.')
    return {'case': case, 'synthetic': True, 'original_sha256': ORIGINAL_SHA,
            'test_sha256': hashlib.sha256(destination.read_bytes()).hexdigest(), 'changes': changes}
