import type { Dispatch, SetStateAction } from 'react';
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
  return (
    <section className="split-layout">
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
      </article>

      <article className="panel">
        <h3>State salarii ({payrollRuns.length})</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Perioadă</th>
                <th>Brut total</th>
                <th>Net total</th>
                <th>CAS</th>
                <th>CASS</th>
                <th>CAM</th>
                <th>Impozit</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {payrollRuns.map((run) => (
                <tr key={run.id}>
                  <td>{run.period}</td>
                  <td>{fmtCurrency(toNum(run.totalGross))}</td>
                  <td>{fmtCurrency(toNum(run.totalNet))}</td>
                  <td>{fmtCurrency(toNum(run.totalCas))}</td>
                  <td>{fmtCurrency(toNum(run.totalCass))}</td>
                  <td>{fmtCurrency(toNum(run.totalCam))}</td>
                  <td>{fmtCurrency(toNum(run.totalTax))}</td>
                  <td>{run.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 style={{ marginTop: '1rem' }}>Angajați ({employees.length})</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nume</th>
                <th>CNP</th>
                <th>Contract</th>
                <th>Brut</th>
                <th>Deducere</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((employee) => (
                <tr key={employee.id}>
                  <td>{employee.name}</td>
                  <td>{employee.cnp}</td>
                  <td>{employee.contractType}</td>
                  <td>{fmtCurrency(toNum(employee.grossSalary))}</td>
                  <td>{fmtCurrency(toNum(employee.personalDeduction))}</td>
                  <td>{employee.isActive ? 'Activ' : 'Inactiv'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}
