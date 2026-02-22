import { env } from '../config/env.js';

export type AnafDeclarationType =
  | 'd300'
  | 'd394'
  | 'd112'
  | 'd101'
  | 'd100'
  | 'd205'
  | 'd392'
  | 'd393'
  | 'd406';

export interface AnafProfileValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function normalizeCui(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

export function bareCui(raw: string): string {
  const normalized = normalizeCui(raw);
  return normalized.startsWith('RO') ? normalized.slice(2) : normalized;
}

export function declarationCode(type: AnafDeclarationType): string {
  const codeByType: Record<AnafDeclarationType, string> = {
    d300: 'D300',
    d394: 'D394',
    d112: 'D112',
    d101: 'D101',
    d100: 'D100',
    d205: 'D205',
    d392: 'D392',
    d393: 'D393',
    d406: 'D406',
  };

  return codeByType[type];
}

export function validateAnafProfile(
  type: AnafDeclarationType,
  data: {
    period: string;
    rowCount: number;
  },
): AnafProfileValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!/^\d{4}-\d{2}$/.test(data.period)) {
    errors.push('Perioada trebuie să fie în format YYYY-MM.');
  }

  const companyName = env.ANAF_COMPANY_NAME.trim();
  const companyCui = normalizeCui(env.ANAF_COMPANY_CUI);
  const companyAddress = env.ANAF_COMPANY_ADDRESS.trim();
  const declarantName = env.ANAF_DECLARANT_NAME.trim();
  const declarantFunction = env.ANAF_DECLARANT_FUNCTION.trim();

  if (companyName.length < 2) {
    errors.push('ANAF_COMPANY_NAME este obligatoriu.');
  }

  if (!/^RO?\d{2,12}$/i.test(companyCui)) {
    errors.push('ANAF_COMPANY_CUI trebuie să conțină un CUI valid (ex. RO12345678).');
  }

  if (companyAddress.length < 5) {
    errors.push('ANAF_COMPANY_ADDRESS este obligatoriu.');
  }

  if (declarantName.length < 2) {
    errors.push('ANAF_DECLARANT_NAME este obligatoriu.');
  }

  if (declarantFunction.length < 2) {
    errors.push('ANAF_DECLARANT_FUNCTION este obligatoriu.');
  }

  if (companyCui === 'RO00000000' || bareCui(companyCui) === '00000000') {
    warnings.push('CUI-ul este încă pe valoarea demo. Actualizează ANAF_COMPANY_CUI.');
  }

  if (companyName.toLowerCase().includes('demo')) {
    warnings.push('Numele companiei este pe profil demo. Actualizează ANAF_COMPANY_NAME.');
  }

  if (data.rowCount === 0) {
    warnings.push(`Declarația ${declarationCode(type)} nu are date pentru perioada selectată.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
