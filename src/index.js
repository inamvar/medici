const book = require('./book');
const mongoose = require('mongoose');
const { Schema } = mongoose;

// This lets you register your own schema before including Medici. Useful if you want to store additional information
// along side each transaction
try {
  mongoose.model('Medici_Transaction');
} catch (error) {
  const transactionSchema = new Schema({
    credit: Number,
    debit: Number,
    meta: Schema.Types.Mixed,
    datetime: Date,
    account_path: [String],
    accounts: String,
    book: String,
    memo: String,
    _journal: {
      type: Schema.Types.ObjectId,
      ref: 'Medici_Journal'
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    voided: {
      type: Boolean,
      default: false
    },
    void_reason: String,
    // The journal that this is voiding, if any
    _original_journal: Schema.Types.ObjectId,
    approved: {
      type: Boolean,
      default: true
    }
  });
  mongoose.model('Medici_Transaction', transactionSchema);
}

// We really only need journals so we can group by journal entry and void all transactions. Datetime
// and memo also go to the transaction for easy searching without having to populate the journal
// model each time.
let journalSchema;
try {
  journalSchema = mongoose.model('Medici_Journal');
} catch (error) {
  journalSchema = new Schema({
    datetime: Date,
    memo: {
      type: String,
      default: ''
    },
    _transactions: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Medici_Transaction'
      }
    ],
    book: String,
    voided: {
      type: Boolean,
      default: false
    },
    void_reason: String,
    approved: {
      type: Boolean,
      default: true
    }
  });

  journalSchema.methods.void = function(book, reason) {
    if (this.voided === true) {
      return Promise.reject(new Error('Journal already voided'));
    }

    // Set this to void with reason and also set all associated transactions
    this.voided = true;
    if (!reason) {
      this.void_reason = '';
    } else {
      this.void_reason = reason;
    }

    const voidTransaction = trans_id => {
      return mongoose
        .model('Medici_Transaction')
        .findByIdAndUpdate(trans_id, {
          voided: true,
          void_reason: this.void_reason
        })
        .catch(err => {
          console.error('Failed to void transaction:', err);
          throw err;
        });
    };

    const voids = [];
    for (let trans_id of this._transactions) {
      voids.push(voidTransaction(trans_id));
    }

    return Promise.all(voids).then(transactions => {
      let newMemo;
      if (this.void_reason) {
        newMemo = this.void_reason;
      } else {
        // It's either VOID, UNVOID, or REVOID
        if (this.memo.substr(0, 6) === '[VOID]') {
          newMemo = this.memo.replace('[VOID]', '[UNVOID]');
        } else if (this.memo.substr(0, 8) === '[UNVOID]') {
          newMemo = this.memo.replace('[UNVOID]', '[REVOID]');
        } else if (this.memo.substr(0, 8) === '[REVOID]') {
          newMemo = this.memo.replace('[REVOID]', '[UNVOID]');
        } else {
          newMemo = `[VOID] ${this.memo}`;
        }
      }
      // Ok now create an equal and opposite journal
      const entry = book.entry(newMemo, null, this._id);
      const valid_fields = [
        'credit',
        'debit',
        'account_path',
        'accounts',
        'datetime',
        'book',
        'memo',
        'timestamp',
        'voided',
        'void_reason',
        '_original_journal'
      ];

      for (let trans of transactions) {
        trans = trans.toObject();
        const meta = {};
        for (let key in trans) {
          const val = trans[key];
          if (key === '_id' || key === '_journal') {
            continue;
          }
          if (valid_fields.indexOf(key) === -1) {
            meta[key] = val;
          }
        }
        if (trans.credit) {
          entry.debit(trans.account_path, trans.credit, meta);
        }
        if (trans.debit) {
          entry.credit(trans.account_path, trans.debit, meta);
        }
      }

      return entry.commit();
    });
  };

  journalSchema.pre('save', function(next) {
    if (!(this.isModified('approved') && this.approved === true)) {
      return next();
    }

    return mongoose
      .model('Medici_Transaction')
      .find({ _journal: this._id })
      .then(function(transactions) {
        return Promise.all(
          transactions.map(tx => {
            tx.approved = true;
            return tx.save();
          })
        ).then(() => next());
      });
  });
  mongoose.model('Medici_Journal', journalSchema);
}

module.exports = { book };
