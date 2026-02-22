import type { Prisma } from '@prisma/client';
import { StockMovementType, StockValuationMethod } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../lib/http-error.js';
import { assertPeriodOpen } from '../lib/period-lock.js';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { writeAudit } from '../lib/audit.js';
import { requirePermissions } from '../middleware/auth.js';
import { currentPeriod } from '../utils/accounting.js';
import { round2, toNumber } from '../utils/number.js';

const router = Router();

const ITEM_CODE_MAX_LEN = 40;
const QUANTITY_EPS = 0.0005;

const createItemSchema = z.object({
  code: z.string().min(1).max(ITEM_CODE_MAX_LEN),
  name: z.string().min(2).max(200),
  unit: z.string().min(1).max(20).default('BUC'),
  valuationMethod: z.enum(['FIFO', 'CMP']).default('FIFO'),
  minStockQty: z.coerce.number().min(0).default(0),
  initialQuantity: z.coerce.number().min(0).default(0),
  initialUnitCost: z.coerce.number().min(0).optional(),
  reason: z.string().max(300).optional(),
});

const nirLineSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitCost: z.coerce.number().min(0),
  note: z.string().max(300).optional(),
});

const nirSchema = z.object({
  date: z.string().datetime().optional(),
  documentNumber: z.string().max(64).optional(),
  reason: z.string().max(300).optional(),
  lines: z.array(nirLineSchema).min(1),
});

const consumptionLineSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.coerce.number().positive(),
  note: z.string().max(300).optional(),
});

const consumptionSchema = z.object({
  date: z.string().datetime().optional(),
  documentNumber: z.string().max(64).optional(),
  reason: z.string().max(300).optional(),
  lines: z.array(consumptionLineSchema).min(1),
});

const inventoryLineSchema = z.object({
  itemId: z.string().min(1),
  countedQuantity: z.coerce.number().min(0),
  unitCost: z.coerce.number().min(0).optional(),
  note: z.string().max(300).optional(),
});

const inventorySchema = z.object({
  date: z.string().datetime().optional(),
  documentNumber: z.string().max(64).optional(),
  reason: z.string().max(300).optional(),
  lines: z.array(inventoryLineSchema).min(1),
});

