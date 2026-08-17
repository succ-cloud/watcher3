function isTransientSaleError(err) {
  const text = [
    err?.message,
    err?.errorResponse?.errmsg,
    err?.errorLabels?.join?.(' '),
    err?.codeName,
    err?.name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    text.includes('transienttransactionerror')
    || text.includes('unknowntransactioncommitresult')
    || text.includes('does not match any in-progress transactions')
    || text.includes('transaction number')
    || text.includes('writeconflict')
    || text.includes('catalog change')
    || err?.hasErrorLabel?.('TransientTransactionError')
    || err?.hasErrorLabel?.('UnknownTransactionCommitResult')
  );
}

function isDuplicateImeError(err) {
  const text = String(err?.message || err?.errorResponse?.errmsg || '').toLowerCase();
  return text.includes('e11000') && text.includes('ime');
}

/**
 * Turn low-level database / server errors into messages staff can act on.
 */
function friendlySaleErrorMessage(err, fallback = 'Could not save this sale. Please try again.') {
  if (!err) return fallback;

  if (Number(err.status) >= 400 && Number(err.status) < 500 && err.message) {
    return String(err.message);
  }

  if (isDuplicateImeError(err)) {
    return 'This IME was already sold. Refresh the page, pick a different unit, and try again.';
  }

  if (isTransientSaleError(err)) {
    return 'The sale could not be saved right now because of a brief connection issue. Wait a moment and tap Confirm again.';
  }

  const msg = String(err.message || '').trim();
  if (!msg) return fallback;

  if (
    /transaction number|in-progress transactions|txnretrycounter|session\s+[0-9a-f-]{36}/i.test(msg)
    || /mongodb.*transaction/i.test(msg)
  ) {
    return 'The sale could not be saved right now because of a brief connection issue. Wait a moment and tap Confirm again.';
  }

  if (/write conflict|writeconflict/i.test(msg)) {
    return 'This product was updated by someone else at the same time. Refresh the page and try the sale again.';
  }

  if (/network|timeout|econnreset|etimedout|socket/i.test(msg)) {
    return 'Could not reach the server. Check your connection and try again.';
  }

  if (Number(err.status) >= 500 || !err.status) {
    return fallback;
  }

  return msg;
}

module.exports = {
  friendlySaleErrorMessage,
  isTransientSaleError,
  isDuplicateImeError,
};
