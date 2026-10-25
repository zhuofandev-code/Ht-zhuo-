require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({limit:'2mb'}));
const origins = (process.env.FRONTEND_ORIGIN || '*').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({origin:(origin,cb)=>!origin||origins.includes('*')||origins.includes(origin)?cb(null,true):cb(new Error('Origine CORS non autorisée')),credentials:false}));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? {rejectUnauthorized:false}:false
});
const SECRET = process.env.JWT_SECRET;
if (!SECRET) console.warn('ATTENTION: configure JWT_SECRET dans Render.');
const q = (sql,params=[])=>pool.query(sql,params);
const cleanEmail = e=>String(e||'').trim().toLowerCase();
const money = n=>Number.isFinite(Number(n)) && Number(n)>=0 ? Math.round(Number(n)*100)/100 : null;
function token(u){return jwt.sign({id:u.id,email:u.email,role:u.role},SECRET,{expiresIn:'14d'});}
function auth(req,res,next){
  const h=req.headers.authorization||'', t=h.startsWith('Bearer ')?h.slice(7):'';
  if(!t)return res.status(401).json({error:'Connexion requise'});
  try{req.claims=jwt.verify(t,SECRET);next()}catch(e){return res.status(401).json({error:'Session expirée, reconnecte-toi'});}
}
async function user(req,res,next){try{const r=await q('SELECT id,name,pseudo,email,role,balance,created_at FROM users WHERE id=$1',[req.claims.id]);if(!r.rowCount)return res.status(401).json({error:'Compte introuvable'});req.user=r.rows[0];next()}catch(e){next(e)}}
const admin=(req,res,next)=>req.user&&req.user.role==='admin'?next():res.status(403).json({error:'Accès réservé à l’administrateur'});
async function setup(){
 await q(`CREATE TABLE IF NOT EXISTS users(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,pseudo TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',balance NUMERIC(12,2) NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 // Compatibility migration: Render may already contain an older users table.
 // CREATE TABLE IF NOT EXISTS does not add columns to an existing table.
 await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`);
 await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pseudo TEXT`);
 await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
 await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
 await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'`);
 await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC(12,2) NOT NULL DEFAULT 0`);
 await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
 await q(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users(email) WHERE email IS NOT NULL`);

 await q(`CREATE TABLE IF NOT EXISTS deposits(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id),amount NUMERIC(12,2) NOT NULL,method TEXT NOT NULL,reference TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),reviewed_at TIMESTAMPTZ)`);
 await q(`CREATE TABLE IF NOT EXISTS orders(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id),game TEXT NOT NULL,package_name TEXT NOT NULL,player_id TEXT NOT NULL DEFAULT '',amount NUMERIC(12,2) NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 await q(`CREATE TABLE IF NOT EXISTS packages(id BIGSERIAL PRIMARY KEY,game TEXT NOT NULL,name TEXT NOT NULL,price NUMERIC(12,2) NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 await q(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value JSONB NOT NULL DEFAULT '{}'::jsonb)`);
 await q(`CREATE TABLE IF NOT EXISTS spin_history(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id),cost NUMERIC(12,2) NOT NULL,result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 await q(`INSERT INTO settings(key,value) VALUES ('guide','{"channel":"","video":""}'::jsonb) ON CONFLICT(key) DO NOTHING`);
 const email=cleanEmail(process.env.ADMIN_EMAIL), pass=process.env.ADMIN_PASSWORD;
 if(email&&pass){
  const existing=await q('SELECT id FROM users WHERE email=$1',[email]);
  const hash=await bcrypt.hash(pass,12);
  if(existing.rowCount) await q("UPDATE users SET role='admin',password_hash=$2 WHERE email=$1",[email,hash]);
  else await q("INSERT INTO users(name,pseudo,email,password_hash,role) VALUES($1,$1,$2,$3,'admin')",[process.env.ADMIN_NAME||'Zhuo Fan',email,hash]);
 }
}
app.get('/healthz',async(req,res)=>{try{await q('SELECT 1');res.json({ok:true,service:'ZHUO FAN HT API',database:'connected',time:new Date().toISOString()})}catch(e){res.status(503).json({ok:false,service:'ZHUO FAN HT API',database:'disconnected',error:'Database non configurée'})}});
app.get('/',(req,res)=>res.json({name:'ZHUO FAN HT API',status:'online',health:'/healthz',docs:'/api'}));
app.get('/api',(req,res)=>res.json({auth:['POST /api/auth/register','POST /api/auth/login','GET /api/me'],wallet:['GET /api/wallet','POST /api/deposits','GET /api/deposits'],orders:['GET /api/orders','POST /api/orders'],admin:['GET /api/admin/overview','GET /api/admin/deposits','PATCH /api/admin/deposits/:id','GET /api/admin/orders','PATCH /api/admin/orders/:id','POST /api/admin/packages','PATCH /api/admin/packages/:id','PATCH /api/admin/settings'],spin:['POST /api/spin'],guide:['GET /api/guide','PUT /api/admin/guide']}));
app.post('/api/auth/register',async(req,res,next)=>{try{
 const name=String(req.body.name||req.body.fullName||req.body.pseudo||'').trim();
 const email=cleanEmail(req.body.email), password=String(req.body.password||'');
 if(name.length<2)return res.status(400).json({error:'Entre ton nom complet (2 caractères minimum)'});
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))return res.status(400).json({error:'Adresse e-mail invalide'});
 if(password.length<6)return res.status(400).json({error:'Mot de passe: 6 caractères minimum'});
 const hash=await bcrypt.hash(password,12);
 const r=await q('INSERT INTO users(name,pseudo,email,password_hash) VALUES($1,$1,$2,$3) RETURNING id,name,pseudo,email,role,balance,created_at',[name,email,hash]);
 const u=r.rows[0];res.status(201).json({token:token(u),user:u});
}catch(e){if(e.code==='23505')return res.status(409).json({error:'Cette adresse e-mail possède déjà un compte'});next(e)}});
app.post('/api/auth/login',async(req,res,next)=>{try{
 const email=cleanEmail(req.body.email),password=String(req.body.password||'');
 const r=await q('SELECT * FROM users WHERE email=$1',[email]);
 if(!r.rowCount||!(await bcrypt.compare(password,r.rows[0].password_hash)))return res.status(401).json({error:'E-mail ou mot de passe incorrect'});
 const u=r.rows[0];res.json({token:token(u),user:{id:u.id,name:u.name,pseudo:u.pseudo,email:u.email,role:u.role,balance:u.balance}});
}catch(e){next(e)}});
app.get('/api/me',auth,user,(req,res)=>res.json({user:req.user}));
app.get('/api/wallet',auth,user,(req,res)=>res.json({balance:Number(req.user.balance)}));
app.get('/api/deposits',auth,user,async(req,res,next)=>{try{const r=await q('SELECT id,amount,method,reference,status,created_at,reviewed_at FROM deposits WHERE user_id=$1 ORDER BY id DESC',[req.user.id]);res.json({deposits:r.rows})}catch(e){next(e)}});
app.post('/api/deposits',auth,user,async(req,res,next)=>{try{
 const amount=money(req.body.amount),method=String(req.body.method||'').trim(),reference=String(req.body.reference||'').trim();
 if(!amount||amount<1)return res.status(400).json({error:'Montant minimum: 1 HTG'});
 if(!['MonCash','NatCash'].includes(method))return res.status(400).json({error:'Choisis MonCash ou NatCash'});
 const r=await q('INSERT INTO deposits(user_id,amount,method,reference) VALUES($1,$2,$3,$4) RETURNING *',[req.user.id,amount,method,reference]);
 res.status(201).json({message:'Demande envoyée, en attente de validation admin',deposit:r.rows[0]});
}catch(e){next(e)}});
app.get('/api/orders',auth,user,async(req,res,next)=>{try{const r=await q('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC',[req.user.id]);res.json({orders:r.rows})}catch(e){next(e)}});
app.post('/api/orders',auth,user,async(req,res,next)=>{const c=await pool.connect();try{
 const game=String(req.body.game||'').trim(),name=String(req.body.package_name||req.body.packageName||'').trim(),player=String(req.body.player_id||req.body.playerId||'').trim(),amount=money(req.body.amount);
 if(!game||!name||!player||!amount||amount<0.01)return res.status(400).json({error:'Jeu, pack, ID joueur et montant sont obligatoires'});
 await c.query('BEGIN');
 const ur=await c.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
 if(Number(ur.rows[0].balance)<amount){await c.query('ROLLBACK');return res.status(400).json({error:'Solde insuffisant. Fais un dépôt avant de commander.'})}
 await c.query('UPDATE users SET balance=balance-$1 WHERE id=$2',[amount,req.user.id]);
 const r=await c.query('INSERT INTO orders(user_id,game,package_name,player_id,amount) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.user.id,game,name,player,amount]);
 await c.query('COMMIT');res.status(201).json({message:'Commande créée',order:r.rows[0]});
}catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()}});
app.post('/api/spin',auth,user,async(req,res,next)=>{try{
 const cost=money(req.body.cost);if(!cost||cost<1)return res.status(400).json({error:'Coût de spin invalide'});
 const c=await pool.connect();try{await c.query('BEGIN');const u=await c.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);if(Number(u.rows[0].balance)<cost){await c.query('ROLLBACK');return res.status(400).json({error:'Solde insuffisant'})}
 // Le résultat doit être déterminé côté serveur par la configuration officielle du jeu.
 const result={status:'pending',message:'Spin enregistré; configure les récompenses avant activation.'};
 await c.query('UPDATE users SET balance=balance-$1 WHERE id=$2',[cost,req.user.id]);
 const r=await c.query('INSERT INTO spin_history(user_id,cost,result) VALUES($1,$2,$3) RETURNING id,created_at',[req.user.id,cost,JSON.stringify(result)]);
 await c.query('COMMIT');res.status(201).json({spin:r.rows[0],result});
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}catch(e){next(e)}});
app.get('/api/guide',async(req,res,next)=>{try{const r=await q("SELECT value FROM settings WHERE key='guide'");res.json(r.rows[0]?.value||{channel:'',video:''})}catch(e){next(e)}});
app.put('/api/admin/guide',auth,user,admin,async(req,res,next)=>{try{const value={channel:String(req.body.channel||''),video:String(req.body.video||'')};const r=await q("INSERT INTO settings(key,value) VALUES('guide',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value RETURNING value",[JSON.stringify(value)]);res.json(r.rows[0].value)}catch(e){next(e)}});
app.post('/api/admin/guide',auth,user,admin,async(req,res,next)=>{try{const value={channel:String(req.body.channel||''),video:String(req.body.video||'')};const r=await q("INSERT INTO settings(key,value) VALUES('guide',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value RETURNING value",[JSON.stringify(value)]);res.json(r.rows[0].value)}catch(e){next(e)}});
app.get('/api/admin/overview',auth,user,admin,async(req,res,next)=>{try{
 const [u,d,o,p]=await Promise.all([q('SELECT COUNT(*)::int n FROM users'),q("SELECT COUNT(*)::int n FROM deposits WHERE status='pending'"),q("SELECT COUNT(*)::int n FROM orders WHERE status='pending'"),q('SELECT COALESCE(SUM(balance),0) total FROM users')]);
 res.json({users:u.rows[0].n,pendingDeposits:d.rows[0].n,pendingOrders:o.rows[0].n,totalWalletBalance:Number(p.rows[0].total)});
}catch(e){next(e)}});
app.get('/api/admin/deposits',auth,user,admin,async(req,res,next)=>{try{const r=await q('SELECT d.*,u.name,u.email FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC');res.json({deposits:r.rows})}catch(e){next(e)}});
app.patch('/api/admin/deposits/:id',auth,user,admin,async(req,res,next)=>{const c=await pool.connect();try{
 const status=String(req.body.status||'');if(!['approved','rejected'].includes(status))return res.status(400).json({error:'Statut invalide'});
 await c.query('BEGIN');const d=await c.query('SELECT * FROM deposits WHERE id=$1 FOR UPDATE',[req.params.id]);if(!d.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'Dépôt introuvable'})}
 if(d.rows[0].status!=='pending'){await c.query('ROLLBACK');return res.status(409).json({error:'Cette demande a déjà été traitée'})}
 if(status==='approved')await c.query('UPDATE users SET balance=balance+$1 WHERE id=$2',[d.rows[0].amount,d.rows[0].user_id]);
 const r=await c.query('UPDATE deposits SET status=$1,reviewed_at=NOW() WHERE id=$2 RETURNING *',[status,req.params.id]);await c.query('COMMIT');res.json({deposit:r.rows[0]});
}catch(e){await c.query('ROLLBACK');next(e)}finally{c.release()}});
app.get('/api/admin/orders',auth,user,admin,async(req,res,next)=>{try{const r=await q('SELECT o.*,u.name,u.email FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC');res.json({orders:r.rows})}catch(e){next(e)}});
app.patch('/api/admin/orders/:id',auth,user,admin,async(req,res,next)=>{try{const status=String(req.body.status||'');if(!['pending','processing','completed','rejected'].includes(status))return res.status(400).json({error:'Statut invalide'});const r=await q('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *',[status,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Commande introuvable'});res.json({order:r.rows[0]})}catch(e){next(e)}});
app.get('/api/admin/packages',auth,user,admin,async(req,res,next)=>{try{const r=await q('SELECT * FROM packages ORDER BY game,name');res.json({packages:r.rows})}catch(e){next(e)}});
app.post('/api/admin/packages',auth,user,admin,async(req,res,next)=>{try{const game=String(req.body.game||'').trim(),name=String(req.body.name||'').trim(),price=money(req.body.price);if(!game||!name||price===null)return res.status(400).json({error:'Jeu, nom et prix valides requis'});const r=await q('INSERT INTO packages(game,name,price,active) VALUES($1,$2,$3,$4) RETURNING *',[game,name,price,req.body.active!==false]);res.status(201).json({package:r.rows[0]})}catch(e){next(e)}});
app.patch('/api/admin/packages/:id',auth,user,admin,async(req,res,next)=>{try{const fields=[],vals=[];for(const k of ['game','name','price','active'])if(req.body[k]!==undefined){vals.push(k==='price'?money(req.body[k]):req.body[k]);fields.push(k+'=$'+vals.length)}if(!fields.length)return res.status(400).json({error:'Aucun champ à modifier'});vals.push(req.params.id);const r=await q('UPDATE packages SET '+fields.join(',')+' WHERE id=$'+vals.length+' RETURNING *',vals);if(!r.rowCount)return res.status(404).json({error:'Pack introuvable'});res.json({package:r.rows[0]})}catch(e){next(e)}});
app.patch('/api/admin/settings',auth,user,admin,async(req,res,next)=>{try{const entries=Object.entries(req.body||{});for(const [key,value] of entries)await q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[key,JSON.stringify(value)]);res.json({ok:true})}catch(e){next(e)}});
app.post('/api/admin/users/:id/credit',auth,user,admin,async(req,res,next)=>{try{const amount=money(req.body.amount);if(!amount||amount<0.01)return res.status(400).json({error:'Montant invalide'});const r=await q('UPDATE users SET balance=balance+$1 WHERE id=$2 RETURNING id,name,email,balance',[amount,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Utilisateur introuvable'});res.json({user:r.rows[0]})}catch(e){next(e)}});
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:'Erreur serveur. Vérifie les logs Render.'})});
const port=process.env.PORT||10000;
setup().then(()=>app.listen(port,'0.0.0.0',()=>console.log('ZHUO FAN HT API démarrée sur '+port))).catch(e=>{console.error('Échec initialisation DB:',e);process.exit(1)});
