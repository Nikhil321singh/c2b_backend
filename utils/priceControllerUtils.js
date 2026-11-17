import modelsModel from '../models/modelsModel.js'

/* -------------------- Constants -------------------- */
const MODEL_DETAILS = 'Model Details'
const A_WARRANTY = 'A+WARRANTY'
const DB_TIMEOUT = 20000

/* -------------------- Utils -------------------- */
const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/* -------------------- Grade Mapping -------------------- */
const buildGrades = (data) => {
  const gradeMapping = {
    [A_WARRANTY]: 'A_PLUS',
    A: 'A',
    'A-': 'A_MINUS',
    'A-Limited': 'A_MINUS_LIMITED',
    B: 'B',
    'B+': 'B_PLUS',
    'B-': 'B_MINUS',
    'B-Limited': 'B_MINUS_LIMITED',
    'C+': 'C_PLUS',
    C: 'C',
    'C-': 'C_MINUS',
    'C-Limited': 'C_MINUS_LIMITED',
    'D+': 'D_PLUS',
    D: 'D',
    'D-': 'D_MINUS',
    E: 'E',
  }

  const grades = {}
  for (const [csvKey, gradeKey] of Object.entries(gradeMapping)) {
    if (data[csvKey] !== undefined && data[csvKey] !== '') {
      grades[gradeKey] = Number(data[csvKey])
    }
  }
  return grades
}

/* -------------------- Model Fetching -------------------- */
const fetchModelIdMap = async (batch, category, modelDetailsColumn) => {
  const modelNames = batch
    .map((a) => a[modelDetailsColumn]?.trim())
    .filter(Boolean)

  const models = await modelsModel
    .find(
      {
        name: {
          $in: modelNames.map((n) => new RegExp(`^${escapeRegExp(n)}$`, 'i')),
        },
        type: category,
      },
      { _id: 1, name: 1 },
    )
    .lean()
    .maxTimeMS(DB_TIMEOUT)

  return new Map(models.map((m) => [m.name.toLowerCase(), m._id]))
}

export {
  escapeRegExp,
  buildGrades,
  fetchModelIdMap,
  MODEL_DETAILS,
  A_WARRANTY,
  DB_TIMEOUT,
}
