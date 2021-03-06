/*!
 * wallet.js - wallet object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var bcoin = require('./env');
var EventEmitter = require('events').EventEmitter;
var constants = bcoin.protocol.constants;
var utils = require('./utils');
var assert = utils.assert;
var BufferReader = require('./reader');
var BufferWriter = require('./writer');
var TXDB = require('./txdb');
var keyTypes = bcoin.keyring.types;
var keyTypesByVal = bcoin.keyring.typesByVal;

/**
 * BIP44 Wallet
 * @exports Wallet
 * @constructor
 * @param {Object} options
 * @param {WalletDB} options.db
 * present, no coins will be available.
 * @param {(HDPrivateKey|HDPublicKey)?} options.master - Master HD key. If not
 * present, it will be generated.
 * @param {Boolean?} options.witness - Whether to use witness programs.
 * @param {Number?} options.accountIndex - The BIP44 account index (default=0).
 * @param {Number?} options.receiveDepth - The index of the _next_ receiving
 * address.
 * @param {Number?} options.changeDepth - The index of the _next_ change
 * address.
 * @param {String?} options.type - Type of wallet (pubkeyhash, multisig)
 * (default=pubkeyhash).
 * @param {Boolean?} options.compressed - Whether to use compressed
 * public keys (default=true).
 * @param {Number?} options.m - `m` value for multisig.
 * @param {Number?} options.n - `n` value for multisig.
 * @param {String?} options.id - Wallet ID (used for storage)
 * (default=account key "address").
 */

function Wallet(db, options) {
  if (!(this instanceof Wallet))
    return new Wallet(db, options);

  EventEmitter.call(this);

  assert(db, 'DB required.');

  this.db = db;
  this.network = db.network;
  this.logger = db.logger;
  this.workerPool = db.workerPool;
  this.writeLock = new bcoin.locker(this);
  this.fundLock = new bcoin.locker(this);

  this.wid = 0;
  this.id = null;
  this.master = null;
  this.initialized = false;
  this.accountDepth = 0;
  this.token = constants.ZERO_HASH;
  this.tokenDepth = 0;
  this.tx = new TXDB(this);

  this.account = null;

  if (options)
    this.fromOptions(options);
}

utils.inherits(Wallet, EventEmitter);

/**
 * Invoke write mutex lock.
 * @private
 */

Wallet.prototype._lockWrite = function _lockWrite(func, args, force) {
  return this.writeLock.lock(func, args, force);
};

/**
 * Invoke funding mutex lock.
 * @private
 */

Wallet.prototype._lockFund = function _lockFund(func, args, force) {
  return this.fundLock.lock(func, args, force);
};

/**
 * Inject properties from options object.
 * @private
 * @param {Object} options
 */

Wallet.prototype.fromOptions = function fromOptions(options) {
  var master = options.master;
  var id, token;

  if (!master)
    master = bcoin.hd.fromMnemonic(null, this.network);

  if (!bcoin.hd.isHD(master) && !MasterKey.isMasterKey(master))
    master = bcoin.hd.from(master, this.network);

  if (bcoin.hd.isHD(master))
    master = MasterKey.fromKey(master);

  assert(MasterKey.isMasterKey(master));

  this.master = master;

  if (options.initialized != null) {
    assert(typeof options.initialized === 'boolean');
    this.initialized = options.initialized;
  }

  if (options.accountDepth != null) {
    assert(utils.isNumber(options.accountDepth));
    this.accountDepth = options.accountDepth;
  }

  if (options.wid != null) {
    assert(utils.isNumber(options.wid));
    this.wid = options.wid;
  }

  if (options.id) {
    assert(utils.isName(options.id), 'Bad wallet ID.');
    id = options.id;
  }

  if (!id)
    id = this.getID();

  if (options.token) {
    assert(Buffer.isBuffer(options.token));
    assert(options.token.length === 32);
    token = options.token;
  }

  if (options.tokenDepth != null) {
    assert(utils.isNumber(options.tokenDepth));
    this.tokenDepth = options.tokenDepth;
  }

  if (!token)
    token = this.getToken(this.master.key, this.tokenDepth);

  this.id = id;
  this.token = token;

  return this;
};

/**
 * Instantiate wallet from options.
 * @param {WalletDB} db
 * @param {Object} options
 * @returns {Wallet}
 */

Wallet.fromOptions = function fromOptions(db, options) {
  return new Wallet(db).fromOptions(options);
};

/**
 * Attempt to intialize the wallet (generating
 * the first addresses along with the lookahead
 * addresses). Called automatically from the
 * walletdb.
 * @param {Function} callback
 */

Wallet.prototype.init = function init(options, callback) {
  var self = this;

  assert(!this.initialized);
  this.initialized = true;

  this.master.encrypt(options.passphrase, function(err) {
    if (err)
      return callback(err);

    self.createAccount(options, function(err, account) {
      if (err)
        return callback(err);

      assert(account);

      self.account = account;

      self.logger.info('Wallet initialized (%s).', self.id);

      self.tx.open(callback);
    });
  });
};

/**
 * Open wallet (done after retrieval).
 * @param {Function} callback
 */

Wallet.prototype.open = function open(callback) {
  var self = this;

  assert(this.initialized);

  this.getAccount(0, function(err, account) {
    if (err)
      return callback(err);

    if (!account)
      return callback(new Error('Default account not found.'));

    self.account = account;

    self.logger.info('Wallet opened (%s).', self.id);

    self.tx.open(callback);
  });
};

/**
 * Close the wallet, unregister with the database.
 * @param {Function} callback
 */

Wallet.prototype.destroy = function destroy(callback) {
  callback = utils.ensure(callback);

  try {
    this.db.unregister(this);
    this.master.destroy();
  } catch (e) {
    this.emit('error', e);
    return callback(e);
  }

  return utils.nextTick(callback);
};

/**
 * Add a public account key to the wallet (multisig).
 * Saves the key in the wallet database.
 * @param {HDPublicKey} key
 * @param {Function} callback
 */

Wallet.prototype.addKey = function addKey(account, key, callback) {
  var self = this;

  if (typeof key === 'function') {
    callback = key;
    key = account;
    account = 0;
  }

  callback = this._lockWrite(addKey, [account, key, callback]);

  if (!callback)
    return;

  this.getAccount(account, function(err, account) {
    if (err)
      return callback(err);

    if (!account)
      return callback(new Error('Account not found.'));

    self.start();

    account.addKey(key, function(err, result) {
      if (err) {
        self.drop();
        return callback(err);
      }
      self.commit(function(err) {
        if (err)
          return callback(err);
        callback(null, result);
      });
    });
  }, true);
};

/**
 * Remove a public account key from the wallet (multisig).
 * Remove the key from the wallet database.
 * @param {HDPublicKey} key
 * @param {Function} callback
 */

Wallet.prototype.removeKey = function removeKey(account, key, callback) {
  var self = this;

  if (typeof key === 'function') {
    callback = key;
    key = account;
    account = 0;
  }

  callback = this._lockWrite(removeKey, [account, key, callback]);

  if (!callback)
    return;

  this.getAccount(account, function(err, account) {
    if (err)
      return callback(err);

    if (!account)
      return callback(new Error('Account not found.'));

    self.start();

    account.removeKey(key, function(err, result) {
      if (err) {
        self.drop();
        return callback(err);
      }
      self.commit(function(err) {
        if (err)
          return callback(err);
        callback(null, result);
      });
    });
  }, true);
};

/**
 * Change or set master key's passphrase.
 * @param {(String|Buffer)?} old
 * @param {String|Buffer} new_
 * @param {Function} callback
 */

Wallet.prototype.setPassphrase = function setPassphrase(old, new_, callback) {
  var self = this;

  if (typeof new_ === 'function') {
    callback = new_;
    new_ = old;
    old = null;
  }

  callback = this._lockWrite(setPassphrase, [old, new_, callback]);

  if (!callback)
    return;

  this.master.decrypt(old, function(err) {
    if (err)
      return callback(err);

    self.master.encrypt(new_, function(err) {
      if (err)
        return callback(err);

      self.start();
      self.save();
      self.commit(callback);
    });
  });
};

/**
 * Generate a new token.
 * @param {(String|Buffer)?} passphrase
 * @param {Function} callback
 */

Wallet.prototype.retoken = function retoken(passphrase, callback) {
  var self = this;

  if (typeof passphrase === 'function') {
    callback = passphrase;
    passphrase = null;
  }

  callback = this._lockWrite(retoken, [passphrase, callback]);

  if (!callback)
    return;

  this.unlock(passphrase, null, function(err, master) {
    if (err)
      return callback(err);

    self.tokenDepth++;
    self.token = self.getToken(master, self.tokenDepth);

    self.start();
    self.save();
    self.commit(function(err) {
      if (err)
        return callback(err);
      callback(null, self.token);
    });
  });
};

/**
 * Lock the wallet, destroy decrypted key.
 */

Wallet.prototype.lock = function lock() {
  this.master.destroy();
};

/**
 * Unlock the key for `timeout` milliseconds.
 * @param {Buffer|String} passphrase
 * @param {Number?} [timeout=60000] - ms.
 */

Wallet.prototype.unlock = function unlock(passphrase, timeout, callback) {
  this.master.unlock(passphrase, timeout, callback);
};

/**
 * Generate the wallet ID if none was passed in.
 * It is represented as HASH160(m/44->public|magic)
 * converted to an "address" with a prefix
 * of `0x03be04` (`WLT` in base58).
 * @private
 * @returns {Base58String}
 */

