// Destination 1 transformer — build a JSON payload for a downstream
// REST API. The HTTP Sender destination POSTs this as application/json.
//
// Common real-world targets for this destination:
//   - Patient portal: notify the patient their lab result is available
//   - Notification service (Slack / Teams / PagerDuty): alert on abnormal flags
//   - Clinical data warehouse REST API: ingest structured result
//   - Downstream FHIR server: post a DiagnosticReport
//   - CRM (e.g., Salesforce Health Cloud): update patient record
//
// We send a clean JSON payload that any consumer can parse without
// having to understand HL7v2.

var observations = JSON.parse(channelMap.get('observations'));

var payload = {
    eventType: 'lab.result.received',
    eventId:   channelMap.get('messageId'),
    patient: {
        mrn:  channelMap.get('mrn'),
        name: channelMap.get('patientName'),
        dob:  channelMap.get('dob'),
        sex:  channelMap.get('sex')
    },
    order: {
        orderId:     channelMap.get('orderId'),
        testCode:    channelMap.get('testCode'),
        testName:    channelMap.get('testName'),
        orderedAt:   channelMap.get('orderedAt'),
        orderingMD:  channelMap.get('orderingMD')
    },
    result: {
        hasAbnormal:  channelMap.get('hasAbnormal') === 'true',
        observations: observations
    },
    receivedAt: new Date().toISOString()
};

return JSON.stringify(payload);
