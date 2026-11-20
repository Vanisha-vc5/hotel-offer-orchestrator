import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { logger } from '../infra/logger';
import type { ChaosStore } from '../mocks/chaos';
import { requestId } from './middleware/requestId';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { healthRouter } from './routes/health.routes';
import { suppliersRouter } from './routes/suppliers.routes';

export interface AppDeps {
  chaos: ChaosStore;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => (req as express.Request).requestId }));
  app.use(express.json({ limit: '10kb' }));

  app.use('/health', healthRouter());
  app.use(suppliersRouter(deps.chaos));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
