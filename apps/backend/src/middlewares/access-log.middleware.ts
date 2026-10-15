import morgan, { StreamOptions } from 'morgan';

/** Callback query strings contain OAuth codes/state and must stay out of logs. */
export function createAccessLogger(stream?: StreamOptions) {
  return morgan((tokens, req, res) => [
    tokens.method(req, res),
    (req.url ?? '/').split('?')[0],
    tokens.status(req, res),
    tokens['response-time'](req, res), 'ms -',
    tokens.res(req, res, 'content-length') ?? '-',
  ].join(' '), { stream });
}
