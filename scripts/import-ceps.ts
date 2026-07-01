import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prisma } from "@/lib/prisma";
import { CepImportService } from "@/modules/ceps/services/cep-import.service";

async function main() {
  const filePath = resolve(process.cwd(), "data/CEPS_CRIS_ABR_26.xlsx");
  console.log(`Lendo arquivo: ${filePath}`);
  const buffer = await readFile(filePath);
  const service = new CepImportService();
  const result = await service.importFromBuffer(
    buffer,
    "CEPS_CRIS_ABR_26.xlsx",
    (processed, total) => {
      console.log(`Processados ${processed}/${total} CEPs`);
    },
  );
  console.log(`Importacao concluida: ${result.imported}/${result.totalRows} linhas.`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
