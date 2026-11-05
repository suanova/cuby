"""Apply accepted edits to the original PDF, retaining fonts, artwork and page geometry.

Short corrections keep the original glyph positions. A growing paragraph can reflow
at its original font size and move the following text/table rows within the same
page. Unsupported layouts stop with a specific issue instead of exporting a broken
or partially updated report.
"""
from collections import Counter
from difflib import SequenceMatcher
from io import BytesIO
import math
import re
from statistics import median
import unicodedata

import pymupdf


class PdfLayoutError(ValueError):
    def __init__(self, message, page=None, check_id=None):
        super().__init__(message)
        self.page, self.check_id = page, check_id


def compact(text): return ''.join(unicodedata.normalize('NFKC', text).split())
def rect_union(rects):
    out=pymupdf.Rect(rects[0])
    for r in rects[1:]: out |= pymupdf.Rect(r)
    return out


def font_name(value): return re.sub(r'^[A-Z]{6}\+', '', value).replace(' ', '').replace('-', '').replace('_', '').lower()


def value_of(doc, xref, key):
    kind,value=doc.xref_get_key(xref,key)
    if kind=='xref': return doc.xref_object(int(value.split()[0]))
    return value


def number_array(value):
    tokens=re.findall(r'\[|\]|[-+]?\d+(?:\.\d+)?', value)
    def read(i):
        out=[];i+=1
        while i<len(tokens) and tokens[i]!=']':
            if tokens[i]=='[': item,i=read(i);out.append(item)
            else: out.append(float(tokens[i]));i+=1
        return out,i+1
    return read(0)[0] if tokens and tokens[0]=='[' else []


def cmap_reverse(data):
    result={}
    def add(code, text):
        try:
            text=bytes.fromhex(text).decode('utf-16-be')
            if len(text)==1: result.setdefault(text,bytes.fromhex(code))
        except (ValueError,UnicodeError): pass
    text=data.decode('latin1')
    for group in re.findall(r'beginbfchar(.*?)endbfchar',text,re.S):
        for code,dest in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>',group):add(code,dest)
    for group in re.findall(r'beginbfrange(.*?)endbfrange',text,re.S):
        for low,high,dest in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^]]*\]|<[0-9A-Fa-f]+>)',group):
            start,end=int(low,16),int(high,16)
            if end-start>65535:raise PdfLayoutError('字體編碼範圍過大，未能安全重用。')
            entries=re.findall(r'<([0-9A-Fa-f]+)>',dest)
            for i,code in enumerate(range(start,end+1)):
                target=entries[i] if dest.startswith('[') and i<len(entries) else format(int(entries[0],16)+i,'0'+str(len(entries[0]))+'x') if not dest.startswith('[') else None
                if target:add(format(code,'0'+str(len(low))+'x'),target)
    return result


