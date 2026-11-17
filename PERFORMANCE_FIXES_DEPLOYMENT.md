# Performance Optimization Fixes - Deployment Guide

## Overview

This document outlines the performance fixes implemented to address critical issues identified during load testing of the Grest C2B service.

## Issues Addressed

### 1. ✅ itemPurchased Endpoint (30% failure rate, 12.8s avg → Expected: <5% failure, <3s avg)
- **Problem**: Complex aggregation pipeline running twice, missing indexes
- **Fix**:
  - Implemented `$facet` for single-pass aggregation
  - Added compound indexes on `leads` collection
  - Added 30-second query timeout

### 2. ✅ Timeout Issues (504 Gateway Timeout)
- **Problem**: Queries exceeding 29-30 seconds
- **Endpoints**: pendingDevices, pickedupDevices, listAllStores
- **Fix**:
  - Added query timeouts (30s max)
  - Removed debug aggregation in pendingDevices
  - Added indexes to deviceslots collection
  - Fixed store pagination (9999 → 50 default limit)

### 3. ✅ Login API Latency (5.5s avg → Expected: <1s avg)
- **Problem**: 4 sequential database queries
- **Fix**:
  - Changed to single query with `.populate()`
  - Added email index to users collection
  - Better error handling

### 4. ✅ S3 Upload Performance (8.2s avg)
- **Note**: Current implementation is standard for file uploads
- **Recommendations** for future optimization:
  - Upgrade to AWS SDK v3
  - Implement image compression
  - Add CloudFront CDN

---

## Files Modified

### Models (Schema + Indexes)
1. **[leadsModel.js](models/leadsModel.js)**
   - Added 8 performance indexes
   - Compound indexes for sold items queries

2. **[UsersModel.js](models/UsersModel.js)**
   - Added email unique index
   - Added role + companyId compound index

3. **[storeModel.js](models/storeModel.js)**
   - Added 4 indexes for search and filtering

4. **[devicesLotModel.js](models/devicesLotModel.js)**
   - Added 5 indexes for pickup devices queries

### Controllers (Query Optimization)
5. **[leadsController.js](controller/leadsController.js)**
   - Lines 462-486: Replaced double aggregation with `$facet`
   - Added query timeouts (15s single, 30s paginated)
   - Enhanced error handling with timeout detection

6. **[UsersController.js](controller/UsersController.js)**
   - Lines 62-135: Optimized login from 4 sequential to 1 query with populate
   - Changed error status from 400 to 500 for server errors

7. **[storeController.js](controller/storeController.js)**
   - Line 156: Changed default limit from 9999 to 50
   - Lines 189-197: Parallelized query and count with `Promise.all`
   - Added `.lean()` for faster query execution
   - Fixed error message (removed hardcoded strings)

8. **[pendingDevicesController.js](controller/pendingDevicesController.js)**
   - Lines 256-263: Added query timeout to allDevices
   - Lines 354-367: Added query timeout to searchDevice
   - Lines 179-189: Removed debug aggregation (extra query)
   - Enhanced error handling

9. **[pickupDevicesController.js](controller/pickupDevicesController.js)**
   - Lines 260-264: Added query timeout and allowDiskUse

### New Files
10. **[scripts/createIndexes.js](scripts/createIndexes.js)** ⭐ NEW
    - Database migration script
    - Creates all performance indexes
    - Safe to run multiple times (checks for existing indexes)

11. **[PERFORMANCE_FIXES_DEPLOYMENT.md](PERFORMANCE_FIXES_DEPLOYMENT.md)** ⭐ NEW
    - This file - deployment guide

---

## Deployment Steps

### Step 1: Backup Your Database
```bash
# Create a backup before making any changes
mongodump --uri="your_mongodb_uri" --out=/backup/grest-c2b-$(date +%Y%m%d)
```

### Step 2: Deploy Code Changes
```bash
# Pull latest code
git pull origin main

# Install dependencies (if needed)
npm install

# Restart the application
pm2 restart grest-c2b-service
# OR
systemctl restart grest-c2b-service
# OR
docker-compose restart
```

