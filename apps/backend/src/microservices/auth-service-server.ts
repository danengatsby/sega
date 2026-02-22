import { env } from '../config/env.js';
import { startAuthService } from './auth-service-app.js';

startAuthService(env.AUTH_SERVICE_PORT);
