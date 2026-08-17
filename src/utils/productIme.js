/** Collect registered IME/serial codes from a product line. */
function normalizedImeList(product) {
  if (!product) return [];
  const fromArray = Array.isArray(product.imeCodes)
    ? product.imeCodes.map((c) => String(c || '').trim()).filter(Boolean)
    : [];
  if (fromArray.length) return fromArray;
  const single = String(product.IME || '').trim();
  return single ? [single] : [];
}

function applyImeFields(target, codes) {
  const list = Array.isArray(codes) ? codes.map((c) => String(c || '').trim()).filter(Boolean) : [];
  if (!list.length) {
    target.imeCodes = [];
    if (typeof target.set === 'function') {
      target.set('IME', undefined);
    } else {
      target.IME = undefined;
    }
    return;
  }
  target.imeCodes = list;
  target.IME = list[0];
}

/** Take the first `qty` IME codes from a product line for transfer/split. */
function splitImeCodes(product, qty) {
  const all = normalizedImeList(product);
  if (!all.length) {
    return { taken: [], remaining: [] };
  }
  const takeCount = Math.min(Math.max(1, qty), all.length);
  return {
    taken: all.slice(0, takeCount),
    remaining: all.slice(takeCount),
  };
}

/** Take specific IME codes from a product line (must all exist on the line). */
function takeSpecificImeCodes(product, selectedImes = []) {
  const wanted = [...new Set(selectedImes.map((c) => String(c || '').trim()).filter(Boolean))];
  if (!wanted.length) {
    return { taken: [], remaining: normalizedImeList(product) };
  }
  const all = normalizedImeList(product);
  const taken = wanted.filter((ime) => all.includes(ime));
  if (taken.length !== wanted.length) {
    const missing = wanted.find((ime) => !all.includes(ime));
    const err = new Error(missing ? `IME not on this product line: ${missing}` : 'Invalid IME selection.');
    err.statusCode = 400;
    throw err;
  }
  const takenSet = new Set(taken);
  return {
    taken,
    remaining: all.filter((ime) => !takenSet.has(ime)),
  };
}

function buildImeManifestLines(product, transferredImes) {
  const base = {
    productName: product?.product_name || '',
    brand: product?.brand || '',
    capacity: product?.capacity || '',
    color: product?.color || '',
    bulkBatchCode: product?.bulkBatchCode || null,
  };
  return transferredImes.map((ime) => ({ ime, ...base }));
}

/** Units on one product line — registered IMEs when present, otherwise stock. */
function resolveEffectiveLineStock(product) {
  if (!product) return 0;
  const imes = normalizedImeList(product);
  const stock = Math.max(0, Number(product?.stock) || 0);
  return imes.length > 0 ? imes.length : stock;
}

/** Sum physical units across product lines (IME count when registered). */
function sumProductsEffectiveStock(products) {
  const list = Array.isArray(products) ? products : [];
  return list.reduce((sum, product) => sum + resolveEffectiveLineStock(product), 0);
}

/** Mongo aggregation expression for one product line's physical unit count. */
function productLineUnitCountExpr() {
  const imeCodesLen = {
    $cond: [
      { $isArray: '$imeCodes' },
      { $size: '$imeCodes' },
      0,
    ],
  };

  return {
    $let: {
      vars: {
        imeCodesLen,
        hasSingleIme: {
          $gt: [
            {
              $strLenCP: {
                $trim: {
                  input: {
                    $convert: {
                      input: { $ifNull: ['$IME', ''] },
                      to: 'string',
                      onError: '',
                      onNull: '',
                    },
                  },
                },
              },
            },
            0,
          ],
        },
        stockVal: {
          $max: [
            0,
            { $convert: { input: '$stock', to: 'double', onError: 0, onNull: 0 } },
          ],
        },
      },
      in: {
        $cond: [
          { $gt: ['$$imeCodesLen', 0] },
          '$$imeCodesLen',
          { $cond: ['$$hasSingleIme', 1, '$$stockVal'] },
        ],
      },
    },
  };
}

module.exports = {
  normalizedImeList,
  applyImeFields,
  splitImeCodes,
  takeSpecificImeCodes,
  buildImeManifestLines,
  resolveEffectiveLineStock,
  sumProductsEffectiveStock,
  productLineUnitCountExpr,
};
