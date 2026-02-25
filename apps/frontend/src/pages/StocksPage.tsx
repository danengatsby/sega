import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { StockItem, StockMovement } from '../types';

interface StockItemFormState {
  code: string;
  name: string;
  unit: string;
  valuationMethod: StockItem['valuationMethod'];
  minStockQty: string;
  initialQuantity: string;
  initialUnitCost: string;
}

interface StockNirFormState {
  documentNumber: string;
  date: string;
  itemId: string;
  quantity: string;
  unitCost: string;
  note: string;
}

interface StockConsumptionFormState {
  documentNumber: string;
  date: string;
  itemId: string;
  quantity: string;
  note: string;
}

interface StockInventoryFormState {
  documentNumber: string;
  date: string;
  itemId: string;
  countedQuantity: string;
  unitCost: string;
  note: string;
}

interface StocksPageProps {
  stockItemForm: StockItemFormState;
  setStockItemForm: Dispatch<SetStateAction<StockItemFormState>>;
  createStockItem: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canCreateStockItem: boolean;
  nirForm: StockNirFormState;
  setNirForm: Dispatch<SetStateAction<StockNirFormState>>;
  registerNir: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canRegisterNir: boolean;
  consumptionForm: StockConsumptionFormState;
  setConsumptionForm: Dispatch<SetStateAction<StockConsumptionFormState>>;
  registerStockConsumption: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canRegisterStockConsumption: boolean;
  inventoryForm: StockInventoryFormState;
  setInventoryForm: Dispatch<SetStateAction<StockInventoryFormState>>;
  reconcileStockInventory: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canReconcileStockInventory: boolean;
  busyKey: string | null;
  stockItems: StockItem[];
  stockMovements: StockMovement[];
  fmtCurrency: (value: number) => string;
  toNum: (value: string | number) => number;
}