Wallet.prototype.getID = function getID() {
  var key, p, hash;

  assert(this.master.key, 'Cannot derive id.');

  key = this.master.key.derive(44);

  p = new BufferWriter();
  p.writeBytes(key.publicKey);
  p.writeU32(this.network.magic);

  hash = utils.hash160(p.render());

  p = new BufferWriter();
  p.writeU8(0x03);
  p.writeU8(0xbe);
  p.writeU8(0x04);
  p.writeBytes(hash);
  p.writeChecksum();

  return utils.toBase58(p.render());
};

/**
 * Generate the wallet api key if none was passed in.
 * It is represented as HASH256(m/44'->private|nonce).
 * @private
 * @param {HDPrivateKey} master
 * @param {Number} nonce
 * @returns {Buffer}
 */

Wallet.prototype.getToken = function getToken(master, nonce) {
  var key, p;

  assert(master, 'Cannot derive token.');

  key = master.derive(44, true);

  p = new BufferWriter();
  p.writeBytes(key.privateKey);
  p.writeU32(nonce);

  return utils.hash256(p.render());
};

/**
 * Create an account. Requires passphrase if master key is encrypted.
 * @param {Object} options - See {@link Account} options.
 * @param {Function} callback - Returns [Error, {@link Account}].
 */

Wallet.prototype.createAccount = function createAccount(options, callback) {
  var self = this;
  var passphrase = options.passphrase;
  var timeout = options.timeout;
  var key;

  callback = this._lockWrite(createAccount, [options, callback]);

  if (!callback)
    return;

  this.unlock(passphrase, timeout, function(err, master) {
    if (err)
      return callback(err);

    key = master.deriveAccount44(self.accountDepth);

    options = {
      network: self.network,
      wid: self.wid,
      id: self.id,
      name: self.accountDepth === 0 ? 'default' : options.name,
      witness: options.witness,
      accountKey: key.hdPublicKey,
      accountIndex: self.accountDepth,
      type: options.type,
      keys: options.keys,
      m: options.m,
      n: options.n
    };

    self.start();

    self.db.createAccount(options, function(err, account) {
      if (err) {
        self.drop();
        return callback(err);
      }

      self.accountDepth++;
      self.save();
      self.commit(function(err) {
        if (err)
          return callback(err);
        callback(null, account);
      });
    });
  });
};

/**
 * Ensure an account. Requires passphrase if master key is encrypted.
 * @param {Object} options - See {@link Account} options.
 * @param {Function} callback - Returns [Error, {@link Account}].
 */

Wallet.prototype.ensureAccount = function ensureAccount(options, callback) {
  var self = this;
  var account = options.account;

  if (typeof options.name === 'string')
    account = options.name;

  this.hasAccount(account, function(err, exists) {
    if (err)
      return callback(err);

    if (exists)
      return self.getAccount(account, callback);

    self.createAccount(options, callback);
  });
};

/**
 * List account names and indexes from the db.
 * @param {Function} callback - Returns [Error, Array].
 */

Wallet.prototype.getAccounts = function getAccounts(callback) {
  this.db.getAccounts(this.wid, callback);
};

/**
 * Get all wallet address hashes.
 * @param {Function} callback - Returns [Error, Array].
 */

Wallet.prototype.getAddressHashes = function getAddressHashes(callback) {
  this.db.getAddressHashes(this.wid, callback);
};

/**
 * Retrieve an account from the database.
 * @param {Number|String} account
 * @param {Function} callback - Returns [Error, {@link Account}].
 */

Wallet.prototype.getAccount = function getAccount(account, callback) {
  var self = this;

  if (this.account) {
    if (account === 0 || account === 'default')
      return callback(null, this.account);
  }

  this.db.getAccount(this.wid, account, function(err, account) {
    if (err)
      return callback(err);

    if (!account)
      return callback();

    account.wid = self.wid;
    account.id = self.id;

    callback(null, account);
  });
};

/**
 * Test whether an account exists.
 * @param {Number|String} account
 * @param {Function} callback - Returns [Error, {@link Boolean}].
 */

Wallet.prototype.hasAccount = function hasAccount(account, callback) {
  this.db.hasAccount(this.wid, account, callback);
};

/**
 * Create a new receiving address (increments receiveDepth).
 * @param {(Number|String)?} account
 * @param {Function} callback - Returns [Error, {@link KeyRing}].
 */

Wallet.prototype.createReceive = function createReceive(account, callback) {
  if (typeof account === 'function') {
    callback = account;
    account = 0;
  }
  return this.createAddress(account, false, callback);
};

/**
 * Create a new change address (increments receiveDepth).
 * @param {(Number|String)?} account
 * @param {Function} callback - Returns [Error, {@link KeyRing}].
 */

Wallet.prototype.createChange = function createChange(account, callback) {
  if (typeof account === 'function') {
    callback = account;
    account = 0;
  }
  return this.createAddress(account, true, callback);
};

/**
 * Create a new address (increments depth).
 * @param {(Number|String)?} account
 * @param {Boolean} change
 * @param {Function} callback - Returns [Error, {@link KeyRing}].
 */

Wallet.prototype.createAddress = function createAddress(account, change, callback) {
  var self = this;

  if (typeof change === 'function') {
    callback = change;
    change = account;
    account = 0;
  }

  callback = this._lockWrite(createAddress, [account, change, callback]);

  if (!callback)
    return;

  this.getAccount(account, function(err, account) {
    if (err)
      return callback(err);

    if (!account)
      return callback(new Error('Account not found.'));

    self.start();

    account.createAddress(change, function(err, result) {
      if (err) {
        self.drop();
        return callback(err);
      }
      self.commit(function(err) {
        if (err)
          return callback(err);
        callback(null, result);
      });
    });
  }, true);
};

/**
 * Save the wallet to the database. Necessary
 * when address depth and keys change.
 * @param {Function} callback
 */

Wallet.prototype.save = function save() {
  return this.db.save(this);
};

/**
 * Start batch.
 * @private
 */

Wallet.prototype.start = function start() {
  return this.db.start(this.wid);
};

/**
 * Drop batch.
 * @private
 */

Wallet.prototype.drop = function drop() {
  return this.db.drop(this.wid);
};

/**
 * Save batch.
 * @param {Function} callback
 */

Wallet.prototype.commit = function commit(callback) {
  return this.db.commit(this.wid, callback);
};

/**
 * Test whether the wallet possesses an address.
 * @param {Address|Hash} address
 * @param {Function} callback - Returns [Error, Boolean].
 */

Wallet.prototype.hasAddress = function hasAddress(address, callback) {
  var hash = bcoin.address.getHash(address, 'hex');
  if (!hash)
    return callback(null, false);
  return this.db.hasAddress(this.wid, hash, callback);
};

/**
 * Get path by address hash.
 * @param {Address|Hash} address
 * @param {Function} callback - Returns [Error, {@link Path}].
 */

Wallet.prototype.getPath = function getPath(address, callback) {
  var self = this;
  var hash = bcoin.address.getHash(address, 'hex');

  if (!hash)
    return callback();

  this.db.getAddressPath(this.wid, hash, function(err, path) {
    if (err)
      return callback(err);

    if (!path)
      return callback();

    path.id = self.id;

    callback(null, path);
  });
};

/**
 * Get all wallet paths.
 * @param {(String|Number)?} account
 * @param {Function} callback - Returns [Error, {@link Path}].
 */

Wallet.prototype.getPaths = function getPaths(account, callback) {
  var self = this;
  var out = [];
  var i, path;

  this._getIndex(account, callback, function(account, callback) {
    this.db.getWalletPaths(this.wid, function(err, paths) {
      if (err)
        return callback(err);

      for (i = 0; i < paths.length; i++) {
        path = paths[i];
        if (!account || path.account === account) {
          path.id = self.id;
          out.push(path);
        }
      }

      callback(null, out);
    });
  });
};

/**
 * Fill a transaction with inputs, estimate
 * transaction size, calculate fee, and add a change output.
 * @see MTX#selectCoins
 * @see MTX#fill
 * @param {MTX} tx - _Must_ be a mutable transaction.
 * @param {Object?} options
 * @param {(String|Number)?} options.account - If no account is
 * specified, coins from the entire wallet will be filled.
 * @param {String?} options.selection - Coin selection priority. Can
 * be `age`, `random`, or `all`. (default=age).
 * @param {Boolean} options.round - Whether to round to the nearest
 * kilobyte for fee calculation.
 * See {@link TX#getMinFee} vs. {@link TX#getRoundFee}.
 * @param {Rate} options.rate - Rate used for fee calculation.
 * @param {Boolean} options.confirmed - Select only confirmed coins.
 * @param {Boolean} options.free - Do not apply a fee if the
 * transaction priority is high enough to be considered free.
 * @param {Amount?} options.fee - Use a hard fee rather than calculating one.
 * @param {Number|Boolean} options.subtractFee - Whether to subtract the
 * fee from existing outputs rather than adding more inputs.
 */