### Step 3: Create Database Indexes
```bash
# Run the index creation script
node scripts/createIndexes.js

# Expected output:
# 🚀 Starting database index creation...
# 📡 Connecting to MongoDB...
# ✅ Connected to MongoDB
#
# 📊 Creating indexes for leads collection...
#   ✅ Created index: is_selled_status_createdAt
#   ✅ Created index: storeId_is_selled_status
#   ... (etc)
```

**⚠️ Important**: Index creation runs in the background and won't block your application, but it may take several minutes on large collections.

### Step 4: Verify Indexes Were Created
```bash
# Connect to MongoDB
mongosh "your_mongodb_uri"

# Check leads indexes
db.leads.getIndexes()

# Check users indexes
db.users.getIndexes()

# Check stores indexes
db.stores.getIndexes()

# Check deviceslots indexes
db.deviceslots.getIndexes()
```

### Step 5: Monitor Performance

#### Expected Improvements:
| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| itemPurchased avg latency | 12.8s | 2-3s | **75-80% faster** |
| itemPurchased failure rate | 30% | <5% | **84% reduction** |
| Login avg latency | 5.5s | 0.8-1.2s | **80% faster** |
| pendingDevices timeouts | 3 | 0 | **100% reduction** |
| listAllStores timeouts | 1 | 0 | **100% reduction** |

#### Monitoring Commands:
```bash
# Watch application logs
pm2 logs grest-c2b-service --lines 100 --raw

# Check for errors
pm2 logs grest-c2b-service --err

# Monitor MongoDB performance
mongosh "your_mongodb_uri" --eval "db.currentOp(true)"

# Check slow queries (>1000ms)
mongosh "your_mongodb_uri" --eval "db.setProfilingLevel(1, { slowms: 1000 })"
```

---

## Rollback Plan

If you encounter issues after deployment:

### Rollback Code Changes
```bash
# Revert to previous version
git revert HEAD
pm2 restart grest-c2b-service
```

### Drop Indexes (if needed)
```bash
mongosh "your_mongodb_uri"

# Drop specific index
db.leads.dropIndex("is_selled_status_createdAt")

# OR drop all indexes except _id (use with caution)
db.leads.dropIndexes()
```

---

## Configuration Changes Required

### Environment Variables
Ensure these are set in your `.env` file:

```bash
# Required
MONGODB_URI=mongodb://...
NODE_ENV=production

# Recommended
MAX_QUERY_TIMEOUT=30000  # 30 seconds
```

### MongoDB Connection Pool (Optional but Recommended)
If you have a `server.js` or database connection file, ensure connection pooling is configured:

```javascript
mongoose.connect(process.env.MONGODB_URI, {
  maxPoolSize: 50,      // Maximum connections
  minPoolSize: 10,      // Minimum connections
  socketTimeoutMS: 45000,
  serverSelectionTimeoutMS: 10000
})
```

---

## Testing After Deployment

### 1. Test itemPurchased Endpoint
```bash
# Should complete in <3 seconds
curl -X GET "https://your-api.com/api/prospects/findAllSelled?limit=20&page=0" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -w "\nTime: %{time_total}s\n"
```

### 2. Test Login
```bash
# Should complete in <1.5 seconds
curl -X POST "https://your-api.com/api/users/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password"}' \
  -w "\nTime: %{time_total}s\n"
```

### 3. Test pendingDevices
```bash
# Should not timeout (max 30s)
curl -X GET "https://your-api.com/api/pendingDevices/all" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -w "\nTime: %{time_total}s\n"
```

### 4. Test listAllStores
```bash
# Should complete in <2 seconds with new default limit
curl -X GET "https://your-api.com/api/store/findAll" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -w "\nTime: %{time_total}s\n"
```

---

## Expected Load Test Results (After Fixes)

Run the same load test again and expect:

### itemPurchased Endpoint
- ✅ Failure rate: **<5%** (down from 30%)
- ✅ Average latency: **2-3s** (down from 12.8s)
- ✅ Max latency: **<10s** (down from 22.2s)
- ✅ 95th percentile: **<5s**

### Login API
- ✅ Average latency: **0.8-1.2s** (down from 5.5s)
- ✅ Max latency: **<3s** (down from 13.7s)

