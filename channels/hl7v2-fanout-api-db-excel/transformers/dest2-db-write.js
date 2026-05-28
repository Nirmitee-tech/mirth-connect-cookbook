// Destination 2 transformer — build the parameter map for a parameterized
// INSERT into the lab_results table. The Database Writer destination
// references these bind variables in its SQL statement.
//
// IMPORTANT: never concatenate values into SQL strings. Always use bind
// variables (the Database Writer supports them natively). This prevents
// SQL injection from anything an upstream system might smuggle in.

var observations = JSON.parse(channelMap.get('observations'));

// Flatten observations into a JSON column — we store one row per result,
// with the per-observation array as JSONB. Easier to query than one row
// per OBX (which would multiply our row count by 10x for a CBC panel).
return {
    message_id:    channelMap.get('messageId'),
    mrn:           channelMap.get('mrn'),
    patient_name:  channelMap.get('patientName'),
    dob:           channelMap.get('dob'),
    sex:           channelMap.get('sex'),
    order_id:      channelMap.get('orderId'),
    test_code:     channelMap.get('testCode'),
    test_name:     channelMap.get('testName'),
    ordered_at:    channelMap.get('orderedAt'),
    ordering_md:   channelMap.get('orderingMD'),
    has_abnormal:  channelMap.get('hasAbnormal') === 'true',
    observations:  JSON.stringify(observations),
    api_ack_id:    channelMap.get('apiAckId'),
    api_status:    channelMap.get('apiStatus'),
    received_at:   new Date().toISOString()
};
