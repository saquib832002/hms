import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    clientIp?: string;
  }
}

/**
 * Attaches a request id and the client IP before anything else runs, so the
 * audit log and the error log can be correlated for the same request.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const incoming = req.headers['x-request-id'];
    req.requestId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();

    const forwarded = req.headers['x-forwarded-for'];
    req.clientIp =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim() ||
      req.socket.remoteAddress ||
      undefined;

    res.setHeader('x-request-id', req.requestId);
    next();
  }
}
