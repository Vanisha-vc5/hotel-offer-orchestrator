import express from 'express';
import type { Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { AppError } from '../domain/errors';
import type { Config } from '../infra/config';
import type { HotelRepository } from '../infra/hotelRepository';
import { logger } from '../infra/logger';
import type { ChaosStore } from '../mocks/chaos';
import type { SupplierMetrics } from '../mocks/supplierMetrics';
import { isTrustedOperator } from './middleware/operatorAuth';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestId, responseTime } from './middleware/requestId';
import { openApiDocument } from './openapi';
import { adminRouter } from './routes/admin.routes';
import { askRouter } from './routes/ask.routes';
import type { AskService } from './services/askService';
import type { DuplicateService } from './services/duplicateService';
import type { AdminDeps } from './routes/admin.routes';
import { healthRouter } from './routes/health.routes';
import { hotelsRouter } from './routes/hotels.routes';
import { suppliersRouter } from './routes/suppliers.routes';
import type { HealthService } from './services/healthService';
import type { HotelService } from './services/hotelService';

export interface AppDeps {
  cfg: Config;
  hotelService: HotelService;
  healthService: HealthService;
  repository: HotelRepository;
  chaos: ChaosStore;
  /** FEATURE_BENCHMARK: supplier call counters (absent when the flag is off). */
  metrics?: SupplierMetrics;
  /** Hooks and admin routes contributed by v2 feature modules. */
  onChaosReset?: AdminDeps['onChaosReset'];
  adminExtensions?: AdminDeps['extensions'];
  /** FEATURE_MONITOR: X-Circuit-State header source. */
  circuitHeader?: () => Promise<string>;
  /** FEATURE_ASK: natural-language search. */
  askService?: AskService;
  /** FEATURE_DUPLICATES: report-only near-duplicates in insights. */
  duplicateService?: DuplicateService;
}

/** Builds the Express app from injected dependencies (exported for supertest). */
export function createApp(deps: AppDeps): Express {
  const { cfg } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.TRUST_PROXY);
  app.set('query parser', 'simple'); // no nested objects/arrays from query strings

  app.use(
    helmet({
      // Allow /docs over plain HTTP on a VM (no forced https upgrade of assets).
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    }),
  );
  app.use(requestId);
  app.use(responseTime);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      customProps: (req) => ({ requestId: (req as express.Request).requestId }),
      autoLogging: { ignore: (req) => req.url === '/health/live' },
    }),
  );
  app.use(express.json({ limit: '10kb' }));

  app.use(
    '/api',
    rateLimit({
      windowMs: cfg.RATE_LIMIT_WINDOW_MS,
      limit: cfg.RATE_LIMIT_MAX,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, _res, next) => next(new AppError('RATE_LIMITED', 429, 'Too many requests')),
      // FEATURE_BENCHMARK: trusted load tests (x-benchmark: 1) are not rate limited.
      skip: (req) =>
        cfg.FEATURE_BENCHMARK &&
        req.header('x-benchmark') === '1' &&
        isTrustedOperator(req, cfg.ADMIN_TOKEN),
    }),
  );

  app.use(
    '/api',
    hotelsRouter(deps.hotelService, {
      allowCoalescingOverride: cfg.FEATURE_BENCHMARK,
      adminToken: cfg.ADMIN_TOKEN,
      circuitHeader: deps.circuitHeader,
      duplicates: deps.duplicateService,
    }),
  );
  if (deps.askService) app.use('/api', askRouter(deps.askService));
  app.use('/health', healthRouter(deps.healthService));
  app.use(suppliersRouter(deps.chaos, deps.metrics));
  app.use(
    '/admin',
    adminRouter({
      chaos: deps.chaos,
      repository: deps.repository,
      chaosEnabled: cfg.ENABLE_CHAOS,
      adminToken: cfg.ADMIN_TOKEN,
      metrics: deps.metrics,
      onChaosReset: deps.onChaosReset,
      extensions: deps.adminExtensions,
    }),
  );

  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, { customSiteTitle: 'Hotel Offer Orchestrator API' }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