Wallet.prototype.fund = function fund(tx, options, callback, force) {
  var self = this;
  var rate;

  if (typeof options === 'function') {
    callback = options;
    options = null;
  }

  if (!options)
    options = {};

  // We use a lock here to ensure we
  // don't end up double spending coins.
  callback = this._lockFund(fund, [tx, options, callback], force);

  if (!callback)
    return;

  if (!this.initialized)
    return callback(new Error('Wallet is not initialized.'));

  this.getAccount(options.account, function(err, account) {
    if (err)
      return callback(err);

    if (!account) {
      if (options.account != null)
        return callback(new Error('Account not found.'));
      account = self.account;
    }

    if (!account.initialized)
      return callback(new Error('Account is not initialized.'));

    self.getCoins(options.account, function(err, coins) {
      if (err)
        return callback(err);

      rate = options.rate;

      if (rate == null) {
        if (self.db.fees)
          rate = self.db.fees.estimateFee();
        else
          rate = self.network.getRate();
      }

      // Don't use any locked coins.
      coins = self.tx.filterLocked(coins);

      try {
        tx.fund(coins, {
          selection: options.selection || 'age',
          round: options.round,
          confirmed: options.confirmed,
          free: options.free,
          fee: options.fee,
          subtractFee: options.subtractFee,
          changeAddress: account.changeAddress.getAddress(),
          height: self.db.height,
          rate: rate,
          wallet: self,
          m: self.m,
          n: self.n
        });
      } catch (e) {
        return callback(e);
      }

      callback();
    });
  });
};

/**
 * Build a transaction, fill it with outputs and inputs,
 * sort the members according to BIP69, set locktime,
 * and template it.
 * @param {Object} options - See {@link Wallet#fund options}.
 * @param {Object[]} options.outputs - See {@link MTX#addOutput}.
 * @param {Function} callback - Returns [Error, {@link MTX}].
 */

Wallet.prototype.createTX = function createTX(options, callback, force) {
  var self = this;
  var outputs = options.outputs;
  var i, tx;

  if (!Array.isArray(outputs) || outputs.length === 0)
    return callback(new Error('No outputs.'));

  // Create mutable tx
  tx = bcoin.mtx();

  // Add the outputs
  for (i = 0; i < outputs.length; i++) {
    try {
      tx.addOutput(outputs[i]);
    } catch (e) {
      callback = utils.asyncify(callback);
      return callback(e);
    }
  }

  // Fill the inputs with unspents
  this.fund(tx, options, function(err) {
    if (err)
      return callback(err);

    // Sort members a la BIP69
    tx.sortMembers();

    // Set the locktime to target value or
    // `height - whatever` to avoid fee sniping.
    // if (options.locktime != null)
    //   tx.setLocktime(options.locktime);
    // else
    //   tx.avoidFeeSniping(self.db.height);

    if (!tx.isSane())
      return callback(new Error('CheckTransaction failed.'));

    if (!tx.checkInputs(self.db.height))
      return callback(new Error('CheckInputs failed.'));

    self.scriptInputs(tx, function(err, total) {
      if (err)
        return callback(err);

      if (total === 0)
        return callback(new Error('scriptInputs failed.'));

      callback(null, tx);
    });
  }, force);
};

/**
 * Build a transaction, fill it with outputs and inputs,
 * sort the members according to BIP69, set locktime,
 * sign and broadcast. Doing this all in one go prevents
 * coins from being double spent.
 * @param {Object} options - See {@link Wallet#fund options}.
 * @param {Object[]} options.outputs - See {@link MTX#addOutput}.
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Wallet.prototype.send = function send(options, callback) {
  var self = this;

  callback = this._lockFund(send, [options, callback]);

  if (!callback)
    return;

  this.createTX(options, function(err, tx) {
    if (err)
      return callback(err);

    self.sign(tx, function(err) {
      if (err)
        return callback(err);

      if (!tx.isSigned())
        return callback(new Error('TX could not be fully signed.'));

      tx = tx.toTX();

      self.addTX(tx, function(err) {
        if (err)
          return callback(err);

        self.logger.debug('Sending wallet tx (%s): %s', self.id, tx.rhash);
        self.db.emit('send', tx);

        callback(null, tx);
      });
    });
  }, true);
};

/**
 * Resend pending wallet transactions.
 * @param {Function} callback
 */

Wallet.prototype.resend = function resend(callback) {
  var self = this;
  var i;

  this.getUnconfirmed(function(err, txs) {
    if (err)
      return callback(err);

    if (txs.length > 0)
      self.logger.info('Rebroadcasting %d transactions.', txs.length);

    for (i = 0; i < txs.length; i++)
      self.db.emit('send', txs[i]);

    callback();
  });
};

/**
 * Derive necessary addresses for signing a transaction.
 * @param {TX|Input} tx
 * @param {Number?} index - Input index.
 * @param {Function} callback - Returns [Error, {@link KeyRing}[]].
 */