function roundQty(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function roundUnitCost(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function sanitizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function sanitizeUnit(unit: string): string {
  return unit.trim().toUpperCase();
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    return {};
  }
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

interface LoadedStockItem {
  id: string;
  code: string;
  name: string;
  valuationMethod: StockValuationMethod;
  quantityOnHand: Prisma.Decimal;
  avgUnitCost: Prisma.Decimal;
}

type TxClient = Prisma.TransactionClient;

async function getCompanyStockItem(tx: TxClient, companyId: string, itemId: string): Promise<LoadedStockItem> {
  const item = await tx.stockItem.findFirst({
    where: {
      id: itemId,
      companyId,
      isActive: true,
    },
    select: {
      id: true,
      code: true,
      name: true,
      valuationMethod: true,
      quantityOnHand: true,
      avgUnitCost: true,
    },
  });

  if (!item) {
    throw HttpError.notFound('Articolul de stoc nu există în compania activă.');
  }

  return item;
}

async function computeFifoAverageCost(tx: TxClient, itemId: string): Promise<number> {
  const lots = await tx.stockLot.findMany({
    where: {
      itemId,
      remainingQuantity: {
        gt: 0,
      },
    },
    select: {
      remainingQuantity: true,
      unitCost: true,
    },
  });

  let qty = 0;
  let value = 0;
  for (const lot of lots) {
    const lotQty = toNumber(lot.remainingQuantity);
    if (lotQty <= QUANTITY_EPS) {
      continue;
    }
    qty += lotQty;
    value += lotQty * toNumber(lot.unitCost);
  }

  if (qty <= QUANTITY_EPS) {
    return 0;
  }

  return roundUnitCost(value / qty);
}

async function applyInboundMovement(params: {
  tx: TxClient;
  companyId: string;
  item: LoadedStockItem;
  movementDate: Date;
  quantity: number;
  unitCost: number;
  type: 'NIR' | 'INVENTORY_PLUS';
  documentNumber?: string;
  note?: string;
}): Promise<{ movementId: string; resultingQuantity: number }> {
  const qty = roundQty(params.quantity);
  const cost = roundUnitCost(params.unitCost);

  if (qty <= 0) {
    throw HttpError.badRequest('Cantitatea trebuie să fie pozitivă.');
  }

  if (cost < 0) {
    throw HttpError.badRequest('Costul unitar nu poate fi negativ.');
  }

  const previousQty = toNumber(params.item.quantityOnHand);
  const previousAvg = toNumber(params.item.avgUnitCost);
  const nextQty = roundQty(previousQty + qty);
  const previousValue = previousQty * previousAvg;
  const nextAvg = nextQty > QUANTITY_EPS ? roundUnitCost((previousValue + qty * cost) / nextQty) : 0;
  const movementTotal = round2(qty * cost);

  await params.tx.stockItem.update({
    where: { id: params.item.id },
    data: {
      quantityOnHand: nextQty,
      avgUnitCost: nextAvg,
    },
  });

  const movement = await params.tx.stockMovement.create({
    data: {
      companyId: params.companyId,
      itemId: params.item.id,
      type: params.type,
      movementDate: params.movementDate,
      quantity: qty,
      unitCost: cost,
      totalCost: movementTotal,
      resultingQuantity: nextQty,
      documentNumber: params.documentNumber,
      note: params.note,
    },
  });

  if (params.item.valuationMethod === StockValuationMethod.FIFO) {
    await params.tx.stockLot.create({
      data: {
        companyId: params.companyId,
        itemId: params.item.id,
        sourceMovementId: movement.id,
        receivedAt: params.movementDate,
        unitCost: cost,
        initialQuantity: qty,
        remainingQuantity: qty,
      },
    });
  }

  return {
    movementId: movement.id,
    resultingQuantity: nextQty,
  };
}

async function applyOutboundMovement(params: {
  tx: TxClient;
  companyId: string;
  item: LoadedStockItem;
  movementDate: Date;
  quantity: number;
  type: 'CONSUMPTION' | 'INVENTORY_MINUS';
  documentNumber?: string;
  note?: string;
}): Promise<{ movementId: string; resultingQuantity: number }> {
  const qty = roundQty(params.quantity);
  if (qty <= 0) {
    throw HttpError.badRequest('Cantitatea de ieșire trebuie să fie pozitivă.');
  }

  const previousQty = toNumber(params.item.quantityOnHand);
  if (qty - previousQty > QUANTITY_EPS) {
    throw HttpError.badRequest(
      `Stoc insuficient pentru articolul ${params.item.code}. Disponibil: ${previousQty.toFixed(3)}.`,
    );
  }

  const nextQty = roundQty(Math.max(previousQty - qty, 0));
  let movementUnitCost = 0;
  let movementTotalAbs = 0;
  let nextAvg = 0;
  let sourceLots: Array<{
    lotId: string;
    quantity: number;
    unitCost: number;
  }> = [];

  if (params.item.valuationMethod === StockValuationMethod.CMP) {
    movementUnitCost = roundUnitCost(toNumber(params.item.avgUnitCost));
    movementTotalAbs = round2(qty * movementUnitCost);
    nextAvg = nextQty > QUANTITY_EPS ? movementUnitCost : 0;
  } else {
    const lots = await params.tx.stockLot.findMany({
      where: {
        itemId: params.item.id,
        companyId: params.companyId,
        remainingQuantity: {
          gt: 0,
        },
      },
      orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        remainingQuantity: true,
        unitCost: true,
      },
    });

    let remaining = qty;

    for (const lot of lots) {
      if (remaining <= QUANTITY_EPS) {
        break;
      }

      const lotRemaining = toNumber(lot.remainingQuantity);
      if (lotRemaining <= QUANTITY_EPS) {
        continue;
      }

      const takeQty = roundQty(Math.min(lotRemaining, remaining));
      if (takeQty <= QUANTITY_EPS) {
        continue;
      }

      const lotUnitCost = roundUnitCost(toNumber(lot.unitCost));
      const lotRemainingAfter = roundQty(Math.max(lotRemaining - takeQty, 0));

      await params.tx.stockLot.update({
        where: { id: lot.id },
        data: {
          remainingQuantity: lotRemainingAfter,
        },
      });

      movementTotalAbs = round2(movementTotalAbs + takeQty * lotUnitCost);
      sourceLots.push({
        lotId: lot.id,
        quantity: takeQty,
        unitCost: lotUnitCost,
      });

      remaining = roundQty(Math.max(remaining - takeQty, 0));
    }

    if (remaining > QUANTITY_EPS) {
      throw HttpError.badRequest(
        `Stoc insuficient pentru articolul ${params.item.code}. Lipsă: ${remaining.toFixed(3)}.`,
      );
    }

    movementUnitCost = qty > QUANTITY_EPS ? roundUnitCost(movementTotalAbs / qty) : 0;
    nextAvg = nextQty > QUANTITY_EPS ? await computeFifoAverageCost(params.tx, params.item.id) : 0;
  }

  await params.tx.stockItem.update({
    where: { id: params.item.id },
    data: {
      quantityOnHand: nextQty,
      avgUnitCost: nextAvg,
    },
  });

  const movement = await params.tx.stockMovement.create({
    data: {
      companyId: params.companyId,
      itemId: params.item.id,
      type: params.type,
      movementDate: params.movementDate,
      quantity: -qty,
      unitCost: movementUnitCost,
      totalCost: -movementTotalAbs,
      resultingQuantity: nextQty,
      documentNumber: params.documentNumber,
      note: params.note,
      sourceLots: sourceLots.length > 0 ? toJsonValue(sourceLots) : undefined,
    },
  });

  return {
    movementId: movement.id,
    resultingQuantity: nextQty,
  };
}

router.get('/items', requirePermissions(PERMISSIONS.STOCKS_READ), async (req, res) => {
  const companyId = req.user!.companyId!;

  const items = await prisma.stockItem.findMany({
    where: {
      companyId,
    },
    orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
  });

  res.json(items);
});

router.get('/movements', requirePermissions(PERMISSIONS.STOCKS_READ), async (req, res) => {
  const companyId = req.user!.companyId!;
  const itemId = typeof req.query.itemId === 'string' && req.query.itemId.trim().length > 0 ? req.query.itemId.trim() : null;
  const fromDate = typeof req.query.from === 'string' && req.query.from.trim().length > 0 ? new Date(req.query.from) : null;
  const toDate = typeof req.query.to === 'string' && req.query.to.trim().length > 0 ? new Date(req.query.to) : null;
  const takeRaw = typeof req.query.take === 'string' ? Number(req.query.take) : Number.NaN;
  const take = Number.isFinite(takeRaw) ? Math.min(Math.max(Math.trunc(takeRaw), 1), 500) : 160;

  if (fromDate && Number.isNaN(fromDate.getTime())) {
    throw HttpError.badRequest('Parametrul from este invalid.');
  }

  if (toDate && Number.isNaN(toDate.getTime())) {
    throw HttpError.badRequest('Parametrul to este invalid.');
  }

  const movements = await prisma.stockMovement.findMany({
    where: {
      companyId,
      ...(itemId ? { itemId } : {}),
      ...(fromDate || toDate
        ? {
            movementDate: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
    },
    include: {
      item: {
        select: {
          id: true,
          code: true,
          name: true,
          unit: true,
          valuationMethod: true,
        },
      },
    },
    orderBy: [{ movementDate: 'desc' }, { createdAt: 'desc' }],
    take,
  });

  res.json(movements);
});

router.post('/items', requirePermissions(PERMISSIONS.STOCKS_WRITE), async (req, res) => {
  const parsed = createItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru articolul de stoc.' });
    return;
  }

  const companyId = req.user!.companyId!;
  const initialQty = roundQty(parsed.data.initialQuantity);
  const initialCost = parsed.data.initialUnitCost !== undefined ? roundUnitCost(parsed.data.initialUnitCost) : null;

  if (initialQty > QUANTITY_EPS && (initialCost === null || initialCost < 0)) {
    throw HttpError.badRequest('Costul unitar inițial este obligatoriu când se setează stoc inițial.');
  }

  const movementDate = new Date();
  await assertPeriodOpen(companyId, currentPeriod(movementDate));

  const created = await prisma.$transaction(async (tx) => {
    const createdItem = await tx.stockItem.create({
      data: {
        companyId,
        code: sanitizeCode(parsed.data.code),
        name: parsed.data.name.trim(),
        unit: sanitizeUnit(parsed.data.unit),
        valuationMethod: parsed.data.valuationMethod as StockValuationMethod,
        minStockQty: roundQty(parsed.data.minStockQty),
        quantityOnHand: 0,
        avgUnitCost: 0,
      },
    });

    if (initialQty > QUANTITY_EPS) {
      await applyInboundMovement({
        tx,
        companyId,
        item: {
          id: createdItem.id,
          code: createdItem.code,
          name: createdItem.name,
          valuationMethod: createdItem.valuationMethod,
          quantityOnHand: createdItem.quantityOnHand,
          avgUnitCost: createdItem.avgUnitCost,
        },
        movementDate,
        quantity: initialQty,
        unitCost: initialCost ?? 0,
        type: StockMovementType.NIR,
        documentNumber: 'INITIAL-STOCK',
        note: 'Sold inițial',
      });
    }

    await writeAudit(
      req,
      {
        tableName: 'stock_items',
        recordId: createdItem.id,
        action: 'CREATE',
        reason: parsed.data.reason,
        afterData: {
          code: createdItem.code,
          valuationMethod: createdItem.valuationMethod,
          minStockQty: createdItem.minStockQty,
          initialQuantity: initialQty,
          initialUnitCost: initialCost,
        },
      },
      tx,
    );

    return tx.stockItem.findUnique({
      where: {
        id: createdItem.id,
      },
    });
  });

  res.status(201).json(created);
});

router.post('/nir', requirePermissions(PERMISSIONS.STOCKS_WRITE), async (req, res) => {
  const parsed = nirSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru NIR.' });
    return;
  }

  const companyId = req.user!.companyId!;
  const movementDate = parsed.data.date ? new Date(parsed.data.date) : new Date();

  if (Number.isNaN(movementDate.getTime())) {
    throw HttpError.badRequest('Data NIR este invalidă.');
  }

  await assertPeriodOpen(companyId, currentPeriod(movementDate));

  const movementIds = await prisma.$transaction(async (tx) => {
    const ids: string[] = [];

    for (const line of parsed.data.lines) {
      const item = await getCompanyStockItem(tx, companyId, line.itemId);
      const result = await applyInboundMovement({
        tx,
        companyId,
        item,
        movementDate,
        quantity: line.quantity,
        unitCost: line.unitCost,
        type: StockMovementType.NIR,
        documentNumber: parsed.data.documentNumber,
        note: line.note,
      });
      ids.push(result.movementId);
    }

    await writeAudit(
      req,
      {
        tableName: 'stock_movements',
        recordId: ids[0],
        action: 'STOCK_NIR',
        reason: parsed.data.reason,
        afterData: {
          documentNumber: parsed.data.documentNumber,
          lineCount: parsed.data.lines.length,
          movementIds: ids,
        },
      },
      tx,
    );

    return ids;
  });

  const movements = await prisma.stockMovement.findMany({
    where: {
      id: {
        in: movementIds,
      },
    },
    include: {
      item: {
        select: {
          id: true,
          code: true,
          name: true,
          unit: true,
          valuationMethod: true,
        },
      },
    },
    orderBy: [{ movementDate: 'desc' }, { createdAt: 'desc' }],
  });

  res.status(201).json({
    movementCount: movements.length,
    movements,
  });
});

router.post('/consumptions', requirePermissions(PERMISSIONS.STOCKS_WRITE), async (req, res) => {
  const parsed = consumptionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru consum.' });
    return;
  }

  const companyId = req.user!.companyId!;
  const movementDate = parsed.data.date ? new Date(parsed.data.date) : new Date();

  if (Number.isNaN(movementDate.getTime())) {
    throw HttpError.badRequest('Data bonului de consum este invalidă.');
  }

  await assertPeriodOpen(companyId, currentPeriod(movementDate));

  const movementIds = await prisma.$transaction(async (tx) => {
    const ids: string[] = [];

    for (const line of parsed.data.lines) {
      const item = await getCompanyStockItem(tx, companyId, line.itemId);
      const result = await applyOutboundMovement({
        tx,
        companyId,
        item,
        movementDate,
        quantity: line.quantity,
        type: StockMovementType.CONSUMPTION,
        documentNumber: parsed.data.documentNumber,
        note: line.note,
      });
      ids.push(result.movementId);
    }

    await writeAudit(
      req,
      {
        tableName: 'stock_movements',
        recordId: ids[0],
        action: 'STOCK_CONSUMPTION',
        reason: parsed.data.reason,
        afterData: {
          documentNumber: parsed.data.documentNumber,
          lineCount: parsed.data.lines.length,
          movementIds: ids,
        },
      },
      tx,
    );

    return ids;
  });

  const movements = await prisma.stockMovement.findMany({
    where: {
      id: {
        in: movementIds,
      },
    },
    include: {
      item: {
        select: {
          id: true,
          code: true,
          name: true,
          unit: true,
          valuationMethod: true,
        },
      },
    },
    orderBy: [{ movementDate: 'desc' }, { createdAt: 'desc' }],
  });

  res.status(201).json({
    movementCount: movements.length,
    movements,
  });
});

