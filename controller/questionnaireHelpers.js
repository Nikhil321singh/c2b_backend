/**
 * Build update object for lead with document ID
 */
export const buildToUpdate = (leadId, documentId, lead, body) => {
  const { emailId, name, phoneNumber, aadharNumber } = body
  const sampleUpd = { documentId, gradeId: lead.gradeId }
  if (emailId) {
    sampleUpd.emailId = emailId
  }
  if (name) {
    sampleUpd.name = name
  }
  if (phoneNumber) {
    sampleUpd.phoneNumber = phoneNumber
  }
  if (aadharNumber) {
    sampleUpd.aadharNumber = aadharNumber
  }
  return sampleUpd
}
