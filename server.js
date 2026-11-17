import express from 'express'
import mongoose from 'mongoose'
import morgan from 'morgan'
import bodyParser from 'body-parser'
import dotenv from 'dotenv'
import cors from 'cors'
import helmet from 'helmet'
import session from 'express-session'
import cron from 'node-cron'
import leads from './models/leadsModel.js'
import UsersRoutes from './routes/UsersRoute.js'
import brandsRoute from './routes/brandsRoute.js'
import questionnaireRoute from './routes/questionnaireRoute.js'
import phoneConditonRote from './routes/phoneConditonRoute.js'
import gradePriceRoute from './routes/gradePriceRoute.js'
import mastersRoute from './routes/mastersRoute.js'
import leadsRoute from './routes/leadsRoute.js'
import discountsRoute from './routes/discountRoute.js'
import userDashboard from './routes/userDashboard.js'
import pendingDevicesRoute from './routes/pendingDevicesRoutes.js'
import pickupDevicesRoute from './routes/pickupDevicesRoute.js'
import leadLifecycleRoute from './routes/leadLifecycleRoute.js'
import Profile_crud from './routes/ProfileCrudRoute.js'
import outstandingRoute from './routes/outstandingRoute.js'
import userRegistryRoute from './routes/userRegistryRoute.js'
import offerRoute from './routes/offerRoute.js'
import storeRoute from './routes/storeRoute.js'
import companyRoute from './routes/companyRoute.js'
import S3Route from './routes/s3Route.js'
import transporter from './utils/mailTransporter.js'
import xlsx from 'xlsx'
import lqdPriceRoute from './routes/lqdPriceRoute.js'
import liquidatorRoute from './routes/liquidatorRoute.js'
import categoryRoute from './routes/categoryRoute.js'
import smsRoute from './routes/smsRoute.js'
import quoteLogRoute from './routes/quoteLogRoute.js'
import generateReceiptRoute from './routes/generateReceiptRoute.js'
import sangeetaconfigRoute from './routes/sangeetaconfigRoute.js'
import couponRoute from './routes/couponRoute.js'
import scheduleCouponExpiryCheck from './utils/scheduleCouponExpiryCheck.js'
import digilockerRoute from './routes/digilockerRoute.js'
import paysprintAadhaarRoute from './routes/paysprintAadhaarRoute.js'
import erasureRoute from './routes/erasureRoute.js'
import scheduleErasureJob from './utils/scheduleErasureJob.js'
import { startKeyRotationScheduler } from './utils/keyRotationScheduler.js'
import bonusSlabRoute from './routes/bonusSlabRoute.js'
import buybackPayoutRoute from './routes/buybackPayoutRoute.js'
import payoutConfigRoute from './routes/payoutConfigRoute.js'
import hsbcPaymentWebhookRoute from './routes/hsbcPaymentWebhookRoute.js'
import { reconcileIncompletePayouts } from './services/buybackPayoutService.js'
import ivsRoute from './routes/ivsRoute.js'
import storePaymentRoute from './routes/storePaymentRoute.js'
import warehouseRoute from './routes/warehouseRoute.js'
import notificationRoute from './routes/notificationRoute.js'
import diagnosisRoute from './routes/diagnosisRoute.js'


import {
  logSanitizationMiddleware,
  errorLoggerMiddleware,
} from './middlewares/logSanitization.js'
import { safeLog } from './utils/piiMasking.js'

const LOCALHOST_HTTPS = 'https://localhost:3000'

const server = express()
dotenv.config()

// CORS Configuration for Lambda/API Gateway
// CRITICAL: Must be the FIRST middleware to ensure headers are set on ALL responses including errors
server.use((req, res, next) => {
  const origin = req.headers.origin

  // List of allowed origins
  const allowedOrigins = [
    'https://main-temp.d1v8jgvh28026.amplifyapp.com',
    'https://grest.in',
    'https://www.grest.in',
    'http://localhost:3000',
    'http://localhost:4200',
  ]

  // Check if origin is allowed
  const isAllowed =
    origin &&
    (allowedOrigins.includes(origin) ||
      origin.includes('.amplifyapp.com') ||
      origin.includes('.grest.in') ||
      origin === LOCALHOST_HTTPS)

  if (isAllowed || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    )
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Requested-With, X-Skip-Interceptor, Accept',
    )
  }

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400') // 24 hours
    return res.status(200).end()
  }

  return next()
})

