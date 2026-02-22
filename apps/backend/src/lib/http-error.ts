export interface HttpErrorOptions {
  code?: string;
  expose?: boolean;
}

export class HttpError extends Error {
  statusCode: number;
  code?: string;
  expose: boolean;

  constructor(statusCode: number, message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = options.code;
    this.expose = options.expose ?? statusCode < 500;
  }

  static badRequest(message: string): HttpError {
    return new HttpError(400, message);
  }

  static unauthorized(message = 'Neautentificat.'): HttpError {
    return new HttpError(401, message);
  }

  static forbidden(message = 'Nu ai permisiuni pentru această operațiune.'): HttpError {
    return new HttpError(403, message);
  }

  static notFound(message = 'Resursa nu a fost găsită.'): HttpError {
    return new HttpError(404, message);
  }

  static conflict(message: string): HttpError {
    return new HttpError(409, message);
  }

  static internal(message = 'Eroare internă de server.'): HttpError {
    return new HttpError(500, message, { expose: false });
  }
}
