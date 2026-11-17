import fs from 'fs'
import swaggerSpec from './swaggerSpec.js'

// Generate swagger.json file
const swaggerJson = JSON.stringify(swaggerSpec, null, 2)

// Write to file
fs.writeFileSync('./swagger.json', swaggerJson)

console.log('✅ Swagger JSON generated successfully at ./swagger.json')
console.log('📤 You can share this file or upload it to https://editor.swagger.io')