### Timeout Endpoints
- ✅ pendingDevices: **0 timeouts** (down from 3)
- ✅ pickedupDevices: **0 timeouts** (down from 1)
- ✅ listAllStores: **0 timeouts** (down from 1)

---

## Monitoring & Alerts (Recommended Setup)

### 1. Enable MongoDB Slow Query Log
```bash
mongosh "your_mongodb_uri"
db.setProfilingLevel(1, { slowms: 1000 })
```

### 2. Application Performance Monitoring (Optional)
Consider adding:
- **New Relic** or **DataDog** for APM
- **Sentry** for error tracking
- **CloudWatch** for AWS infrastructure

### 3. Custom Health Check Endpoint
Add to your application:
```javascript
app.get('/health', async (req, res) => {
  try {
    await mongoose.connection.db.admin().ping()
    res.json({ status: 'healthy', timestamp: new Date() })
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: error.message })
  }
})
```

---

## Troubleshooting

### Issue: Indexes Not Created
**Symptom**: Script runs but indexes don't appear
**Solution**:
```bash
# Check for errors in MongoDB logs
mongosh "your_mongodb_uri"
db.adminCommand({ getLog: "global" })

# Ensure user has createIndex permission
db.runCommand({ connectionStatus: 1 })
```

### Issue: Performance Not Improved
**Symptom**: Queries still slow after deployment
**Solution**:
1. Verify indexes were created: `db.leads.getIndexes()`
2. Check if indexes are being used:
   ```javascript
   db.leads.explain("executionStats").find({is_selled: true})
   ```
3. Look for `"stage": "IXSCAN"` (good) vs `"stage": "COLLSCAN"` (bad)

### Issue: Application Crashes
**Symptom**: Service restarts repeatedly
**Solution**:
1. Check logs: `pm2 logs grest-c2b-service --err --lines 50`
2. Common causes:
   - Memory exhaustion (check `pm2 monit`)
   - MongoDB connection issues
   - Syntax errors in modified files

---

## Additional Optimizations (Future Consideration)

### 1. Implement Caching (Redis)
- Cache frequently accessed data (stores list, company info)
- Expected improvement: 50-80% reduction in database load

### 2. Upgrade AWS SDK
- Migrate from `aws-sdk` v2 to `@aws-sdk/client-s3` v3
- Expected improvement: 20-30% faster S3 uploads

### 3. Add Database Read Replicas
- Route read queries to replicas
- Route write queries to primary
- Expected improvement: 40-60% better throughput

### 4. Implement Connection Pooling at Load Balancer
- Use pgBouncer-style connection pooling
- Expected improvement: Handle 2-3x more concurrent requests

---

## Success Criteria

Your deployment is successful if:

- ✅ All indexes created without errors
- ✅ Application starts and serves requests
- ✅ itemPurchased failure rate < 10%
- ✅ Login latency < 2s average
- ✅ No 504 timeouts in pendingDevices/listAllStores
- ✅ Error logs show improved error messages
- ✅ No new errors introduced

---

## Support & Contact

If you encounter issues during deployment:

1. Check the troubleshooting section above
2. Review application logs: `pm2 logs grest-c2b-service`
3. Check MongoDB logs for slow queries
4. Verify environment variables are set correctly

---

## Changelog

### 2026-02-25 - Performance Optimization Release v1.0

**Added:**
- Database indexes for leads, users, stores, deviceslots collections
- Query timeouts to prevent runaway queries
- $facet optimization for reduced aggregation passes
- Enhanced error handling with timeout detection
- Migration script for index creation

**Changed:**
- Login query from sequential to parallel with populate
- Store findAll default limit from 9999 to 50
- Store findAll to use Promise.all for parallel execution
- Error status codes (400 → 500) for server errors

**Removed:**
- Debug aggregation in pendingDevices (performance bottleneck)
- Hardcoded error messages in storeController

**Fixed:**
- Double aggregation issue in findAll/findAllSelled
- Sequential queries in login endpoint
- Pagination causing full collection scans
- Missing indexes causing collection scans
- Gateway timeouts in device list endpoints

---

**Deployed by**: Claude Code Performance Optimization
**Date**: 2026-02-25
**Version**: 1.0.0
