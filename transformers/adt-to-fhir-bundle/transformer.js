// =====================================================
// HL7v2 ADT → FHIR R4 Bundle + Business Rules
// =====================================================

// === MAPPING TABLES ===
var FACILITY_MAP = {
    'MGH':        {name: 'Massachusetts General Hospital', npi: '1234567890'},
    'BOSTON_MED': {name: 'Boston Medical Center', npi: '0987654321'},
    'CHILDREN':  {name: 'Boston Children\'s Hospital', npi: '1112223334'},
    'BWH':       {name: 'Brigham and Women\'s Hospital', npi: '5556667778'},
    'MAIN_HOSP': {name: 'Main Street Hospital', npi: '9998887776'}
};

var WARD_SERVICE_MAP = {
    'ICU':   {specialty: 'Critical Care Medicine', snomed: '309904001'},
    'CCU':   {specialty: 'Cardiology', snomed: '309904001'},
    'ER':    {specialty: 'Emergency Medicine', snomed: '310000008'},
    'SURG':  {specialty: 'General Surgery', snomed: '394294004'},
    'MED':   {specialty: 'Internal Medicine', snomed: '394802001'},
    'PEDS':  {specialty: 'Pediatrics', snomed: '394537008'},
    'ONCO':  {specialty: 'Oncology', snomed: '394593009'}
};

var PAYER_MAP = {
    'BCBS':    {name: 'Blue Cross Blue Shield', type: 'PPO'},
    'AETNA':   {name: 'Aetna Health Plans', type: 'HMO'},
    'UHC':     {name: 'UnitedHealthcare', type: 'PPO'},
    'MCARE':   {name: 'Medicare', type: 'Medicare'},
    'MCAID':   {name: 'MassHealth (Medicaid)', type: 'Medicaid'},
    'SELF':    {name: 'Self Pay', type: 'Self'}
};

var CRITICAL_DX = {
    'I21': {priority: 'STAT', alert: 'STEMI/NSTEMI Protocol', team: 'Cardiology'},
    'I46': {priority: 'STAT', alert: 'Cardiac Arrest Protocol', team: 'Code Blue'},
    'A41': {priority: 'URGENT', alert: 'Sepsis Bundle (SEP-1)', team: 'Infectious Disease'},
    'I63': {priority: 'STAT', alert: 'Stroke Code', team: 'Neurology'},
    'K35': {priority: 'URGENT', alert: 'Acute Abdomen', team: 'Surgery'},
    'S72': {priority: 'URGENT', alert: 'Hip Fracture Protocol', team: 'Orthopedics'},
    'J18': {priority: 'URGENT', alert: 'Pneumonia Bundle (PN-6)', team: 'Pulmonology'},
    'E11': {priority: 'ROUTINE', alert: 'Diabetes Care Protocol', team: 'Endocrinology'}
};


var ICD_TO_SNOMED = {
    'A41.9': {code: '91302008',  display: 'Sepsis (disorder)'},
    'I21.9': {code: '22298006',  display: 'Myocardial infarction (disorder)'},
    'J18.9': {code: '233604007', display: 'Pneumonia (disorder)'},
    'K35.80':{code: '74400008',  display: 'Appendicitis (disorder)'},
    'E11.9': {code: '44054006',  display: 'Diabetes mellitus type 2 (disorder)'},
    'I10':   {code: '38341003',  display: 'Hypertensive disorder (disorder)'},
    'R07.9': {code: '29857009',  display: 'Chest pain (finding)'},
    'I63.9': {code: '230690007', display: 'Cerebrovascular accident (disorder)'},
    'S52.501A':{code:'263102004',display: 'Fracture of radius (disorder)'},
    'S62.001A':{code:'65966004', display: 'Fracture of wrist (disorder)'},
    'J06.9': {code: '54150009',  display: 'Upper respiratory infection (disorder)'},
    'S72.001A':{code:'5913000',  display: 'Fracture of neck of femur (disorder)'}
};