// Also use cors package as fallback
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) {
      return callback(null, true)
    }

    const allowedOrigins = [
      'https://main-temp.d1v8jgvh28026.amplifyapp.com',
      'https://grest.in',
      'https://www.grest.in',
      'http://localhost:3000',
      'http://localhost:4200',
    ]

    const isAllowed = allowedOrigins.some(
      (allowedOrigin) =>
        allowedOrigin === origin ||
        origin.includes('.amplifyapp.com') ||
        origin.includes('.grest.in'))

    return callback(null, isAllowed)
  },
  credentials: true,
  optionsSuccessStatus: 200,
}

server.use(cors(corsOptions))

// Security Headers Middleware
// Use Helmet to set various HTTP security headers
server.use(
  helmet({
    // Strict-Transport-Security: Forces HTTPS connections
    hsts: {
      maxAge: 31536000, // 1 year in seconds
      includeSubDomains: true,
      preload: true,
    },
    // Content-Security-Policy: Prevents XSS attacks
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: [
          "'self'",
          'https://api.tradein.grest.in',
          'https://62p4oqvpxb.execute-api.ap-south-1.amazonaws.com',
        ],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    // X-Frame-Options: Prevents clickjacking
    frameguard: {
      action: 'deny',
    },
    // X-Content-Type-Options: Prevents MIME sniffing
    noSniff: true,
    // Referrer-Policy: Controls referrer information
    referrerPolicy: {
      policy: 'no-referrer',
    },
    // Permissions-Policy: Controls browser features
    permittedCrossDomainPolicies: {
      permittedPolicies: 'none',
    },
    // Disable Cross-Origin policies that can interfere with CORS
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  }),
)

// Additional security headers not covered by Helmet
server.use((req, res, next) => {
  // Permissions-Policy header (formerly Feature-Policy)
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()',
  )
  next()
})

server.disable('x-powered-by')

server.use(morgan('dev'))
server.use(bodyParser.urlencoded({ extended: true }))
server.use(bodyParser.json())
// Session Management Configuration
// DPDP Act Compliance - Section 9.1 (Session Security)
server.use(
  session({
    secret: process.env.JWT_SECERET || 'techHelps', // Use environment variable
    resave: false,
    saveUninitialized: false, // Don't create session until something is stored (security best practice)
    name: 'sessionId', // Hide the default 'connect.sid' name
    cookie: {
      maxAge: 30 * 60 * 1000, // 30 minutes of inactivity
      httpOnly: true, // Prevent XSS attacks (cannot be accessed via JavaScript)
      secure: process.env.NODE_ENV === 'production', // HTTPS only in production
      sameSite: 'strict', // CSRF protection - don't send cookie on cross-site requests
    },
  }),
)

// PII Masking - Log Sanitization Middleware
// Automatically sanitizes all request/response logs to prevent PII exposure
// DPDP Act Compliance - Section 7.2 (Masking Requirements)
server.use(logSanitizationMiddleware)

// mongoose.connect("mongodb+srv://akhil1659:akhil1659@cluster0.35ongwb.mongodb.net/", { useNewUrlParser: true, useUnifiedTopology: true })
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
const db = mongoose.connection
db.on('error', (err) => {
  safeLog.error('Database connection error:', err)
})

db.once('open', () => {
  safeLog.info('Database Connected')
})

cron.schedule(
  '0 0 * * *',
  () => {
    // Run this job every day at midnight in India time
    updateStatusForDevices()
    sendReport()
  },
  {
    timezone: 'Asia/Kolkata', // Specify the timezone
  },
)

// Initialize coupon expiry scheduler
scheduleCouponExpiryCheck()

// Initialize erasure request scheduler (DPDP Act - Right to Erasure)
scheduleErasureJob()

startKeyRotationScheduler()

if (
  process.env.ENVIRONMENT !== 'lambda' &&
  process.env.HSBC_PAYOUT_RECONCILIATION_ENABLED !== 'false'
) {
  cron.schedule('*/5 * * * *', async () => {
    try {
      await reconcileIncompletePayouts()
    } catch (error) {
      safeLog.error('HSBC payout reconciliation job failed', error)
    }
  })
}

