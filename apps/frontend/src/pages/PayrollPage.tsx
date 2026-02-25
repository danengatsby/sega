import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { Employee, PayrollRun } from '../types';

interface EmployeeFormState {
  cnp: string;
  name: string;
  contractType: string;
  grossSalary: string;
  personalDeduction: string;
}

interface PayrollFormState {
  period: string;
}

interface PayrollPageProps {
  employeeForm: EmployeeFormState;
  setEmployeeForm: Dispatch<SetStateAction<EmployeeFormState>>;
  createEmployee: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canCreateEmployee: boolean;
  payrollForm: PayrollFormState;
  setPayrollForm: Dispatch<SetStateAction<PayrollFormState>>;
  runPayroll: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canRunPayroll: boolean;
  busyKey: string | null;
  payrollRuns: PayrollRun[];
  employees: Employee[];
  fmtCurrency: (value: number) => string;
  toNum: (value: string | number) => number;
}

export function PayrollPage({
  employeeForm,
  setEmployeeForm,
  createEmployee,
  canCreateEmployee,
  payrollForm,
  setPayrollForm,
  runPayroll,
  canRunPayroll,
  busyKey,
  payrollRuns,
  employees,
  fmtCurrency,
  toNum,
}: PayrollPageProps) {
  const [selectedPayrollRunId, setSelectedPayrollRunId] = useState('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const selectedPayrollRun = useMemo(
    () => payrollRuns.find((run) => run.id === selectedPayrollRunId) ?? null,
    [payrollRuns, selectedPayrollRunId],
  );
  const selectedEmployee = useMemo(
    () => employees.find((employee) => employee.id === selectedEmployeeId) ?? null,
    [employees, selectedEmployeeId],
  );

  return (
    <section className="split-layout split-layout-single-column">
      <article className="panel">
        <h3>Administrare salarii</h3>
        {canCreateEmployee ? (
          <form onSubmit={(event) => void createEmployee(event)} className="stack-form">
            <label>
              CNP
              <input
                value={employeeForm.cnp}
                onChange={(event) => setEmployeeForm((prev) => ({ ...prev, cnp: event.target.value }))}
                required
              />
            </label>
            <label>
              Nume complet
              <input
                value={employeeForm.name}
                onChange={(event) => setEmployeeForm((prev) => ({ ...prev, name: event.target.value }))}
                required
              />
            </label>
            <label>
              Tip contract
              <input
                value={employeeForm.contractType}
                onChange={(event) => setEmployeeForm((prev) => ({ ...prev, contractType: event.target.value }))}
                required
              />
            </label>
            <div className="inline-fields">
              <label>
                Brut
                <input
                  type="number"
                  step="0.01"
                  value={employeeForm.grossSalary}
                  onChange={(event) => setEmployeeForm((prev) => ({ ...prev, grossSalary: event.target.value }))}
                  required
                />
              </label>
              <label>
                Deducere
                <input
                  type="number"
                  step="0.01"
                  value={employeeForm.personalDeduction}
                  onChange={(event) => setEmployeeForm((prev) => ({ ...prev, personalDeduction: event.target.value }))}
                />
              </label>
            </div>
            <button type="submit" disabled={busyKey === 'employee'}>
              {busyKey === 'employee' ? 'Salvare...' : 'Salvează angajat'}
            </button>
          </form>
        ) : (
          <p className="muted">Nu ai permisiunea de a adăuga sau modifica angajați.</p>
        )}

        <h3 style={{ marginTop: '1rem' }}>Rulare stat salarii</h3>
        {canRunPayroll ? (
          <form onSubmit={(event) => void runPayroll(event)} className="stack-form">
            <label>
              Perioadă
              <input
                type="month"
                value={payrollForm.period}
                onChange={(event) => setPayrollForm({ period: event.target.value })}
                required
              />
            </label>
            <button type="submit" disabled={busyKey === 'payroll'}>
              {busyKey === 'payroll' ? 'Procesare...' : 'Generează salarii + note contabile'}
            </button>
          </form>
        ) : (
          <p className="muted">Nu ai permisiunea de a genera state de salarii.</p>
        )}
        <h3 style={{ marginTop: '1rem' }}>State salarii ({payrollRuns.length})</h3>
        <label>
          Lista statelor de salarii
          <select
            className="accounts-overflow-select"
            size={12}
            value={selectedPayrollRunId}
            onChange={(event) => setSelectedPayrollRunId(event.target.value)}
          >
            <option value="" disabled>
              Selectează statul
            </option>
            {payrollRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {run.period} · Brut {fmtCurrency(toNum(run.totalGross))} · Net {fmtCurrency(toNum(run.totalNet))} · {run.status}
              </option>
            ))}
          </select>
        </label>
        {selectedPayrollRun ? (
          <div className="timeline-item journal-entry-preview">
            <header>
              <strong>Stat salarii: {selectedPayrollRun.period}</strong>
              <span>{selectedPayrollRun.status}</span>
            </header>
            <div className="journal-entry-preview-lines">
              <div>Brut total: {fmtCurrency(toNum(selectedPayrollRun.totalGross))}</div>
              <div>Net total: {fmtCurrency(toNum(selectedPayrollRun.totalNet))}</div>
              <div>CAS: {fmtCurrency(toNum(selectedPayrollRun.totalCas))}</div>
              <div>CASS: {fmtCurrency(toNum(selectedPayrollRun.totalCass))}</div>
              <div>CAM: {fmtCurrency(toNum(selectedPayrollRun.totalCam))}</div>
              <div>Impozit: {fmtCurrency(toNum(selectedPayrollRun.totalTax))}</div>
            </div>
          </div>
        ) : (
          <p className="muted">Selectează un stat de salarii din listă.</p>
        )}

        <h3 style={{ marginTop: '1rem' }}>Angajați ({employees.length})</h3>
        <label>
          Lista angajaților
          <select
            className="accounts-overflow-select"
            size={12}
            value={selectedEmployeeId}
            onChange={(event) => setSelectedEmployeeId(event.target.value)}
          >
            <option value="" disabled>
              Selectează angajatul
            </option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name} · {employee.contractType} · {fmtCurrency(toNum(employee.grossSalary))} ·{' '}
                {employee.isActive ? 'Activ' : 'Inactiv'}
              </option>
            ))}
          </select>
        </label>
        {selectedEmployee ? (
          <div className="timeline-item journal-entry-preview">
            <header>
              <strong>{selectedEmployee.name}</strong>
              <span>{selectedEmployee.isActive ? 'Activ' : 'Inactiv'}</span>
            </header>
            <div className="journal-entry-preview-lines">
              <div>CNP: {selectedEmployee.cnp}</div>
              <div>Contract: {selectedEmployee.contractType}</div>
              <div>Salariu brut: {fmtCurrency(toNum(selectedEmployee.grossSalary))}</div>
              <div>Deducere personală: {fmtCurrency(toNum(selectedEmployee.personalDeduction))}</div>
              <div>Data angajării: {new Date(selectedEmployee.hiredAt).toLocaleDateString('ro-RO')}</div>
            </div>
          </div>
        ) : (
          <p className="muted">Selectează un angajat din listă.</p>
        )}
      </article>
    </section>
  );
}
