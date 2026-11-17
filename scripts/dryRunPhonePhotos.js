import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { safeLog } from '../utils/piiMasking.js'

const fileName = fileURLToPath(import.meta.url)
const dirName = path.dirname(fileName)

// Normalize string for fuzzy matching
const normalizeString = (str) => {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '') // Remove all non-alphanumeric characters
}

// Scan all images in GRESTTRADEINPHOTOS folder
const scanImages = (baseDir) => {
  const imageMap = new Map()
  const brandFolders = fs.readdirSync(baseDir)

  brandFolders.forEach(brand => {
    const brandPath = path.join(baseDir, brand)
    if (fs.statSync(brandPath).isDirectory()) {
      const files = fs.readdirSync(brandPath)
      files.forEach(file => {
        if (file.match(/\.(png|jpg|jpeg)$/i)) {
          const nameWithoutExt = file.replace(/\.(png|jpg|jpeg)$/i, '')
          const normalizedName = normalizeString(nameWithoutExt)
          const fullPath = path.join(brandPath, file)

          // Store both original and normalized name for lookup
          imageMap.set(normalizedName, {
            originalName: nameWithoutExt,
            fileName: file,
            filePath: fullPath,
            brand: brand
          })
        }
      })
    }
  })

  return imageMap
}

// Main function
const dryRun = async () => {
  try {
    // Read models from JSON file
    const modelsJsonPath = path.join(dirName, '..', 'grestUat.models.json')
    safeLog.info('Reading models from:', modelsJsonPath)
    const models = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'))
    safeLog.info(`Found ${models.length} models in JSON file`)

    // Scan all images
    const tradeInPhotosDir = path.join(dirName, '..', 'GRESTTRADEINPHOTOS')
    safeLog.info('Scanning images from:', tradeInPhotosDir)
    const imageMap = scanImages(tradeInPhotosDir)
    safeLog.info(`Found ${imageMap.size} images in GRESTTRADEINPHOTOS folder\n`)

    safeLog.info('='.repeat(80))
    safeLog.info('DRY RUN - No changes will be made')
    safeLog.info('='.repeat(80))

    let matchedCount = 0
    let notMatchedCount = 0
    const notMatched = []
    const matched = []
    const usedImages = new Set()

    for (const model of models) {
      const modelName = model.name
      const modelId = model._id?.$oid || 'unknown'
      const normalizedModelName = normalizeString(modelName)

      if (imageMap.has(normalizedModelName)) {
        const imageInfo = imageMap.get(normalizedModelName)
        matched.push({
          modelName,
          modelId,
          imagePath: `${imageInfo.brand}/${imageInfo.fileName}`,
          currentFront: model.phonePhotos?.front || 'not set'
        })
        usedImages.add(normalizedModelName)
        matchedCount++
      } else {
        notMatchedCount++
        notMatched.push(modelName)
      }
    }

    // Find unmatched images (images without corresponding models)
    const unmatchedImages = []
    for (const [normalizedName, imageInfo] of imageMap.entries()) {
      if (!usedImages.has(normalizedName)) {
        unmatchedImages.push({
          imagePath: `${imageInfo.brand}/${imageInfo.fileName}`,
          fullPath: imageInfo.filePath,
          originalName: imageInfo.originalName
        })
      }
    }

    // Display matched models
    safeLog.info(`\n\n✓ MATCHED MODELS (${matchedCount})`)
    safeLog.info('-'.repeat(80))
    matched.forEach((m, idx) => {
      safeLog.info(`\n${idx + 1}. ${m.modelName}`)
      safeLog.info(`   ID: ${m.modelId}`)
      safeLog.info(`   Image: ${m.imagePath}`)
      safeLog.info(`   Current front: ${m.currentFront}`)
    })

    // Display unmatched models
    safeLog.info(`\n\n✗ NOT MATCHED MODELS (${notMatchedCount})`)
    safeLog.info('-'.repeat(80))
    if (notMatched.length <= 100) {
      notMatched.forEach((name, idx) => {
        safeLog.info(`${idx + 1}. ${name}`)
      })
    } else {
      notMatched.slice(0, 50).forEach((name, idx) => {
        safeLog.info(`${idx + 1}. ${name}`)
      })
      safeLog.info(`\n... and ${notMatched.length - 50} more`)
    }

    // Display unmatched images
    safeLog.info(`\n\n⚠ UNMATCHED IMAGES (${unmatchedImages.length})`)
    safeLog.info('-'.repeat(80))
    safeLog.info('Images that don\'t have corresponding models:\n')
    if (unmatchedImages.length <= 100) {
      unmatchedImages.forEach((img, idx) => {
        safeLog.info(`${idx + 1}. ${img.imagePath}`)
      })
    } else {
      unmatchedImages.slice(0, 50).forEach((img, idx) => {
        safeLog.info(`${idx + 1}. ${img.imagePath}`)
      })
      safeLog.info(`\n... and ${unmatchedImages.length - 50} more`)
    }

    // Summary
    safeLog.info(`\n\n${'='.repeat(80)}`)
    safeLog.info('SUMMARY')
    safeLog.info('='.repeat(80))
    safeLog.info(`Total models: ${models.length}`)
    safeLog.info(`Matched: ${matchedCount} (${((matchedCount / models.length) * 100).toFixed(1)}%)`)
    safeLog.info(`Models not matched: ${notMatchedCount} (${((notMatchedCount / models.length) * 100).toFixed(1)}%)`)
    safeLog.info(`Total images available: ${imageMap.size}`)
    safeLog.info(`Images not matched: ${unmatchedImages.length}`)

    // Save detailed report to file
    const reportPath = path.join(dirName, '..', 'phone-photos-dry-run-report.json')
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalModels: models.length,
        matched: matchedCount,
        modelsNotMatched: notMatchedCount,
        totalImages: imageMap.size,
        imagesNotMatched: unmatchedImages.length,
        matchPercentage: ((matchedCount / models.length) * 100).toFixed(1)
      },
      matched,
      modelsNotMatched: notMatched,
      imagesNotMatched: unmatchedImages
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    safeLog.info(`\nDetailed report saved to: ${reportPath}`)

  } catch (error) {
    safeLog.error('Error:', error)
    process.exit(1)
  }
}

dryRun()
