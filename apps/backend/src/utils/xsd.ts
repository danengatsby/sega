import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import type { AnafDeclarationType } from './anaf.js';

const execFileAsync = promisify(execFile);

export interface XsdValidationResult {
  performed: boolean;
  valid: boolean | null;
  validator: 'xmllint' | 'none';
  schemaPath: string | null;
  errors: string[];
  warnings: string[];
}

const schemaByType: Record<AnafDeclarationType, string> = {
  d300: 'd300.xsd',
  d394: 'd394.xsd',
  d112: 'd112.xsd',
  d101: 'd101.xsd',
  d100: 'd100.xsd',
  d205: 'd205.xsd',
  d392: 'd392.xsd',
  d393: 'd393.xsd',
  d406: 'd406.xsd',
};

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-lc', `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function validateXmlWithXsd(
  type: AnafDeclarationType,
  xml: string,
  requested: boolean,
): Promise<XsdValidationResult> {
  if (!requested && !env.ANAF_VALIDATE_XSD) {
    return {
      performed: false,
      valid: null,
      validator: 'none',
      schemaPath: null,
      errors: [],
      warnings: ['Validarea XSD este dezactivată (ANAF_VALIDATE_XSD=false).'],
    };
  }

  const schemaFileName = schemaByType[type];
  const schemaPath = path.resolve(process.cwd(), env.ANAF_XSD_DIR, schemaFileName);

  if (!(await fileExists(schemaPath))) {
    return {
      performed: false,
      valid: null,
      validator: 'none',
      schemaPath,
      errors: [],
      warnings: [
        `Schema XSD nu există la ${schemaPath}. Copiază fișierul oficial ANAF (${schemaFileName}) în ANAF_XSD_DIR.`,
      ],
    };
  }

  const hasXmllint = await commandExists('xmllint');
  if (!hasXmllint) {
    return {
      performed: false,
      valid: null,
      validator: 'none',
      schemaPath,
      errors: [],
      warnings: ['Comanda xmllint nu este instalată. Nu se poate executa validarea XSD locală.'],
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sega-anaf-'));
  const xmlPath = path.join(tempDir, `${type}.xml`);

  try {
    await fs.writeFile(xmlPath, xml, 'utf8');

    try {
      await execFileAsync('xmllint', ['--noout', '--schema', schemaPath, xmlPath]);
      return {
        performed: true,
        valid: true,
        validator: 'xmllint',
        schemaPath,
        errors: [],
        warnings: [],
      };
    } catch (error) {
      const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: string }).stderr ?? '') : '';
      const parsedErrors = stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      return {
        performed: true,
        valid: false,
        validator: 'xmllint',
        schemaPath,
        errors: parsedErrors.length > 0 ? parsedErrors : ['Validarea XSD a eșuat fără detalii.'],
        warnings: [],
      };
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