class OriginalFont:
    def __init__(self, doc, item):
        self.doc,self.xref,self.name=doc,item[0],item[3]
        self.kind=value_of(doc,self.xref,'Subtype')
        self.encoding=value_of(doc,self.xref,'Encoding')
        self.mapping={};self.widths={};self.default=0;self.clone=None
        self.widths_revision=0;self.installed_revision=-1
        self.superscripts={};self.outline_cache={};self.ttf=None;self.ttf_checked=False
        self.resource='FB'+str(self.xref)
        raw=doc.extract_font(self.xref)[3]
        self.raw=raw
        try:self.metric=pymupdf.Font(fontbuffer=raw) if raw else pymupdf.Font(self.name)
        except Exception:self.metric=None
        kind,ref=doc.xref_get_key(self.xref,'ToUnicode')
        if kind=='xref':self.mapping=cmap_reverse(doc.xref_stream(int(ref.split()[0])))
        if self.kind=='/Type0':
            if self.encoding!='/Identity-H':raise PdfLayoutError('此字體使用特殊或直排編碼，需保留原稿排版。')
            refs=re.findall(r'(\d+)\s+\d+\s+R',value_of(doc,self.xref,'DescendantFonts'))
            if not refs:raise PdfLayoutError('找不到原PDF字體。')
            desc=int(refs[0]);dw=value_of(doc,desc,'DW');self.default=float(dw) if dw!='null' else 1000
            values=number_array(value_of(doc,desc,'W'));i=0
            while i<len(values):
                start=int(values[i]);entry=values[i+1]
                if isinstance(entry,list):
                    self.widths.update({start+j:w for j,w in enumerate(entry)});i+=2
                else:
                    self.widths.update({j:values[i+2] for j in range(start,int(entry)+1)});i+=3
            if not self.mapping:self._collect_cid_mapping()
        else:
            if self.encoding not in ('/WinAnsiEncoding','null') and not self.mapping:
                raise PdfLayoutError('此字體使用自訂編碼，未能安全保留字體。')
            first=value_of(doc,self.xref,'FirstChar');self.first=int(first) if first!='null' else 0
            self.original_widths=number_array(value_of(doc,self.xref,'Widths'))
            self.widths={self.first+i:w for i,w in enumerate(self.original_widths)}

    def _collect_cid_mapping(self):
        # CID CFF subsets sometimes rely on a predefined Adobe CMap instead of
        # /ToUnicode. Reuse only proven Unicode/glyph/CID pairs from this exact font.
        try:
            from fontTools.cffLib import CFFFontSet
            cff=CFFFontSet();cff.decompile(BytesIO(self.raw),None)
            charset=cff.topDictIndex[0].charset
        except Exception:return
        for page in self.doc:
            candidates={f[0] for f in page.get_fonts(full=True) if font_name(f[3])==font_name(self.name)}
            if candidates!={self.xref}:continue
            for trace in page.get_texttrace():
                if font_name(trace['font'])!=font_name(self.name):continue
                for uni,gid,*_ in trace['chars']:
                    if 0<=gid<len(charset) and re.fullmatch(r'cid\d+',charset[gid]):
                        self.mapping.setdefault(chr(uni),int(charset[gid][3:]).to_bytes(2,'big'))

    def _outline(self,char):
        # Some embedded TrueType subsets retain a full Unicode cmap but replace
        # unused glyph outlines with empty glyphs. has_glyph() alone misses this.
        if char.isspace():return True
        if char in self.outline_cache:return self.outline_cache[char]
        if not self.ttf_checked:
            self.ttf_checked=True
            if self.raw[:4].hex() in ('00010000','74746366','4f54544f'):
                try:
                    from fontTools.ttLib import TTFont
                    self.ttf=TTFont(BytesIO(self.raw))
                except ImportError:raise PdfLayoutError('請先安裝本機PDF工具的fonttools依賴。')
                except Exception:raise PdfLayoutError('未能驗證原字體字形。')
        visible=True
        if self.ttf and 'glyf' in self.ttf:
            name=(self.ttf.getBestCmap() or {}).get(ord(char))
            visible=bool(name and self.ttf['glyf'][name].numberOfContours)
        self.outline_cache[char]=visible
        return visible

    def encode(self, char):
        if char in self.superscripts:return self.encode(self.superscripts[char])
        code=self.mapping.get(char)
        if code is None and self.kind!='/Type0' and self.encoding in ('/WinAnsiEncoding','null'):
            try:
                candidate=char.encode('cp1252')
                if len(candidate)==1 and self.metric and self.metric.has_glyph(ord(char)):code=candidate
            except UnicodeError:pass
        if code is not None and self._outline(char):
            self.mapping[char]=code;return code
        # The source tables already typeset m² with a raised, smaller normal 2.
        # Use that same font's digit rather than a blank subset glyph or another
        # font. NFKC readback validates m²/m2 equivalence, while the PDF stays live text.
        base={'²':'2','³':'3','¹':'1'}.get(char)
        if base and self._outline(base):
            encoded=self.encode(base);self.superscripts[char]=base;return encoded
        raise PdfLayoutError(f'原字體未能重用「{char}」，請提供原稿字體或調整寫法。')

    def width(self,char,size):
        code=int.from_bytes(self.encode(char),'big');value=self.widths.get(code,self.default)
        if value<=0 and self.metric and self.metric.has_glyph(ord(char)):
            value=self.metric.glyph_advance(ord(char))*1000
            self.widths[code]=value;self.widths_revision+=1
        if value<=0 and not char.isspace():raise PdfLayoutError(f'未能確認「{char}」的原字體寬度。')
        return value*size/1000*(2/3 if char in self.superscripts else 1)

    def install(self,page):
        if self.clone is None:
            self.clone=self.xref
            if self.kind!='/Type0' and self.original_widths:
                # New characters may exist in the embedded font but have a zero
                # width in the original subset's PDF dictionary. Extend a clone.
                self.clone=self.doc.get_new_xref();self.doc.update_object(self.clone,self.doc.xref_object(self.xref))
        if self.kind!='/Type0' and self.original_widths and self.installed_revision!=self.widths_revision:
            end=max(self.widths);values=[self.widths.get(i,0) for i in range(self.first,end+1)]
            self.doc.xref_set_key(self.clone,'LastChar',str(end))
            self.doc.xref_set_key(self.clone,'Widths','['+' '.join(f'{v:.6f}' for v in values)+']')
            self.installed_revision=self.widths_revision
        if self.doc.xref_get_key(page.xref,'Resources')[0]=='null':
            parent=page.xref
            while self.doc.xref_get_key(parent,'Resources')[0]=='null':
                kind,ref=self.doc.xref_get_key(parent,'Parent')
                if kind!='xref':raise PdfLayoutError('找不到原頁資源。')
                parent=int(ref.split()[0])
            self.doc.xref_set_key(page.xref,'Resources',value_of(self.doc,parent,'Resources'))
        self.doc.xref_set_key(page.xref,'Resources/Font/'+self.resource,f'{self.clone} 0 R')


