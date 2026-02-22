import { env } from '../config/env.js';
import { startInvoiceService } from './invoice-service-app.js';

startInvoiceService(env.INVOICE_SERVICE_PORT);
