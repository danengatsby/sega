import { env } from './config/env.js';
import { startServer } from './app.js';

startServer(env.PORT);