export function StocksPage({
  stockItemForm,
  setStockItemForm,
  createStockItem,
  canCreateStockItem,
  nirForm,
  setNirForm,
  registerNir,
  canRegisterNir,
  consumptionForm,
  setConsumptionForm,
  registerStockConsumption,
  canRegisterStockConsumption,
  inventoryForm,
  setInventoryForm,
  reconcileStockInventory,
  canReconcileStockInventory,
  busyKey,
  stockItems,
  stockMovements,
  fmtCurrency,
  toNum,
}: StocksPageProps) {
  const [selectedStockItemId, setSelectedStockItemId] = useState('');
  const selectedStockItem = useMemo(
    () => stockItems.find((item) => item.id === selectedStockItemId) ?? null,
    [stockItems, selectedStockItemId],
  );
  const selectedStockItemQty = useMemo(() => (selectedStockItem ? toNum(selectedStockItem.quantityOnHand) : 0), [selectedStockItem, toNum]);
  const selectedStockItemAvgCost = useMemo(() => (selectedStockItem ? toNum(selectedStockItem.avgUnitCost) : 0), [selectedStockItem, toNum]);
  const selectedStockItemMinQty = useMemo(() => (selectedStockItem ? toNum(selectedStockItem.minStockQty) : 0), [selectedStockItem, toNum]);
  const selectedStockItemValue = selectedStockItemQty * selectedStockItemAvgCost;
  const selectedStockItemIsLow = selectedStockItemQty < selectedStockItemMinQty;

  return (
    <section className="split-layout split-layout-single-column">
      <article className="panel">
        <h3>Articole stoc</h3>
        {canCreateStockItem ? (
          <form onSubmit={(event) => void createStockItem(event)} className="stack-form">
            <div className="inline-fields">
              <label>
                Cod
                <input
                  value={stockItemForm.code}
                  onChange={(event) => setStockItemForm((prev) => ({ ...prev, code: event.target.value }))}
                  required
                />
              </label>
              <label>
                UM
                <input
                  value={stockItemForm.unit}
                  onChange={(event) => setStockItemForm((prev) => ({ ...prev, unit: event.target.value }))}
                  required
                />
              </label>
            </div>
            <label>
              Denumire
              <input
                value={stockItemForm.name}
                onChange={(event) => setStockItemForm((prev) => ({ ...prev, name: event.target.value }))}
                required
              />
            </label>
            <div className="inline-fields">
              <label>
                Metodă evaluare
                <select
                  value={stockItemForm.valuationMethod}
                  onChange={(event) =>
                    setStockItemForm((prev) => ({
                      ...prev,
                      valuationMethod: event.target.value as StockItem['valuationMethod'],
                    }))
                  }
                >
                  <option value="FIFO">FIFO</option>
                  <option value="CMP">CMP</option>
                </select>
              </label>
              <label>
                Stoc minim
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  value={stockItemForm.minStockQty}
                  onChange={(event) => setStockItemForm((prev) => ({ ...prev, minStockQty: event.target.value }))}
                  required
                />
              </label>
            </div>
            <div className="inline-fields">
              <label>
                Cantitate inițială
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  value={stockItemForm.initialQuantity}
                  onChange={(event) => setStockItemForm((prev) => ({ ...prev, initialQuantity: event.target.value }))}
                  required
                />
              </label>
              <label>
                Cost unitar inițial
                <input
                  type="number"
                  step="0.0001"
                  min="0"
                  value={stockItemForm.initialUnitCost}
                  onChange={(event) => setStockItemForm((prev) => ({ ...prev, initialUnitCost: event.target.value }))}
                />
              </label>
            </div>
            <button type="submit" disabled={busyKey === 'stock-item'}>
              {busyKey === 'stock-item' ? 'Salvare...' : 'Salvează articol'}
            </button>
          </form>
        ) : (
          <p className="muted">Nu ai permisiunea de a adăuga articole de stoc.</p>
        )}

        <h3 style={{ marginTop: '1rem' }}>NIR (intrare stoc)</h3>
        {canRegisterNir ? (
          <form onSubmit={(event) => void registerNir(event)} className="stack-form">
            <div className="inline-fields">
              <label>
                Nr. document
                <input
                  value={nirForm.documentNumber}
                  onChange={(event) => setNirForm((prev) => ({ ...prev, documentNumber: event.target.value }))}
                />
              </label>
              <label>
                Data
                <input
                  type="datetime-local"
                  value={nirForm.date}
                  onChange={(event) => setNirForm((prev) => ({ ...prev, date: event.target.value }))}
                  required
                />
              </label>
            </div>
            <label>
              Articol
              <select
                value={nirForm.itemId}
                onChange={(event) => setNirForm((prev) => ({ ...prev, itemId: event.target.value }))}
                required
              >
                <option value="">Selectează articol</option>
                {stockItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} - {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="inline-fields">
              <label>
                Cantitate
                <input
                  type="number"
                  step="0.001"
                  min="0.001"
                  value={nirForm.quantity}
                  onChange={(event) => setNirForm((prev) => ({ ...prev, quantity: event.target.value }))}
                  required
                />
              </label>
              <label>
                Cost unitar
                <input
                  type="number"
                  step="0.0001"
                  min="0"
                  value={nirForm.unitCost}
                  onChange={(event) => setNirForm((prev) => ({ ...prev, unitCost: event.target.value }))}
                  required
                />
              </label>
            </div>
            <label>
              Observații
              <input
                value={nirForm.note}
                onChange={(event) => setNirForm((prev) => ({ ...prev, note: event.target.value }))}
              />
            </label>
            <button type="submit" disabled={busyKey === 'stock-nir'}>
              {busyKey === 'stock-nir' ? 'Procesare...' : 'Înregistrează NIR'}
            </button>
          </form>
        ) : (
          <p className="muted">Nu ai permisiunea de a înregistra NIR.</p>
        )}

        <h3 style={{ marginTop: '1rem' }}>Bon consum</h3>
        {canRegisterStockConsumption ? (
          <form onSubmit={(event) => void registerStockConsumption(event)} className="stack-form">
            <div className="inline-fields">
              <label>
                Nr. document
                <input
                  value={consumptionForm.documentNumber}
                  onChange={(event) =>
                    setConsumptionForm((prev) => ({ ...prev, documentNumber: event.target.value }))
                  }
                />
              </label>
              <label>
                Data
                <input
                  type="datetime-local"
                  value={consumptionForm.date}
                  onChange={(event) => setConsumptionForm((prev) => ({ ...prev, date: event.target.value }))}
                  required
                />
              </label>
            </div>
            <label>
              Articol
              <select
                value={consumptionForm.itemId}
                onChange={(event) => setConsumptionForm((prev) => ({ ...prev, itemId: event.target.value }))}
                required
              >
                <option value="">Selectează articol</option>
                {stockItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} - {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="inline-fields">
              <label>
                Cantitate consumată
                <input
                  type="number"
                  step="0.001"
                  min="0.001"
                  value={consumptionForm.quantity}
                  onChange={(event) => setConsumptionForm((prev) => ({ ...prev, quantity: event.target.value }))}
                  required
                />
              </label>
              <label>
                Observații
                <input
                  value={consumptionForm.note}
                  onChange={(event) => setConsumptionForm((prev) => ({ ...prev, note: event.target.value }))}
                />
              </label>
            </div>
            <button type="submit" disabled={busyKey === 'stock-consumption'}>
              {busyKey === 'stock-consumption' ? 'Procesare...' : 'Înregistrează consum'}
            </button>
          </form>
        ) : (
          <p className="muted">Nu ai permisiunea de a înregistra consumuri.</p>
        )}

        <h3 style={{ marginTop: '1rem' }}>Inventar și regularizare</h3>
        {canReconcileStockInventory ? (
          <form onSubmit={(event) => void reconcileStockInventory(event)} className="stack-form">
            <div className="inline-fields">
              <label>
                Nr. inventar
                <input
                  value={inventoryForm.documentNumber}
                  onChange={(event) => setInventoryForm((prev) => ({ ...prev, documentNumber: event.target.value }))}
                />
              </label>
              <label>
                Data
                <input
                  type="datetime-local"
                  value={inventoryForm.date}
                  onChange={(event) => setInventoryForm((prev) => ({ ...prev, date: event.target.value }))}
                  required
                />
              </label>
            </div>
            <label>
              Articol
              <select
                value={inventoryForm.itemId}
                onChange={(event) => setInventoryForm((prev) => ({ ...prev, itemId: event.target.value }))}
                required
              >
                <option value="">Selectează articol</option>
                {stockItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} - {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="inline-fields">
              <label>
                Cantitate inventariată
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  value={inventoryForm.countedQuantity}
                  onChange={(event) => setInventoryForm((prev) => ({ ...prev, countedQuantity: event.target.value }))}
                  required
                />
              </label>
              <label>
                Cost unitar (doar plus inventar)
                <input
                  type="number"
                  step="0.0001"
                  min="0"
                  value={inventoryForm.unitCost}
                  onChange={(event) => setInventoryForm((prev) => ({ ...prev, unitCost: event.target.value }))}
                />
              </label>
            </div>
            <label>
              Observații
              <input
                value={inventoryForm.note}
                onChange={(event) => setInventoryForm((prev) => ({ ...prev, note: event.target.value }))}
              />
            </label>
            <button type="submit" disabled={busyKey === 'stock-inventory'}>
              {busyKey === 'stock-inventory' ? 'Procesare...' : 'Aplică inventar'}
            </button>
          </form>
        ) : (
          <p className="muted">Nu ai permisiunea de a face regularizări de inventar.</p>
        )}
        <div className="stocks-summary-grid">
          <section className="stocks-summary-card">
            <h3>Stocuri curente ({stockItems.length})</h3>
            <label>
              Lista stocurilor
              <select
                className="accounts-overflow-select"
                size={12}
                value={selectedStockItemId}
                onChange={(event) => setSelectedStockItemId(event.target.value)}
              >
                <option value="" disabled>
                  Selectează stocul
                </option>
                {stockItems.map((item) => {
                  const qty = toNum(item.quantityOnHand);
                  const minQty = toNum(item.minStockQty);
                  return (
                    <option key={item.id} value={item.id}>
                      {item.code} - {item.name} · Stoc {qty.toFixed(3)} {item.unit} · {qty < minQty ? 'SUB MINIM' : 'OK'}
                    </option>
                  );
                })}
              </select>
            </label>
            {selectedStockItem ? (
              <div className="timeline-item journal-entry-preview">
                <header>
                  <strong>
                    {selectedStockItem.code} - {selectedStockItem.name}
                  </strong>
                  <span>{selectedStockItem.valuationMethod}</span>
                </header>
                <div className="journal-entry-preview-lines">
                  <div>
                    Stoc curent: {selectedStockItemQty.toFixed(3)} {selectedStockItem.unit}
                  </div>
                  <div>Cost mediu: {selectedStockItemAvgCost.toFixed(4)}</div>
                  <div>Valoare stoc: {fmtCurrency(selectedStockItemValue)}</div>
                  <div>
                    Stoc minim: {selectedStockItemMinQty.toFixed(3)} {selectedStockItem.unit}
                  </div>
                  <div>Status: {selectedStockItemIsLow ? 'SUB MINIM' : 'OK'}</div>
                </div>
              </div>
            ) : (
              <p className="muted">Selectează un stoc din listă pentru afișarea în container.</p>
            )}
          </section>

          <section className="stocks-summary-card">
            <h3>Mișcări recente ({stockMovements.length})</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Tip</th>
                    <th>Articol</th>
                    <th>Cantitate</th>
                    <th>Cost unitar</th>
                    <th>Valoare</th>
                    <th>Stoc rezultat</th>
                    <th>Document</th>
                  </tr>
                </thead>
                <tbody>
                  {stockMovements.map((movement) => (
                    <tr key={movement.id}>
                      <td>{new Date(movement.movementDate).toLocaleString()}</td>
                      <td>{movement.type}</td>
                      <td>
                        {movement.item.code} - {movement.item.name}
                      </td>
                      <td>{toNum(movement.quantity).toFixed(3)}</td>
                      <td>{toNum(movement.unitCost).toFixed(4)}</td>
                      <td>{fmtCurrency(toNum(movement.totalCost))}</td>
                      <td>{toNum(movement.resultingQuantity).toFixed(3)}</td>
                      <td>{movement.documentNumber ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </article>
    </section>
  );
}
