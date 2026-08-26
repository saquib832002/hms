import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.use(cookieParser());

  // Needed for req.ip / x-forwarded-for to be meaningful behind a reverse
  // proxy — the audit log records the client IP, and without this every
  // entry would show the proxy's address instead.
  app.set('trust proxy', 1);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Reject unknown properties rather than silently dropping them. If a
      // client sends a field the API does not know about, that is a bug worth
      // surfacing, not swallowing.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const origins = config.get<string[]>('corsOrigins') ?? [];
  app.enableCors({
    origin: origins.length ? origins : true,
    credentials: true, // the refresh cookie needs this
  });

  app.enableShutdownHooks();

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);

  logger.log(`API listening on http://localhost:${port}/api/v1`);
  if (config.get<string>('nodeEnv') !== 'production') {
    logger.warn('DEVELOPMENT MODE — dummy data only. Never point this at real patient data.');
  }
}

void bootstrap();
