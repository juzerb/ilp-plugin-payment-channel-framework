const EventEmitter = require('events')
const BigNumber = require('bignumber.js')

const Connection = require('./model/connection').Connection
const Transfer = require('./model/transfer').Transfer
const TransferLog = require('./model/transferlog').TransferLog
const log = require('./controllers/log')

class PluginVirtual extends EventEmitter {

  /* LedgerPlugin API */

  constructor (opts) {
    super()

    this.connected = false
    this.auth = opts.auth
    this.store = opts.store
    // store contains
    //   put(k, v) => promise.null
    //   get(k)    => promise.string
    //   del(k)    => promise.null

    this.myAccount = '1'
    this.otherAccount = '2'
    // TODO: Q is opts.limit the right place to get this?
    this.limit = opts.auth.limit
    this.transferLog = new TransferLog(this.store)

    this.connectionConfig = opts.auth // technically auth holds ledger-specific info
    this.connection = new Connection(this.connectionConfig)

    this.connection.on('receive', (obj) => {
      this._receive(obj).catch((err) => {
        log.error(err)
        this.emit('error', err)
      })
    })
  }

  static canConnectToLedger (auth) {
    // TODO: Q test the server?
    return true
  }

  connect () {
    return new Promise((resolve) => {
      this.connection.on('connect', () => {
        this.emit('connect')
        this.connected = true
        resolve(null)
      })
      this.connection.connect()
    })
  }

  disconnect () {
    return this.connection.disconnect().then(() => {
      this.emit('disconnect')
      this.connected = false
      return Promise.resolve(null)
    })
  }

  isConnected () {
    return this.connected
  }

  getBalance () {
    return this.store.get('a' + this.myAccount).then((balance) => {
      // TODO: Q figure out what the store does when a key doesn't exist
      if (!balance) {
        return this.store.put('a' + this.myAccount, '0').then(() => {
          return Promise.resolve('0')
        })
      }
      return Promise.resolve(balance)
    })
  }
  _getBalanceFloat () {
    return this.getBalance().then((balance) => {
      return Promise.resolve(new BigNumber(balance))
    })
  }

  getConnectors () {
    // the connection is only between two plugins for now, so the connector
    // name can be literally anything
    return Promise.resolve([this.otherAccount])
  }

  send (outgoingTransfer) {
    this._log('sending out a Transfer with tid: ' + outgoingTransfer.id)
    return this.connection.send({
      type: 'transfer',
      transfer: (new Transfer(outgoingTransfer)).serialize()
    }).then(() => {
      return this.transferLog.store(outgoingTransfer)
    }).catch((err) => {
      log.error(err)
    })
  }

  getInfo () {
    return Promise.resolve({
      /* placeholder values */
      // TODO: Q what should these be
      precision: 'inf',
      scale: 'inf',
      currencyCode: 'GBP',
      currencySymbol: '$' 
    })
  }

  /* Add these once UTP and ATP are introduced
  fullfillCondition(transferId, fullfillment) {
    // TODO: implement this
  }
  */

  replyToTransfer (transferId, replyMessage) {
    return this.transferLog.getId(transferId).then((storedTransfer) => {
      return this.connection.send({
        type: 'reply',
        transfer: storedTransfer,
        message: replyMessage
      })
    })
  }

  /* Private Functions */
  _receive (obj) {

    /* eslint-disable padded-blocks */
    if (obj.type === 'transfer') {

      this._log('received a Transfer with tid: ' + obj.transfer.id)
      this.emit('incoming', obj.transfer)
      return this._handleTransfer(new Transfer(obj.transfer))

    } else if (obj.type === 'acknowledge') {

      this._log('received a ACK on tid: ' + obj.transfer.id)
      // TODO: Q should accept be fullfill execution condition even in OTP?
      this.emit('accept', obj.transfer, obj.message) // TODO: Q can obj.message be null?
      return this._handleAcknowledge(new Transfer(obj.transfer))

    } else if (obj.type === 'reject') {

      this._log('received a reject on tid: ' + obj.transfer.id)
      this.emit('reject', obj.transfer, obj.message)
      return this.transferLog.complete(obj.transfer)

    } else if (obj.type === 'reply') {

      this._log('received a reply on tid: ' + obj.transfer.id)
      this.emit('reply', obj.transfer, obj.message)
      return Promise.resolve(null)

    } else {
      throw new Error('Invalid message received')
    }
    /* eslint-enable padded-blocks */
  }

  _handleTransfer (transfer) {
    return this.transferLog.get(transfer).then((storedTransfer) => {
      if (storedTransfer) {
        this.emit('_repeatTransfer', transfer)
        return this._rejectTransfer(transfer, 'repeat transfer id').then(() => {
          throw new Error('repeat transfer id')
        })
      } else {
        return Promise.resolve(null) 
      }
    }).then(() => {
      return this.transferLog.store(transfer.serialize())
    }).then(() => {
      return this._getBalanceFloat()
    }).then((balance) => {
      if (transfer.amount.isNaN()) {
        return this._rejectTransfer(transfer, 'amount is not a number')
      } else if (transfer.amount.lte(new BigNumber(0))) {
        return this._rejectTransfer(transfer, 'invalid amount')
      } else if ((balance.add(transfer.amount).lessThanOrEqualTo(this.limit))) {
        return this._addBalance(this.myAccount, transfer.amount).then(() => {
          return this._acceptTransfer(transfer)
        })
      } else {
        return this._rejectTransfer(transfer, 'credit limit exceeded')
      }
    })
  }

  _handleAcknowledge (transfer) {
    // subtract the transfer amount because it's ackowledging a sent transaction
    var pv = this
    return this.transferLog.get(transfer).then((storedTransfer) => {
      if (transfer.equals(new Transfer(storedTransfer))) {
        return this.transferLog.isComplete(transfer).then((isComplete) => {
          if (isComplete) {
            this._falseAcknowledge(transfer)
          } else {
            return this.transferLog.complete(transfer).then(() => {
              return pv._addBalance(pv.myAccount, transfer.amount.negated())
            })
          }
        })
      } else {
        this._falseAcknowledge(transfer)
      }
    })
  }

  _falseAcknowledge (transfer) {
    this.emit('_falseAcknowledge', transfer)
    throw new Error('Recieved false acknowledge for tid: ' + transfer.id)
  }

  _addBalance (account, amt) {
    return this._getBalanceFloat().then((balance) => {
      // TODO: make sure that these numbers have the correct precision
      this._log(balance + ' changed by ' + amt)
      let newBalance = balance.add(amt).toString()
      return this.store.put('a' + account, balance.add(amt).toString())
      .then(() => {
        return Promise.resolve(newBalance)
      })
    }).then((newBalance) => {
      // event for debugging
      this.emit('_balanceChanged', newBalance)
      return Promise.resolve(null)
    })
  }

  _acceptTransfer (transfer) {
    this._log('sending out an ACK for tid: ' + transfer.id)
    return this.connection.send({
      type: 'acknowledge',
      transfer: transfer.serialize(),
      message: new Buffer('transfer accepted')
    })
  }
  _rejectTransfer (transfer, reason) {
    this._log('sending out a reject for tid: ' + transfer.id)
    this.transferLog.complete(transfer)
    return this.connection.send({
      type: 'reject',
      transfer: transfer.serialize(),
      message: new Buffer(reason)
    })
  }

  _log (msg) {
    log.log(this.auth.account + ': ' + msg)
  }
}

exports.PluginVirtual = PluginVirtual
exports.Connection = Connection
