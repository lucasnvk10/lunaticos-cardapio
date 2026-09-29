import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {describe,it,expect} from 'vitest';
import {scannerLink,joinScanner,listOrders,pareto,team} from '../worker/services/management';
import {getOperationalReport} from '../worker/services/admin';
import {createPaymentOrder} from '../worker/services/orders';
import type {Bindings,AuthenticatedOperator} from '../worker/types';

function setup() {
  const db=new DatabaseSync(':memory:');
  for(const file of ['migrations/0001_initial.sql','migrations/0002_admin_credentials.sql','db/seed.sql','migrations/0008_eventos_operator_role.sql','migrations/0013_team_and_visits.sql']) db.exec(readFileSync(file,'utf8'));
  db.exec("INSERT INTO operators(id,event_id,display_name,role) VALUES ('admin','evt_piloto','Admin','ADMIN')");
  const prepare=(sql:string)=>{
    let args:Array<string|number|null>=[];
    const execute=()=>{const stmt=db.prepare(sql);const results=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);return {results,success:true,meta:{changes:Number(db.prepare('SELECT changes() AS n').get()!.n)}};};
    return {bind(...values:Array<string|number|null>){args=values;return this;},_execute:execute,async first(){return execute().results[0]??null;},async all(){return execute();},async run(){return execute();}};
  };
  const DB={prepare,async batch(statements:Array<ReturnType<typeof prepare>>){db.exec('BEGIN');try{const rows=statements.map(s=>s._execute());db.exec('COMMIT');return rows;}catch(e){db.exec('ROLLBACK');throw e;}}} as unknown as D1Database;
  const env={DB,APP_ORIGIN:'http://localhost:8787'} as Bindings;
  const operator={id:'admin',eventId:'evt_piloto',role:'ADMIN'} as AuthenticatedOperator;
  return {db,env,operator};
}

describe('gestão do evento',()=>{
  it('novo checkout guarda telefone normalizado e rejeita número incompleto',async()=>{
    const {db,env}=setup();
    env.PAYMENTS_MODE='mock';env.TOKEN_ENCRYPTION_KEY='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const input={eventSlug:'evento-piloto',idempotencyKey:'checkout_management_telephone_001',accessToken:'a'.repeat(48),customer:{name:'Cliente teste',taxId:'52998224725',phone:'(41) 99999-9999'},items:[{productId:'prd_cerveja',quantity:1}]};
    await createPaymentOrder(env,input);
    expect(db.prepare('SELECT customer_phone FROM orders').get()!.customer_phone).toBe('41999999999');
    await expect(createPaymentOrder(env,{...input,customer:{...input.customer,phone:'123'}})).rejects.toMatchObject({code:'INVALID_PHONE'});
  });
  it('link direto identifica leitores individuais e fixa acesso EVENTOS',async()=>{
    const {db,env,operator}=setup();
    const link=await scannerLink(env,operator);
    const token=new URLSearchParams(new URL(link.activationUrl).hash.slice(1)).get('token')!;
    const a=await joinScanner(env,token,'Bruno');const b=await joinScanner(env,token,'Maria');
    expect(a.id).not.toBe(b.id);
    expect(db.prepare('SELECT role FROM operators WHERE id=?').get(a.id)!.role).toBe('EVENTOS');
    expect((await team(env,operator.eventId)).length).toBe(3);
    db.exec('UPDATE scanner_invites SET max_uses=2');
    await expect(joinScanner(env,token,'Terceiro')).rejects.toMatchObject({code:'INVITE_INVALID'});
    expect(db.prepare('SELECT COUNT(*) AS n FROM operators').get()!.n).toBe(3);
  });
  it('links expirados ou revogados não criam operadores',async()=>{
    const {db,env,operator}=setup();const link=await scannerLink(env,operator);
    const token=new URLSearchParams(new URL(link.activationUrl).hash.slice(1)).get('token')!;
    db.exec("UPDATE scanner_invites SET expires_at=datetime('now','-1 minute')");
    await expect(joinScanner(env,token,'Teste')).rejects.toMatchObject({code:'INVITE_INVALID'});
    db.exec("UPDATE scanner_invites SET expires_at=datetime('now','+1 day'),revoked_at=CURRENT_TIMESTAMP");
    await expect(joinScanner(env,token,'Teste')).rejects.toMatchObject({code:'INVITE_INVALID'});
    expect(db.prepare('SELECT COUNT(*) AS n FROM operators').get()!.n).toBe(1);
  });
  it('consulta nome, telefone e pedido, sem CPF ou segredo; escapa curingas e respeita evento',async()=>{
    const {db,env}=setup();
    db.exec(`INSERT INTO orders (id,public_id,event_id,kind,status,idempotency_key,access_token_hash,amount_cents,customer_name,customer_tax_id,customer_phone)
      VALUES ('o1','pedido_001','evt_piloto','PAYMENT','PAID','idem1','secret',2000,'Maria','52998224725','41999999999');
      INSERT INTO order_items(id,event_id,order_id,product_id,product_name,unit_price_cents,quantity,total_cents)
      VALUES ('i1','evt_piloto','o1','prd_chevette','Chevette',1000,2,2000);`);
    for(const q of ['maria','(41) 99999-9999','pedido_001']) {
      const result=await listOrders(env,'evt_piloto',q,1);
      expect(result.total).toBe(1);expect(result.orders[0].items).toMatchObject([{name:'Chevette',quantity:2}]);
      expect(JSON.stringify(result)).not.toContain('52998224725');expect(JSON.stringify(result)).not.toContain('secret');
    }
    expect((await listOrders(env,'evt_piloto','52998224725',1)).total).toBe(0);
    expect((await listOrders(env,'evt_piloto','%',1)).total).toBe(0);
    expect((await listOrders(env,'another','Maria',1)).total).toBe(0);
    const report=await getOperationalReport(env,'evt_piloto');
    expect(report.summary.revenueCents).toBe(2000);expect(report.summary.paidOrders).toBe(1);
    expect(report.detailedSales[0].orderPublicId).toBe('pedido_001');expect(report.stockSummary[0].productName).toBeTruthy();
  });
  it('Pareto inclui o produto que cruza 80%, descarta zeros e soma 100%',()=>{
    const rows=pareto([{productName:'C',revenueCents:100,paidUnits:1},{productName:'A',revenueCents:600,paidUnits:3},{productName:'B',revenueCents:300,paidUnits:2},{productName:'zero',revenueCents:0,paidUnits:0}]);
    expect(rows.map(r=>r.priority)).toEqual([true,true,false]);expect(rows[2].cumulative).toBe(100);expect(pareto([])).toEqual([]);
  });
});
