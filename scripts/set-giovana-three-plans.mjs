import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { GIOVANA_AGENT_ID } from '../src/config/giovana.ts';

const plans = [
  { id: '92ce3180-e5ba-41da-a001-000000000001', name: '350Mb', speed: '350Mb', price: 89.90, order: 1 },
  { id: '92ce3180-e5ba-41da-a001-000000000002', name: '500Mega + 60Gb (Celular)', speed: '500Mb + 60Gb', price: 129.90, order: 2 },
  { id: '92ce3180-e5ba-41da-a001-000000000004', name: '600Mb', speed: '600Mb', price: 99.90, order: 3 },
  { id: '92ce3180-e5ba-41da-a001-000000000003', name: '1Gb + 60Gb (Celular)', speed: '1Gb + 60Gb', price: 179.90, order: 4 },
];
const prisma = new PrismaClient();
const recommendedPlan = plans.find(({ id }) => id === '92ce3180-e5ba-41da-a001-000000000004');
assert(recommendedPlan, 'Plano recomendado nao encontrado');
try {
  await prisma.$transaction(async (tx) => {
    const cris = await tx.agent.findFirstOrThrow({ where: { name: 'Cris', active: true, deletedAt: null }, include: { plans: { orderBy: { id: 'asc' } } } });
    const giovana = await tx.agent.findUniqueOrThrow({ where: { id: GIOVANA_AGENT_ID } });
    assert.equal(giovana.rules.catalogMode, 'linked', 'Requer suporte ao catalogo vinculado');
    for (const plan of plans) {
      const existing = await tx.plan.findUnique({ where: { id: plan.id }, include: { agents: { select: { id: true } } } });
      if (existing) {
        assert(existing.agents.every(({ id }) => id === GIOVANA_AGENT_ID));
        assert.equal(existing.name, plan.name);
        assert.equal(Number(existing.price), plan.price);
        assert(existing.active && !existing.deletedAt);
      } else {
        await tx.plan.create({ data: { ...plan, description: 'Catalogo Giovana', active: true } });
      }
    }
    await tx.agent.update({ where: { id: giovana.id }, data: {
      plans: { set: plans.map(({ id }) => ({ id })) },
      rules: { ...giovana.rules, recommendedPlanId: recommendedPlan.id,
        catalogoExclusivo: 'Ofereca exclusivamente os quatro planos vinculados: 350Mb por R$ 89,90; 500Mega + 60Gb (Celular) por R$ 129,90; 600Mb por R$ 99,90; 1Gb + 60Gb (Celular) por R$ 179,90. Recomende 600Mb por R$ 99,90. Nao mencione ou ofereca planos antigos ou de outros agentes.' },
    } });
    const after = await tx.agent.findUnique({ where: { id: cris.id }, include: { plans: { orderBy: { id: 'asc' } } } });
    assert.deepEqual(after, cris, 'Cris deve permanecer intacto');
    const result = await tx.agent.findUniqueOrThrow({ where: { id: giovana.id }, include: { plans: { orderBy: { order: 'asc' } } } });
    assert.deepEqual(result.plans.map(({ id }) => id).sort(), plans.map(({ id }) => id).sort());
    assert.equal(result.rules.recommendedPlanId, recommendedPlan.id);
    console.log(JSON.stringify({ plans: result.plans.map(({ name, price }) => ({ name, price })), recommendation: recommendedPlan.name, crisUnchanged: true }));
  }, { timeout: 30000 });
} finally { await prisma.$disconnect(); }
