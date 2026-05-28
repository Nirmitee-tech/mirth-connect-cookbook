// =====================================================
// Smart ADT Router — Content-Based Message Routing
// Routes by: Ward type, Patient class, Age
// =====================================================

var patientClass = msg['PV1']['PV1.2']['PV1.2.1'].toString();
var ward = msg['PV1']['PV1.3']['PV1.3.1'].toString().toUpperCase();
var admitType = msg['PV1']['PV1.4']['PV1.4.1'].toString();
var firstName = msg['PID']['PID.5']['PID.5.2'].toString();
var lastName = msg['PID']['PID.5']['PID.5.1'].toString();
var dob = msg['PID']['PID.7']['PID.7.1'].toString();
var mrn = msg['PID']['PID.3']['PID.3.1'].toString();

// Calculate age
var age = 0;
if (dob.length >= 8) {
    var birthYear = parseInt(dob.substring(0, 4));
    var now = new Date();
    age = now.getFullYear() - birthYear;
}

// =====================================================
// ROUTING RULES
// =====================================================
var routeTo = [];
var priority = 'NORMAL';
var routeReason = [];

// Rule 1: ICU/CCU → Critical Care System
if (ward.indexOf('ICU') >= 0 || ward.indexOf('CCU') >= 0 || ward.indexOf('SICU') >= 0 || ward.indexOf('MICU') >= 0) {
    routeTo.push('CRITICAL_CARE');
    priority = 'HIGH';
    routeReason.push('ICU/CCU admission detected');
}

// Rule 2: ER/Emergency → Emergency Department System
if (patientClass == 'E' || ward.indexOf('ER') >= 0 || ward.indexOf('ED') >= 0 || admitType == 'E') {
    routeTo.push('EMERGENCY');
    if (priority != 'HIGH') priority = 'URGENT';
    routeReason.push('Emergency encounter');
}

// Rule 3: Pediatric (age < 18 or PEDS ward) → Children's Hospital
if (age < 18 || ward.indexOf('PED') >= 0 || ward.indexOf('NICU') >= 0) {
    routeTo.push('PEDIATRICS');
    routeReason.push('Pediatric patient (age: ' + age + ')');
}

// Rule 4: Surgical wards → Surgical Scheduling System
if (ward.indexOf('SURG') >= 0 || ward.indexOf('OR') >= 0 || ward.indexOf('PACU') >= 0) {
    routeTo.push('SURGICAL');
    routeReason.push('Surgical ward');
}

// Rule 5: Default → General EHR
if (routeTo.length == 0) {
    routeTo.push('GENERAL_EHR');
    routeReason.push('Standard admission');
}

// Rule 6: All admissions → Analytics/Data Warehouse (always)
routeTo.push('ANALYTICS');

// Build routing manifest
var manifest = {
    messageId: $('batchSequenceId'),
    timestamp: new Date().toISOString(),
    patient: {mrn: mrn, name: firstName + ' ' + lastName, age: age},
    encounter: {ward: ward, class: patientClass, admitType: admitType},
    routing: {
        destinations: routeTo,
        priority: priority,
        reasons: routeReason,
        totalRoutes: routeTo.length
    }
};

// Store routing decisions
channelMap.put('routeTo', routeTo.join(','));
channelMap.put('priority', priority);
channelMap.put('routingManifest', JSON.stringify(manifest, null, 2));
channelMap.put('isICU', (ward.indexOf('ICU') >= 0).toString());
channelMap.put('isER', (patientClass == 'E').toString());
channelMap.put('isPediatric', (age < 18).toString());

logger.info('ROUTER: ' + firstName + ' ' + lastName + ' (age ' + age + ') | Ward: ' + ward + ' | Routes: ' + routeTo.join(', ') + ' | Priority: ' + priority);