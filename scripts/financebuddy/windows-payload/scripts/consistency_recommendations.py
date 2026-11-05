"""Shared source validation for recommendations delivered with review findings."""
import copy
import re
from review_suggestions import span

SLOTS=('esg_zh','esg_en','annual_zh','annual_en')
INSTRUCTION='''每項需處理的問題必須同時提供recommendation，不要等待用戶另按取得建議。summary用自然繁中一兩句直接講如何處理。可以安全修訂且有原句時，edits提供最多兩處局部改寫，original須為所引用本年原頁唯一的逐字連續短句（12至1800字）；replacement保留原語言及否定／條件，限3000字。不得改歷史文件或移到未引用頁面。不能猜哪一版數字、年份、政策或方法正確；有清楚假設的改寫須requires_confirmation=true，confirmation_prompt具體問要確認的事實。若須先取得底稿或確認事實才能決定新寫法，edits=[]，直接給核實建議，不能編造制度、數字或用待填文字當修訂。沒有問題時edits=[]。'''
INSTRUCTION += 'summary限一句，直接說改哪裡；confirmation_prompt只問一個具體事實，勿重複問題或要求籠統的底稿。不要「統一口徑／責任及條件／否定範圍」等抽象用語。'


def schema():
    string={'type':'string'}
    edit={'type':'object','properties':{'slot':{'type':'string','enum':list(SLOTS)},'page':{'type':'integer'},'original':string,'replacement':string},
          'required':['slot','page','original','replacement'],'additionalProperties':False}
    return {'type':'object','properties':{'summary':string,'requires_confirmation':{'type':'boolean'},'confirmation_prompt':string,
             'edits':{'type':'array','items':edit,'maxItems':4}},
            'required':['summary','requires_confirmation','confirmation_prompt','edits'],'additionalProperties':False}


def eligible(check):
    return check.get('review_state',check.get('status')) in ('difference','needs_confirmation','pending') and check.get('category')!='page_numbers'


def advice(check):
    text=check.get('regulatory',{}).get('action') or check.get('reason') or '請確認此項所列的原文差異。'
    return {'summary':text[:500],'requires_confirmation':True,'confirmation_prompt':text[:500],'edits':[]}


def validate(value,pages,refs=None):
    value=copy.deepcopy(value)
    if not isinstance(value,dict) or not isinstance(value.get('summary'),str) or not 1<=len(value['summary'])<=500:
        raise ValueError('建議格式不完整。')
    if type(value.get('requires_confirmation')) is not bool or not isinstance(value.get('confirmation_prompt'),str) or len(value['confirmation_prompt'])>500:
        raise ValueError('建議未交代需確認的事實。')
    edits=value.get('edits')
    if not isinstance(edits,list) or len(edits)>4:raise ValueError('建議修改數量無效。')
    allowed=None if refs is None else {(r['slot'],r['page']) for r in refs}
    located={}
    for edit in edits:
        if not isinstance(edit,dict) or set(edit)!={'slot','page','original','replacement'}:raise ValueError('修改欄位無效。')
        slot,page=edit['slot'],edit['page']
        if slot not in SLOTS or slot not in pages or type(page) is not int or not 1<=page<=len(pages[slot]):raise ValueError('只能修改本年報告的有效頁面。')
        if allowed is not None and (slot,page) not in allowed:raise ValueError('修改必須位於此問題引用的原頁。')
        original=edit['original']
        if not isinstance(original,str) or not 12<=len(original)<=1800:raise ValueError('建議原句未能在指定頁面唯一定位。')
        location=span(pages[slot][page-1],original)
        if not location:raise ValueError('建議原句未能在指定頁面唯一定位。')
        replacement=edit['replacement']
        if not isinstance(replacement,str) or not 1<=len(replacement.strip())<=3000 or replacement==original:raise ValueError('請提供具體的新寫法。')
        if set(re.findall(r'\d[\d,.]*',replacement))-set(re.findall(r'\d[\d,.]*',original)):
            value['requires_confirmation']=True
            value['confirmation_prompt']=value['confirmation_prompt'] or '請確認新寫法中的數字及年份。'
        a,b=location;group=located.setdefault((slot,page),[])
        if any(a<end and b>start for start,end in group):raise ValueError('此建議內的修改重疊。')
        group.append((a,b))
    if value['requires_confirmation'] and edits and not value['confirmation_prompt'].strip():
        value['confirmation_prompt']='請確認此修改涉及的範圍、條件及事實。'
    return {k:value[k] for k in ('summary','requires_confirmation','confirmation_prompt','edits')}


def from_finding(check,pages):
    """Bad edits cannot hide an otherwise verified finding or become applicable."""
    try:return validate(check['recommendation'],pages,check['refs'])
    except (KeyError,ValueError,TypeError):return advice(check)