class FontBook:
    def __init__(self,doc):self.doc=doc;self.cache={}
    def get(self,page,glyph):
        style=glyph['style'];candidates=[f for f in page.get_fonts(full=True) if font_name(f[3])==font_name(style['font'])]
        candidates.sort(key=lambda f:(f[-1]!=0,f[0]))
        if not candidates:raise PdfLayoutError('找不到原文字體，未能保留樣式。')
        item=candidates[0]
        if item[0] not in self.cache:self.cache[item[0]]=OriginalFont(self.doc,item)
        return self.cache[item[0]]


def glyphs_of(page):
    glyphs=[];blocks=[]
    traces={}
    for trace in page.get_texttrace():
        for uni,gid,origin,*_ in trace['chars']:
            traces[(round(origin[0],2),round(origin[1],2),chr(uni))]=trace
    for bi,block in enumerate(page.get_text('rawdict')['blocks']):
        if block['type']!=0:continue
        group=[]
        for li,line in enumerate(block['lines']):
            for style in line['spans']:
                trace=next((traces.get((round(c['origin'][0],2),round(c['origin'][1],2),c['c'])) for c in style['chars'] if (round(c['origin'][0],2),round(c['origin'][1],2),c['c']) in traces),None)
                preserved={k:style[k] for k in ('font','size','color','alpha','flags','char_flags')}
                preserved.update(xsize=trace['size'] if trace else style['size'],ysize=style['size']**2/trace['size'] if trace and trace['size'] else style['size'],trace_type=trace['type'] if trace else 0)
                if trace and trace['colorspace']==3:preserved['rgb']=trace['color']
                for char in style['chars']:
                    g={**char,'style':preserved,'dir':line['dir'],'block':bi,'line':(bi,li),'index':len(glyphs)}
                    glyphs.append(g);group.append(g)
        blocks.append({'id':bi,'bbox':block['bbox'],'glyphs':group,'lines':block['lines']})
    return glyphs,blocks


