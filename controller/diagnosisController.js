import crypto from 'crypto'
import axios from 'axios'

// In-memory store for sessions (replace with MongoDB/Redis in production)
const sessions = new Map()

// Blancco test name → human-readable label mapping
const BLANCCO_TEST_MAP = {
  'display-touch': 'Touch Screen',
  'display-multi-touch': 'Multi Touch',
  'display-crack': 'Display Crack',
  'display-ghost-images': 'Ghost Images',
  'display-purple-ink-stain': 'Purple Ink Stain',
  'display-black-ink-spots': 'Black Ink Spots',
  'display-drag-gesture': 'Drag Gesture',
  'display-coloured-vertical-lines': 'Coloured Vertical Lines',
  'camera-back': 'Rear Camera',
  'camera-front': 'Front Camera',
  'camera-auto-focus': 'Auto Focus',
  'camera-back-flash': 'Flash',
  'camera-front-flash': 'Front Flash',
  'audio-speaker': 'Speaker',
  'audio-microphone': 'Microphone',
  'button-volume-up': 'Volume Up Button',
  'button-volume-down': 'Volume Down Button',
  'device-vibration': 'Vibration',
  'detect-bluetooth': 'Bluetooth',
  'sensor-gyroscope': 'Gyroscope',
  'sensor-accelerometer': 'Accelerometer',
  'sensor-magnetometer': 'Magnetometer',
  'long-group-test-quick-check': 'Quick Health Check',
}

/**
 * Polls the Blancco API for a report by IMEI.
 * Returns the mapped results object or null if no report found yet.
 */
const pollBlanccoByIMEI = async (imei, sessionCreatedAt) => {
  const apiUrl = process.env.BLANCCO_API_URL || 'https://api.eu-west-1.blancco.cloud'
  const apiKey = process.env.BLANCCO_API_KEY

  if (!apiKey) {
    console.error('[Diagnosis] BLANCCO_API_KEY is not configured')
    return null
  }

  // Strip milliseconds from ISO date — Blancco rejects format with ms (e.g. .144Z)
  // Use session creation time so we only fetch reports done AFTER this session started
  const createdAt = new Date(sessionCreatedAt)
  const dateFilter = createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z')

  try {
    const response = await axios.post(
      `${apiUrl}/v1/reports/export`,
      {
        "category": "DIAGNOSTIC",
        "filter": {
          "date": { "gt": dateFilter },
          "fields": [{ "name": "@imei", "like": imei }],
        },
        "cursor": "",
        "format": "JSON",
        "container": "NONE",
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-BLANCCO-API-KEY": apiKey,
        },
        // 204 means no reports yet — don't throw
        validateStatus: (status) => status === 200 || status === 204,
      }
    )

    if (response.status === 204 || !response.data?.reports?.length) {
      return null // No report yet
    }

    // Sort by date descending and take the most recent report
    const reports = response.data.reports.sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    )
    const latestReport = reports[0]

    // Map each test to a readable label + result
    const mappedTests = latestReport.tests.map((test) => ({
      name: BLANCCO_TEST_MAP[test.name] || test.name,
      blanccoKey: test.name,
      result: test.result, // PASSED | FAILED | INDETERMINATE
    }))

    return {
      tests: mappedTests,
      properties: latestReport.properties,
      uuid: latestReport.uuid,
      date: latestReport.date,
      blanccoAssetId: latestReport.blancco_asset_id,
    }
  } catch (error) {
    console.error('[Diagnosis] Error polling Blancco API:', error.response?.data || error.message)
    return null
  }
}

export const createDiagnosisSession = async (req, res) => {
  try {
    const { imei, storeId, agentId } = req.body

    if (!imei) {
      return res.status(400).json({ success: false, message: 'IMEI is required' })
    }

    const sessionId = crypto.randomUUID()

    const sessionData = {
      sessionId,
      imei,
      storeId,
      agentId,
      status: 'Waiting for scan...',
      results: null,
      createdAt: new Date(),
    }

    sessions.set(sessionId, sessionData)

    return res.status(200).json({
      success: true,
      data: { sessionId },
    })
  } catch (error) {
    console.error('[Diagnosis] Error creating session:', error)
    return res.status(500).json({ success: false, message: 'Internal Server Error' })
  }
}

export const getDiagnosisSession = async (req, res) => {
  try {
    const { sessionId } = req.params

    const sessionData = sessions.get(sessionId)

    if (!sessionData) {
      return res.status(404).json({ success: false, message: 'Session not found' })
    }

    // If already completed, just return the cached results (no need to call Blancco again)
    if (sessionData.status === 'Completed' && sessionData.results) {
      return res.status(200).json({ success: true, data: sessionData })
    }

    // Poll Blancco to check if the test has been completed
    console.log(`[Diagnosis] Polling Blancco for IMEI: ${sessionData.imei}`)
    const blanccoResults = await pollBlanccoByIMEI(sessionData.imei, sessionData.createdAt)

    if (blanccoResults) {
      // Test is done! Update session with real results
      sessionData.status = 'Completed'
      sessionData.results = blanccoResults
      sessionData.updatedAt = new Date()
      sessions.set(sessionId, sessionData)
      console.log(`[Diagnosis] ✅ Report found for IMEI: ${sessionData.imei}`)
    } else {
      sessionData.status = 'Waiting for scan...'
    }

    return res.status(200).json({ success: true, data: sessionData })
  } catch (error) {
    console.error('[Diagnosis] Error fetching session:', error)
    return res.status(500).json({ success: false, message: 'Internal Server Error' })
  }
}

export const updateDiagnosisSession = async (req, res) => {
  try {
    const { sessionId } = req.params
    const { status, results } = req.body

    const sessionData = sessions.get(sessionId)

    if (!sessionData) {
      return res.status(404).json({ success: false, message: 'Session not found' })
    }

    if (status) sessionData.status = status
    if (results) sessionData.results = results
    sessionData.updatedAt = new Date()

    sessions.set(sessionId, sessionData)

    return res.status(200).json({ success: true, message: 'Session updated successfully' })
  } catch (error) {
    console.error('[Diagnosis] Error updating session:', error)
    return res.status(500).json({ success: false, message: 'Internal Server Error' })
  }
}

export const getBlanccoReport = async (req, res) => {
  try {
    const { uuid } = req.params

    if (!uuid) {
      return res.status(400).json({ success: false, message: 'UUID is required' })
    }

    const apiUrl = process.env.BLANCCO_API_URL || 'https://api.eu-west-1.blancco.cloud'
    const apiKey = process.env.BLANCCO_API_KEY

    if (!apiKey) {
      return res.status(500).json({ success: false, message: 'Server Configuration Error' })
    }

    const response = await axios.post(
      `${apiUrl}/v1/reports/export`,
      {
        category: 'DIAGNOSTIC',
        format: 'JSON',
        container: 'NONE',
        filter: { fields: [{ name: 'uuid', like: uuid }] },
      },
      { headers: { 'Content-Type': 'application/json', 'X-BLANCCO-API-KEY': apiKey } }
    )

    return res.status(200).json({ success: true, data: response.data })
  } catch (error) {
    console.error('[Diagnosis] Error fetching Blancco report:', error.response?.data || error.message)
    return res.status(500).json({ success: false, message: 'Failed to fetch report from Blancco' })
  }
}