// === LIVE TX TEST ===
var txTestResult = 'NOT_TESTED';
try {
    var HC = Packages.org.apache.http.impl.client.HttpClients;
    txTestResult = 'CLASS_FOUND: ' + HC;
    var cl = HC.createDefault();
    txTestResult = 'CLIENT_CREATED';
    var hg = new Packages.org.apache.http.client.methods.HttpGet('https://tx.fhir.org/r4/CodeSystem/$lookup?system=http%3A%2F%2Fhl7.org%2Ffhir%2Fsid%2Ficd-10-cm&code=A41.9');
    hg.addHeader('Accept', 'application/fhir+json');
    txTestResult = 'GET_CREATED';
    var resp = cl.execute(hg);
    txTestResult = 'EXECUTED: ' + resp.getStatusLine().getStatusCode();
    var body = Packages.org.apache.http.util.EntityUtils.toString(resp.getEntity(), 'UTF-8');
    txTestResult = 'BODY_LEN: ' + body.length;
    resp.close();
    cl.close();
    var parsed = JSON.parse(body);
    var params = parsed.parameter || [];
    for (var pi = 0; pi < params.length; pi++) {
        if (params[pi].name == 'display') txTestResult = 'VALIDATED: ' + params[pi].valueString;
    }
} catch(txe) {
    txTestResult = 'ERROR: ' + txe;
}
channelMap.put('txTestResult', txTestResult);

var MARITAL_MAP = {'S':'Never Married','M':'Married','D':'Divorced','W':'Widowed'};

// === EXTRACT FIELDS ===
var facility = msg['MSH']['MSH.4']['MSH.4.1'].toString();
var mrn = msg['PID']['PID.3']['PID.3.1'].toString();
var lastName = msg['PID']['PID.5']['PID.5.1'].toString();
var firstName = msg['PID']['PID.5']['PID.5.2'].toString();
var dob = msg['PID']['PID.7']['PID.7.1'].toString();
var gender = msg['PID']['PID.8']['PID.8.1'].toString();
var street = msg['PID']['PID.11']['PID.11.1'].toString();
var city = msg['PID']['PID.11']['PID.11.3'].toString();
var state = msg['PID']['PID.11']['PID.11.4'].toString();
var zip = msg['PID']['PID.11']['PID.11.5'].toString();
var phone = msg['PID']['PID.13']['PID.13.1'].toString();
var marital = msg['PID']['PID.16']['PID.16.1'].toString();

var patientClass = msg['PV1']['PV1.2']['PV1.2.1'].toString();
var ward = msg['PV1']['PV1.3']['PV1.3.1'].toString();
var room = msg['PV1']['PV1.3']['PV1.3.2'].toString();
var bed = msg['PV1']['PV1.3']['PV1.3.3'].toString();
var admitType = msg['PV1']['PV1.4']['PV1.4.1'].toString();
var attId = msg['PV1']['PV1.7']['PV1.7.1'].toString();
var attLast = msg['PV1']['PV1.7']['PV1.7.2'].toString();
var attFirst = msg['PV1']['PV1.7']['PV1.7.3'].toString();
var visitNum = msg['PV1']['PV1.19']['PV1.19.1'].toString();

var dx = '', dxDesc = '', dxSys = '';
try { dx = msg['DG1']['DG1.3']['DG1.3.1'].toString(); dxDesc = msg['DG1']['DG1.3']['DG1.3.2'].toString(); dxSys = msg['DG1']['DG1.3']['DG1.3.3'].toString(); } catch(e) {}

var insId = '', insName = '', grpNum = '';
try { insId = msg['IN1']['IN1.3']['IN1.3.1'].toString(); insName = msg['IN1']['IN1.4']['IN1.4.1'].toString(); grpNum = msg['IN1']['IN1.8']['IN1.8.1'].toString(); } catch(e) {}

