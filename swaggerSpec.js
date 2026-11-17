import swaggerJsdoc from 'swagger-jsdoc'

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Grest C2B API',
      version: '1.0.0',
      description: 'API documentation for Grest C2B',
      // contact: {
      //   name: 'Grest C2B Team',
      //   email: 'jayant@365aitech.com',
      // },
    },
    servers: [
      {
        url: 'https://api.tradein.grest.in',
        description: 'Production server',
      },
      {
        url: 'https://62p4oqvpxb.execute-api.ap-south-1.amazonaws.com/uat',
        description: 'UAT server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          description: 'Enter your JWT token (without Bearer prefix)',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: false,
            },
            message: {
              type: 'string',
              example: 'Error message',
            },
          },
        },
        Success: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true,
            },
            message: {
              type: 'string',
              example: 'Operation successful',
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Users', description: 'User management and authentication' },
      { name: 'Profile', description: 'Profile operations' },
    ],
  },
  apis: ['./swagger/*.yaml'],
}

const swaggerSpec = swaggerJsdoc(options)

export default swaggerSpec
