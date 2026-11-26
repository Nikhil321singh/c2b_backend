/**
 * Build update object for lead with document ID
 */
export const buildToUpdate = (leadId, documentId, lead, body) => {
  const { emailId, name, phoneNumber, aadharNumber, aadharVerificationReason } = body
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
  if (aadharVerificationReason) {
    sampleUpd.aadharVerificationReason = aadharVerificationReason
  }
  return sampleUpd
}
