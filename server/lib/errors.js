// Errors thrown with httpError() are sent to the client as
// { error: { code, message } } with the given status. Anything else becomes a 500.
export function httpError(status, code, message = code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.expose = true;
  return err;
}

export function errorHandler(err, req, res, _next) {
  const status = err.expose ? err.status : 500;
  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return;
  res.status(status).json({
    error: {
      code: err.expose ? err.code : 'internal_error',
      message: err.expose ? err.message : 'Something went wrong',
    },
  });
}
