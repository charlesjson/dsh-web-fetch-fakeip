/** Small valid PDF generated in memory; tests do not require downloaded fixtures. */
export function makePdf(pages = ['A PDF document']) {
  const objects = [], add = content => { objects.push(content); return objects.length }
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const ids = pages.map(text => {
    const page = add(''), stream = text === null ? '0 0 100 100 re S' : `BT /F1 12 Tf 30 700 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
    objects[page - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`
    return page
  })
  objects[1] = `<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(' ')}] /Count ${ids.length} >>`
  let source = '%PDF-1.4\n', offsets = [0]
  objects.forEach((content, index) => { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${content}\nendobj\n` })
  const xref = Buffer.byteLength(source)
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(source)
}