// === APPLY MAPPINGS ===
var gMap = {'M':'male','F':'female','O':'other'};
var fGender = gMap[gender] || 'unknown';
var cMap = {'I':{c:'IMP',d:'inpatient'},'O':{c:'AMB',d:'ambulatory'},'E':{c:'EMER',d:'emergency'}};
var encClass = cMap[patientClass] || {c:'AMB',d:'ambulatory'};
var aMap = {'E':'Emergency','R':'Routine','U':'Urgent','N':'Newborn'};
var fAdmit = aMap[admitType] || admitType;
var fac = FACILITY_MAP[facility] || {name:facility,npi:'UNKNOWN'};
var svc = WARD_SERVICE_MAP[ward.toUpperCase()] || {specialty:'General',snomed:'394802001'};
var pay = insId ? (PAYER_MAP[insId.toUpperCase()] || {name:insName||insId,type:'Unknown'}) : null;
var fDob = dob.length >= 8 ? dob.substring(0,4)+'-'+dob.substring(4,6)+'-'+dob.substring(6,8) : '';
var age = dob.length >= 8 ? new Date().getFullYear() - parseInt(dob.substring(0,4)) : 0;
var fDxSys = dxSys == 'ICD10' ? 'http://hl7.org/fhir/sid/icd-10-cm' : 'http://snomed.info/sct';

// === BUSINESS RULES ===
var alerts = [];
var flags = [];
var notifs = [];

if (dx) {
    var prefix = dx.substring(0,3);
    var crit = CRITICAL_DX[prefix];
    if (crit) { alerts.push({priority:crit.priority, alert:crit.alert, team:crit.team, code:dx}); }
}

if (age >= 65 && patientClass == 'I') {
    flags.push({code:'geriatric-screen', display:'Geriatric Screening Required', reason:'Inpatient age >= 65 (age: '+age+')'});
    notifs.push('Geriatric consult auto-ordered');
}
if (age < 18) { flags.push({code:'pediatric', display:'Pediatric Patient', reason:'Age < 18'}); }

if (ward.toUpperCase().indexOf('ICU') >= 0) {
    flags.push({code:'icu-admit', display:'ICU Admission', reason:'Ward: '+ward});
    notifs.push('ICU bed management + pharmacy notified');
}

if (!pay) { flags.push({code:'no-insurance', display:'Insurance Missing', reason:'No IN1 segment'}); notifs.push('Financial counseling referral'); }

if (dx && dx.substring(0,3) == 'A41') {
    flags.push({code:'sep-1', display:'SEP-1 Sepsis Bundle Required', reason:'DX: '+dx});
    notifs.push('SEP-1 timer: Lactate 3h, cultures before ABX, broad-spectrum ABX 1h');
}

if (age >= 65 && dx && dx.substring(0,3) == 'S72') {
    flags.push({code:'hip-fx-elderly', display:'Elderly Hip Fracture Fast-Track', reason:'S72.x + age >=65'});
    alerts.push({priority:'STAT', alert:'Target OR within 24h', team:'Ortho+Geriatrics', code:dx});
}

// === BUILD FHIR BUNDLE ===
var patient = {resourceType:'Patient',id:mrn,meta:{profile:['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient']},identifier:[{use:'usual',type:{coding:[{system:'http://terminology.hl7.org/CodeSystem/v2-0203',code:'MR'}]},system:'urn:oid:2.16.840.1.113883.1.13.'+fac.npi,value:mrn}],active:true,name:[{use:'official',family:lastName,given:[firstName]}],gender:fGender,birthDate:fDob,address:[{use:'home',line:[street],city:city,state:state,postalCode:zip,country:'US'}],telecom:[{system:'phone',value:phone,use:'home'}]};
if (MARITAL_MAP[marital]) patient.maritalStatus = {coding:[{system:'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus',code:marital,display:MARITAL_MAP[marital]}]};

var org = {resourceType:'Organization',id:'org-'+facility,identifier:[{system:'http://hl7.org/fhir/sid/us-npi',value:fac.npi}],name:fac.name};
var pract = {resourceType:'Practitioner',id:'pract-'+attId,identifier:[{system:'http://hospital.org/practitioners',value:attId}],name:[{family:attLast,given:[attFirst]}],qualification:[{code:{coding:[{system:'http://snomed.info/sct',code:svc.snomed,display:svc.specialty}]}}]};
var enc = {resourceType:'Encounter',id:'enc-'+(visitNum||mrn),status:'in-progress','class':{system:'http://terminology.hl7.org/CodeSystem/v3-ActCode',code:encClass.c,display:encClass.d},type:[{coding:[{system:'http://terminology.hl7.org/CodeSystem/admit-type',code:admitType,display:fAdmit}]}],serviceType:{coding:[{system:'http://snomed.info/sct',code:svc.snomed,display:svc.specialty}]},subject:{reference:'Patient/'+mrn,display:firstName+' '+lastName},participant:[{individual:{reference:'Practitioner/pract-'+attId,display:attFirst+' '+attLast}}],location:[{location:{display:ward+' Room '+room+' Bed '+bed},status:'active'}],serviceProvider:{reference:'Organization/org-'+facility,display:fac.name}};

