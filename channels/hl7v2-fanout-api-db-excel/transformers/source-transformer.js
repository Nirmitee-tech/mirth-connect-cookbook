// Source transformer — extract fields once from HL7v2 ORU^R01, stash in
// channelMap so all 3 destinations can use them without re-parsing.
//
// Why: each destination is independent. Doing the parsing once here means
// destinations can fan out in parallel without redundant work, and we get
// a single place to handle the message shape changing.

try {
    var msh = msg['MSH'];
    var pid = msg['PID'];
    var obr = msg['OBR'];

    // Patient identity
    var mrn  = String(pid['PID.3']['PID.3.1']);
    var name = String(pid['PID.5']['PID.5.1']) + ' ' + String(pid['PID.5']['PID.5.2']);
    var dob  = String(pid['PID.7']['PID.7.1']);
    var sex  = String(pid['PID.8']['PID.8.1']);

    // Order / report identity
    var orderId = String(obr['OBR.2']['OBR.2.1']) || String(obr['OBR.3']['OBR.3.1']);
    var testCode = String(obr['OBR.4']['OBR.4.1']);
    var testName = String(obr['OBR.4']['OBR.4.2']);
    var orderedAt = String(obr['OBR.7']['OBR.7.1']);
    var orderingMD = String(obr['OBR.16']['OBR.16.2']) + ' ' + String(obr['OBR.16']['OBR.16.3']);

    // Result observations — there can be many OBX segments
    var observations = [];
    var obxList = msg['OBX'].length ? msg['OBX'] : [msg['OBX']];
    for (var i = 0; i < obxList.length; i++) {
        var obx = obxList[i];
        if (!obx['OBX.3']) continue;
        observations.push({
            code:  String(obx['OBX.3']['OBX.3.1']),
            label: String(obx['OBX.3']['OBX.3.2']),
            value: String(obx['OBX.5']['OBX.5.1']),
            unit:  String(obx['OBX.6']['OBX.6.1']),
            range: String(obx['OBX.7']['OBX.7.1']),
            flag:  String(obx['OBX.8']['OBX.8.1'])   // N=normal, H=high, L=low, etc.
        });
    }

    // Stash everything once — each destination consumes channelMap
    channelMap.put('messageId', String(msh['MSH.10']['MSH.10.1']));
    channelMap.put('mrn',        mrn);
    channelMap.put('patientName', name.trim());
    channelMap.put('dob',        dob);
    channelMap.put('sex',        sex);
    channelMap.put('orderId',    orderId);
    channelMap.put('testCode',   testCode);
    channelMap.put('testName',   testName);
    channelMap.put('orderedAt',  orderedAt);
    channelMap.put('orderingMD', orderingMD.trim());
    channelMap.put('observations', JSON.stringify(observations));

    // Compute a single "is abnormal?" flag — any observation flagged H/L/A/AA
    var anyAbnormal = observations.some(function(o) {
        return o.flag && o.flag.length > 0 && o.flag !== 'N';
    });
    channelMap.put('hasAbnormal', anyAbnormal ? 'true' : 'false');

} catch (e) {
    logger.error('Source transformer failed: ' + e);
    channel.getResponseMap().put('parseError', ResponseFactory.getErrorResponse(e.toString()));
}
