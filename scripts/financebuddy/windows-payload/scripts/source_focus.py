"""Read-only, evidence-bound emphasis metadata; never change finding identity."""
import json
from pathlib import Path

from reader_language import fingerprint

SCHEMA_VERSION='financebuddy-source-focus-1'
SLOTS={'esg_zh','esg_en','annual_zh','annual_en',
       'prior_esg_zh','prior_esg_en','prior_annual_zh','prior_annual_en'}


def unique_object(pairs):
    value={}
    for key,item in pairs:
        if key in value:raise ValueError('Duplicate annotation key.')
        value[key]=item
    return value


def ref_identity(ref,documents):
    if not isinstance(ref,dict):raise ValueError('Incomplete reference.')
    slot,page,quote=(ref.get(key) for key in ('slot','page','quote'))
    if not isinstance(slot,str) or slot not in SLOTS or type(page) is not int or page<1:
        raise ValueError('Invalid source location.')
    if not isinstance(quote,str) or not quote.strip():raise ValueError('Empty source quote.')
    matches=[doc for doc in documents if isinstance(doc,dict) and doc.get('slot')==slot]
    if len(matches)!=1 or type(matches[0].get('page_count')) is not int or page>matches[0]['page_count']:
        raise ValueError('Unknown source page.')
    return slot,page,quote


def valid_item(check,entry,documents):
    if (check.get('semantic_kind')!='bilingual' or check.get('regulatory') or check.get('category')=='regulatory'
            or check.get('review_state') not in ('difference','needs_confirmation')):
        raise ValueError('Unsupported finding.')
    if (not isinstance(entry,dict) or set(entry)!={'source_fingerprint','refs'}
            or entry['source_fingerprint']!=fingerprint(check)):
        raise ValueError('Stale finding.')
    refs=check.get('refs');annotations=entry['refs']
    if not isinstance(refs,list) or not 1<=len(refs)<=8 or not isinstance(annotations,list) or len(annotations)!=len(refs):
        raise ValueError('Incomplete source metadata.')
    identities=[ref_identity(ref,documents) for ref in refs]
    if len(set(identities))!=len(identities):raise ValueError('Ambiguous source metadata.')
    validated={}
    for annotation in annotations:
        if not isinstance(annotation,dict) or set(annotation)!={'slot','page','quote','phrases'}:
            raise ValueError('Incomplete annotation.')
        identity=ref_identity(annotation,documents)
        if identity not in identities or identity in validated:raise ValueError('Mismatched or duplicate source.')
        phrases=annotation['phrases'];quote=identity[2];ranges=[]
        if not isinstance(phrases,list) or not 1<=len(phrases)<=4:raise ValueError('Invalid phrases.')
        for phrase in phrases:
            if (not isinstance(phrase,str) or not 1<=len(phrase)<=120 or phrase!=phrase.strip()
                    or not phrase.strip() or phrase==quote.strip()):
                raise ValueError('Phrase must be a proper exact substring.')
            start=quote.find(phrase)
            if start<0 or quote.find(phrase,start+1)>=0:raise ValueError('Missing or ambiguous phrase.')
            end=start+len(phrase)
            if any(start<b and end>a for a,b in ranges):raise ValueError('Overlapping or duplicate phrase.')
            ranges.append((start,end))
        if sum(len(phrase) for phrase in phrases)>=len(quote.strip()):
            raise ValueError('Phrases cannot collectively cover the whole quote.')
        remainder=[];cursor=0
        for start,end in sorted(ranges):
            remainder.append(quote[cursor:start]);cursor=end
        remainder.append(quote[cursor:])
        if not any(char.isalnum() for text in remainder for char in text):
            raise ValueError('Some meaningful source text must remain unemphasized.')
        validated[identity]={'slot':identity[0],'page':identity[1],'quote':quote,'phrases':list(phrases)}
    return [validated[identity] for identity in identities]


def apply_source_focus(folder,report,base_sha256):
    # A persisted report must not bypass sidecar validation with an embedded key.
    # Shallow copying preserves all nested check/ref/copy objects verbatim.
    result={key:value for key,value in report.items() if key!='source_focus'}
    try:
        saved=json.loads((Path(folder)/'source-focus.json').read_text(encoding='utf-8'),object_pairs_hook=unique_object)
        if (not isinstance(saved,dict) or set(saved)!={'schema_version','base_sha256','items'}
                or saved['schema_version']!=SCHEMA_VERSION or saved['base_sha256']!=base_sha256
                or not isinstance(saved['items'],dict)):
            return result
    except (OSError,ValueError,TypeError,UnicodeError,RecursionError):
        return result
    checks=report.get('checks',[]);documents=report.get('documents',[]);focus={}
    for check in checks:
        if not isinstance(check,dict) or not isinstance(check.get('id'),str):continue
        key=check['id']
        if key not in saved['items'] or sum(isinstance(c,dict) and c.get('id')==key for c in checks)!=1:continue
        try:focus[key]=valid_item(check,saved['items'][key],documents)
        except (ValueError,KeyError,TypeError,AttributeError):continue
    if focus:result['source_focus']=focus
    return result