var bundle = {resourceType:'Bundle',type:'transaction',timestamp:new Date().toISOString(),entry:[{resource:patient,request:{method:'PUT',url:'Patient/'+mrn}},{resource:org,request:{method:'PUT',url:'Organization/org-'+facility}},{resource:pract,request:{method:'PUT',url:'Practitioner/pract-'+attId}},{resource:enc,request:{method:'PUT',url:'Encounter/enc-'+(visitNum||mrn)}}]};

if (dx) {
    var cond = {resourceType:'Condition',id:'cond-'+mrn+'-'+dx.replace(/\./g,'-'),clinicalStatus:{coding:[{system:'http://terminology.hl7.org/CodeSystem/condition-clinical',code:'active'}]},code:{coding:[{system:fDxSys,code:dx,display:dxDesc}].concat(ICD_TO_SNOMED[dx] ? [{system:'http://snomed.info/sct',code:ICD_TO_SNOMED[dx].code,display:ICD_TO_SNOMED[dx].display}] : []),text:dxDesc},subject:{reference:'Patient/'+mrn},encounter:{reference:'Encounter/enc-'+(visitNum||mrn)}};
    bundle.entry.push({resource:cond,request:{method:'PUT',url:'Condition/cond-'+mrn+'-'+dx.replace(/\./g,'-')}});
}

if (pay) {
    var cov = {resourceType:'Coverage',id:'cov-'+mrn,status:'active',beneficiary:{reference:'Patient/'+mrn},payor:[{display:pay.name}],'class':[{type:{coding:[{code:'group'}]},value:grpNum,name:pay.name},{type:{coding:[{code:'plan'}]},value:pay.type}]};
    bundle.entry.push({resource:cov,request:{method:'PUT',url:'Coverage/cov-'+mrn}});
}

for (var i=0;i<flags.length;i++) {
    var fl = {resourceType:'Flag',id:'flag-'+mrn+'-'+flags[i].code,status:'active',code:{coding:[{system:'http://hospital.org/flags',code:flags[i].code,display:flags[i].display}],text:flags[i].display+' ('+flags[i].reason+')'},subject:{reference:'Patient/'+mrn}};
    bundle.entry.push({resource:fl,request:{method:'PUT',url:'Flag/flag-'+mrn+'-'+flags[i].code}});
}

var rules = {alerts:alerts,flags:flags,notifications:notifs,mappings:{facility:facility+' -> '+fac.name,ward:ward+' -> '+svc.specialty,gender:gender+' -> '+fGender,class:patientClass+' -> '+encClass.d,admit:admitType+' -> '+fAdmit,insurance:(insId||'NONE')+' -> '+(pay?pay.name:'Not provided'),snomedMapping:(dx && ICD_TO_SNOMED[dx]) ? dx+' -> SNOMED '+ICD_TO_SNOMED[dx].code+' ('+ICD_TO_SNOMED[dx].display+')' : 'No SNOMED mapping',marital:marital+' -> '+(MARITAL_MAP[marital]||'N/A')}};

channelMap.put('fhirBundle', JSON.stringify(bundle, null, 2));
channelMap.put('businessRules', JSON.stringify(rules, null, 2));
channelMap.put('resourceCount', bundle.entry.length.toString());
channelMap.put('alertCount', alerts.length.toString());
channelMap.put('flagCount', flags.length.toString());

logger.info('Bundle: '+bundle.entry.length+' resources, '+alerts.length+' alerts, '+flags.length+' flags | '+firstName+' '+lastName);