const updateStatusForDevices = async () => {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  try {
    await leads.updateMany(
      { status: 'On Hold', updatedAt: { $lt: twentyFourHoursAgo } },
      { $set: { status: 'Available For Pickup' } },
    )
    safeLog.info('Status updated for devices after 24 hours.')
  } catch (error) {
    safeLog.error('Error updating device status:', error)
  }
}

async function processResults(result) {
  return result.map((item) => {
    const qnaList = {
      Core: [],
      Cosmetics: [],
      Display: [],
      Functional_major: [],
      Functional_minor: [],
      Warranty: [],
    }
    for (const section of item.QNA) {
      for (const category in section) {
        for (const question of section[category]) {
          qnaList[category].push(`${question.quetion}: ${question.key}`)
        }
      }
    }
    const qnamod = {
      Core: qnaList.Core.join(' || \n'),
      Cosmetics: qnaList.Cosmetics.join(' || \n'),
      Display: qnaList.Display.join(' || \n'),
      Functional_major: qnaList.Functional_major.join(' || \n'),
      Functional_minor: qnaList.Functional_minor.join(' || \n'),
      Warranty: qnaList.Warranty.join(' || \n'),
    }
    return {
      LeadId: item.LeadId,
      Date: item.Date,
      UserName: item.userName,
      Category: item.Category,
      ProductName: item.ProductName,
      Variant: item.variant,
      FinalPrice: item.price.toString(),
      IMEI: item.IMEI,
      UniqueId: item.uniqueCode,
      CustomerName: item.CustomerName,
      CustomerMobileNo: item.CustomerMobileNo,
      CustomerEmail: item.CustomerEmail,
      QNACore: qnamod.Core,
      QNACosmetics: qnamod.Cosmetics,
      QNADisplay: qnamod.Display,
      QNAFunMajor: qnamod.Functional_major,
      QNAFunMinor: qnamod.Functional_minor,
      QNAWarranty: qnamod.Warranty,
    }
  })
}

const docUserPipe = [
  {
    $lookup: {
      from: 'documents',
      localField: 'documentId',
      foreignField: '_id',
      as: 'document',
    },
  },
  {
    $unwind: {
      path: '$document',
      preserveNullAndEmptyArrays: true,
    },
  },
  {
    $lookup: {
      from: 'users',
      localField: 'userId',
      foreignField: '_id',
      as: 'user',
    },
  },
  {
    $unwind: {
      path: '$user',
      preserveNullAndEmptyArrays: true,
    },
  },
]

const codModPipe = [
  {
    $lookup: {
      from: 'condtioncodes',
      localField: 'gradeId',
      foreignField: '_id',
      as: 'gradeInfo',
    },
  },
  {
    $unwind: {
      path: '$gradeInfo',
      preserveNullAndEmptyArrays: true,
    },
  },
  {
    $lookup: {
      from: 'models',
      localField: 'modelId',
      foreignField: '_id',
      as: 'model',
    },
  },
  {
    $unwind: {
      path: '$model',
      preserveNullAndEmptyArrays: true,
    },
  },
]

