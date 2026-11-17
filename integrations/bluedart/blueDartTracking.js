// Minimal reader for the Blue Dart tracking servlet's XML response.
//
// The project has no XML parser dependency and adding one needs approval, so
// this extracts only the handful of fields the warehouse view needs, tolerating
// both the attribute form (<Shipment WaybillNo="..">) and the element form
// (<WaybillNo>..</WaybillNo>) that the servlet uses across versions.
//
// The raw status text is stored verbatim. Blue Dart's scan/status code
// vocabulary has not been supplied, so no mapping onto GREST delivery statuses
// is attempted here.

const decodeEntities = (value) =>
  String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .trim()

const readTag = (xml, tag) => {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  return match ? decodeEntities(match[1]) : ''
}

const readAttribute = (xml, name) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(xml)
  return match ? decodeEntities(match[1]) : ''
}

const readValue = (xml, name) => readTag(xml, name) || readAttribute(xml, name)

/**
 * Parse a tracking response into one entry per shipment.
 * @param {string} xml - Raw servlet response
 * @returns {Array<{awbNo: string, status: string, statusType: string,
 *   statusDate: string, statusTime: string, expectedDeliveryDate: string,
 *   error: string}>}
 */
export const parseTrackingResponse = (xml) => {
  const body = String(xml || '')
  const blocks = body.match(/<Shipment\b[\s\S]*?<\/Shipment>/gi)
  if (!blocks) {
    // The servlet reports lookup failures as a bare <Error> document.
    const error = readTag(body, 'Error') || readTag(body, 'error')
    return error ? [{ awbNo: '', status: '', error }] : []
  }
  return blocks.map((block) => ({
    awbNo: readValue(block, 'WaybillNo') || readValue(block, 'AWBNo'),
    status: readValue(block, 'Status'),
    statusType: readValue(block, 'StatusType'),
    statusDate: readValue(block, 'StatusDate'),
    statusTime: readValue(block, 'StatusTime'),
    expectedDeliveryDate: readValue(block, 'ExpectedDeliveryDate'),
    error: readValue(block, 'StatusCode') === 'NF' ? 'Waybill not found' : '',
  }))
}
