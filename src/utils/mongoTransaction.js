const mongoose = require('mongoose');

/**
 * Run work inside a MongoDB transaction with automatic retry for transient errors.
 * Prefer this over manual startTransaction / commit / abort to avoid session desync.
 */
async function runInTransaction(work, options = {}) {
  const session = await mongoose.startSession();
  try {
    let output;
    await session.withTransaction(
      async () => {
        output = await work(session);
      },
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        maxCommitTimeMS: 30000,
        ...options,
      },
    );
    return output;
  } finally {
    session.endSession();
  }
}

module.exports = { runInTransaction };