def locate(glyphs,quote):
    visible=[g for g in glyphs if not g['c'].isspace()]
    text=''.join(g['c'] for g in visible);needle=''.join(quote.split())
    hits=[m.start() for m in re.finditer(re.escape(needle),text)]
    if len(hits)!=1:raise PdfLayoutError('原句未能在原頁唯一定位，請重新取得建議。')
    return visible[hits[0]:hits[0]+len(needle)]


def same_style(glyphs):
    return len({(g['style']['font'],round(g['style']['size'],3),g['style']['color'],g['style']['alpha'],tuple(g['dir'])) for g in glyphs})==1


def small_rect(glyph):
    r=pymupdf.Rect(glyph['bbox']);x=(r.x0+r.x1)/2;y=glyph['origin'][1]-glyph['style']['size']*.35
    return pymupdf.Rect(x-.06,y-.06,x+.06,y+.06)


def remove_glyphs(page,glyphs):
    for g in glyphs:
        if pymupdf.Rect(g['bbox']).width>0:page.add_redact_annot(small_rect(g),fill=False,cross_out=False)


def text_command(page,font,style,text,origins):
    if style.get('alpha',255)!=255:raise PdfLayoutError('半透明文字需保留原稿排版。')
    if style.get('trace_type',0)!=0:raise PdfLayoutError('此頁文字是掃描/OCR或特殊描邊，需使用可編輯原稿。')
    if style.get('flags',0)&2 and font.metric and not font.metric.is_italic:raise PdfLayoutError('此段使用特殊斜體變形，需保留原稿排版。')
    size=style.get('xsize',style['size']);ysize=style.get('ysize',style['size'])
    # Resolve all glyphs before installing the font and writing commands.
    encoded=[font.encode(char) for char in text]
    font.install(page);point=pymupdf.Point(origins[0])*~page.transformation_matrix
    color=' '.join(f'{v:.9f}' for v in style.get('rgb',pymupdf.sRGB_to_pdf(style['color'])))
    command=f'q BT {color} rg {size/ysize:.9f} 0 0 1 {point.x:.7f} {point.y:.7f} Tm '
    scale=None;parts=[]
    for i,(char,pos) in enumerate(zip(text,origins)):
        factor=2/3 if char in font.superscripts else 1
        if factor!=scale:
            if parts:command+='['+' '.join(parts)+'] TJ ';parts=[]
            command+=f'/{font.resource} {ysize*factor:.7f} Tf {ysize*.36 if factor!=1 else 0:.7f} Ts '
            scale=factor
        parts.append('<'+encoded[i].hex()+'>')
        if i+1<len(text):parts.append(f'{(font.width(char,size)-(origins[i+1][0]-pos[0]))/(size*factor)*1000:.7f}')
    return command+'['+' '.join(parts)+'] TJ ET Q\n'



def append_commands(page,commands):
    if not commands:return
    doc=page.parent;xref=doc.get_new_xref();doc.update_object(xref,'<<>>');doc.update_stream(xref,''.join(commands).encode('ascii'))
    doc.xref_set_key(page.xref,'Contents','['+' '.join(f'{x} 0 R' for x in page.get_contents()+[xref])+']')


