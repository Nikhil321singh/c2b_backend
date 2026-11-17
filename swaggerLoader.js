// Wrapper to conditionally load swagger
// This prevents errors in Lambda environment where swagger files may not be deployed

export const loadSwagger = async () => {
  if (process.env.ENVIRONMENT === 'lambda') {
    return null
  }

  try {
    const swaggerSpecModule = await import('./swaggerSpec.js')
    return swaggerSpecModule.default
  } catch (error) {
    console.warn('Swagger not available:', error.message)
    return null
  }
}
