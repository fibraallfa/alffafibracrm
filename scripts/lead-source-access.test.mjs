import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationAgentWhere, leadSourceWhere, getLeadAgentScope } from '../src/lib/lead-source-access.ts';
import { LeadRepository } from '../src/repositories/lead.repository.ts';
import { prisma } from '../src/lib/prisma.ts';

for (const [flags, expected] of [[{}, {}], [{'leads.onlyCris': true}, {source:{in:['chatbot','chatbot:cris']}}], [{'leads.onlyGiovana':true},{source:'chatbot:giovana'}]]) {
  test(`employee source filter ${JSON.stringify(flags)}`, async (t) => {
    const user={id:'employee',role:'EMPLOYEE',permissions:flags};
    assert.deepEqual(leadSourceWhere(user),expected);
    const originalMany=prisma.lead.findMany, originalFirst=prisma.lead.findFirst;
    const queries=[];
    prisma.lead.findMany=async ({where})=>{queries.push(where);return [];};
    prisma.lead.findFirst=async ({where})=>{queries.push(where);return null;};
    t.after(()=>{prisma.lead.findMany=originalMany;prisma.lead.findFirst=originalFirst;});
    const repo=new LeadRepository();
    await repo.findMany(user);
    await repo.findById('lead',user);
    assert.deepEqual(queries[0],{deletedAt:null,...expected,assignedUserId:'employee'});
    assert.deepEqual(queries[1],{id:'lead',deletedAt:null,...expected,assignedUserId:'employee'});
  });
}
test('explicit chatbot restriction also applies to administrators',()=>{
  assert.deepEqual(leadSourceWhere({id:'admin',role:'ADMIN',permissions:{'leads.onlyGiovana':true}}),{source:'chatbot:giovana'});
  assert.equal(conversationAgentWhere({id:'admin',role:'ADMIN',permissions:{'leads.onlyGiovana':true}}).agentId, 'a8b1e073-d32a-4c11-8b8b-0b15b829aec1');
  assert.equal(getLeadAgentScope(null),'both');
  assert.equal(getLeadAgentScope({}),'both');
});