def minimal_plan(page,glyphs,selected,replacement,fonts):
    before=''.join(g['c'] for g in selected);after=''.join(replacement.split())
    changes={}
    for op,a,b,c,d in SequenceMatcher(None,before,after,autojunk=False).get_opcodes():
        if op=='equal':continue
        if op!='replace' or b-a!=d-c:return None
        for old,new in zip(selected[a:b],after[c:d]):changes[old['index']]=new
    if not changes:raise PdfLayoutError('此修改只改空白，未有可保留版面的文字替換。')
    groups=[]
    for index in changes:
        left=right=index;isword=lambda g:not g['c'].isspace()
        if isword(glyphs[index]):
            while left>0 and glyphs[left-1]['line']==glyphs[index]['line'] and isword(glyphs[left-1]):left-=1
            while right+1<len(glyphs) and glyphs[right+1]['line']==glyphs[index]['line'] and isword(glyphs[right+1]):right+=1
        if not any(left==a and right==b for a,b in groups):groups.append((left,right))
    plans=[]
    for left,right in groups:
        group=glyphs[left:right+1]
        if not same_style(group) or tuple(group[0]['dir'])!=(1,0):return None
        font=fonts.get(page,group[0]);text=''.join(changes.get(g['index'],g['c']) for g in group)
        for i,(g,char) in enumerate(zip(group,text)):
            old=pymupdf.Rect(g['bbox']).width;new=font.width(char,g['style']['xsize'])
            if new>old+.3:return None
        plans.append({'glyphs':group,'font':font,'text':text,'origins':[g['origin'] for g in group]})
    return {'kind':'in_place','parts':plans,'rects':[list(rect_union([g['bbox'] for g in part['glyphs']])+(-1,-1,1,1)) for part in plans]}


def wrapped(text,font,size,width):
    lines=[];line='';current=0
    # Retain spaces inside English words and allow CJK to wrap between glyphs.
    tokens=re.findall(r'[^\S\n]+|[A-Za-z0-9][A-Za-z0-9_.,:/%+\-]*|[^\s]|\n',text)
    for token in tokens:
        if token=='\n':lines.append(line.rstrip());line='';current=0;continue
        length=sum(font.width(c,size) for c in token)
        if not line and token.isspace():continue
        if current+length>width+.05 and line:lines.append(line.rstrip());line='';current=0
        if length>width+.05:raise PdfLayoutError('新寫法包含過長字詞，原欄寬放不下。')
        if not line and token.isspace():continue
        line+=token;current+=length
    if line:lines.append(line.rstrip())
    return lines