const sendReport = async (req, res) => {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  try {
    const result = await leads.aggregate([
      {
        $match: { updatedAt: { $gte: twentyFourHoursAgo }, is_selled: true },
      },
      ...docUserPipe,
      ...codModPipe,
      {
        $addFields: {
          LeadId: {
            $toString: '$_id',
          },
          Date: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$updatedAt',
            },
          },
          userName: { $concat: ['$user.firstName', ' ', '$user.lastName'] },
          Category: '$model.type',
          ProductName: '$model.name',
          variant: { $concat: ['$ram', '/', '$storage'] },
          IMEI: '$document.IMEI',
          CustomerName: '$name',
          CustomerMobileNo: '$phoneNumber',
          CustomerEmail: '$emailId',
        },
      },
      {
        $sort: {
          updatedAt: -1,
        },
      },
      {
        $project: {
          _id: 0,
          __v: 0,
          brandId: 0,
          createdAt: 0,
          documentId: 0,
          modelId: 0,
          userId: 0,
          emailId: 0,
          phoneNumber: 0,
          name: 0,
          storage: 0,
          gradeId: 0,
          reciept: 0,
          ram: 0,
          status: 0,
          updatedAt: 0,
          model: 0,
          user: 0,
          document: 0,
          gradeInfo: 0,
          actualPrice: 0,
        },
      },
    ])

    const mod = await processResults(result)

    const Message =
      mod.length === 0
        ? `
    <div
      style="max-width: 90%; margin: auto; padding-top: 20px;"
    >
      <br/>
      <span style="font-weight:800; display:block;">There are 0 order completed on - ${new Date(
        Date.now(),
      )}</span>
    </div>
  `
        : `
    <div
      style="max-width: 90%; margin: auto; padding-top: 20px;"
    >
      <br/>
      <span style="font-weight:800; display:block;">The list of orders completed for - ${new Date(
        Date.now(),
      )}</span>
    </div>
  `

    const newWB = xlsx.utils.book_new()
    const newWS = xlsx.utils.json_to_sheet(mod)
    xlsx.utils.book_append_sheet(newWB, newWS, 'name')
    const buffer = xlsx.write(newWB, { bookType: 'xlsx', type: 'buffer' })
    const toEmails = process.env.EMAILS
      ? process.env.EMAILS.split(',').map((email) => email.trim())
      : []
    await transporter.sendMail({
      from: 'jayant@365aitech.com',
      to: toEmails,
      subject: 'Grest C2B(Lambda tradin) Order Completed Report',
      attachments: [
        {
          filename: 'leads_report.xlsx',
          content: buffer,
        },
      ],
      html: Message,
    })
    safeLog.info('Daily report email sent successfully')
  } catch (error) {
    safeLog.error('Error sending daily report email:', error.message)
    return
  }
}

if (process.env.ENVIRONMENT !== 'lambda') {
  const PORT = process.env.PORT || 3000

  server.listen(PORT, () => {
    safeLog.info(`Server running on port: ${PORT}`)
  })
}

server.get('/test123', (req, res) => {
  return res.send('test successful')
})

// Health check endpoint for Lambda
server.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    environment: process.env.ENVIRONMENT || 'development',
    timestamp: new Date().toISOString(),
  })
})
server.use('/upload', express.static('upload'))
server.use('/api/users', UsersRoutes)
server.use('/api/s3', S3Route)
server.use('/api/category', categoryRoute)
server.use('/api/brands', brandsRoute)
server.use('/api/questionnaires', questionnaireRoute)
server.use('/api/conditions', phoneConditonRote)
server.use('/api/grades', gradePriceRoute)
server.use('/api/masters', mastersRoute)
server.use('/api/prospects', leadsRoute)
server.use('/api/discounts', discountsRoute)
server.use('/api/user/Dashboard', userDashboard)
server.use('/api/pendingDevices', pendingDevicesRoute)
server.use('/api/pickupDevices', pickupDevicesRoute)
server.use('/api/leadSet', leadLifecycleRoute)
server.use('/api/profile', Profile_crud)
server.use('/api/outstanding', outstandingRoute)
server.use('/api/userregistry', userRegistryRoute)
server.use('/api/offer', offerRoute)
server.use('/api/store', storeRoute)
server.use('/api/company', companyRoute)
server.use('/api/liquidators', liquidatorRoute)
server.use('/api/lqdprices', lqdPriceRoute)
server.use('/api/sms', smsRoute)
server.use('/api/receipt', generateReceiptRoute)
server.use('/api/quoteTracking', quoteLogRoute)
server.use('/api/store-config', sangeetaconfigRoute)
server.use('/api/coupons', couponRoute)
server.use('/api/digilocker', digilockerRoute)
server.use('/api/paysprint-aadhaar', paysprintAadhaarRoute)
server.use('/api/erasure', erasureRoute)
server.use('/api/imei', ivsRoute)
server.use('/api/dynamic-pricing', bonusSlabRoute)
server.use('/api/buyback-payouts', buybackPayoutRoute)
server.use('/api/payout-config', payoutConfigRoute)
server.use('/api/hsbc-payments', hsbcPaymentWebhookRoute)
server.use('/api/store-payments', storePaymentRoute)
server.use('/api/warehouse', warehouseRoute)
server.use('/api/notifications', notificationRoute)
server.use('/api/diagnosis', diagnosisRoute)

server.get('/', (req, res) => {
  return res.send('Welcome to the Grest C2B API!')
})

// PII Masking - Error Logger Middleware
// Catches and logs errors with automatic PII sanitization
// DPDP Act Compliance - Section 7.2 (Masking Requirements)
// This must be placed AFTER all routes as a global error handler
server.use(errorLoggerMiddleware)

export default server
