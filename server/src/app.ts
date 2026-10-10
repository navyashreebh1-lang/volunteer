import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import type { AppContext } from './context.js';
import { errorHandler, notFoundHandler } from './middleware.js';
import { createRoutes } from './routes.js';

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  // Needed for correct client IPs (rate limiting) and secure cookies behind a proxy.
  if (ctx.config.isProduction) app.set('trust proxy', 1);

  app.use(helmet());
  app.use(express.json({ limit: '50kb' }));
  app.use(cookieParser());

  app.use('/api', createRoutes(ctx));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
