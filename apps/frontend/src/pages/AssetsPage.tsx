import type { Dispatch, SetStateAction } from 'react';
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
  return (
    <section className="split-layout">
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
      </article>

      <article className="panel">
        <h3>Registru mijloace fixe ({assets.length})</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cod</th>
                <th>Denumire</th>
                <th>Valoare</th>
                <th>Reziduală</th>
                <th>Metodă</th>
                <th>Durată</th>
                <th>Ultima amortizare</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => {
                const latest = asset.depreciationRecords[0];
                return (
                  <tr key={asset.id}>
                    <td>{asset.code ?? '-'}</td>
                    <td>{asset.name}</td>
                    <td>{fmtCurrency(toNum(asset.value))}</td>
                    <td>{fmtCurrency(toNum(asset.residualValue))}</td>
                    <td>{asset.depreciationMethod}</td>
                    <td>{asset.usefulLifeMonths} luni</td>
                    <td>{latest ? `${latest.period} (${fmtCurrency(toNum(latest.depreciationAmount))})` : 'Neamortizat'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}
