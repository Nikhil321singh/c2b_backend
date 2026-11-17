import storeModel from '../models/storeModel.js';
import companyModel from '../models/companyModel.js';
import { safeLog } from './piiMasking.js';

/**
 * Get email recipients for a store based on company configuration
 * @param {ObjectId} storeId - Store ID
 * @param {string} notificationType - Type of notification (e.g., 'paymentReceipt')
 * @returns {Promise<string[]>} Array of email addresses
 */
export const getEmailRecipientsForStore = async (storeId, notificationType = 'paymentReceipt') => {
  try {
    // Get store information
    const storeInfo = await storeModel.findById(storeId).lean();
    if (!storeInfo || !storeInfo.email) {
      throw new Error('Store email not found');
    }

    // Start with store's primary email
    let emailRecipients = Array.isArray(storeInfo.email)
      ? [...storeInfo.email]
      : [storeInfo.email];

    // Get company configuration
    const company = await companyModel.findById(storeInfo.companyId).lean();
    if (!company) {
      safeLog.warn(`Company not found for store ${storeId}`);
      return emailRecipients;
    }

    // Check if company has email configuration enabled
    if (company.emailConfiguration?.enabled) {
      const emailConfig = company.emailConfiguration;

      // Check if this notification type is enabled
      if (!emailConfig.notificationTypes?.includes(notificationType)) {
        safeLog.info(`Notification type ${notificationType} not enabled for company ${company.companyCode}`);
        return emailRecipients;
      }

      // Add company-specific recipients
      if (emailConfig.recipients && Array.isArray(emailConfig.recipients)) {
        const activeRecipients = emailConfig.recipients
          .filter(r => r.active !== false)
          .map(r => r.email);

        emailRecipients = [...emailRecipients, ...activeRecipients];
      }
    } else {
      safeLog.info(`Email configuration not enabled for company ${company.companyCode}`);
    }

    // Remove duplicates and return
    return [...new Set(emailRecipients)];

  } catch (error) {
    safeLog.error('Error getting email recipients for store:', error);
    throw error;
  }
};

/**
 * Get company email configuration by company ID
 * @param {ObjectId} companyId - Company ID
 * @returns {Promise<Object|null>} Email configuration or null
 */
export const getCompanyEmailConfig = async (companyId) => {
  try {
    const company = await companyModel.findById(companyId).select('emailConfiguration').lean();
    return company?.emailConfiguration || null;
  } catch (error) {
    safeLog.error('Error getting company email config:', error);
    return null;
  }
};

export default {
  getEmailRecipientsForStore,
  getCompanyEmailConfig,
};
