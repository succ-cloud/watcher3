const mongoose = require('mongoose');

const orderSequenceSchema = new mongoose.Schema(
  {
    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    seq: { type: Number, default: 0, min: 0 },
  },
  { timestamps: false },
);

orderSequenceSchema.index({ year: 1, month: 1 }, { unique: true });

module.exports = mongoose.models.OrderSequence || mongoose.model('OrderSequence', orderSequenceSchema);
