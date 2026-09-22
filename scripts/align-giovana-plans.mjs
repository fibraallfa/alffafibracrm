import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { GIOVANA_AGENT_ID } from '../src/config/giovana.ts';

const prisma = new PrismaClient();
try {
  await prisma.$transaction(async (tx) => {
    const cris = await tx.agent.findFirst({ where: { name: 'Cris', active: true, deletedAt: null }, include: { plans: { orderBy: { id: 'asc' } } } });
    const giovana = await tx.agent.findUniqueOrThrow({ where: { id: GIOVANA_AGENT_ID } });
    assert(cris, 'Cris nao encontrado');
    const plans = cris.plans.filter((plan) => plan.active && !plan.deletedAt);
    assert(plans.length, 'Catalogo vazio');
    const rules = { ...giovana.rules, catalogMode: 'linked', catalogoExclusivo: 'Use somente os planos ativos vinculados a este atendimento, iguais ao catalogo do Cris. Nunca ofereca ofertas antigas ou invente valores.' };
    delete rules.recommendedPlanId;
    if (cris.rules?.recommendedPlanId) rules.recommendedPlanId = cris.rules.recommendedPlanId;
    await tx.agent.update({ where: { id: giovana.id }, data: { rules, plans: { set: plans.map(({ id }) => ({ id })) } } });
    const after = await tx.agent.findUnique({ where: { id: cris.id }, include: { plans: { orderBy: { id: 'asc' } } } });
    assert.deepEqual(after, cris, 'Cris deve permanecer identico');
    console.log(JSON.stringify({ agent: 'Giovana', plans: plans.map(({ name, price }) => ({ name, price })), crisUnchanged: true }));
  }, { timeout: 30000 });
} finally { await prisma.$disconnect(); }
