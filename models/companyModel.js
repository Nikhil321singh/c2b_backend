import mongoose from "mongoose";
const { Schema } = mongoose;

const companySchema = new Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true
        },
        companyCode: {
            type: String,
            unique: true,
            sparse: true // Auto-generated after creation
        },
        contactNumber: {
            type: String,
            required: true,
            trim: true
        },
        address: {
            type: String,
            required: true
        },
        gstNumber: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },
        panNumber: {
            type: String,
            required: true,
            trim: true,
        },
        remarks: {
            type: String,
            default: ''
        },
        showPrice: {
            type: Boolean,
            default: false
        },
        maskInfo: {
            type: Boolean,
            default: false
        },
        aadharVerificationRequired: {
            type: Boolean,
            default: true
        },
        buybackPayoutSettings: {
            enabled: {
                type: Boolean,
                default: false
            },
            deviceCooldownDays: {
                type: Number,
                min: 0,
                default: 0
            },
            customerSellLimitCount: {
                type: Number,
                min: 0,
                default: 0
            },
            customerSellLimitWindowDays: {
                type: Number,
                min: 0,
                default: 0
            }
        },
        storePaymentSettings: {
            mode: {
                type: String,
                enum: [
                    'COMPANY_ACCOUNTS',
                    'MANAGER_FUNDS',
                    'PREPAID_DEFERRED'
                ],
                default: 'COMPANY_ACCOUNTS'
            }
        },
        attachedDocuments: [{
            fileName: String,
            fileUrl: String,
            fileType: String,
            uploadedAt: { type: Date, default: Date.now }
        }],
        priceSheets: [{
            fileName: String,
            fileUrl: String,
            category: String,
            uploadedAt: { type: Date, default: Date.now }
        }],
        status: {
            type: String,
            enum: ['active', 'inactive'],
            default: 'active'
        },
        createdBy: {
            type: Schema.Types.ObjectId,
            required: true,
            ref: 'users',
        },
        updatedBy: {
            type: Schema.Types.ObjectId,
            ref: 'users',
        },
        emailConfiguration: {
            type: {
                enabled: {
                    type: Boolean,
                    default: false,
                    description: 'Enable company-specific email notifications'
                },
                recipients: [{
                    email: {
                        type: String,
                        required: true,
                        lowercase: true,
                        trim: true,
                        validate: {
                            validator: function(v) {
                                return /^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/.test(v);
                            },
                            message: props => `${props.value} is not a valid email address!`
                        }
                    },
                    name: {
                        type: String,
                        trim: true,
                        default: ''
                    },
                    type: {
                        type: String,
                        enum: ['primary', 'cc', 'bcc'],
                        default: 'cc'
                    },
                    active: {
                        type: Boolean,
                        default: true
                    }
                }],
                notificationTypes: [{
                    type: String,
                    enum: ['paymentReceipt', 'devicePickup', 'statusUpdate', 'priceUpdate'],
                    default: ['paymentReceipt']
                }]
            },
            default: {
                enabled: false,
                recipients: [],
                notificationTypes: ['paymentReceipt']
            }
        }
    },
    { timestamps: true }
);
const companyModel = mongoose.model("company", companySchema);

export default companyModel;
