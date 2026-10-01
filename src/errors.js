export class UserError extends Error {
  constructor(message, code = 'error') {
    super(message);
    this.code = code;
  }
}

export function explainNetError(e, host) {
  if (e instanceof UserError) return e;
  const code = e?.cause?.code || e?.code || '';
  const msg = String(e?.message || '');
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT')
    return new UserError(`⏱️ ${host} took too long to respond.`, 'timeout');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return new UserError(`❓ I couldn't find ${host}. Check the spelling of the address.`, 'dns');
  if (code === 'ECONNREFUSED')
    return new UserError(`🚫 ${host} refused the connection.`, 'refused');
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET')
    return new UserError(`🚫 ${host} closed the connection unexpectedly.`, 'reset');
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code + msg))
    return new UserError(`🔓 ${host} has an invalid or untrusted SSL certificate.`, 'ssl');
  if (/redirect/i.test(msg))
    return new UserError(`🔁 ${host} redirected too many times.`, 'redirects');
  return new UserError(`Could not reach ${host} (${code || msg || 'unknown error'}).`, 'network');
}
