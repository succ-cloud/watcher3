const mongoose = require('mongoose');

const exchangeRecordSchema = new mongoose.Schema(
  {
    originalIME: { type: String, required: true, trim: true, index: true },
    newIME: { type: String, required: true, trim: true, index: true },
    phoneName: { type: String, required: true, trim: true, index: true },
    storage: { type: String, required: true, trim: true },
    exchangeDate: { type: Date, default: Date.now, index: true },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    priceDifference: { type: Number, default: null },
    notes: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

const ExchangeRecord =
  mongoose.models.ExchangeRecord || mongoose.model('ExchangeRecord', exchangeRecordSchema);

module.exports = ExchangeRecord;
