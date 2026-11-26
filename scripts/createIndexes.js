import mongoose from 'mongoose'
import dotenv from 'dotenv'

dotenv.config()

const MONGODB_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.DATABASE_URI

if (!MONGODB_URI) {
  console.error(
    '❌ ERROR: MONGODB_URI or DATABASE_URI environment variable not set',
  )
  console.error(
    'Please set it in your .env file or pass it as an environment variable',
  )
  process.exit(1)
}

// Helper function to handle index creation errors
function handleIndexError(err, indexName) {
  if (err.code === 85 || err.code === 86) {
    console.log(`  ⚠️  Index ${indexName} already exists (skipping)`)
  } else {
    console.error(`  ❌ Error creating index ${indexName}:`, err.message)
  }
}

// Helper function to create indexes for a collection
async function createCollectionIndexes(db, collectionName, indexes) {
  console.log(`\n📊 Creating indexes for ${collectionName} collection...`)

  for (const index of indexes) {
    try {
      await db.collection(collectionName).createIndex(index.key, {
        name: index.name,
        background: true,
        ...index.options,
      })
      console.log(`  ✅ Created index: ${index.name}`)
    } catch (err) {
      handleIndexError(err, index.name)
    }
  }
}

// Helper function to print collection summary
async function printCollectionSummary(db, collectionName) {
  try {
    const indexes = await db.collection(collectionName).indexes()
    console.log(
      `\n${collectionName} collection has ${indexes.length} indexes:`,
    )
    indexes.forEach((idx) => {
      const keys = Object.keys(idx.key).join(', ')
      console.log(`  - ${idx.name} (${keys})`)
    })
  } catch (err) {
    console.error(
      `  ❌ Error listing indexes for ${collectionName}:`,
      err.message,
    )
  }
}

async function createIndexes() {
  console.log('🚀 Starting database index creation...\n')

  try {
    // Connect to MongoDB
    console.log('📡 Connecting to MongoDB...')
    await mongoose.connect(MONGODB_URI)
    console.log('✅ Connected to MongoDB\n')

    // Get database instance
    const db = mongoose.connection.db

    // Define all indexes
    const leadsIndexes = [
      {
        key: { is_selled: 1, status: 1, createdAt: -1 },
        name: 'is_selled_status_createdAt',
      },
      {
        key: { storeId: 1, is_selled: 1, status: 1 },
        name: 'storeId_is_selled_status',
      },
      { key: { companyId: 1, is_selled: 1 }, name: 'companyId_is_selled' },
      { key: { userId: 1, is_selled: 1 }, name: 'userId_is_selled' },
      { key: { status: 1, createdAt: -1 }, name: 'status_createdAt' },
      { key: { phoneNumber: 1 }, name: 'phoneNumber' },
      { key: { emailId: 1 }, name: 'emailId' },
      { key: { name: 1 }, name: 'name' },
      {
        key: { storePaymentRequestId: 1 },
        name: 'storePaymentRequestId',
      },
      {
        key: { storePaymentStatus: 1 },
        name: 'storePaymentStatus',
      },
    ]

    const usersIndexes = [
      { key: { email: 1 }, name: 'email_unique', options: { unique: true } },
      { key: { role: 1, companyId: 1 }, name: 'role_companyId' },
      { key: { storeId: 1 }, name: 'storeId' },
    ]

    const storesIndexes = [
      { key: { storeName: 1 }, name: 'storeName' },
      { key: { companyId: 1, storeName: 1 }, name: 'companyId_storeName' },
      { key: { status: 1 }, name: 'status' },
      { key: { region: 1 }, name: 'region' },
    ]

    const devicesLotIndexes = [
      { key: { status: 1, updatedAt: -1 }, name: 'status_updatedAt' },
      { key: { storeId: 1, status: 1 }, name: 'storeId_status' },
      { key: { uniqueCode: 1 }, name: 'uniqueCode' },
      { key: { userId: 1 }, name: 'userId' },
      { key: { createdAt: -1 }, name: 'createdAt' },
      {
        key: { companyId: 1, paymentStatus: 1, createdAt: -1 },
        name: 'companyId_paymentStatus_createdAt',
      },
      // One logistics lot per customer payout.
      {
        key: { buybackPayoutId: 1 },
        name: 'buybackPayoutId_unique',
        options: {
          unique: true,
          partialFilterExpression: { buybackPayoutId: { $exists: true } },
        },
      },
      { key: { source: 1, status: 1 }, name: 'source_status' },
    ]

    // Create indexes for all collections
    await createCollectionIndexes(db, 'leads', leadsIndexes)
    await createCollectionIndexes(db, 'users', usersIndexes)
    await createCollectionIndexes(db, 'stores', storesIndexes)
    await createCollectionIndexes(db, 'deviceslots', devicesLotIndexes)

    // Print summary
    console.log('\n' + '='.repeat(60))
    console.log('📈 INDEX CREATION SUMMARY')
    console.log('='.repeat(60))

    const collections = ['leads', 'users', 'stores', 'deviceslots']
    for (const collectionName of collections) {
      await printCollectionSummary(db, collectionName)
    }

    console.log('\n' + '='.repeat(60))
    console.log('✅ Index creation completed successfully!')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\n❌ ERROR:', error.message)
    console.error(error.stack)
    process.exit(1)
  } finally {
    await mongoose.connection.close()
    console.log('\n📡 Disconnected from MongoDB')
    process.exit(0)
  }
}

// Run the migration
createIndexes()
