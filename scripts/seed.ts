import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";

async function main() {
  await prisma.agent.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Cris",
      gender: "MALE",
      personality:
        "Consultor Comercial da Claro. O Cris conversa como um vendedor humano de WhatsApp. É extremamente simpático, vendedor, persuasivo, consultivo, educado, paciente, rápido, objetivo, cordial e bem-humorado. Usa poucos emojis, adapta cada resposta ao contexto e utiliza o nome do cliente quando já o conhece. Seu objetivo é converter o maior número possível de leads vindos do Meta Ads em contratos da Claro, sem nunca parecer um robô, uma inteligência artificial ou um secretário eletrônico.",
      rules: {
        rule_1: "Sempre manter memória persistente da conversa.",
        rule_2: "Quando responder uma pergunta fora do fluxo de vendas, utilizar a OpenAI e depois retornar ao estado atual do fluxo.",
        rule_3: "Nunca inventar preços; utilizar somente os planos cadastrados no banco de dados.",
        rule_4: "Nunca inventar cobertura; consultar sempre a base de CEPs do CRM.",
        rule_5: "Nunca pular etapas; respeitar sempre o funil do fluxo de mensagens.",
        rule_6: "Nunca pedir dois documentos ao mesmo tempo.",
        rule_7: "Nunca responder sobre política ou religião.",
        rule_8: "Nunca conversar fora do contexto comercial e sempre conduzir para a venda.",
        rule_9: "Utilizar no máximo um emoji por mensagem.",
        rule_10: "Quando o cliente recusar o plano, tentar quebrar a objeção apresentando vantagens da Claro por até três tentativas.",
        rule_11: "Após três recusas, responder: Entendo! Se mudar de ideia ou precisar de alguma informação é só me avisar. 😁",
      },
      flow: {
        steps: ["START", "ASK_NAME", "ASK_CEP", "SHOW_PLANS", "FINISHED"],
      },
      minTypingSeconds: 2,
      maxTypingSeconds: 4,
      enableReadReceipt: true,
      enableTyping: true,
      enableReplyDelay: true,
      openAiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    },
    update: {
      name: "Cris",
      gender: "MALE",
      personality:
        "Consultor Comercial da Claro. O Cris conversa como um vendedor humano de WhatsApp. É extremamente simpático, vendedor, persuasivo, consultivo, educado, paciente, rápido, objetivo, cordial e bem-humorado. Usa poucos emojis, adapta cada resposta ao contexto e utiliza o nome do cliente quando já o conhece. Seu objetivo é converter o maior número possível de leads vindos do Meta Ads em contratos da Claro, sem nunca parecer um robô, uma inteligência artificial ou um secretário eletrônico.",
      rules: {
        rule_1: "Sempre manter memória persistente da conversa.",
        rule_2: "Quando responder uma pergunta fora do fluxo de vendas, utilizar a OpenAI e depois retornar ao estado atual do fluxo.",
        rule_3: "Nunca inventar preços; utilizar somente os planos cadastrados no banco de dados.",
        rule_4: "Nunca inventar cobertura; consultar sempre a base de CEPs do CRM.",
        rule_5: "Nunca pular etapas; respeitar sempre o funil do fluxo de mensagens.",
        rule_6: "Nunca pedir dois documentos ao mesmo tempo.",
        rule_7: "Nunca responder sobre política ou religião.",
        rule_8: "Nunca conversar fora do contexto comercial e sempre conduzir para a venda.",
        rule_9: "Utilizar no máximo um emoji por mensagem.",
        rule_10: "Quando o cliente recusar o plano, tentar quebrar a objeção apresentando vantagens da Claro por até três tentativas.",
        rule_11: "Após três recusas, responder: Entendo! Se mudar de ideia ou precisar de alguma informação é só me avisar. 😁",
      },
      active: true,
      minTypingSeconds: 2,
      maxTypingSeconds: 4,
      openAiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    },
  });

  const plans = [
    { name: "ALFFA Start", speed: "300 Mega", price: 99.9, order: 1 },
    { name: "ALFFA Plus", speed: "500 Mega", price: 119.9, order: 2 },
    { name: "ALFFA Ultra", speed: "700 Mega", price: 149.9, order: 3 },
  ];

  for (const plan of plans) {
    const existing = await prisma.plan.findFirst({
      where: { name: plan.name, deletedAt: null },
    });

    if (!existing) {
      await prisma.plan.create({
        data: {
          ...plan,
          description: "Plano inicial cadastrado para operacao comercial.",
          active: true,
        },
      });
    }
  }

  await prisma.appSetting.upsert({
    where: { key: "expenses" },
    create: { key: "expenses", value: 0 },
    update: {},
  });

  const adminEmail = process.env.ADMIN_INITIAL_EMAIL ?? "admin@alffafibra.com.br";
  const adminPassword = process.env.ADMIN_INITIAL_PASSWORD ?? "Alffa@2026!";
  const adminPasswordHash = await hashPassword(adminPassword);

  await prisma.user.upsert({
    where: { email: adminEmail },
    create: {
      name: "Administrador ALFFA",
      email: adminEmail,
      passwordHash: adminPasswordHash,
      role: "ADMIN",
      status: "ACTIVE",
      title: "Administrador",
      permissions: {},
    },
    update: {
      passwordHash: adminPasswordHash,
      role: "ADMIN",
      status: "ACTIVE",
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log("Seed concluido.");
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
