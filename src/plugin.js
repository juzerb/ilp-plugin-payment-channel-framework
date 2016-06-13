'use strict'

const EventEmitter = require('events')

const Balance = require('./model/balance')
const Connection = require('./model/connection').Connection
const Transfer = require('./model/transfer')
const TransferLog = require('./model/transferlog').TransferLog
const log = require('./util/log')('plugin')

const cc = require('five-bells-condition')

class PluginVirtual extends EventEmitter {

  /* LedgerPlugin API */

  /**
  * Create a PluginVirtual
  * @param {object} opts contains PluginOptions for PluginVirtual.
  *
  * @param {object} opts.store methods for persistance
  * @param {function} opts.store.get get an element by key
  * @param {function} opts.store.put store an element by key, value
  * @param {function} opts.store.del delete an elemeny by key
  *
  * @param {object} opts.auth ledger-specific information
  * @param {string} opts.auth.account name of your PluginVirtual (can be anything)
  * @param {string} opts.auth.room room to connect to in signalling server
  * @param {string} opts.auth.limit numeric string representing credit limit
  * @param {string} opts.auth.host hostname of signalling server with port
  */
  constructor (opts) {
    super()

    let that = this
    this._handle = (err) => {
      that.emit('exception', err)
    }
    
    this.auth = opts.auth

    this.transferLog = new TransferLog(opts.store)

    this.connected = false
    this.connectionConfig = opts.auth
    this.connection = new Connection(this.connectionConfig)
    this.connection.on('receive', (obj) => {
      this._receive(obj).catch(this._handle)
    })

    this.balance = new Balance({
      store: opts.store,
      limit: opts.auth.limit,
      max: opts.auth.max
    })
    this.balance.on('_balanceChanged', (balance) => {
      this._log('balance changed to ' + balance)
      this.emit('_balanceChanged', balance)
    })
  }

  static canConnectToLedger (auth) {
    // TODO: Q test the server?
    return true
  }