Wallet.prototype.deriveInputs = function deriveInputs(tx, callback) {
  var self = this;
  var rings = [];
  var ring;

  this.getInputPaths(tx, function(err, paths) {
    if (err)
      return callback(err);

    utils.forEachSerial(paths, function(path, next) {
      self.getAccount(path.account, function(err, account) {
        if (err)
          return next(err);

        if (!account)
          return next();

        ring = account.deriveAddress(path.change, path.index);
        rings.push(ring);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      callback(null, rings);
    });
  });
};

/**
 * Retrieve a single keyring by address.
 * @param {Address|Hash} hash
 * @param {Function} callback
 */

Wallet.prototype.getKeyring = function getKeyring(address, callback) {
  var self = this;
  var hash = bcoin.address.getHash(address, 'hex');
  var ring;

  if (!hash)
    return callback();

  this.getPath(hash, function(err, path) {
    if (err)
      return callback(err);

    if (!path)
      return callback();

    self.getAccount(path.account, function(err, account) {
      if (err)
        return callback(err);

      if (!account)
        return callback();

      ring = account.deriveAddress(path.change, path.index);

      callback(null, ring);
    });
  });
};

/**
 * Map input addresses to paths.
 * @param {TX|Input} tx
 * @param {Function} callback - Returns [Error, {@link Path}[]].
 */

Wallet.prototype.getInputPaths = function getInputPaths(tx, callback) {
  var self = this;
  var paths = [];
  var hashes = [];
  var hash;

  function done() {
    utils.forEachSerial(hashes, function(hash, next, i) {
      self.getPath(hash, function(err, path) {
        if (err)
          return next(err);

        if (path)
          paths.push(path);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);
      return callback(null, paths);
    });
  }

  if (tx instanceof bcoin.input) {
    if (!tx.coin)
      return callback(new Error('Not all coins available.'));
    hash = tx.coin.getHash('hex');
    if (hash)
      hashes.push(hash);
    return done();
  }

  this.fillCoins(tx, function(err) {
    if (err)
      return callback(err);

    if (!tx.hasCoins())
      return callback(new Error('Not all coins available.'));

    hashes = tx.getInputHashes('hex');
    done();
  });
};

/**
 * Map output addresses to paths.
 * @param {TX|Output} tx
 * @param {Function} callback - Returns [Error, {@link Path}[]].
 */

Wallet.prototype.getOutputPaths = function getOutputPaths(tx, callback) {
  var self = this;
  var paths = [];
  var hashes = [];
  var hash;

  if (tx instanceof bcoin.output) {
    hash = tx.getHash('hex');
    if (hash)
      hashes.push(hash);
  } else {
    hashes = tx.getOutputHashes('hex');
  }

  utils.forEachSerial(hashes, function(hash, next, i) {
    self.getPath(hash, function(err, path) {
      if (err)
        return next(err);

      if (path)
        paths.push(path);

      next();
    });
  }, function(err) {
    if (err)
      return callback(err);
    callback(null, paths);
  });
};

/**
 * Sync address depths based on a transaction's outputs.
 * This is used for deriving new addresses when
 * a confirmed transaction is seen.
 * @param {PathInfo} info
 * @param {Function} callback - Returns [Errr, Boolean]
 * (true if new addresses were allocated).
 */

Wallet.prototype.syncOutputDepth = function syncOutputDepth(info, callback) {
  var self = this;
  var receive = [];
  var accounts = {};
  var i, path;

  callback = this._lockWrite(syncOutputDepth, [info, callback]);

  if (!callback)
    return;

  this.start();

  for (i = 0; i < info.paths.length; i++) {
    path = info.paths[i];

    if (!accounts[path.account])
      accounts[path.account] = [];

    accounts[path.account].push(path);
  }

  accounts = utils.values(accounts);

  utils.forEachSerial(accounts, function(paths, next) {
    var account = paths[0].account;
    var receiveDepth = -1;
    var changeDepth = -1;

    for (i = 0; i < paths.length; i++) {
      path = paths[i];

      if (path.change) {
        if (path.index > changeDepth)
          changeDepth = path.index;
      } else {
        if (path.index > receiveDepth)
          receiveDepth = path.index;
      }
    }

    receiveDepth += 2;
    changeDepth += 2;

    self.getAccount(account, function(err, account) {
      if (err)
        return next(err);

      if (!account)
        return next();

      account.setDepth(receiveDepth, changeDepth, function(err, rcv, chng) {
        if (err)
          return next(err);

        if (rcv)
          receive.push(rcv);

        next();
      });
    });
  }, function(err) {
    if (err) {
      self.drop();
      return callback(err);
    }

    if (receive.length > 0) {
      self.db.emit('address', self.id, receive);
      self.emit('address', receive);
    }

    self.commit(function(err) {
      if (err)
        return callback(err);
      callback(null, receive);
    });
  });
};

/**
 * Emit balance events after a tx is saved.
 * @private
 * @param {TX} tx
 * @param {PathInfo} info
 * @param {Function} callback
 */

Wallet.prototype.updateBalances = function updateBalances(callback) {
  var self = this;

  if (this.db.listeners('balance').length === 0
      && this.listeners('balance').length === 0) {
    return callback();
  }

  this.getBalance(function(err, balance) {
    if (err)
      return callback(err);

    self.db.emit('balance', self.id, balance);
    self.emit('balance', balance);

    callback();
  });
};

/**
 * Derive new addresses and emit balance.
 * @private
 * @param {TX} tx
 * @param {PathInfo} info
 * @param {Function} callback
 */

Wallet.prototype.handleTX = function handleTX(info, callback) {
  var self = this;
  this.syncOutputDepth(info, function(err) {
    if (err)
      return callback(err);

    self.updateBalances(callback);
  });
};

/**
 * Get a redeem script or witness script by hash.
 * @param {Hash} hash - Can be a ripemd160 or a sha256.
 * @returns {Script}
 */

Wallet.prototype.getRedeem = function getRedeem(hash, callback) {
  var self = this;
  var ring;

  if (typeof hash === 'string')
    hash = new Buffer(hash, 'hex');

  this.getPath(hash.toString('hex'), function(err, path) {
    if (err)
      return callback(err);

    if (!path)
      return callback();

    self.getAccount(path.account, function(err, account) {
      if (err)
        return callback(err);

      if (!account)
        return callback();

      ring = account.deriveAddress(path.change, path.index);

      if (ring.program && hash.length === 20) {
        if (utils.equal(hash, ring.programHash))
          return callback(null, ring.program);
      }

      callback(null, ring.script);
    });
  });
};

/**
 * Build input scripts templates for a transaction (does not
 * sign, only creates signature slots). Only builds scripts
 * for inputs that are redeemable by this wallet.
 * @param {MTX} tx
 * @param {Number?} index - Index of input. If not present,
 * it will attempt to sign all redeemable inputs.
 * @param {Function} callback - Returns [Error, Number]
 * (total number of scripts built).
 */

Wallet.prototype.scriptInputs = function scriptInputs(tx, callback) {
  var total = 0;
  var i;

  this.deriveInputs(tx, function(err, rings) {
    if (err)
      return callback(err);

    for (i = 0; i < rings.length; i++)
      total += rings[i].scriptInputs(tx);

    callback(null, total);
  });
};

/**
 * Build input scripts and sign inputs for a transaction. Only attempts
 * to build/sign inputs that are redeemable by this wallet.
 * @param {MTX} tx
 * @param {Object|String|Buffer} options - Options or passphrase.
 * @param {Number?} options.index - Index of input. If not present,
 * it will attempt to build and sign all redeemable inputs.
 * @param {SighashType?} options.type
 * @param {Function} callback - Returns [Error, Number] (total number
 * of inputs scripts built and signed).
 */

Wallet.prototype.sign = function sign(tx, options, callback) {
  var self = this;
  var passphrase, timeout, index, type;

  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  if (typeof options === 'string' || Buffer.isBuffer(options))
    options = { passphrase: options };

  passphrase = options.passphrase;
  timeout = options.timeout;
  index = options.index;
  type = options.type;

  this.deriveInputs(tx, function(err, rings) {
    if (err)
      return callback(err);

    self.unlock(passphrase, timeout, function(err, master) {
      if (err)
        return callback(err);

      self._sign(rings, master, tx, index, type, callback);
    });
  });
};

/**
 * Sign a transaction.
 * @param {KeyRing[]} rings
 * @param {HDPrivateKey} master
 * @param {MTX} tx
 * @param {Number?} index
 * @param {SighashType?} type
 */

Wallet.sign = function sign(rings, master, tx, index, type) {
  var total = 0;
  var i, ring, key;

  for (i = 0; i < rings.length; i++) {
    ring = rings[i];
    key = ring.derive(master);
    assert(utils.equal(key.getPublicKey(), ring.key));
    total += ring.sign(tx, key, index, type);
  }

  return total;
};

/**
 * Sign a transaction asynchronously.
 * @param {KeyRing[]} rings
 * @param {HDPrivateKey} master
 * @param {MTX} tx
 * @param {Number?} index
 * @param {SighashType?} type
 * @param {Function} callback - Returns [Error, Number] (total number
 * of inputs scripts built and signed).
 */

Wallet.prototype._sign = function _sign(rings, master, tx, index, type, callback) {
  var result;

  if (!this.workerPool) {
    callback = utils.asyncify(callback);
    try {
      result = Wallet.sign(rings, master, tx, index, type);
    } catch (e) {
      return callback(e);
    }
    return callback(null, result);
  }

  this.workerPool.sign(rings, master, tx, index, type, callback);
};

/**
 * Fill transaction with coins (accesses db).
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Wallet.prototype.fillCoins = function fillCoins(tx, callback) {
  return this.tx.fillCoins(tx, callback);
};

/**
 * Fill transaction with historical coins (accesses db).
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Wallet.prototype.fillHistory = function fillHistory(tx, callback) {
  return this.tx.fillHistory(tx, callback);
};

/**
 * Fill transaction with historical coins (accesses db).
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Wallet.prototype.toDetails = function toDetails(tx, callback) {
  return this.tx.toDetails(tx, callback);
};

/**
 * Fill transaction with historical coins (accesses db).
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Wallet.prototype.getDetails = function getDetails(tx, callback) {
  return this.tx.getDetails(tx, callback);
};

/**
 * Get a coin from the wallet (accesses db).
 * @param {Hash} hash
 * @param {Number} index
 * @param {Function} callback - Returns [Error, {@link Coin}].
 */

Wallet.prototype.getCoin = function getCoin(hash, index, callback) {
  return this.tx.getCoin(hash, index, callback);
};

/**
 * Get a transaction from the wallet (accesses db).
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Wallet.prototype.getTX = function getTX(hash, callback) {
  return this.tx.getTX(hash, callback);
};

/**
 * Add a transaction to the wallets TX history (accesses db).
 * @param {TX} tx
 * @param {Function} callback
 */

Wallet.prototype.addTX = function addTX(tx, callback) {
  this.db.addTX(tx, callback);
};

/**
 * Get all transactions in transaction history (accesses db).
 * @param {(String|Number)?} account
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

Wallet.prototype.getHistory = function getHistory(account, callback) {
  this._getIndex(account, callback, function(account, callback) {
    this.tx.getHistory(account, callback);
  });
};

/**
 * Get all available coins (accesses db).
 * @param {(String|Number)?} account
 * @param {Function} callback - Returns [Error, {@link Coin}[]].
 */

Wallet.prototype.getCoins = function getCoins(account, callback) {
  this._getIndex(account, callback, function(account, callback) {
    this.tx.getCoins(account, callback);
  });
};

/**
 * Get all pending/unconfirmed transactions (accesses db).
 * @param {(String|Number)?} account
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

Wallet.prototype.getUnconfirmed = function getUnconfirmed(account, callback) {
  this._getIndex(account, callback, function(account, callback) {
    this.tx.getUnconfirmed(account, callback);
  });
};

/**
 * Get wallet balance (accesses db).
 * @param {(String|Number)?} account
 * @param {Function} callback - Returns [Error, {@link Balance}].
 */

Wallet.prototype.getBalance = function getBalance(account, callback) {
  this._getIndex(account, callback, function(account, callback) {
    this.tx.getBalance(account, callback);
  });
};

/**
 * Get last timestamp and height this wallet was active
 * at (accesses db). Useful for resetting the chain
 * to a certain height when in SPV mode.
 * @param {(String|Number)?} account
 * @param {Function} callback - Returns [Error, Number(ts), Number(height)].
 */

Wallet.prototype.getLastTime = function getLastTime(account, callback) {
  this._getIndex(account, callback, function(account, callback) {
    this.tx.getLastTime(account, callback);
  });
};

/**
 * Get a range of transactions between two timestamps (accesses db).
 * @param {(String|Number)?} account
 * @param {Object} options
 * @param {Number} options.start
 * @param {Number} options.end
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

Wallet.prototype.getRange = function getRange(account, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = account;
    account = null;
  }
  this._getIndex(account, callback, function(account, callback) {
    this.tx.getRange(account, options, callback);
  });
};

/**
 * Get the last N transactions (accesses db).
 * @param {(String|Number)?} account
 * @param {Number} limit
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

Wallet.prototype.getLast = function getLast(account, limit, callback) {
  if (typeof limit === 'function') {
    callback = limit;
    limit = account;
    account = null;
  }
  this._getIndex(account, callback, function(account, callback) {
    this.tx.getLast(account, limit, callback);
  });
};

/**
 * Zap stale TXs from wallet (accesses db).
 * @param {(Number|String)?} account
 * @param {Number} age - Age threshold (unix time, default=72 hours).
 * @param {Function} callback - Returns [Error].
 */

Wallet.prototype.zap = function zap(account, age, callback) {
  if (typeof age === 'function') {
    callback = age;
    age = account;
    account = null;
  }
  this._getIndex(account, callback, function(account, callback) {
    this.tx.zap(account, age, callback);
  });
};

/**
 * Abandon transaction (accesses db).
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error].
 */

Wallet.prototype.abandon = function abandon(hash, callback) {
  this.tx.abandon(hash, callback);
};

/**
 * Resolve account index.
 * @private
 * @param {(Number|String)?} account
 * @param {Function} errback - Returns [Error].
 * @param {Function} callback
 */

Wallet.prototype._getIndex = function _getIndex(account, errback, callback) {
  var self = this;

  if (typeof account === 'function') {
    errback = account;
    account = null;
  }

  if (account == null)
    return callback.call(this, null, errback);

  this.db.getAccountIndex(this.wid, account, function(err, index) {
    if (err)
      return errback(err);

    if (index === -1)
      return errback(new Error('Account not found.'));

    callback.call(self, index, errback);
  });
};

/**
 * Get public key for current receiving address.
 * @param {String?} enc - `"hex"` or `null`.
 * @returns {Buffer}
 */

Wallet.prototype.getPublicKey = function getPublicKey(enc) {
  if (!this.receiveAddress)
    return;
  return this.receiveAddress.getPublicKey(enc);
};

/**
 * Get redeem script for current receiving address.
 * @returns {Script}
 */

Wallet.prototype.getScript = function getScript() {
  if (!this.receiveAddress)
    return;
  return this.receiveAddress.getScript();
};

/**
 * Get scripthash for current receiving address.
 * @param {String?} enc - `"hex"` or `null`.
 * @returns {Buffer}
 */

Wallet.prototype.getScriptHash = function getScriptHash(enc) {
  if (!this.receiveAddress)
    return;
  return this.receiveAddress.getScriptHash(enc);
};

/**
 * Get ripemd160 scripthash for current receiving address.
 * @param {String?} enc - `"hex"` or `null`.
 * @returns {Buffer}
 */

Wallet.prototype.getScriptHash160 = function getScriptHash160(enc) {
  if (!this.receiveAddress)
    return;
  return this.receiveAddress.getScriptHash160(enc);
};

/**
 * Get sha256 scripthash for current receiving address.
 * @param {String?} enc - `"hex"` or `null`.
 * @returns {Buffer}
 */

Wallet.prototype.getScriptHash256 = function getScriptHash256(enc) {
  if (!this.receiveAddress)
    return;
  return this.receiveAddress.getScriptHash256(enc);
};

/**
 * Get scripthash address for current receiving address.
 * @param {String?} enc - `"base58"` or `null`.
 * @returns {Address|Base58Address}
 */

Wallet.prototype.getScriptAddress = function getScriptAddress(enc) {
  if (!this.receiveAddress)
    return;
  return this.receiveAddress.getScriptAddress(enc);
};

/**
 * Get witness program for current receiving address.
 * @returns {Buffer}
 */

Wallet.prototype.getProgram = function getProgram() {
  if (!this.receiveAddress)
    return;
  return this.receiveAddress.getProgram();
};

/**
 * Get current receiving address' ripemd160 program
 * scripthash (for witness programs behind a scripthash).
 * @param {String?} enc - `"hex"` or `null`.
 * @returns {Buffer}
 */

Wallet.prototype.getProgramHash = function getProgramHash(enc) {
  if (!this.receiveAddress)
    return;
  return this.receiveAddress.getProgramHash(enc);
};

/**
 * Get current receiving address'
 * scripthash address for witness program.
 * @param {String?} enc - `"base58"` or `null`.
 * @returns {Address|Base58Address}
 */

Wallet.prototype.getProgramAddress = function getProgramAddress(enc) {
  if (!this.receiveAddress)
    return;
  return this.receiveAddress.getProgramAddress(enc);
};

/**
 * Get public key hash for current receiving address.
 * @param {String?} enc - `"hex"` or `null`.
 * @returns {Buffer}
 */

Wallet.prototype.getKeyHash = function getKeyHash(enc) {
  if (!this.receiveAddress)
    return;
  return this.receiveAddress.getKeyHash(enc);
};

/**
 * Get pubkeyhash address for current receiving address.
 * @param {String?} enc - `"base58"` or `null`.
 * @returns {Address|Base58Address}
 */

Wallet.prototype.getKeyAddress = function getKeyAddress(enc) {
  if (!this.receiveAddress)
    return;
  return this.receiveAddress.getKeyAddress(enc);
};

/**
 * Get hash for current receiving address.
 * @param {String?} enc - `"hex"` or `null`.
 * @returns {Buffer}
 */

Wallet.prototype.getHash = function getHash(enc) {
  if (!this.receiveAddress)
    return;
  return this.receiveAddress.getHash(enc);
};

/**
 * Get base58 address for current receiving address.
 * @param {String?} enc - `"base58"` or `null`.
 * @returns {Address|Base58Address}
 */

Wallet.prototype.getAddress = function getAddress(enc) {
  if (!this.receiveAddress)
    return;
  return this.receiveAddress.getAddress(enc);
};

Wallet.prototype.__defineGetter__('publicKey', function() {
  return this.getPublicKey();
});

Wallet.prototype.__defineGetter__('script', function() {
  return this.getScript();
});

Wallet.prototype.__defineGetter__('scriptHash', function() {
  return this.getScriptHash();
});

Wallet.prototype.__defineGetter__('scriptHash160', function() {
  return this.getScriptHash160();
});

Wallet.prototype.__defineGetter__('scriptHash256', function() {
  return this.getScriptHash256();
});

Wallet.prototype.__defineGetter__('scriptAddress', function() {
  return this.getScriptAddress();
});

Wallet.prototype.__defineGetter__('program', function() {
  return this.getProgram();
});

Wallet.prototype.__defineGetter__('programHash', function() {
  return this.getProgramHash();
});

Wallet.prototype.__defineGetter__('programAddress', function() {
  return this.getProgramAddress();
});

Wallet.prototype.__defineGetter__('keyHash', function() {
  return this.getKeyHash();
});

Wallet.prototype.__defineGetter__('keyAddress', function() {
  return this.getKeyAddress();
});

Wallet.prototype.__defineGetter__('hash', function() {
  return this.getHash();
});

Wallet.prototype.__defineGetter__('address', function() {
  return this.getAddress();
});

Wallet.prototype.__defineGetter__('receiveDepth', function() {
  if (!this.account)
    return -1;
  return this.account.receiveDepth;
});

Wallet.prototype.__defineGetter__('changeDepth', function() {
  if (!this.account)
    return -1;
  return this.account.changeDepth;
});

Wallet.prototype.__defineGetter__('accountKey', function() {
  if (!this.account)
    return;
  return this.account.accountKey;
});

Wallet.prototype.__defineGetter__('receiveAddress', function() {
  if (!this.account)
    return;
  return this.account.receiveAddress;
});

Wallet.prototype.__defineGetter__('changeAddress', function() {
  if (!this.account)
    return;
  return this.account.changeAddress;
});

/**
 * Convert the wallet to a more inspection-friendly object.
 * @returns {Object}
 */

Wallet.prototype.inspect = function inspect() {
  return {
    wid: this.wid,
    id: this.id,
    network: this.network.type,
    initialized: this.initialized,
    accountDepth: this.accountDepth,
    token: this.token.toString('hex'),
    tokenDepth: this.tokenDepth,
    master: this.master,
    account: this.account
  };
};

/**
 * Convert the wallet to an object suitable for
 * serialization. Will automatically encrypt the
 * master key based on the `passphrase` option.
 * @returns {Object}
 */

Wallet.prototype.toJSON = function toJSON() {
  return {
    network: this.network.type,
    wid: this.wid,
    id: this.id,
    initialized: this.initialized,
    accountDepth: this.accountDepth,
    token: this.token.toString('hex'),
    tokenDepth: this.tokenDepth,
    master: this.master.toJSON(),
    account: this.account ? this.account.toJSON() : null
  };
};

/**
 * Inject properties from json object.
 * @private
 * @param {Object} json
 */

Wallet.prototype.fromJSON = function fromJSON(json) {
  assert(utils.isNumber(json.wid));
  assert(typeof json.initialized === 'boolean');
  assert(utils.isName(json.id), 'Bad wallet ID.');
  assert(utils.isNumber(json.accountDepth));
  assert(typeof json.token === 'string');
  assert(json.token.length === 64);
  assert(utils.isNumber(json.tokenDepth));

  this.network = bcoin.network.get(json.network);
  this.wid = json.wid;
  this.id = json.id;
  this.initialized = json.initialized;
  this.accountDepth = json.accountDepth;
  this.token = new Buffer(json.token, 'hex');
  this.master = MasterKey.fromJSON(json.master);

  return this;
};

/**
 * Serialize the wallet.
 * @returns {Buffer}
 */

Wallet.prototype.toRaw = function toRaw(writer) {
  var p = new BufferWriter(writer);

  p.writeU32(this.network.magic);
  p.writeU32(this.wid);
  p.writeVarString(this.id, 'utf8');
  p.writeU8(this.initialized ? 1 : 0);
  p.writeU32(this.accountDepth);
  p.writeBytes(this.token);
  p.writeU32(this.tokenDepth);
  p.writeVarBytes(this.master.toRaw());

  if (!writer)
    p = p.render();

  return p;
};

/**
 * Inject properties from serialized data.
 * @private
 * @param {Buffer} data
 */

Wallet.prototype.fromRaw = function fromRaw(data) {
  var p = new BufferReader(data);
  this.network = bcoin.network.fromMagic(p.readU32());
  this.wid = p.readU32();
  this.id = p.readVarString('utf8');
  this.initialized = p.readU8() === 1;
  this.accountDepth = p.readU32();
  this.token = p.readBytes(32);
  this.tokenDepth = p.readU32();
  this.master = MasterKey.fromRaw(p.readVarBytes());
  return this;
};

/**
 * Instantiate a wallet from serialized data.
 * @param {Buffer} data
 * @returns {Wallet}
 */

Wallet.fromRaw = function fromRaw(db, data) {
  return new Wallet(db).fromRaw(data);
};

/**
 * Instantiate a Wallet from a
 * jsonified wallet object.
 * @param {Object} json - The jsonified wallet object.
 * @returns {Wallet}
 */

Wallet.fromJSON = function fromJSON(db, json) {
  return new Wallet(db).fromJSON(json);
};

/**
 * Test an object to see if it is a Wallet.
 * @param {Object} obj
 * @returns {Boolean}
 */

Wallet.isWallet = function isWallet(obj) {
  return obj
    && typeof obj.accountDepth === 'number'
    && obj.scriptInputs === 'function';
};

/**
 * Represents a BIP44 Account belonging to a {@link Wallet}.
 * Note that this object does not enforce locks. Any method
 * that does a write is internal API only and will lead
 * to race conditions if used elsewhere.
 * @exports Account
 * @constructor
 * @param {Object} options
 * @param {WalletDB} options.db
 * @param {HDPublicKey} options.accountKey
 * @param {Boolean?} options.witness - Whether to use witness programs.
 * @param {Number} options.accountIndex - The BIP44 account index.
 * @param {Number?} options.receiveDepth - The index of the _next_ receiving
 * address.
 * @param {Number?} options.changeDepth - The index of the _next_ change
 * address.
 * @param {String?} options.type - Type of wallet (pubkeyhash, multisig)
 * (default=pubkeyhash).
 * @param {Number?} options.m - `m` value for multisig.
 * @param {Number?} options.n - `n` value for multisig.
 * @param {String?} options.wid - Wallet ID
 * @param {String?} options.name - Account name
 */

function Account(db, options) {
  if (!(this instanceof Account))
    return new Account(db, options);

  assert(db, 'Database is required.');

  this.db = db;
  this.network = db.network;
  this.lookahead = Account.MAX_LOOKAHEAD;

  this.receiveAddress = null;
  this.changeAddress = null;

  this.wid = 0;
  this.id = null;
  this.name = null;
  this.witness = this.db.options.witness;
  this.accountKey = null;
  this.accountIndex = 0;
  this.receiveDepth = 0;
  this.changeDepth = 0;
  this.type = keyTypes.PUBKEYHASH;
  this.m = 1;
  this.n = 1;
  this.keys = [];
  this.initialized = false;

  if (options)
    this.fromOptions(options);
}

/**
 * Inject properties from options object.
 * @private
 * @param {Object} options
 */

Account.prototype.fromOptions = function fromOptions(options) {
  var i;

  assert(options, 'Options are required.');
  assert(utils.isNumber(options.wid));
  assert(utils.isName(options.id), 'Bad Wallet ID.');
  assert(bcoin.hd.isHD(options.accountKey), 'Account key is required.');
  assert(utils.isNumber(options.accountIndex), 'Account index is required.');

  this.wid = options.wid;
  this.id = options.id;

  if (options.name != null) {
    assert(utils.isName(options.name), 'Bad account name.');
    this.name = options.name;
  }

  if (options.witness != null) {
    assert(typeof options.witness === 'boolean');
    this.witness = options.witness;
  }

  this.accountKey = options.accountKey;

  if (options.accountIndex != null) {
    assert(utils.isNumber(options.accountIndex));
    this.accountIndex = options.accountIndex;
  }

  if (options.receiveDepth != null) {
    assert(utils.isNumber(options.receiveDepth));
    this.receiveDepth = options.receiveDepth;
  }

  if (options.changeDepth != null) {
    assert(utils.isNumber(options.changeDepth));
    this.changeDepth = options.changeDepth;
  }

  if (options.type != null) {
    if (typeof options.type === 'string') {
      this.type = keyTypes[options.type.toUpperCase()];
      assert(this.type != null);
    } else {
      assert(typeof options.type === 'number');
      this.type = options.type;
      assert(keyTypesByVal[this.type]);
    }
  }

  if (options.m != null) {
    assert(utils.isNumber(options.m));
    this.m = options.m;
  }

  if (options.n != null) {
    assert(utils.isNumber(options.n));
    this.n = options.n;
  }

  if (options.initialized != null) {
    assert(typeof options.initialized === 'boolean');
    this.initialized = options.initialized;
  }

  if (this.n > 1)
    this.type = keyTypes.MULTISIG;

  if (this.m < 1 || this.m > this.n)
    throw new Error('m ranges between 1 and n');

  if (!this.name)
    this.name = this.accountIndex + '';

  this.pushKey(this.accountKey);

  if (options.keys) {
    assert(Array.isArray(options.keys));
    for (i = 0; i < options.keys.length; i++)
      this.pushKey(options.keys[i]);
  }

  return this;
};

/**
 * Instantiate account from options.
 * @param {WalletDB} db
 * @param {Object} options
 * @returns {Account}
 */

Account.fromOptions = function fromOptions(db, options) {
  return new Account(db).fromOptions(options);
};

/*
 * Default address lookahead.
 * @const {Number}
 */

Account.MAX_LOOKAHEAD = 5;

/**
 * Attempt to intialize the account (generating
 * the first addresses along with the lookahead
 * addresses). Called automatically from the
 * walletdb.
 * @param {Function} callback
 */

Account.prototype.init = function init(callback) {
  // Waiting for more keys.
  if (this.keys.length !== this.n) {
    assert(!this.initialized);
    this.save();
    return callback();
  }

  assert(this.receiveDepth === 0);
  assert(this.changeDepth === 0);

  this.initialized = true;
  this.setDepth(1, 1, callback);
};

/**
 * Open the account (done after retrieval).
 * @param {Function} callback
 */

Account.prototype.open = function open(callback) {
  if (!this.initialized)
    return callback();

  this.receiveAddress = this.deriveReceive(this.receiveDepth - 1);
  this.changeAddress = this.deriveChange(this.changeDepth - 1);

  callback();
};

/**
 * Add a public account key to the account (multisig).
 * Does not update the database.
 * @param {HDPublicKey} key - Account (bip44)
 * key (can be in base58 form).
 * @throws Error on non-hdkey/non-accountkey.
 */

Account.prototype.pushKey = function pushKey(key) {
  var index = -1;
  var i;

  assert(key, 'Key required.');

  if (key.accountKey)
    key = key.accountKey;

  if (bcoin.hd.isExtended(key))
    key = bcoin.hd.fromBase58(key);

  if (key.hdPublicKey)
    key = key.hdPublicKey;

  if (!bcoin.hd.isHD(key))
    throw new Error('Must add HD keys to wallet.');

  if (!key.isAccount44())
    throw new Error('Must add HD account keys to BIP44 wallet.');

  for (i = 0; i < this.keys.length; i++) {
    if (this.keys[i].equal(key)) {
      index = i;
      break;
    }
  }

  if (index !== -1)
    return false;

  if (this.keys.length === this.n)
    throw new Error('Cannot add more keys.');

  this.keys.push(key);

  return true;
};

/**
 * Remove a public account key to the account (multisig).
 * Does not update the database.
 * @param {HDPublicKey} key - Account (bip44)
 * key (can be in base58 form).
 * @throws Error on non-hdkey/non-accountkey.
 */

Account.prototype.spliceKey = function spliceKey(key) {
  var index = -1;
  var i;

  assert(key, 'Key required.');

  if (key.accountKey)
    key = key.accountKey;

  if (bcoin.hd.isExtended(key))
    key = bcoin.hd.fromBase58(key);

  if (key.hdPublicKey)
    key = key.hdPublicKey;

  if (!bcoin.hd.isHD(key))
    throw new Error('Must add HD keys to wallet.');

  if (!key.isAccount44())
    throw new Error('Must add HD account keys to BIP44 wallet.');

  for (i = 0; i < this.keys.length; i++) {
    if (this.keys[i].equal(key)) {
      index = i;
      break;
    }
  }

  if (index === -1)
    return false;

  if (this.keys.length === this.n)
    throw new Error('Cannot remove key.');

  this.keys.splice(index, 1);

  return true;
};

/**
 * Add a public account key to the account (multisig).
 * Saves the key in the wallet database.
 * @param {HDPublicKey} key
 * @param {Function} callback
 */

Account.prototype.addKey = function addKey(key, callback) {
  var self = this;
  var result = false;

  try {
    result = this.pushKey(key);
  } catch (e) {
    return callback(e);
  }

  this._checkKeys(function(err, exists) {
    if (err)
      return callback(err);

    if (exists) {
      self.spliceKey(key);
      return callback(new Error('Cannot add a key from another account.'));
    }

    // Try to initialize again.
    self.init(function(err) {
      if (err)
        return callback(err);

      callback(null, result);
    });
  });
};

/**
 * Ensure accounts are not sharing keys.
 * @private
 * @param {Function} callback
 */

Account.prototype._checkKeys = function _checkKeys(callback) {
  var self = this;
  var ring, hash;

  if (this.initialized || this.type !== keyTypes.MULTISIG)
    return callback(null, false);

  if (this.keys.length !== this.n)
    return callback(null, false);

  ring = this.deriveReceive(0);
  hash = ring.getScriptHash('hex');

  this.db.getAddressPaths(hash, function(err, paths) {
    if (err)
      return callback(err);

    if (!paths)
      return callback(null, false);

    callback(null, paths[self.wid] != null);
  });
};

/**
 * Remove a public account key from the account (multisig).
 * Remove the key from the wallet database.
 * @param {HDPublicKey} key
 * @param {Function} callback
 */

Account.prototype.removeKey = function removeKey(key, callback) {
  var result = false;

  try {
    result = this.spliceKey(key);
  } catch (e) {
    return callback(e);
  }

  this.save();

  callback(null, result);
};

/**
 * Create a new receiving address (increments receiveDepth).
 * @returns {KeyRing}
 */

Account.prototype.createReceive = function createReceive(callback) {
  return this.createAddress(false, callback);
};

/**
 * Create a new change address (increments receiveDepth).
 * @returns {KeyRing}
 */

Account.prototype.createChange = function createChange(callback) {
  return this.createAddress(true, callback);
};

/**
 * Create a new address (increments depth).
 * @param {Boolean} change
 * @param {Function} callback - Returns [Error, {@link KeyRing}].
 */

Account.prototype.createAddress = function createAddress(change, callback) {
  var self = this;
  var ring, lookahead;

  if (typeof change === 'function') {
    callback = change;
    change = false;
  }

  if (change) {
    ring = this.deriveChange(this.changeDepth);
    lookahead = this.deriveChange(this.changeDepth + this.lookahead);
    this.changeDepth++;
    this.changeAddress = ring;
  } else {
    ring = this.deriveReceive(this.receiveDepth);
    lookahead = this.deriveReceive(this.receiveDepth + this.lookahead);
    this.receiveDepth++;
    this.receiveAddress = ring;
  }

  this.saveAddress([ring, lookahead], function(err) {
    if (err)
      return callback(err);

    self.save();

    callback(null, ring);
  });
};

/**
 * Derive a receiving address at `index`. Do not increment depth.
 * @param {Number} index
 * @returns {KeyRing}
 */

Account.prototype.deriveReceive = function deriveReceive(index) {
  return this.deriveAddress(false, index);
};

/**
 * Derive a change address at `index`. Do not increment depth.
 * @param {Number} index
 * @returns {KeyRing}
 */

Account.prototype.deriveChange = function deriveChange(index) {
  return this.deriveAddress(true, index);
};

/**
 * Derive an address at `index`. Do not increment depth.
 * @param {Boolean} change - Whether the address on the change branch.
 * @param {Number} index
 * @returns {KeyRing}
 */

Account.prototype.deriveAddress = function deriveAddress(change, index) {
  var keys = [];
  var i, key, shared;

  change = +change;

  key = this.accountKey.derive(change).derive(index);

  for (i = 0; i < this.keys.length; i++) {
    shared = this.keys[i];
    shared = shared.derive(change).derive(index);
    keys.push(shared.publicKey);
  }

  return bcoin.keyring.fromAccount(this, key, keys, change, index);
};

/**
 * Save the account to the database. Necessary
 * when address depth and keys change.
 * @param {Function} callback
 */

Account.prototype.save = function save() {
  return this.db.saveAccount(this);
};

/**
 * Save addresses to path map.
 * @param {KeyRing[]} rings
 * @param {Function} callback
 */

Account.prototype.saveAddress = function saveAddress(rings, callback) {
  return this.db.saveAddress(this.wid, rings, callback);
};

/**
 * Set change and receiving depth (depth is the index of the _next_ address).
 * Allocate all addresses up to depth. Note that this also allocates
 * new lookahead addresses.
 * @param {Number} depth
 * @param {Function} callback - Returns [Error, {@link KeyRing}, {@link KeyRing}].
 */

Account.prototype.setDepth = function setDepth(receiveDepth, changeDepth, callback) {
  var self = this;
  var rings = [];
  var i, receive, change;

  if (receiveDepth > this.receiveDepth) {
    for (i = this.receiveDepth; i < receiveDepth; i++) {
      receive = this.deriveReceive(i);
      rings.push(receive);
    }

    for (i = receiveDepth; i < receiveDepth + this.lookahead; i++)
      rings.push(this.deriveReceive(i));

    this.receiveAddress = receive;
    this.receiveDepth = receiveDepth;
  }

  if (changeDepth > this.changeDepth) {
    for (i = this.changeDepth; i < changeDepth; i++) {
      change = this.deriveChange(i);
      rings.push(change);
    }

    for (i = changeDepth; i < changeDepth + this.lookahead; i++)
      rings.push(this.deriveChange(i));

    this.changeAddress = change;
    this.changeDepth = changeDepth;
  }

  if (rings.length === 0)
    return callback();

  this.saveAddress(rings, function(err) {
    if (err)
      return callback(err);

    self.save();

    callback(null, receive, change);
  });
};

/**
 * Convert the account to a more inspection-friendly object.
 * @returns {Object}
 */

Account.prototype.inspect = function inspect() {
  return {
    wid: this.wid,
    name: this.name,
    network: this.network,
    initialized: this.initialized,
    type: keyTypesByVal[this.type].toLowerCase(),
    m: this.m,
    n: this.n,
    address: this.initialized
      ? this.receiveAddress.getAddress()
      : null,
    programAddress: this.initialized
      ? this.receiveAddress.getProgramAddress()
      : null,
    witness: this.witness,
    accountIndex: this.accountIndex,
    receiveDepth: this.receiveDepth,
    changeDepth: this.changeDepth,
    accountKey: this.accountKey.xpubkey,
    keys: this.keys.map(function(key) {
      return key.xpubkey;
    })
  };
};

/**
 * Convert the account to an object suitable for
 * serialization.
 * @returns {Object}
 */

Account.prototype.toJSON = function toJSON() {
  return {
    network: this.network.type,
    wid: this.wid,
    name: this.name,
    initialized: this.initialized,
    type: keyTypesByVal[this.type].toLowerCase(),
    m: this.m,
    n: this.n,
    witness: this.witness,
    accountIndex: this.accountIndex,
    receiveDepth: this.receiveDepth,
    changeDepth: this.changeDepth,
    receiveAddress: this.receiveAddress
      ? this.receiveAddress.getAddress('base58')
      : null,
    programAddress: this.receiveAddress
      ? this.receiveAddress.getProgramAddress('base58')
      : null,
    changeAddress: this.changeAddress
      ? this.changeAddress.getAddress('base58')
      : null,
    accountKey: this.accountKey.xpubkey,
    keys: this.keys.map(function(key) {
      return key.xpubkey;
    })
  };
};

/**
 * Inject properties from json object.
 * @private
 * @param {Object} json
 */

Account.prototype.fromJSON = function fromJSON(json) {
  var i;

  assert.equal(json.network, this.network.type);
  assert(utils.isNumber(json.wid));
  assert(utils.isName(json.id), 'Bad wallet ID.');
  assert(utils.isName(json.name), 'Bad account name.');
  assert(typeof json.initialized === 'boolean');
  assert(typeof json.type === 'string');
  assert(utils.isNumber(json.m));
  assert(utils.isNumber(json.n));
  assert(typeof json.witness === 'boolean');
  assert(utils.isNumber(json.accountIndex));
  assert(utils.isNumber(json.receiveDepth));
  assert(utils.isNumber(json.changeDepth));
  assert(Array.isArray(json.keys));

  this.wid = json.wid;
  this.name = json.name;
  this.initialized = json.initialized;
  this.type = keyTypes[json.type.toUpperCase()];
  this.m = json.m;
  this.n = json.n;
  this.witness = json.witness;
  this.accountIndex = json.accountIndex;
  this.receiveDepth = json.receiveDepth;
  this.changeDepth = json.changeDepth;
  this.accountKey = bcoin.hd.fromBase58(json.accountKey);

  assert(this.type != null);

  for (i = 0; i < json.keys.length; i++)
    this.keys.push(bcoin.hd.fromBase58(json.keys[i]));

  return this;
};

/**
 * Serialize the account.
 * @returns {Buffer}
 */

Account.prototype.toRaw = function toRaw(writer) {
  var p = new BufferWriter(writer);
  var i;

  p.writeU32(this.network.magic);
  p.writeVarString(this.name, 'utf8');
  p.writeU8(this.initialized ? 1 : 0);
  p.writeU8(this.type);
  p.writeU8(this.m);
  p.writeU8(this.n);
  p.writeU8(this.witness ? 1 : 0);
  p.writeU32(this.accountIndex);
  p.writeU32(this.receiveDepth);
  p.writeU32(this.changeDepth);
  p.writeBytes(this.accountKey.toRaw());
  p.writeU8(this.keys.length);

  for (i = 0; i < this.keys.length; i++)
    p.writeBytes(this.keys[i].toRaw());

  if (!writer)
    p = p.render();

  return p;
};

/**
 * Inject properties from serialized data.
 * @private
 * @param {Buffer} data
 * @returns {Object}
 */

Account.prototype.fromRaw = function fromRaw(data) {
  var p = new BufferReader(data);
  var i, count;

  this.network = bcoin.network.fromMagic(p.readU32());
  this.name = p.readVarString('utf8');
  this.initialized = p.readU8() === 1;
  this.type = p.readU8();
  this.m = p.readU8();
  this.n = p.readU8();
  this.witness = p.readU8() === 1;
  this.accountIndex = p.readU32();
  this.receiveDepth = p.readU32();
  this.changeDepth = p.readU32();
  this.accountKey = bcoin.hd.fromRaw(p.readBytes(82));

  assert(keyTypesByVal[this.type]);

  count = p.readU8();

  for (i = 0; i < count; i++)
    this.keys.push(bcoin.hd.fromRaw(p.readBytes(82)));

  return this;
};

/**
 * Instantiate a account from serialized data.
 * @param {WalletDB} data
 * @param {Buffer} data
 * @returns {Account}
 */

Account.fromRaw = function fromRaw(db, data) {
  return new Account(db).fromRaw(data);
};

/**
 * Instantiate a Account from a
 * jsonified account object.
 * @param {WalletDB} db
 * @param {Object} json - The jsonified account object.
 * @returns {Account}
 */

Account.fromJSON = function fromJSON(db, json) {
  return new Account(db).fromJSON(json);
};

/**
 * Test an object to see if it is a Account.
 * @param {Object} obj
 * @returns {Boolean}
 */

Account.isAccount = function isAccount(obj) {
  return obj
    && typeof obj.receiveDepth === 'number'
    && obj.deriveAddress === 'function';
};

/**
 * Master BIP32 key which can exist
 * in a timed out encrypted state.
 * @exports Master
 * @constructor
 * @param {Object} options
 */

function MasterKey(options) {
  if (!(this instanceof MasterKey))
    return new MasterKey(options);

  this.encrypted = false;
  this.iv = null;
  this.ciphertext = null;
  this.key = null;

  this.timer = null;
  this.until = 0;
  this._destroy = this.destroy.bind(this);
  this.locker = new bcoin.locker(this);
}

/**
 * Inject properties from options object.
 * @private
 * @param {Object} options
 */

MasterKey.prototype.fromOptions = function fromOptions(options) {
  assert(options);

  if (options.encrypted != null) {
    assert(typeof options.encrypted === 'boolean');
    this.encrypted = options.encrypted;
  }

  if (options.iv) {
    assert(Buffer.isBuffer(options.iv));
    this.iv = options.iv;
  }

  if (options.ciphertext) {
    assert(Buffer.isBuffer(options.ciphertext));
    this.ciphertext = options.ciphertext;
  }

  if (options.key) {
    assert(bcoin.hd.isHD(options.key));
    this.key = options.key;
  }

  assert(this.encrypted ? !this.key : this.key);

  return this;
};

/**
 * Instantiate master key from options.
 * @returns {MasterKey}
 */

MasterKey.fromOptions = function fromOptions(options) {
  return new MasterKey().fromOptions(options);
};

/**
 * Invoke mutex lock.
 * @private
 */

MasterKey.prototype._lock = function _lock(func, args, force) {
  return this.locker.lock(func, args, force);
};

/**
 * Decrypt the key and set a timeout to destroy decrypted data.
 * @param {Buffer|String} passphrase - Zero this yourself.
 * @param {Number} [timeout=60000] timeout in ms.
 * @param {Function} callback - Returns [Error, {@link HDPrivateKey}].
 */

MasterKey.prototype.unlock = function unlock(passphrase, timeout, callback) {
  var self = this;

  callback = this._lock(unlock, [passphrase, timeout, callback]);

  if (!callback)
    return;

  if (this.key)
    return callback(null, this.key);

  if (!passphrase)
    return callback(new Error('No passphrase.'));

  assert(this.encrypted);

  utils.decrypt(this.ciphertext, passphrase, this.iv, function(err, data) {
    if (err)
      return callback(err);

    try {
      self.key = bcoin.hd.fromExtended(data);
    } catch (e) {
      return callback(e);
    }

    self.start(timeout);

    callback(null, self.key);
  });
};

/**
 * Start the destroy timer.
 * @private
 * @param {Number} [timeout=60000] timeout in ms.
 */

MasterKey.prototype.start = function start(timeout) {
  if (!timeout)
    timeout = 60000;

  this.stop();

  if (timeout === -1)
    return;

  this.until = utils.now() + (timeout / 1000 | 0);
  this.timer = setTimeout(this._destroy, timeout);
};

/**
 * Stop the destroy timer.
 * @private
 */

MasterKey.prototype.stop = function stop() {
  if (this.timer != null) {
    clearTimeout(this.timer);
    this.timer = null;
    this.until = 0;
  }
};

/**
 * Destroy the key by zeroing the
 * privateKey and chainCode. Stop
 * the timer if there is one.
 */

MasterKey.prototype.destroy = function destroy() {
  if (!this.encrypted) {
    assert(this.timer == null);
    assert(this.key);
    return;
  }

  this.stop();

  if (this.key) {
    this.key.destroy(true);
    this.key = null;
  }
};

/**
 * Decrypt the key permanently.
 * @param {Buffer|String} passphrase - Zero this yourself.
 * @param {Function} callback
 */

MasterKey.prototype.decrypt = function decrypt(passphrase, callback) {
  var self = this;

  callback = this._lock(decrypt, [passphrase, callback]);

  if (!callback)
    return;

  if (!this.encrypted) {
    assert(this.key);
    return callback();
  }

  if (!passphrase)
    return callback();

  this.destroy();

  utils.decrypt(this.ciphertext, passphrase, this.iv, function(err, data) {
    if (err)
      return callback(err);

    try {
      self.key = bcoin.hd.fromExtended(data);
    } catch (e) {
      return callback(e);
    }

    self.encrypted = false;
    self.iv = null;
    self.ciphertext = null;

    callback();
  });
};

/**
 * Encrypt the key permanently.
 * @param {Buffer|String} passphrase - Zero this yourself.
 * @param {Function} callback
 */

MasterKey.prototype.encrypt = function encrypt(passphrase, callback) {
  var self = this;
  var data, iv;

  callback = this._lock(encrypt, [passphrase, callback]);

  if (!callback)
    return;

  if (this.encrypted)
    return;

  if (!passphrase)
    return callback();

  data = this.key.toExtended();
  iv = bcoin.ec.random(16);

  this.stop();

  utils.encrypt(data, passphrase, iv, function(err, data) {
    if (err)
      return callback(err);

    self.key = null;
    self.encrypted = true;
    self.iv = iv;
    self.ciphertext = data;

    callback();
  });
};

/**
 * Serialize the key in the form of:
 * `[enc-flag][iv?][ciphertext?][extended-key?]`
 * @returns {Buffer}
 */

MasterKey.prototype.toRaw = function toRaw(writer) {
  var p = new BufferWriter(writer);

  if (this.encrypted) {
    p.writeU8(1);
    p.writeVarBytes(this.iv);
    p.writeVarBytes(this.ciphertext);

    // Future-proofing:
    // algorithm (0=pbkdf2, 1=scrypt)
    p.writeU8(0);
    // iterations (pbkdf2) / N (scrypt)
    p.writeU32(50000);
    // r (scrypt)
    p.writeU32(0);
    // p (scrypt)
    p.writeU32(0);

    if (!writer)
      p = p.render();

    return p;
  }

  p.writeU8(0);
  p.writeVarBytes(this.key.toExtended());

  if (!writer)
    p = p.render();

  return p;
};

/**
 * Inject properties from serialized data.
 * @private
 * @param {Buffer} raw
 */

MasterKey.prototype.fromRaw = function fromRaw(raw) {
  var p = new BufferReader(raw);

  this.encrypted = p.readU8() === 1;

  if (this.encrypted) {
    this.iv = p.readVarBytes();
    this.ciphertext = p.readVarBytes();

    // Future-proofing:
    assert(p.readU8() === 0);
    assert(p.readU32() === 50000);
    assert(p.readU32() === 0);
    assert(p.readU32() === 0);

    return this;
  }

  this.key = bcoin.hd.fromExtended(p.readVarBytes());

  return this;
};

/**
 * Instantiate master key from serialized data.
 * @returns {MasterKey}
 */

MasterKey.fromRaw = function fromRaw(raw) {
  return new MasterKey().fromRaw(raw);
};

/**
 * Inject properties from an HDPrivateKey.
 * @private
 * @param {HDPrivateKey} key
 */

MasterKey.prototype.fromKey = function fromKey(key) {
  this.encrypted = false;
  this.iv = null;
  this.ciphertext = null;
  this.key = key;
  return this;
};

/**
 * Instantiate master key from an HDPrivateKey.
 * @param {HDPrivateKey} key
 * @returns {MasterKey}
 */

MasterKey.fromKey = function fromKey(key) {
  return new MasterKey().fromKey(key);
};

/**
 * Convert master key to a jsonifiable object.
 * @returns {Object}
 */

MasterKey.prototype.toJSON = function toJSON() {
  if (this.encrypted) {
    return {
      encrypted: true,
      iv: this.iv.toString('hex'),
      ciphertext: this.ciphertext.toString('hex'),
      // Future-proofing:
      algorithm: 'pbkdf2',
      N: 50000,
      r: 0,
      p: 0
    };
  }

  return {
    encrypted: false,
    key: this.key.toJSON()
  };
};

/**
 * Inject properties from JSON object.
 * @private
 * @param {Object} json
 */

MasterKey.prototype.fromJSON = function fromJSON(json) {
  assert(typeof json.encrypted === 'boolean');

  this.encrypted = json.encrypted;

  if (json.encrypted) {
    assert(typeof json.iv === 'string');
    assert(typeof json.ciphertext === 'string');
    // Future-proofing:
    assert(json.algorithm === 'pbkdf2');
    assert(json.N === 50000);
    assert(json.r === 0);
    assert(json.p === 0);
    this.iv = new Buffer(json.iv, 'hex');
    this.ciphertext = new Buffer(json.ciphertext, 'hex');
  } else {
    this.key = bcoin.hd.fromJSON(json.key);
  }

  return this;
};

/**
 * Instantiate master key from jsonified object.
 * @param {Object} json
 * @returns {MasterKey}
 */

MasterKey.fromJSON = function fromJSON(json) {
  return new MasterKey().fromJSON(json);
};

/**
 * Inspect the key.
 * @returns {Object}
 */

MasterKey.prototype.inspect = function inspect() {
  var json = this.toJSON();
  if (this.key)
    json.key = this.key.toJSON();
  return json;
};

/**
 * Test whether an object is a MasterKey.
 * @param {Object} obj
 * @returns {Boolean}
 */

MasterKey.isMasterKey = function isMasterKey(obj) {
  return obj
    && typeof obj.encrypted === 'boolean'
    && typeof obj.decrypt === 'function';
};

/*
 * Expose
 */

exports = Wallet;
exports.Account = Account;
exports.MasterKey = MasterKey;

module.exports = exports;
