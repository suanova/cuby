"""Separate findings from unfinished checks; mark precise evidence only."""
import re
import unicodedata
from decimal import Decimal, InvalidOperation

import pymupdf

STATES = {'difference', 'matched', 'needs_confirmation', 'not_checked', 'candidate'}
UNIT_LABELS = {'HKD_thousands': '千港元', 'tCO2e': 'tCO₂e', 'm3': '立方米', 'L': '升'}


def unit_label(unit):
    if unit.endswith('/m2_finished_goods'):
        return unit_label(unit.split('/')[0]) + '／平方米製成品'
    return UNIT_LABELS.get(unit, unit)


def check_state(check):
    if check.get('review_state') in STATES:
        return check['review_state']
    if check['category'] == 'page_numbers':
        return 'candidate'
    if check['status'] in ('matched', 'difference'):
        return check['status']
    # Read-only compatibility with existing immutable reviews. These two cases
    # have a specific observed difference; other pending rows are incomplete.
    if check['category'] == 'restatement' and any(s in check['reason'] for s in ('不同單位／量綱', '精度不同')):
        return 'needs_confirmation'
    return 'not_checked'


def present_check(check):
    state = check_state(check)
    check['review_state'] = state
    refs = check['refs']
    for ref in refs:
        if ref.get('unit'):
            ref['unit_label'] = unit_label(ref['unit'])
    if check.get('semantic_kind'):
        return check
    if check['category']=='page_numbers':
        if refs:
            kind='ESG' if 'esg' in refs[0]['slot'] else '年報'
            check['title']=f'同頁數字初篩 · {kind}第{refs[0]["page"]}頁'
        check['reason']='同頁碼的數字不同，可能只是排版或頁次不同；未確認段落是否對應，不算報告問題。'
        return check
    if check['id'] in ('basis-esg_zh', 'basis-annual_zh'):
        report = 'ESG' if check['id'] == 'basis-esg_zh' else '年報'
        check.update(title=report + '涵蓋業務及計算方法', reason='尚未逐句比較中英文的涵蓋業務及計算方法。',
                     refs=[], review_state='not_checked')
    elif check['id'] == 'cross-esg-annual':
        check.update(title='ESG與年報涵蓋的公司及業務', reason='尚未比較兩份報告涵蓋的公司及業務。', review_state='not_checked')
    elif check['id'].startswith('cross-full-time-staff-') and state == 'not_checked':
        check['reason'] = '尚未配對兩份報告的全職員工總數。'
    elif check['id'] == 'basis-factor-title-year' and len(refs) == 2:
        zh, en = refs
        if state == 'difference':
            check['reason'] = f'中文寫「{zh["value"]}」，英文寫「{en["value"]}」。請確認正確年份並統一兩版。'
        for ref in refs:
            pattern = (r'\d{4}\s*年省級電力\s*平均二氧化碳排放因數' if ref['slot'].endswith('zh')
                       else r'Provincial Electricity Average Carbon Emission Factors\s+\d{4}')
            match = re.search(pattern, ref['quote'], re.I)
            if match:
                ref['highlight_texts'] = [match[0]]
    elif check['category'] == 'metric':
        if state == 'matched':
            check['reason'] = '中英文數字及單位一致。'
        elif state == 'difference' and len(refs) == 2:
            left, right = refs
            check['reason'] = (f'中文版寫「{left.get("value", "")} {left.get("unit_label", "")}」，'
                               f'英文版寫「{right.get("value", "")} {right.get("unit_label", "")}」。請確認並統一。')
    elif check['category'] == 'restatement':
        values = [r for r in refs if r.get('value') is not None]
        if state == 'matched':
            check['reason'] = '今年比較欄與去年報告一致。'
        elif len(values) >= 2 and state in ('difference', 'needs_confirmation'):
            current, old = values[:2]
            if current.get('unit') != old.get('unit'):
                check['reason'] = f'今年用「{current.get("unit_label", "")}」，去年用「{old.get("unit_label", "")}」。請提供換算依據。'
            elif state == 'needs_confirmation':
                check['reason'] = f'今年寫「{current["value"]}」，去年寫「{old["value"]}」。可能只是小數位不同，請確認。'
            else:
                check['reason'] = f'今年比較欄寫「{current["value"]}」，去年寫「{old["value"]}」。請確認是否重列，並補充原因。'
    return check


def present_report(report):
    for check in report['checks']:
        present_check(check)
    report['coverage']['not_checked'] = sum(c['review_state'] == 'not_checked' for c in report['checks'])
    report['coverage']['needs_confirmation'] = sum(c['review_state'] == 'needs_confirmation' for c in report['checks'])
    return report


