"""Explicit older Yeebo table layouts. Preserve raw units; never invent conversions."""
import re
from emissions_baseline import previous_year

NUM=re.compile(r'(?<![A-Za-z0-9.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?')
def parse(content,year,language):
    result=[]
    total=r'Total\s*greenhouse\s*gas\s*emissions\s*\*|溫室氣體排放總量\s*\*'
    density=r'Greenhouse\s*gas\s*emission\s*intensity|溫室氣體排放密度'
    patterns={'total_ghg':total,'scope1':r'Scope\s*1\s*:|範圍\s*1\s*：','scope2':r'Scope\s*2\s*:|範圍\s*2\s*：',
              'scope3':r'Scope\s*3\s*:|範圍\s*3\s*：','ghg_intensity':density}
    marks=[]
    for key,pattern in patterns.items():
        hits=list(re.finditer(pattern,content,re.I))
        if len(hits)==1:marks.append((hits[0].start(),hits[0].end(),key))
    marks.sort()
    if [key for _,_,key in marks]==['total_ghg','scope1','scope2','scope3','ghg_intensity']:
        years=re.findall(r'(?:FY)?(20\d{2}/\d{2})',content[:marks[0][0]])[-2:]
        rows={key:content[start:marks[i+1][0] if i+1<len(marks) else len(content)] for i,(start,end,key) in enumerate(marks)}
        total_unit=bool(re.search(r'tonnes\s+of\s+CO2\s*e|公噸二氧化碳當量',rows['total_ghg'],re.I))
        intensity_unit=(bool(re.search(r'tonnes\s+of\s+CO2\s*e\s*/\s*m2|公噸二氧化碳當量\s*╱',rows['ghg_intensity'],re.I))
                        and bool(re.search(r'finished\s*goods|每平方米製成品',rows['ghg_intensity'],re.I)))
        parsed=[]
        if years==[year,previous_year(year)] and total_unit and intensity_unit:
            for i,(start,end,key) in enumerate(marks):
                segment=content[end:marks[i+1][0] if i+1<len(marks) else len(content)]
                # CO2e/m2 are units, not table values. Old GHG rows have decimals.
                values=re.findall(r'(?<![\d.])\d[\d,]*\.\d+(?!\d)',segment)
                if len(values)!=2:parsed=[];break
                for data_year,value in zip(years,values):
                    parsed.append({'metric':'ghg_'+key,'year':data_year,'value':value.replace(',',''),
                                   'unit':'tCO2e/m2_finished_goods' if key=='ghg_intensity' else 'tCO2e',
                                   'quote':rows[key],'unit_basis':'Explicit total-row merged unit and indented Scope 1/2/3 rows in the same table.'})
            result+=parsed
    carriers={'purchased_electricity':r'Electricity\s*##|市電\s*##','natural_gas':r'Natural\s*gas\s*#|天然氣\s*#',
              'diesel':r'Diesel\s*\*|柴油\s*\*','petrol':r'Petrol\s*\^|汽油\s*\^'}
    # The energy table may follow a GHG footnote on the same page; find all
    # labels first and use only the nearest four repeated year column headings.
    marks=[]
    for key,pattern in carriers.items():
        hits=list(re.finditer(pattern,content,re.I))
        if len(hits)==1:marks.append((hits[0].start(),hits[0].end(),key))
    marks.sort()
    if len(marks)==4:
        years=re.findall(r'(?:FY)?(20\d{2}/\d{2})',content[:marks[0][0]])[-4:]
        if years==[year,year,previous_year(year),previous_year(year)]:
            for i,(start,end,key) in enumerate(marks):
                segment=content[end:marks[i+1][0] if i+1<len(marks) else len(content)]
                segment=re.split(r'The\s*overall|能源消耗的整體|Notes?\s*:|附註\s*[:：]|Yeebo|億都',segment,maxsplit=1,flags=re.I)[0]
                unit=('kWh' if re.search(r'kWh|千瓦時',segment) else 'm3' if re.search(r'm3|立方米',segment) else 'L' if re.search(r'litres?|liters?|升|\bL\b',segment,re.I) else None)
                denominator=bool(re.search(r'finished\s*goods|每平方米製成品',segment,re.I))
                clean=re.sub(r'm[23]|CO2','',segment)
                values=NUM.findall(clean)
                if not unit or not denominator or len(values)!=4:continue
                for data_year,quantity,value in zip(years,['consumption','intensity','consumption','intensity'],values):
                    result.append({'metric':'energy_'+key+'_'+quantity,'year':data_year,'value':value.replace(',',''),
                                   'unit':unit+'/m2_finished_goods' if quantity=='intensity' else unit,'quote':content[start:end]+segment,
                                   'unit_basis':'Original per-cell physical/energy unit; no conversion applied.'})
    return result