router.post('/inventory', requirePermissions(PERMISSIONS.STOCKS_WRITE), async (req, res) => {
  const parsed = inventorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru inventar.' });
    return;
  }

  const companyId = req.user!.companyId!;
  const movementDate = parsed.data.date ? new Date(parsed.data.date) : new Date();

  if (Number.isNaN(movementDate.getTime())) {
    throw HttpError.badRequest('Data inventarului este invalidă.');
  }

  await assertPeriodOpen(companyId, currentPeriod(movementDate));

  const result = await prisma.$transaction(async (tx) => {
    const adjustments: Array<{
      itemId: string;
      itemCode: string;
      itemName: string;
      systemQuantity: number;
      countedQuantity: number;
      differenceQuantity: number;
      movementId: string;
    }> = [];

    for (const line of parsed.data.lines) {
      const item = await getCompanyStockItem(tx, companyId, line.itemId);
      const systemQty = roundQty(toNumber(item.quantityOnHand));
      const countedQty = roundQty(line.countedQuantity);
      const difference = roundQty(countedQty - systemQty);

      if (Math.abs(difference) <= QUANTITY_EPS) {
        continue;
      }

      if (difference > 0) {
        const resolvedUnitCost =
          line.unitCost !== undefined
            ? roundUnitCost(line.unitCost)
            : roundUnitCost(toNumber(item.avgUnitCost));

        if (resolvedUnitCost <= 0) {
          throw HttpError.badRequest(
            `Pentru plus inventar la articolul ${item.code} este necesar unitCost (> 0).`,
          );
        }

        const movement = await applyInboundMovement({
          tx,
          companyId,
          item,
          movementDate,
          quantity: difference,
          unitCost: resolvedUnitCost,
          type: StockMovementType.INVENTORY_PLUS,
          documentNumber: parsed.data.documentNumber,
          note: line.note ?? 'Regularizare inventar (+)',
        });

        adjustments.push({
          itemId: item.id,
          itemCode: item.code,
          itemName: item.name,
          systemQuantity: systemQty,
          countedQuantity: countedQty,
          differenceQuantity: difference,
          movementId: movement.movementId,
        });
      } else {
        const movement = await applyOutboundMovement({
          tx,
          companyId,
          item,
          movementDate,
          quantity: Math.abs(difference),
          type: StockMovementType.INVENTORY_MINUS,
          documentNumber: parsed.data.documentNumber,
          note: line.note ?? 'Regularizare inventar (-)',
        });

        adjustments.push({
          itemId: item.id,
          itemCode: item.code,
          itemName: item.name,
          systemQuantity: systemQty,
          countedQuantity: countedQty,
          differenceQuantity: difference,
          movementId: movement.movementId,
        });
      }
    }

    await writeAudit(
      req,
      {
        tableName: 'stock_items',
        recordId: adjustments[0]?.itemId,
        action: 'STOCK_INVENTORY_RECONCILIATION',
        reason: parsed.data.reason,
        afterData: {
          documentNumber: parsed.data.documentNumber,
          adjustmentCount: adjustments.length,
          adjustments,
        },
      },
      tx,
    );

    return adjustments;
  });

  res.status(201).json({
    adjustmentCount: result.length,
    adjustments: result,
  });
});

export default router;