def numeric_value(value):
    raw = str(value).strip().replace(',', '').replace('−', '-').replace('（', '(').replace('）', ')')
    if raw.startswith('(') and raw.endswith(')'):
        raw = '-' + raw[1:-1]
    try:
        value = Decimal(raw)
        return value if value.is_finite() else None
    except InvalidOperation:
        return None


def highlight_rects(page, check, slot, number):
    previous = pymupdf.TOOLS.set_small_glyph_heights()
    try:
        pymupdf.TOOLS.set_small_glyph_heights(True)
        return _highlight_rects(page, check, slot, number)
    finally:
        pymupdf.TOOLS.set_small_glyph_heights(previous)


def _highlight_rects(page, check, slot, number):
    if check_state(check) in ('not_checked', 'candidate'):
        return []
    rects = []
    for ref in check['refs']:
        if (ref['slot'], ref['page']) != (slot, number):
            continue
        exact = ref.get('highlight_texts') or []
        if exact:
            for text in exact:
                if len(text) <= 220:
                    # Justified PDF text can return many fragments for one line.
                    # Map the unique normalized quote to glyph rows first, so a
                    # two-line sentence is not rejected as thirteen "lines".
                    matches = locate_wrapped_quote(page,text) or page.search_for(text)
                    line_limit=8 if check['category']=='regulatory' else 6 if check.get('semantic_kind') else 3
                    rows=group_rect_rows(matches)
                    if len(rows) <= line_limit and sum(r.height for r in rows)<page.rect.height*.16:
                        value_rects = page.search_for(str(ref['value'])) if ref.get('value') else []
                        anchored = [r for r in value_rects if any(r.intersects(anchor) for anchor in matches)]
                        rects.extend(anchored or matches)
            continue
        value = numeric_value(ref['value']) if ref.get('value') is not None else None
        if value is not None:
            matches = []
            for word in page.get_text('words'):
                candidate = numeric_value(word[4])
                joined = re.match(r'^([−-]?[\d,]+(?:\.\d+)?)(?=m[23]|kWh|litres?|liters?|升|立方米|千瓦時|千瓦时)', word[4], re.I)
                if candidate is None and joined:
                    candidate = numeric_value(joined[1])
                if candidate == value:
                    matches.append(pymupdf.Rect(word[:4]))
            # Frequently repeated values need a better row anchor, not a page
            # covered with highlights.
            if len(matches) <= 6:
                rects.extend(matches)
            continue
        quote = ref['quote'].strip()
        if len(quote) <= 220:
            matches = locate_wrapped_quote(page,quote) or page.search_for(quote)
            line_limit=6 if check.get('semantic_kind') else 3
            rows=group_rect_rows(matches)
            if len(rows) <= line_limit and sum(r.height for r in rows) < page.rect.height * .12:
                rects.extend(matches)
    return rects[:24]


def locate_wrapped_quote(page, text):
    """Map a unique exact quote in block or visual-row order back to glyphs."""
    target=re.sub(r'\s+','',unicodedata.normalize('NFKC',text))
    glyphs=[]
    for block in page.get_text('rawdict',sort=True)['blocks']:
        for line in block.get('lines',[]):
            for span in line['spans']:
                for char in span['chars']:
                    normalized=re.sub(r'\s+','',unicodedata.normalize('NFKC',char['c']))
                    if normalized:glyphs.append((normalized,char['bbox'],char.get('origin',(char['bbox'][0],char['bbox'][3]))))
    if not target:return []
    visual_rows=[]
    for glyph in sorted(glyphs,key=lambda g:(g[2][1],g[1][0])):
        if visual_rows and abs(visual_rows[-1][0][2][1]-glyph[2][1])<3:visual_rows[-1].append(glyph)
        else:visual_rows.append([glyph])
    visual=[g for row in visual_rows for g in sorted(row,key=lambda g:g[1][0])]
    for ordered in (glyphs,visual):
        chars=[];boxes=[]
        for normalized,box,_ in ordered:
            chars.extend(normalized);boxes.extend([box]*len(normalized))
        joined=''.join(chars);start=joined.find(target)
        if start<0 or joined.find(target,start+1)>=0:continue
        rects=[]
        for box in boxes[start:start+len(target)]:
            rect=pymupdf.Rect(box)
            # Keep separate table cells separate, including their empty gap.
            if rects and abs(rects[-1].y0-rect.y0)<3 and rect.x0-rects[-1].x1<max(8,rect.height*1.5):rects[-1]|=rect
            else:rects.append(rect)
        return rects if len(group_rect_rows(rects))<=8 else []
    return []


def group_rect_rows(rects):
    rows=[]
    for rect in sorted(rects,key=lambda r:(r.y0,r.x0)):
        if rows and abs(rows[-1].y0-rect.y0)<3:rows[-1]|=rect
        else:rows.append(pymupdf.Rect(rect))
    return rows
