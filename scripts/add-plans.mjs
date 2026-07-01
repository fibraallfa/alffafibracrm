import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const envPath = path.resolve(".env");

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] ??= value;
  }
}

const prisma = new PrismaClient();

const plans = [
  {
    name: "Plano 250Mb",
    speed: "250Mb",
    price: 89.9,
    description: "Plano 250Mb + Globoplay",
    order: 1,
  },
  {
    name: "Plano 500Mb",
    speed: "500Mb",
    price: 99.9,
    description: "Plano 500Mb + Globoplay",
    order: 2,
  },
  {
    name: "Plano 1Gb",
    speed: "1Gb",
    price: 199.9,
    description: "Plano 1Gb + Globoplay",
    order: 3,
  },
  {
    name: "Plano 250Mb + Chip",
    speed: "250Mb + Chip",
    price: 119.8,
    description: "Plano 250Mb + Chip + Globoplay",
    order: 4,
  },
  {
    name: "Plano 500Mb + Chip",
    speed: "500Mb + Chip",
    price: 139.8,
    description: "Plano 500Mb + Chip + Globoplay",
    order: 5,
  },
  {
    name: "Plano 1Gb + Chip",
    speed: "1Gb + Chip",
    price: 189.8,
    description: "Plano 1Gb + Chip + Globoplay",
    order: 6,
  },
];

const legacyPlanNames = ["ALFFA Start", "ALFFA Plus", "ALFFA Ultra"];

async function main() {
  await prisma.plan.updateMany({
    where: {
      name: { in: legacyPlanNames },
      deletedAt: null,
    },
    data: {
      active: false,
      deletedAt: new Date(),
    },
  });

  for (const plan of plans) {
    const existing = await prisma.plan.findFirst({
      where: { name: plan.name, deletedAt: null },
    });

    if (existing) {
      await prisma.plan.update({
        where: { id: existing.id },
        data: { ...plan, active: true },
      });
      console.log(`atualizado: ${plan.name}`);
    } else {
      await prisma.plan.create({ data: { ...plan, active: true } });
      console.log(`criado: ${plan.name}`);
    }
  }

  const activePlans = await prisma.plan.findMany({
    where: { deletedAt: null, active: true },
    orderBy: [{ order: "asc" }, { createdAt: "desc" }],
    select: { name: true, price: true },
  });

  console.log(`planos ativos: ${activePlans.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
