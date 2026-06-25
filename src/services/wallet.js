// Wallet — atomic credit/debit with a transaction ledger.
//
// `creditTx`/`debitTx` run inside a caller-supplied Prisma transaction so a
// multi-leg settlement (e.g. debit rider + credit driver, or debit customer +
// credit courier + credit vendor) is all-or-nothing. The public `credit`/`debit`
// wrap a single move in its own transaction (back-compat for simple callers).
// A unique `reference` makes a move idempotent — replaying it hits the unique
// constraint and rolls the whole settlement back instead of double-paying.
const prisma = require('../config/database');
const { HttpError } = require('../utils/http');

async function getOrCreate(userId, tx = prisma) {
  return tx.wallet.upsert({ where: { userId }, update: {}, create: { userId } });
}

async function creditTx(tx, userId, amount, type, { contextType, contextId, reference, meta } = {}) {
  if (!(amount > 0)) return null;
  const wallet = await getOrCreate(userId, tx);
  const balanceAfter = Number(wallet.balance) + amount;
  await tx.wallet.update({ where: { id: wallet.id }, data: { balance: balanceAfter } });
  return tx.walletTransaction.create({
    data: { walletId: wallet.id, type, amount, balanceAfter, status: 'SUCCESS', contextType, contextId, reference, meta },
  });
}

async function debitTx(tx, userId, amount, type, { contextType, contextId, reference, meta } = {}) {
  if (!(amount > 0)) return null;
  const wallet = await getOrCreate(userId, tx);
  if (Number(wallet.balance) < amount) throw new HttpError(402, 'Insufficient wallet balance');
  const balanceAfter = Number(wallet.balance) - amount;
  await tx.wallet.update({ where: { id: wallet.id }, data: { balance: balanceAfter } });
  return tx.walletTransaction.create({
    data: { walletId: wallet.id, type, amount, balanceAfter, status: 'SUCCESS', contextType, contextId, reference, meta },
  });
}

const credit = (userId, amount, type, opts) => prisma.$transaction((tx) => creditTx(tx, userId, amount, type, opts));
const debit = (userId, amount, type, opts) => prisma.$transaction((tx) => debitTx(tx, userId, amount, type, opts));

module.exports = { getOrCreate, credit, debit, creditTx, debitTx };
