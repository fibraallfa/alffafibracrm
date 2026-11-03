import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
const {outputText}=ts.transpileModule(fs.readFileSync(new URL('../src/lib/database-config.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}});
const {runtimeDatabaseUrl,databaseProjectRef}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const connection='postgresql://postgres.abcdefghijklmnopqrst:fixture-password@aws-1-us-east-2.pooler.supabase.com:6543/postgres?sslmode=require&pool_timeout=17';
test('serverless pool tuning preserves database identity, credentials, and explicit timeouts',()=>{
 const original=new URL(connection),updated=new URL(runtimeDatabaseUrl(connection,true));
 for(const field of ['host','username','password','pathname'])assert.equal(updated[field],original[field]);
 assert.equal(updated.searchParams.get('sslmode'),'require');
 assert.equal(updated.searchParams.get('connection_limit'),'1');
 assert.equal(updated.searchParams.get('pool_timeout'),'17');
 assert.equal(updated.searchParams.get('pgbouncer'),'true');
 assert.equal(runtimeDatabaseUrl(connection,false),connection);
});
test('health exposes only a validated Supabase project reference',()=>{
 assert.equal(databaseProjectRef(connection),'abcdefghijklmnopqrst');
 assert.equal(databaseProjectRef('postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co/postgres'),'abcdefghijklmnopqrst');
 assert.equal(databaseProjectRef('postgresql://user:secret@localhost/postgres'),null);
 assert.equal(databaseProjectRef('invalid'),null);
});