def paragraph_plan(page,glyphs,blocks,selected,edit,fonts):
    if len({g['block'] for g in selected})!=1:raise PdfLayoutError('跨段落改寫需調整排版，請縮短新寫法或提供原稿。')
    block=next(b for b in blocks if b['id']==selected[0]['block']);group=block['glyphs']
    visible=[g for g in group if not g['c'].isspace()]
    if not same_style(visible) or tuple(visible[0]['dir'])!=(1,0):raise PdfLayoutError('此段混合字體或直排，請用原稿調整排版。')
    from review_suggestions import span
    text='\n'.join(''.join(c['c'] for s in l['spans'] for c in s['chars']) for l in block['lines'])
    bounds=span(text,edit['original'])
    if not bounds:raise PdfLayoutError('未能在原段落定位修改。')
    text=re.sub(r'\s+',' ',text[:bounds[0]]+edit['replacement']+text[bounds[1]:]).strip()
    box=pymupdf.Rect(block['bbox']);style=group[0]['style'];font=fonts.get(page,group[0]);size=style['xsize']
    ys=[]
    for y in sorted(median(g['origin'][1] for g in group if g['line']==key) for key in {g['line'] for g in group}):
        if not ys or y-ys[-1]>.3:ys.append(y)
    lineheight=median(b-a for a,b in zip(ys,ys[1:])) if len(ys)>1 else size*1.5
    if lineheight<size:raise PdfLayoutError('此段行距未能安全重排。')
    lines=wrapped(text,font,size,box.width)
    extra=max(0,(len(lines)-len(ys))*lineheight)
    # A lower line can start in this column and continue beyond its edge.
    # Select and classify complete lines, or moving only overlapping glyphs
    # would leave the line's trailing words at their original baseline.
    page_lines={}
    for g in glyphs:page_lines.setdefault(g['line'],[]).append(g)
    lower_lines=[line for line in page_lines.values() if any(g['origin'][1]>ys[-1]+size*.4
        and g['bbox'][2]>box.x0-1 and g['bbox'][0]<box.x1+1 for g in line)]
    # Header/footer remain at their original locations. Same-page flow is allowed
    # only above the bottom 8% reserved for running footers/page numbers.
    footer_y=page.rect.height*.92
    moving=[g for line in lower_lines if min(g['bbox'][1] for g in line)<footer_y for g in line]
    footer=[g for line in lower_lines if min(g['bbox'][1] for g in line)>=footer_y for g in line]
    limit=min([g['bbox'][1] for g in footer]+[page.rect.height*.94])-max(8,size)
    bottom=max([g['bbox'][3] for g in moving]+[box.y1])
    # Include a final table rule just below the last row's text.
    nearby=[d['rect'].y1 for d in page.get_drawings() if d['type']=='s' and all(item[0]=='l' for item in d['items'])
            and d['rect'].y0>=box.y1 and d['rect'].y1<=bottom+lineheight
            and d['rect'].x1>=box.x0 and d['rect'].x0<=box.x1]
    bottom=max([bottom]+nearby)
    if bottom+extra>limit:raise PdfLayoutError('新增文字放不進同一頁，請縮短新寫法或使用原稿排版。')
    if extra and any(g['bbox'][0]<box.x0-2 or g['bbox'][2]>box.x1+2 for g in moving):
        raise PdfLayoutError('下方包含跨欄內容，需使用原稿排版。')
    region=pymupdf.Rect(box.x0-1,box.y0-1,box.x1+1,bottom+extra+2)
    drawings=[]
    if extra:
        for image in page.get_image_info():
            r=pymupdf.Rect(image['bbox'])
            if r.intersects(region) and not r.contains(region):raise PdfLayoutError('此頁新增段落會移動圖像，需用原稿排版。')
        for drawing in page.get_drawings():
            r=pymupdf.Rect(drawing['rect'])
            if r.y0<box.y1 or r.y1>bottom+1 or r.x1<box.x0 or r.x0>box.x1:continue
            if drawing['type']!='s' or any(item[0]!='l' for item in drawing['items']):
                raise PdfLayoutError('此頁有複雜圖形，需用原稿排版。')
            drawings.append(drawing)
    # Detect justification from the original first-line spaces.
    first=[g for g in group if g['line']==group[0]['line']];spaces=[]
    for i,g in enumerate(first[:-1]):
        if g['c']==' ':spaces.append(first[i+1]['origin'][0]-g['origin'][0])
    justify=bool(spaces and median(spaces)>font.width(' ',size)*1.2)
    parts=[]
    for i,line in enumerate(lines):
        natural=sum(font.width(c,size) for c in line);gap=(box.width-natural)/line.count(' ') if justify and i<len(lines)-1 and ' ' in line else 0
        x=group[0]['origin'][0];positions=[]
        for char in line:positions.append((x,group[0]['origin'][1]+i*lineheight));x+=font.width(char,size)+(gap if char==' ' else 0)
        parts.append({'font':font,'style':style,'text':line,'origins':positions})
    if extra:
        # Validate all moved glyphs before removing anything. No font substitution.
        for g in moving:
            if tuple(g['dir'])!=(1,0):raise PdfLayoutError('下方包含旋轉文字，需用原稿排版。')
            f=fonts.get(page,g);f.width(g['c'],g['style']['size'])
    return {'kind':'same_page_reflow' if extra else 'paragraph','glyphs':group,'moving':moving if extra else [],'parts':parts,'drawings':drawings,'shift':extra,'rects':[list(region)]}


def redraw_line(page,drawing,dy):
    shape=page.new_shape()
    for _,a,b in drawing['items']:shape.draw_line((a.x,a.y+dy),(b.x,b.y+dy))
    shape.finish(color=drawing['color'],width=drawing['width'],dashes=drawing['dashes'],lineCap=max(drawing['lineCap']),lineJoin=drawing['lineJoin'],stroke_opacity=drawing.get('stroke_opacity',1),closePath=drawing.get('closePath',False))
    shape.commit()