  connect () {
    this.connection.connect()
    return new Promise((resolve) => {
      this.connection.on('connect', () => {
        this.emit('connect')
        this.connected = true
        resolve(null)
      })
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
  
  getConnectors () {
    // the connection is only between two plugins for now, so the connector
    // name can be literally anything
    return Promise.resolve(['x'])
  }

  send (outgoingTransfer) {
    this._log('sending out a Transfer with tid: ' + outgoingTransfer.id)
    return this.connection.send({
      type: 'transfer',
      transfer: outgoingTransfer
    }).then(() => {
      return this.transferLog.storeOutgoing(outgoingTransfer)
    }).catch(this._handle())
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

  fulfillCondition(transferId, fulfillmentBuffer) {
    let fulfillment = fulfillmentBuffer.toString()
    let transfer = null
    this._log('fulfilling: ' + fulfillment)
    return this.transferLog.getId(transferId).then((storedTransfer) => {
      transfer = storedTransfer
      return this._fulfillConditionLocal(transfer, fulfillment)
    }).then(() => {
      return this._sendFulfillment(transfer, fulfillment)
    })
  }

  _validate (fulfillment, condition) {
    try {
      return cc.validateFulfillment(fulfillment, condition)
    } catch (err) {
      return false
    }
  }
  
  _fulfillConditionLocal(transfer, fulfillment) {
    if (!transfer) {
      throw new Error('got transfer ID for nonexistant transfer')
    stored} else if (!transfer.executionCondition) {
      throw new Error('got transfer ID for OTP transfer')        
    }

    let execute = transfer.executionCondition
    let cancel = transfer.cancellationCondition  
    let action = Promise.resolve(null)

    if (this._validate(fulfillment, execute)) {
      return this._executeTransfer(transfer, fulfillment)
    } else if (cancel && this._validate(fulfillment, cancel)) {
      return this._cancelTransfer(transfer, fulfillment)
    } else {
      throw new Error('invalid fulfillment')
    }
  }

  _executeTransfer(transfer, fulfillment) {
    let fulfillmentBuffer = new Buffer(fulfillment)
    this.emit('fulfill_execution_condition', transfer, fulfillmentBuffer)
    // because there is only one balance, kept, money is not _actually_ kept
    // in escrow (although it behaves as though it were). So there is nothing
    // to do for the execution condition.
  }

  _cancelTransfer (transfer, fulfillment) {
    let fulfillmentBuffer = new Buffer(fulfillment)
    this.emit('fulfill_cancellation_condition', transfer, fulfillmentBuffer)
    // if the transfer was incoming, then a cancellation means nothing because
    // balances aren't affected until it executes
    return this.transferLog.getType(transfer).then((type) => {
      if (type === this.transferLog.outgoing) {
        return this.balance.add(transfer.amount)
      } else if (type === this.transferLog.incoming) {
        return this.balance.sub(transfer.amount) 
      }
    })
  }

  _sendFulfillment(transfer, fulfillment) {
    return this.connection.send({
      type: 'fulfillment',
      transfer: transfer,
      fulfillment: fulfillment
    })
  }

  replyToTransfer (transferId, replyMessage) {
    return this.transferLog.getId(transferId).then((storedTransfer) => {
      return this.connection.send({
        type: 'reply',
        transfer: storedTransfer,
        message: replyMessage
      })
    })
  }

  _receive (obj) {
    if (obj.type === 'transfer') {
      this._log('received a Transfer with tid: ' + obj.transfer.id)
      this.emit('receive', obj.transfer)
      return this._handleTransfer(obj.transfer)
    } else if (obj.type === 'acknowledge') {
      this._log('received an ACK on tid: ' + obj.transfer.id)
      // TODO: Q should accept be fullfill execution condition even in OTP?
      this.emit('accept', obj.transfer, new Buffer(obj.message))
      return this._handleAcknowledge(obj.transfer)
    } else if (obj.type === 'reject') {
      this._log('received a reject on tid: ' + obj.transfer.id)
      this.emit('reject', obj.transfer, new Buffer(obj.message))
      return this.transferLog.complete(obj.transfer)
    } else if (obj.type === 'reply') {
      this._log('received a reply on tid: ' + obj.transfer.id)
      this.emit('reply', obj.transfer, new Buffer(obj.message))
      return Promise.resolve(null)
    } else if (obj.type === 'fulfillment') {
      this._log('received a fulfillment for tid: ' + obj.transfer.id)
      this.emit('fulfillment', obj.transfer, new Buffer(obj.fulfillment))
      // don't do fullfillCondition because then it would lead to an
      // endless cycle of fulfillments sent back and forth
      return this._fulfillConditionLocal(obj.transfer, obj.fulfillment)
    } else {
      this._handle(new Error('Invalid message received'))
    }
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
      return this.transferLog.storeIncoming(transfer)
    }).then(() => {
      return this.balance.isValidIncoming(transfer.amount)
    }).then((valid) => {
      if (valid) {
        return this.balance.add(transfer.amount).then(() => {
          this._acceptTransfer(transfer)
        })
      } else {
        return this._rejectTransfer(transfer, 'invalid transfer amount')
      }
    }).catch(this._handle)
  }

  _handleAcknowledge (transfer) {
    return this.transferLog.get(transfer).then((storedTransfer) => {
      if (Transfer.equals(storedTransfer, transfer)) {
        return this.transferLog.isComplete(transfer)
      } else {
        this._falseAcknowledge(transfer)
      }
    }).then((isComplete) => {
      if (isComplete) {
        this._falseAcknowledge(transfer)
      } else {
        this.balance.sub(transfer.amount)
      }
    }).then(() => {
      this.transferLog.complete(transfer)
    })
  }

  _falseAcknowledge (transfer) {
    this.emit('_falseAcknowledge', transfer)
    throw new Error('Recieved false acknowledge for tid: ' + transfer.id)
  }

  _acceptTransfer (transfer) {
    this._log('sending out an ACK for tid: ' + transfer.id)
    return this.connection.send({
      type: 'acknowledge',
      transfer: transfer,
      message: 'transfer accepted'
    })
  }

  _rejectTransfer (transfer, reason) {
    this._log('sending out a reject for tid: ' + transfer.id)
    this.transferLog.complete(transfer)
    return this.connection.send({
      type: 'reject',
      transfer: transfer,
      message: reason
    })
  }

  _log (msg) {
    log.log(this.auth.account + ': ' + msg)
  }
}

exports.PluginVirtual = PluginVirtual
exports.Connection = Connection
