import assert from 'node:assert/strict';
import test from 'node:test';
import {ChatbotRepository} from '../src/repositories/chatbot.repository.ts';
import {prisma} from '../src/lib/prisma.ts';
const repo=new ChatbotRepository();
for(const [label,user,scope,expected,excluded] of [
 ['employee owner',{id:'00000000-0000-0000-0000-000000000001',role:'EMPLOYEE'},'both','ownerUserId','agentId'],
 ['restricted administrator',{id:'admin',role:'ADMIN',permissions:{'leads.onlyGiovana':true}},'cris','agentId','ownerUserId'],
 ['Cris administrator',{id:'admin',role:'ADMIN'},'cris','agentId','ownerUserId'],
]){
 test(`summary SQL preserves ${label} access scope and bounds the history`,async t=>{
  const original=prisma.$queryRaw;
  t.after(()=>{prisma.$queryRaw=original;});
  let query;
  prisma.$queryRaw=async q=>{query=q;return [{id:'conversation',state:'ASK_NAME',ownerUserId:null,updatedAt:new Date(),messages:[{direction:'outbound',createdAt:'2026-11-03T00:00:00Z'}]}];};
  const rows=await repo.listConversationSummaries(user,scope);
  assert.match(query.sql,/LIMIT 5/);
  assert.match(query.sql,new RegExp(`AND[^]*${expected}`));
  if(excluded==='ownerUserId')assert.doesNotMatch(query.sql,/AND c\."ownerUserId"/);
  else assert.doesNotMatch(query.sql,/AND \(c\."agentId"/);
  assert(rows[0].messages[0].createdAt instanceof Date);
  assert.equal(query.values.length,1);
 });
}
