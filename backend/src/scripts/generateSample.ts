import path from 'path';
import ExcelJS from 'exceljs';

async function main(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Contacts');
  sheet.addRow(['Email', 'Contact name', 'Company', 'Designation', 'Website', 'Source']);
  const rows = [
    ['mira.patel@northwind.example', 'Mira Patel', 'Northwind Analytics', 'Talent Partner', 'https://northwind.example', 'Sample list'],
    ['mira.patel@northwind.example', 'Mira Patel', 'Northwind Analytics', 'Talent Partner', 'https://northwind.example', 'Sample list'],
    ['not-an-email', 'Dev Shah', 'Contoso Cloud', 'Engineering Manager', 'https://contoso.example', 'Sample list'],
    ['', 'Missing Email', 'Fabrikam', 'Recruiter', 'https://fabrikam.example', 'Sample list'],
    ['avery.chen@adventureworks.example', '', 'Adventure Works', 'Hiring Manager', 'https://adventureworks.example', 'Sample list'],
    ['r.iyer@litware.example', 'R. Iyer', '', 'Procurement Lead', '', 'Sample list'],
    ['jordan.lee@wideworld.example', 'Jordan Lee', 'Wide World Importers', 'IT Director', 'https://wideworld.example', 'Sample list'],
  ];
  for (const row of rows) sheet.addRow(row);
  const destination = path.resolve(__dirname, '../../../examples/sample-contacts.xlsx');
  await workbook.xlsx.writeFile(destination);
  console.log(`Wrote ${destination}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
