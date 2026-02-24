function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildSimplePdf(lines: string[]): Buffer {
  const linesPerPage = 52;
  const normalizedLines = lines.length > 0 ? lines : [''];
  const pages: string[][] = [];

  for (let index = 0; index < normalizedLines.length; index += linesPerPage) {
    pages.push(normalizedLines.slice(index, index + linesPerPage));
  }

  const pageCount = pages.length;
  const firstPageObjectId = 3;
  const fontObjectId = firstPageObjectId + pageCount;
  const firstContentObjectId = fontObjectId + 1;
  const totalObjects = firstContentObjectId + pageCount - 1;

  const objects = new Map<number, string>();
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');

  const pageRefList = Array.from({ length: pageCount }, (_value, pageIndex) => `${firstPageObjectId + pageIndex} 0 R`).join(' ');
  objects.set(2, `<< /Type /Pages /Kids [${pageRefList}] /Count ${pageCount} >>`);

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageObjectId = firstPageObjectId + pageIndex;
    const contentObjectId = firstContentObjectId + pageIndex;
    const pageLines = pages[pageIndex] ?? [];

    const contentLines = ['BT', '/F1 11 Tf', '14 TL', '50 790 Td'];
    for (let lineIndex = 0; lineIndex < pageLines.length; lineIndex += 1) {
      const line = escapePdfText(pageLines[lineIndex] ?? '');
      contentLines.push(`(${line}) Tj`);
      if (lineIndex < pageLines.length - 1) {
        contentLines.push('T*');
      }
    }
    contentLines.push('ET');
    const contentStream = contentLines.join('\n');

    objects.set(
      pageObjectId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
    );
    objects.set(
      contentObjectId,
      `<< /Length ${Buffer.byteLength(contentStream, 'utf8')} >>\nstream\n${contentStream}\nendstream`,
    );
  }

  objects.set(fontObjectId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];

  for (let objectId = 1; objectId <= totalObjects; objectId += 1) {
    const objectBody = objects.get(objectId);
    if (!objectBody) {
      throw new Error(`Lipsește obiectul PDF cu id ${objectId}.`);
    }
    offsets[objectId] = Buffer.byteLength(pdf, 'utf8');
    pdf += `${objectId} 0 obj\n${objectBody}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${totalObjects + 1}\n`;
  pdf += '0000000000 65535 f \n';

  for (let objectId = 1; objectId <= totalObjects; objectId += 1) {
    pdf += `${String(offsets[objectId] ?? 0).padStart(10, '0')} 00000 n \n`;
  }

  pdf += 'trailer\n';
  pdf += `<< /Size ${totalObjects + 1} /Root 1 0 R >>\n`;
  pdf += 'startxref\n';
  pdf += `${xrefOffset}\n`;
  pdf += '%%EOF';

  return Buffer.from(pdf, 'utf8');
}
