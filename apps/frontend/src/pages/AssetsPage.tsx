import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { Asset } from '../types';

interface AssetFormState {
  code: string;
  name: string;
  value: string;
  residualValue: string;
  depreciationMethod: Asset['depreciationMethod'];
  usefulLifeMonths: string;
  startDate: string;
}

interface DepreciationFormState {
  period: string;
}

interface AssetsPageProps {
  assetForm: AssetFormState;
  setAssetForm: Dispatch<SetStateAction<AssetFormState>>;
  createAsset: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canCreateAsset: boolean;
  depreciationForm: DepreciationFormState;
  setDepreciationForm: Dispatch<SetStateAction<DepreciationFormState>>;
  runDepreciation: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canRunDepreciation: boolean;
  busyKey: string | null;
  assets: Asset[];
  fmtCurrency: (value: number) => string;
  toNum: (value: string | number) => number;
}

export function AssetsPage({
  assetForm,
  setAssetForm,
  createAsset,
  canCreateAsset,
  depreciationForm,
  setDepreciationForm,
  runDepreciation,
  canRunDepreciation,
  busyKey,
  assets,
  fmtCurrency,
  toNum,
}: AssetsPageProps) {
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const selectedAsset = useMemo(() => assets.find((asset) => asset.id === selectedAssetId) ?? null, [assets, selectedAssetId]);
  const selectedAssetLatestDepreciation = selectedAsset?.depreciationRecords[0] ?? null;

  return (
    <section className="split-layout split-layout-single-column">
      <article className="panel">
        <h3>Administrare mijloace fixe</h3>
        {canCreateAsset ? (
          <form onSubmit={(event) => void createAsset(event)} className="stack-form">
            <label>
              Cod
              <input
                value={assetForm.code}
                onChange={(event) => setAssetForm((prev) => ({ ...prev, code: event.target.value }))}
              />
            </label>
            <label>
              Denumire
              <input
                value={assetForm.name}
                onChange={(event) => setAssetForm((prev) => ({ ...prev, name: event.target.value }))}
                required
              />
            </label>
            <div className="inline-fields">
              <label>
                Valoare
                <input
                  type="number"
                  step="0.01"
                  value={assetForm.value}
                  onChange={(event) => setAssetForm((prev) => ({ ...prev, value: event.target.value }))}
                  required
                />
              </label>
              <label>
                Valoare reziduală
                <input
                  type="number"
                  step="0.01"
                  value={assetForm.residualValue}
                  onChange={(event) => setAssetForm((prev) => ({ ...prev, residualValue: event.target.value }))}
                  required
                />
              </label>
            </div>
            <label>
              Metodă amortizare
              <select
                value={assetForm.depreciationMethod}
                onChange={(event) =>
                  setAssetForm((prev) => ({
                    ...prev,
                    depreciationMethod: event.target.value as Asset['depreciationMethod'],
                  }))
                }
              >
                <option value="LINEAR">Liniară</option>
                <option value="DEGRESSIVE">Degresivă</option>
                <option value="ACCELERATED">Accelerată</option>
              </select>
            </label>
            <div className="inline-fields">
              <label>
                Durată (luni)
                <input
                  type="number"
                  min="1"
                  value={assetForm.usefulLifeMonths}
                  onChange={(event) => setAssetForm((prev) => ({ ...prev, usefulLifeMonths: event.target.value }))}
                  required
                />
              </label>
              <label>
                Data punerii în funcțiune
                <input
                  type="datetime-local"
                  value={assetForm.startDate}
                  onChange={(event) => setAssetForm((prev) => ({ ...prev, startDate: event.target.value }))}
                  required
                />
              </label>
            </div>
            <button type="submit" disabled={busyKey === 'asset'}>
              {busyKey === 'asset' ? 'Salvare...' : 'Salvează mijloc fix'}
            </button>
          </form>
        ) : (
          <p className="muted">Nu ai permisiunea de a adăuga mijloace fixe.</p>
        )}

        <h3 style={{ marginTop: '1rem' }}>Rulare amortizare</h3>
        {canRunDepreciation ? (
          <form onSubmit={(event) => void runDepreciation(event)} className="stack-form">
            <label>
              Perioadă
              <input
                type="month"
                value={depreciationForm.period}
                onChange={(event) => setDepreciationForm({ period: event.target.value })}
                required
              />
            </label>
            <button type="submit" disabled={busyKey === 'depreciation'}>
              {busyKey === 'depreciation' ? 'Procesare...' : 'Generează amortizare + note contabile'}
            </button>
          </form>
        ) : (
          <p className="muted">Nu ai permisiunea de a rula amortizarea.</p>
        )}

        <h3 style={{ marginTop: '1rem' }}>Registru mijloace fixe ({assets.length})</h3>
        <label>
          Lista mijloacelor fixe
          <select
            className="accounts-overflow-select"
            size={12}
            value={selectedAssetId}
            onChange={(event) => setSelectedAssetId(event.target.value)}
          >
            <option value="" disabled>
              Selectează mijlocul fix
            </option>
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.code ?? '-'} - {asset.name} · {fmtCurrency(toNum(asset.value))} ·{' '}
                {asset.depreciationRecords[0]?.period ?? 'Neamortizat'}
              </option>
            ))}
          </select>
        </label>
        {selectedAsset ? (
          <div className="timeline-item journal-entry-preview">
            <header>
              <strong>
                {selectedAsset.code ?? '-'} - {selectedAsset.name}
              </strong>
              <span>{selectedAsset.isActive ? 'Activ' : 'Inactiv'}</span>
            </header>
            <div className="journal-entry-preview-lines">
              <div>Valoare: {fmtCurrency(toNum(selectedAsset.value))}</div>
              <div>Valoare reziduală: {fmtCurrency(toNum(selectedAsset.residualValue))}</div>
              <div>Metodă amortizare: {selectedAsset.depreciationMethod}</div>
              <div>Durată: {selectedAsset.usefulLifeMonths} luni</div>
              <div>Data punerii în funcțiune: {new Date(selectedAsset.startDate).toLocaleDateString('ro-RO')}</div>
              <div>
                Ultima amortizare:{' '}
                {selectedAssetLatestDepreciation
                  ? `${selectedAssetLatestDepreciation.period} (${fmtCurrency(toNum(selectedAssetLatestDepreciation.depreciationAmount))})`
                  : 'Neamortizat'}
              </div>
            </div>
          </div>
        ) : (
          <p className="muted">Selectează un mijloc fix din listă pentru afișarea în container.</p>
        )}
      </article>
    </section>
  );
}
