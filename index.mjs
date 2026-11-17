import serverlessExpress from '@vendia/serverless-express';
import server from './server.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Configure serverless express with binary support and CORS
let serverlessExpressInstance;

function asyncTask() {
  return serverlessExpress({
    app: server,
    binarySettings: {
      isBinary: ({ headers }) => {
        return headers['accept']?.includes('image') ||
               headers['content-type']?.includes('image');
      }
    }
  });
}

// Export the handler function
export const handler = async (event, context) => {
  // Set environment for Lambda
  process.env.ENVIRONMENT = 'lambda';

  // Lazy initialize the serverless express instance
  if (!serverlessExpressInstance) {
    serverlessExpressInstance = asyncTask();
  }

  return serverlessExpressInstance(event, context);
};
