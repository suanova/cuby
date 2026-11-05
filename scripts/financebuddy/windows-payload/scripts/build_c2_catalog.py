"""Compile a source-checked Main Board C2 coverage inventory, not legal approval."""
import hashlib
import json
from pathlib import Path
import re
import unicodedata
import pymupdf

ROOT=Path(__file__).resolve().parents[1]
RULE='dataset/rules/HKEX_主板C2_ESG守則_EN.pdf'
SHA='4bbf50f7f9231953e26d0bf391d53aa178dd9d4c774806db97072fa22dbb4746'
URL='https://en-rules.hkex.com.hk/rulebook/appendix-c2-environmental-social-and-governance-reporting-code-0'
PDF_URL='https://en-rules.hkex.com.hk/sites/default/files/net_file_store/HKEX4476_3841_VER36624.pdf'
def norm(s):return re.sub(r'\s+','',unicodedata.normalize('NFKC',s)).casefold()
def digest(b):return hashlib.sha256(b).hexdigest()

def compile_catalog(root=ROOT):
    raw=(root/RULE).read_bytes()
    if digest(raw)!=SHA:raise ValueError('C2 source changed; re-map the catalog before compiling.')
    with pymupdf.open(stream=raw,filetype='pdf') as pdf:
        pages=[p.get_text() for p in pdf]
    rules=[]
    def add(clause,part,batch,label,page,anchor,criteria,kind='disclosure',condition='always',related=()):
        if norm(anchor) not in norm(pages[page-1]):raise ValueError(f'Rule {clause} quote absent on PDF {page}: {anchor}')
        rules.append({'id':'C2-'+re.sub(r'[^A-Za-z0-9]+','-',clause).strip('-'),'clause':clause,'part':part,'batch':batch,
          'label':label,'rule_page':page,'rule_quote':anchor,'criteria':criteria,'kind':kind,'condition':condition,'related_clauses':list(related)})
    add('4(1)-period','A','general','ESG 與年報期間一致',2,'regarding the same period covered in its annual report',
        '核對 ESG 與年報的起訖日；未提供年報時列待補，不能以ESG自述證明兩份相同。',condition='annual_required')
    add('4(1)-publication','A','general','年度發布及兩個網站刊載',2,'must be published on the Exchange’s website and the issuer’s website',
        '需正式刊載日期及交易所、公司網站網址；待刊稿尚未發布不等於已違規。',kind='external')
    add('4(2)(a)','A','general','向股東提供獨立 ESG 報告',2,'provide the ESG report to its shareholders using electronic means',
        '獨立報告的股東提供安排及適用法律須另核；PDF內容不能證明已送達。',kind='external',condition='separate_report')
    add('4(2)(d)','A','general','獨立 ESG 與年報同時發布',2,'at the same time as the publication of the annual report',
        '核對正式刊載日期；待刊稿列待補發布安排，不判違規。',kind='external',condition='separate_report')
    add('7','A','general','額外重大議題及持份者意見',2,'additional ESG issues and KPIs that reflect the issuer’s significant environmental and social impacts',
        '此項屬鼓勵性披露；如有額外重大議題，記錄選擇及持份者意見，不能當硬性遺漏。',kind='recommended')
    add('9','A','general','獨立鑒證的級別、範圍及程序',3,'Where independent assurance is obtained',
        '只在取得鑒證時核對級別、範圍及程序；沒有鑒證並非違規，未說明有無則適用性待確認。',condition='assurance_obtained')
    add('11(1)','A','general','重大議題與氣候財務影響',3,'could reasonably be expected to affect its cash flows, its access to finance or cost of capital',
        '重大議題辨識及氣候財務重大性，不能把所有一般環保活動當作財務重大風險。',related=('14',))
    add('11(2)','A','general','量化數據、目的及比較資料',3,'Quantitative information should be accompanied by a narrative',
        '歷史KPI可量度、有目的及影響解釋，適當時有比較資料；不把方向性目標一律當缺少數值。')
    add('11(3)','A','general','平衡呈現',3,'avoid selections, omissions, or presentation formats',
        '只報告有具體原文支持的偏頗或誤導呈現；僅有平衡聲明不能核實全體資訊，欠原始資料時列需人工核實。',kind='manual')
    add('11(4)','A','general','跨年方法一致性',3,'consistent methodologies to allow for meaningful comparisons',
        '方法及KPI變更是否交代；不得假設沿用方法或直接將數字相同視為口徑相同。',related=('14',))
    for clause,label,anchor,criteria in [
      ('12(i)','董事報告的環境政策及表現','a discussion of the issuer’s environmental (including climate-related) policies and performance','核對年報董事報告的業務回顧及ESG銜接。'),
      ('12(ii)','董事報告的重大法律合規','a discussion of the issuer’s compliance with the relevant laws and regulations','核對對公司有重大影響的法規遵守說明；不以一般聲明核實實際法律合規。'),
      ('12(iii)','董事報告的關鍵關係','an account of the issuer’s key relationships','核對員工、客戶、供應商及其他關鍵關係。')]:
        add(clause,'A','general',label,4,anchor,criteria,condition='annual_required')
    for clause,label,anchor,criteria in [
      ('13(i)','董事會監督 ESG','a disclosure of the board’s oversight of ESG issues','需董事會聲明及監督角色，只有工作小組介紹不足。'),
      ('13(ii)','ESG 管理策略及重大議題管理','the board’s ESG management approach and strategy','辨識、評估、排序及管理重大ESG議題和業務風險的程序。'),
      ('13(iii)','董事會檢討目標進度','how the board reviews progress made against ESG-related goals and targets','董事會如何檢討進度，以及目標與業務的關係。'),
      ('14-materiality','重大議題辨識及選擇準則','the process to identify and the criteria for the selection of material ESG factors','辨識程序及選擇準則兩者均須檢視。'),
      ('14-stakeholders','持份者參與程序及結果','a description of significant stakeholders identified','如有持份者參與，須有主要持份者、程序及結果；未進行不可猜測。'),
      ('14-quantitative','排放及能源計算依據','Information on the standards, methodologies, assumptions and/','標準、方法、假設／工具、換算因子來源；只列因子不能確認其他要素。'),
      ('14-consistency','影響可比性的變更','any changes to the methods or KPIs used','方法、KPI及其他影響比較的變動；欠底稿不能核實數值真實性。'),
      ('15-boundary','報告邊界及選取程序','describing the process used to identify which entities or operations are included','需有涵蓋公司／營運及選取程序；財務合併邊界不必然等同ESG營運邊界。'),
      ('15-change','範圍變更及原因','explain the difference and reason for the change','如有範圍變動，核對差異及原因，不把正常擴展業務直接判錯。')]:
        add(clause,'B','general',label,5,anchor,criteria,related=('10',) if clause=='13(i)' else ())

    general={'A1':(6,'排放政策及重大法規'),'A2':(7,'資源使用政策'),'A3':(7,'環境及天然資源政策'),
      'B1':(8,'僱傭政策及重大法規'),'B2':(8,'健康安全政策及重大法規'),'B3':(9,'培訓政策及活動'),
      'B4':(9,'防止童工及強迫勞工'),'B5':(10,'供應鏈環境及社會風險政策'),'B6':(11,'產品責任政策及重大法規'),
      'B7':(12,'反貪污政策及重大法規'),'B8':(12,'社區參與政策')}
    kpi_labels={
      'A1.1':'廢氣種類及排放數據','A1.3':'有害廢物總量及密度','A1.4':'無害廢物總量及密度','A1.5':'排放目標及行動','A1.6':'廢物處理、減量目標及行動',
      'A2.1':'分類能源總量及密度','A2.2':'用水總量及密度','A2.3':'能源效益目標及行動','A2.4':'取水問題、用水效益目標及行動','A2.5':'包裝材料總量及每單位用量','A3.1':'重大環境影響及管理行動',
      'B1.1':'員工人數的四類細分','B1.2':'流失率的三類細分','B2.1':'三年工亡人數及比率','B2.2':'工傷損失工作日','B2.3':'安全措施及執行監察',
      'B3.1':'按性別及職級的受訓比例','B3.2':'按性別及職級的平均培訓時數','B4.1':'防止童工及強迫勞工的審查','B4.2':'發現違規後的處理程序',
      'B5.1':'按地區的供應商數目','B5.2':'供應商聘用慣例及覆蓋數目','B5.3':'供應鏈環社風險辨識及監察','B5.4':'環保採購慣例及監察',
      'B6.1':'因安全健康召回的產品比例','B6.2':'產品服務投訴數及處理','B6.3':'知識產權保護','B6.4':'品質保證及召回程序','B6.5':'客戶資料私隱政策及監察',
      'B7.1':'已審結貪污案件數及結果','B7.2':'預防及舉報程序與監察','B7.3':'董事及員工反貪污培訓','B8.1':'社區貢獻重點','B8.2':'投入社區的金錢或時間'}
    for aspect,(page,label) in general.items():
        text=pages[page-1];segment=text[text.index('Aspect '+aspect+':'):];segment=segment[:segment.index('KPI '+aspect+'.1')]
        original=segment.split('General Disclosure',1)[1].strip()
        add(aspect+'-GD','C','environment' if aspect.startswith('A') else 'social',label,page,original[:170],
          '逐項核對此一般披露原文的所有要素及相關主題；政策與重大法律遵守說明須分別檢視。',condition='topic_relevance')
    for ident,label in kpi_labels.items():
        page=next(i+1 for i,t in enumerate(pages) if re.search(r'KPI\s+'+re.escape(ident)+r'\b',t))
        text=pages[page-1];match=re.search(r'KPI\s+'+re.escape(ident)+r'\s*',text);tail=text[match.end():]
        cut=re.search(r'\n(?:KPI\s|Aspect\s|Community\b|Operating Practices\b|AC2\s)',tail)
        original=(tail[:cut.start()] if cut else tail).strip()
        add(ident,'C','environment' if ident.startswith('A') else 'social',label,page,original[:170],
          re.sub(r'\s+',' ',original)+' 核對數值、單位、分母、期間、所有要求細分及所需行動／監察；索引不算實際披露。零值與明確否定陳述可以是有效披露；條文中的where appropriate／if applicable不可刪掉。',condition='topic_relevance')

    def d(clause,label,page,anchor,criteria,condition='always',kind='disclosure',batch=None):
        n=int(re.match(r'\d+',clause)[0]);batch=batch or ('climate_strategy' if n<24 else 'climate_finance' if n<28 else 'climate_metrics' if n<37 else 'climate_targets')
        add(clause,'D',batch,label,page,anchor,criteria,kind,condition)
    d('16(2)','尚未披露項目的工作計劃',13,'work plan, progress and timetable','此項屬鼓勵披露；有不披露或寬免主張時記錄補充披露的工作計劃、進度及時間表。',kind='recommended',batch='climate_strategy')
    d('19(a)','氣候監督機構或負責人',14,'the governance body(s)','董事會／委員會或負責人的身份及監督職責；可與B13合併披露，不要求重複章節。')
    d('19(a)(i)','氣候監督的技能及能力',14,'how the body(s) or individual(s) determines whether appropriate skills','現有或將發展的技能能力，以及如何作此判斷。')
    d('19(a)(ii)','氣候資訊匯報方式及頻率',14,'how and how often the body(s) or individual(s) is informed','方式及頻率均須核對。')
    d('19(a)(iii)','氣候事項納入策略及重大交易',14,'when overseeing the issuer’s strategy, its decisions on major transactions','策略、重大交易、風險管理及相關政策如何考慮風險機遇及權衡。')
    d('19(a)(iv)','監督氣候目標及薪酬連結',14,'oversees the setting of, and monitors progress','目標訂立、進度監督及是否／如何連結薪酬；可交叉引用35。')
    d('19(b)(i)','管理層氣候職責及監督',15,'whether the role is delegated to a specific management-level position','職責委派對象及其監督安排。')
    d('19(b)(ii)','管理層控制程序及內部整合',15,'whether management uses controls and procedures','有否及如何使用控制程序，與其他內部職能如何整合。')
    for clause,label,anchor,criteria in [
      ('20(a)','氣候風險機遇及財務影響','describe climate-related risks and opportunities','對現金流、融資或資本成本可能有影響的風險及機遇。'),
      ('20(b)','實體及轉型風險分類','physical risk or climate-related transition risk','逐項風險的實體／轉型分類。'),
      ('20(c)','風險機遇的時間跨度','over which time horizons','各項風險及機遇的短中長期影響。'),
      ('20(d)','短中長期定義及規劃銜接','how the issuer defines ‘short term’','三種期限的定義與策略規劃時間的關係。')]:d(clause,label,15,anchor,criteria)
    d('20-note2','商業敏感機遇的豁免主張',16,'disclose the fact that it has used the exemption','只限機遇、非公開、嚴重損害經濟利益且不能用彙總披露達標；使用時披露事實及每期重評。不得把一般保密理由當已批准豁免。',condition='commercial_sensitivity_claim')
    d('21(a)','業務模式及價值鏈影響',17,'current and anticipated effects','需有目前及預期影響，不能只列一般氣候風險名稱。')
    d('21(b)','風險機遇集中位置',17,'where in the issuer’s business model and value chain','地區、設施、資產類型等集中位置。')
    for clause,label,anchor,criteria in [
      ('22(a)(i)','業務模式及資源調整','current and anticipated changes to the issuer’s business model','目前及預期變更，包括資源分配。'),
      ('22(a)(ii)','適應及減緩措施','current and anticipated adaptation and mitigation efforts','目前與預期、直接或間接措施。'),
      ('22(a)(iii)','氣候轉型計劃或否定陳述','or an appropriate negative statement where the issuer does not have','有計劃則披露主要假設及依賴條件；沒有可明確作否定陳述。'),
      ('22(a)(iv)','實現氣候目標的方法','how the issuer plans to achieve any climate-related targets','與37–40所列目標相對應的實現方法。')]:d(clause,label,17,anchor,criteria)
    d('22(b)','氣候行動的資源投入',18,'how the issuer is resourcing, and plans to resource','現有及計劃資源如何支持22(a)活動。')
    d('23','以往氣候計劃的進度',18,'progress of plans disclosed in previous reporting periods','本稿是否披露以往計劃的進度；未提供舊報告時不能確認已完整承接所有舊承諾。')
    d('24(a)','本期氣候財務影響',18,'financial position, financial performance and cash flows for the reporting period','定性及定量、本期財務狀況、業績及現金流；量化豁免須按25附註3/5核對，不直接判漏。')
    d('24(b)','下年度重大賬面值調整風險',18,'a material adjustment within the next annual reporting period','資產及負債的賬面值重大調整風險；明確無此風險可作有效陳述。')
    d('24-note2','財務影響與財報項目銜接',18,'explain how such information is reflected in its financial statements','量化資訊如非財報獨立行，需說明反映在哪些財務項目。',condition='non_line_item_financial_quantification')
    d('25(a)','預期財務狀況、投資及資金',18,'its investment and disposal plans','短中長期財務狀況變化、投資／處置計劃及資金來源；核對25附註的量化寬免條件。')
    d('25(b)','預期業績及現金流影響',19,'financial performance and cash flows to change','短中長期業績及現金流的定性及定量資訊，適用量化寬免須有依據。')
    d('25-notes3-5','財務量化寬免的原因及替代披露',19,'explain why it has not provided quantitative information','核對不能分開辨識／高度不確定性；欠技能能力資源只適用預期量化。主張寬免時需原因、定性影響及相關財報項目；附註5(c)合併量化或無用處判斷亦須核對（PDF20）。',condition='financial_relief_claim')
    d('26(a)','氣候韌性評估結果',20,'the issuer’s assessment of its climate resilience','評估日期、策略及業務模式意涵、重大不確定性及短中長期適應能力。')
    d('26(b)(i)','情境分析輸入的七項資料',20,'information about the inputs used','情境及來源、多樣性、實體／轉型、最新國際協議相容情境及選擇原因、時間及營運範圍；完整要求延續至PDF21。')
    d('26(b)(ii)','情境分析主要假設',21,'the key assumptions the issuer made in the analysis','核對主要假設；不能用模型常識補充。')
    d('26(b)(iii)','情境分析執行期間',21,'the reporting period in which the climate-related scenario analysis was carried out','實際執行的報告期間，不能用報告出版年代替。')
    for clause,label,anchor,criteria in [
      ('27(a)(i)','風險程序的輸入及參數','the inputs and parameters the issuer uses','資料來源及程序涵蓋營運範圍。'),
      ('27(a)(ii)','情境分析納入風險辨識','whether and how the issuer uses climate-related scenario analysis','是否及如何使用；否定陳述不等於自動違規。'),
      ('27(a)(iii)','風險性質、機率及影響程度','nature, likelihood and magnitude','定性因素、量化門檻或其他評估準則。'),
      ('27(a)(iv)','氣候風險與其他風險排序','prioritises climate-related risks relative to other types of risks','是否及如何相對其他風險排序。')]:d(clause,label,21,anchor,criteria)
    d('27(a)(v)','氣候風險監察',22,'how the issuer monitors climate-related risks','實際監察程序。')
    d('27(a)(vi)','風險程序的跨年變更',22,'changed the processes it uses compared with the previous reporting period','是否及如何改變；明確無變更可有效披露。')
    d('27(b)','氣候機遇管理程序',22,'the processes the issuer uses to identify, assess, prioritise and monitor','機遇辨識、評估、排序、監察及是否／如何使用情境分析。')
    d('27(c)','整體風險管理整合',22,'integrated into and inform the issuer’s overall risk management process','整合程度及方法，可引用綜合ESG風險管理，毋須重複章節。')
    for scope in (1,2,3):d(f'28({chr(96+scope)})',f'Scope {scope} 排放總量、單位及期間',22,f'Scope {scope} greenhouse gas emissions',
        '當期absolute gross總量、metric tonnes CO2e及清楚期間；不可用淨抵銷值代替，不能從表格總數推定gross方法。')
    d('29(a)','溫室氣體計量標準',22,'Greenhouse Gas Protocol: A Corporate Accounting and Reporting Standard (2004)','核對各適用Scope，非僅Scope3；其他計量標準須有管轄機關或另一上市交易所要求依據。')
    for clause,label,anchor,criteria in [
      ('29(b)(i)','排放方法、輸入及假設','the measurement approach, inputs and assumptions','方法、輸入及假設各自核對；需跨讀能源表及腳註；因子來源並不代表完整方法。'),
      ('29(b)(ii)','選擇排放計量方法的原因','the reason why the issuer has chosen','方法、輸入及假設的選擇原因；與本期變更原因不同。'),
      ('29(b)(iii)','排放方法變更及原因','any changes the issuer made to the measurement approach','本期方法、輸入、假設的變更及原因。'),
      ('29(c)-location','Scope 2 地點基準排放','disclose its location-based Scope 2 greenhouse gas emissions','location-based須清晰；地區因子只能部分支持，market-based不能取代。'),
      ('29(c)-contracts','Scope 2 合約文書資訊','provide information about any contractual instruments','如有相關文書，需足以理解Scope2的資訊；未提及不能推定沒有。'),
      ('29(d)','Scope 3 涵蓋類別','disclose the categories included within the issuer’s measure','依2011價值鏈標準說明納入的類別；本項不表示所有15類均適用，核對界定及理由。'),
      ('29-note2','價值鏈數據期間差異','the length of the reporting periods is the same','如採不同期間的價值鏈數據，核對最近可取得、期間長度相同及期間之間重大事件影響披露。')]:
        d(clause,label,23,anchor,criteria,condition='value_chain_different_periods' if clause=='29-note2' else 'contracts_if_any' if clause=='29(c)-contracts' else 'always')
    d('29-note3','金融業融資排放補充',24,'additional information about the issuer’s Category 15','只在業務包括資產管理、商業銀行或保險時考慮；屬鼓勵披露。',condition='financial_sector',kind='recommended')
    for clause,label,anchor,criteria in [
      ('30','轉型風險資產／業務金額及比例','assets or business activities vulnerable to climate-related transition risks','金額及百分比、對應資產／業務及分母；估計毛利損失不自動等同受影響業務比例。'),
      ('31','實體風險資產／業務金額及比例','assets or business activities vulnerable to climate-related physical risks','金額及百分比，以及資產／業務範圍和分母。'),
      ('32','氣候機遇資產／業務金額及比例','assets or business activities aligned with climate-related opportunities','金額及百分比，以及資產／業務範圍和分母。'),
      ('33','氣候資本、融資及投資金額','capital expenditure, financing or investment','投向氣候風險及機遇的資本開支、融資或投資金額。'),
      ('34','內部碳價或否定陳述','does not apply a carbon price in decision-making','有使用時需是否及如何用於決策及每噸價格；沒有可明確否定，不能要求虛構碳價。')]:d(clause,label,24,anchor,criteria)
    d('35','氣候薪酬連結或否定陳述',25,'whether and how climate-related considerations are factored','是否及如何納入薪酬，或明確否定；可與19(a)(iv)合併。')
    d('36','行業指標',25,'An issuer is encouraged to disclose industry-based metrics','建議披露；參考相關行業指標及適用性，不把未披露當硬性缺失。',kind='recommended')
    d('37-targets','自訂及法定氣候目標',25,'qualitative and quantitative climate-related targets','自訂及法規要求目標；不能假設一定有某個未證實法定目標。')
    for clause,label,anchor,criteria in [
      ('37(a)','目標指標','the metric used to set the target','逐個目標對應指標。'),
      ('37(b)','目標目的','the objective of the target','減緩、適應或科學倡議等目的。'),
      ('37(c)','目標涵蓋範圍','the part of the issuer to which the target applies','全公司或指定業務、地區等。'),
      ('37(d)','目標期間','the period over which the target applies','每項目標適用期間。'),
      ('37(e)','目標基準期','the base period from which progress is measured','每項目標基準期。'),
      ('37(f)','里程碑或中期目標','milestones or interim targets (if any)','如有才要求；不能將沒有中期目標自動判硬性遺漏。'),
      ('37(g)','絕對值或密度目標','whether the target is an absolute target or an intensity target','量化目標需說明絕對或強度；定性目標不適用此細項。')]:d(clause,label,25,anchor,criteria,condition='targets_if_any')
    d('37(h)','國際協議及地區承諾如何影響目標',26,'how the latest international agreement on climate change','如何影響目標設定，包括相關地區承諾；不替公司補充主張。',condition='targets_if_any')
    for clause,label,anchor,criteria in [
      ('38(a)','目標及方法是否第三方驗證','whether the target and the methodology for setting the target has been validated','是否驗證及對應目標；並非強制必須找第三方驗證。'),
      ('38(b)','目標檢討程序','the issuer’s processes for reviewing the target','逐項目標的檢討程序。'),
      ('38(c)','監察目標進度的指標','the metrics used to monitor progress','逐項目標的進度指標。'),
      ('38(d)','目標修訂及原因','any revisions to the target and an explanation','如有修訂，需內容及原因。'),
      ('39','氣候目標表現及趨勢','performance against each climate-related target','對每項目標的表現及趨勢／變動分析；僅年度同比不必然等同對目標基準期進度。'),
      ('40(a)','排放目標涵蓋氣體','which greenhouse gases are covered by the target','每項排放目標涵蓋哪些氣體。'),
      ('40(b)','排放目標涵蓋 Scope','whether Scope 1, Scope 2 or Scope 3','每項目標所涵蓋範圍。'),
      ('40(c)','總量及淨排放目標','separately disclose its associated gross greenhouse gas emissions target','標明gross/net；淨目標另需gross目標。'),
      ('40(d)','行業減碳路徑','whether the target was derived using a sectoral decarbonisation approach','是否使用行業減碳方法，否定陳述可有效。'),
      ('40(e)(i)','碳信用依賴程度','relies on the use of carbon credits','若計劃以碳信用達成淨排放目標，披露程度及方法。'),
      ('40(e)(ii)','碳信用第三方認證計劃','which third-party scheme(s) will verify or certify','計劃使用碳信用時的認證計劃。')]:
        d(clause,label,26,anchor,criteria,condition='carbon_credits_planned' if clause.startswith('40(e)') else 'ghg_targets_if_any' if clause.startswith('40') else 'targets_if_any')
    d('40(e)(iii)','碳信用類型及減碳／移除',27,'the type of carbon credit','自然／技術移除及減排／移除的類型。',condition='carbon_credits_planned')
    d('40(e)(iv)','碳信用可信度及完整性',27,'credibility and integrity of the carbon credits','理解可信度及完整性所需其他因素，例如永久性假設。',condition='carbon_credits_planned')
    d('41','跨行業及行業指標的適用性考慮',27,'refer to and consider the applicability','準備21–26及37–38時考慮跨行業及行業指標；第36仍屬鼓勵披露，不能因本條把全部行業指標轉為強制。',kind='manual')

    inventory=[]
    for n in range(1,42):
        mapped=[r['id'] for r in rules if re.match(r'^'+str(n)+r'(?:\D|$)',r['clause']) or str(n) in r['related_clauses']]
        inventory.append({'unit':str(n),'part':'A' if n<=12 else 'B' if n<=15 else 'D','handling':'review' if mapped else 'context',
          'checks':mapped,'note':'' if mapped else '定義、義務架構或閱讀指引；透過適用性引擎及各披露項執行，不另假定公司須逐字重述守則。'})
    inventory += [{'unit':r['clause'],'part':'C','handling':'review','checks':[r['id']]} for r in rules if r['part']=='C']
    inventory += [{'unit':c,'part':'C','handling':'repealed','checks':[],'note':'已於2025-01-01刪除，不當作現行遺漏。'} for c in ('A1.2','A4-GD','A4.1')]
    ids=[r['id'] for r in rules]
    if len(ids)!=len(set(ids)):raise ValueError('Duplicate catalog IDs.')
    return {'schema_version':'financebuddy-c2-full-catalog-1','revision':'1.0.0','jurisdiction':'HKEX Main Board','effective_from':'2025-01-01',
      'source':{'file_name':Path(RULE).name,'local_path':RULE,'sha256':SHA,'text_sha256':digest(norm('\n'.join(pages)).encode()),'page_count':len(pages),'url':URL,'pdf_url':PDF_URL},
      'batches':[{'id':key,'label':label} for key,label in [('general','報告原則及董事會'),('environment','環境披露'),('social','社會披露'),('climate_strategy','氣候治理及策略'),('climate_finance','氣候財務影響及韌性'),('climate_metrics','氣候指標及計量'),('climate_targets','氣候目標及進度')]],
      'inventory':inventory,'checks':rules,'scope_note':'C2第1–41段及Part C現行一般披露／KPI全數登記；披露項、程序及建議項分開，並非全部屬硬性義務。外部引用準則、台帳及法律合規真實性不由PDF單獨證實。'}

if __name__=='__main__':
    catalog=compile_catalog();target=ROOT/'cuby/config/c2-full-catalog.json'
    target.write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'checks':len(catalog['checks']),'inventory_units':len(catalog['inventory']),'batches':{b['id']:sum(r['batch']==b['id'] for r in catalog['checks']) for b in catalog['batches']}}))
