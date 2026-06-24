// Wallet — atomic credit/debit with a transaction ledger.
const prisma = require('../config/database');
const { HttpError } = require('../utils/http');

async function getOrCreate(userId, tx = prisma) {
  return tx.wallet.upsert({ where: { userId }, update: {}, create: { userId } });
}

async function credit(userId, amount, type, { contextType, contextId, reference, meta } = {}) {
  if (amount <= 0) return null;
  return prisma.$transaction(async (tx) => {
    const wallet = await getOrCreate(userId, tx);
    const balanceAfter = Number(wallet.balance) + amount;
    await tx.wallet.update({ where: { id: wallet.id }, data: { balance: balanceAfter } });
    return tx.walletTransaction.create({
      data: { walletId: wallet.id, type, amount, balanceAfter, status: 'SUCCESS', contextType, contextId, reference, meta },
    });
  });
}

async function debit(userId, amount, type, { contextType, contextId, reference, meta } = {}) {
  if (amount <= 0) return null;
  return prisma.$transaction(async (tx) => {
    const wallet = await getOrCreate(userId, tx);
    if (Number(wallet.balance) < amount) throw new HttpError(402, 'Insufficient wallet balance');
    const balanceAfter = Number(wallet.balance) - amount;
    await tx.wallet.update({ where: { id: wallet.id }, data: { balance: balanceAfter } });
    return tx.walletTransaction.create({
      data: { walletId: wallet.id, type, amount, balanceAfter, status: 'SUCCESS', contextType, contextId, reference, meta },
    });
  });
}

module.exports = { getOrCreate, credit, debit };