def outside_matches(before,after,rects,scale=1):
    a=before.get_pixmap(matrix=pymupdf.Matrix(scale,scale),alpha=False)
    b=after.get_pixmap(matrix=pymupdf.Matrix(scale,scale),alpha=False)
    if (a.width,a.height,a.n)!=(b.width,b.height,b.n):return False
    left,right=a.samples,b.samples;stride=a.width*a.n
    areas=[pymupdf.Rect(r)*pymupdf.Matrix(scale,scale) for r in rects]
    for y in range(a.height):
        spans=sorted((max(0,math.floor(r.x0)-2),min(a.width,math.ceil(r.x1)+2)) for r in areas if r.y0-2<=y<=r.y1+2)
        x=0
        for start,end in spans+[(a.width,a.width)]:
            if start>x and left[y*stride+x*a.n:y*stride+start*a.n]!=right[y*stride+x*a.n:y*stride+start*a.n]:return False
            x=max(x,end)
    return True


def text_inventory(page):
    return Counter(compact(''.join(g['c'] for g in glyphs_of(page)[0])))


def drawing_inventory(page,plans=()):
    shifts={d['seqno']:p['shift'] for p in plans for d in p.get('drawings',[])}
    counts=Counter()
    for d in page.get_drawings():
        dy=shifts.get(d['seqno'],0);items=[]
        for item in d['items']:
            points=[]
            for point in item[1:]:
                if isinstance(point,pymupdf.Point):points.append((round(point.x,2),round(point.y+dy,2)))
                elif isinstance(point,pymupdf.Rect):points.append(tuple(round(v+(dy if i%2 else 0),2) for i,v in enumerate(point)))
                else:points.append(str(point))
            items.append((item[0],tuple(points)))
        color=lambda value:tuple(round(v,6) for v in value) if value is not None else None
        counts[(d['type'],tuple(items),round(d['width'] or 0,3),color(d['color']),color(d['fill']),tuple(d.get('lineCap') or ()),d.get('lineJoin'),d.get('closePath'),d.get('dashes'),d.get('stroke_opacity'),d.get('fill_opacity'))]+=1
    return counts


def apply_page(page,edits,fonts):
    if page.rotation:raise PdfLayoutError('此頁有旋轉排版，請使用原稿處理。')
    if list(page.widgets() or []):raise PdfLayoutError('此頁有互動欄位，請使用原稿處理。')
    if any(a.type[0]==pymupdf.PDF_ANNOT_REDACT for a in page.annots() or []):raise PdfLayoutError('此頁已有遮蓋標記，請先由原稿確認。')
    glyphs,blocks=glyphs_of(page);plans=[]
    for edit in edits:
        selected=locate(glyphs,edit['original'])
        plan=minimal_plan(page,glyphs,selected,edit['replacement'],fonts)
        if plan is None:plan=paragraph_plan(page,glyphs,blocks,selected,edit,fonts)
        plan['check_id']=edit.get('check_id');plans.append(plan)
    if len(plans)>1 and any(p['kind']!='in_place' for p in plans):
        raise PdfLayoutError('同頁有多項段落改寫，需逐項調整排版。')
    if any(pymupdf.Rect(link['from']).intersects(pymupdf.Rect(r)) for link in page.get_links() for plan in plans for r in plan['rects']):
        raise PdfLayoutError('修改區包含連結，請使用原稿保留連結及排版。')
    # Overlap redaction removes all original rules (including rules inside Forms).
    # Restore a simple full-page solid background behind the retained page content.
    # Other artwork must survive unchanged; the vector/raster verification rejects it
    # if MuPDF cannot retain it.
    backgrounds=[d for d in page.get_drawings() if d['type']=='f' and len(d['items'])==1
                 and d['items'][0][0]=='re' and pymupdf.Rect(d['items'][0][1]).contains(page.rect)]
    removed=[]
    for plan in plans:
        removed += [g for part in plan['parts'] for g in part.get('glyphs',[])] if plan['kind']=='in_place' else plan['glyphs']+plan['moving']
        for drawing in plan.get('drawings',[]):
            r=pymupdf.Rect(drawing['rect']);pad=max(1,drawing['width']*5+.1);r+=(-pad,-pad,pad,pad);page.add_redact_annot(r,fill=False,cross_out=False)
    remove_glyphs(page,{g['index']:g for g in removed}.values())
    page.apply_redactions(images=0,graphics=2 if any(p.get('drawings') for p in plans) else 0,text=0)
    for background in reversed(backgrounds):
        key=(background['rect'],background['fill'])
        if not any(d['type']=='f' and d['rect']==key[0] and d['fill']==key[1] for d in page.get_drawings()):
            page.draw_rect(background['rect'],color=None,fill=background['fill'],fill_opacity=background['fill_opacity'],overlay=False)
    commands=[]
    for plan in plans:
        for part in plan['parts']:
            if part['text']:commands.append(text_command(page,part['font'],part.get('style') or part['glyphs'][0]['style'],part['text'],part['origins']))
        for g in plan.get('moving',[]):
            f=fonts.get(page,g);commands.append(text_command(page,f,g['style'],g['c'],[(g['origin'][0],g['origin'][1]+plan['shift'])]))
        for drawing in plan.get('drawings',[]):redraw_line(page,drawing,plan['shift'])
    append_commands(page,commands)
    return plans


