// Errors thrown by the web adapter. Same shape as public/js/api.js's ApiError so the UI maps
// `code` to the `errors.<code>` translations exactly as in the self-hosted app.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const apiError = (status, code, message) => new ApiError(status, code, message);