def revise_pdf(raw,edits):
    if not edits:
        with pymupdf.open(stream=raw,filetype='pdf') as original:
            return raw,{'status':'ready','pages':[],'page_count':len(original)}
    source=pymupdf.open(stream=raw,filetype='pdf');doc=pymupdf.open(stream=raw,filetype='pdf')
    try:
        if doc.is_encrypted or doc.get_sigflags()>0:raise PdfLayoutError('加密或已簽署PDF需使用原稿處理。')
        book=FontBook(doc);groups={};plans={};expected={}
        for edit in edits:groups.setdefault(edit['page'],[]).append(edit)
        for number,items in groups.items():
            try:
                expected[number]=text_inventory(source[number-1])
                for edit in items:
                    expected[number].subtract(Counter(compact(edit['original'])));expected[number].update(compact(edit['replacement']))
                expected[number]=+expected[number]
                plans[number]=apply_page(doc[number-1],items,book)
            except PdfLayoutError as e:
                e.page=number;e.check_id=e.check_id or items[0].get('check_id');raise
        result=doc.tobytes(garbage=4,deflate=True)
        with pymupdf.open(stream=result,filetype='pdf') as verified:
            if len(verified)!=len(source):raise PdfLayoutError('匯出頁數不符，未提供此檔案。')
            for i in range(len(source)):
                if source[i].rect!=verified[i].rect or source[i].rotation!=verified[i].rotation:raise PdfLayoutError('原頁尺寸已改動，未提供此檔案。',i+1)
                if i+1 in expected and text_inventory(verified[i])!=expected[i+1]:raise PdfLayoutError('修訂文字讀回不符，未提供此檔案。',i+1)
                if i+1 in expected and drawing_inventory(source[i],plans[i+1])!=drawing_inventory(verified[i]):raise PdfLayoutError('表格線或圖形核對不符，未提供此檔案。',i+1)
                rects=[r for p in plans.get(i+1,[]) for r in p['rects']]
                if not outside_matches(source[i],verified[i],rects):raise PdfLayoutError('指定修改區以外的版面有變，未提供此檔案。',i+1)
        return result,{'status':'ready','page_count':len(source),'pages':[{'page':p,'mode':items[0]['kind'],'shift_points':round(items[0].get('shift',0),3),'outside_edit_area_identical':True} for p,items in plans.items()]}
    finally:source.close();doc.close()
