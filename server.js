
require("dotenv").config();
const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB_NAME || "sahayak_desk";

if (!MONGO_URI) {
  console.error("MONGO_URI missing. Put it in .env");
  process.exit(1);
}
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
    credentials: false
}));

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

let db, client;
const now = () => new Date().toISOString();
const idOf = x => String(x);
const normalizeEmail = v => String(v ?? "").trim().toLowerCase();
const cleanAgent = a => a ? ({
  id: idOf(a._id), name:a.name, email:a.email, role:a.role, team:a.team,
  active: !!a.active
}) : null;

function oid(id) { try { return new ObjectId(id); } catch { return null; } }

async function seed() {
  const agents = db.collection("agents");
  const existing = await agents.findOne({email:"jais@gmail.com"});
  if (!existing) {
    await agents.insertOne({
      name:"Sahayak Admin", email:"jais@gmail.com",
      password:await bcrypt.hash("admin123",10), role:"admin",
      team:"Support", active:true, seededDemo:true, createdAt:now()
    });
  } else if (existing.seededDemo || existing.name === "Sahayak Admin") {
    const ok = await bcrypt.compare("admin123", existing.password || "");
    if (!ok) await agents.updateOne({_id:existing._id}, {$set:{password:await bcrypt.hash("admin123",10), role:"admin", active:true, seededDemo:true}});
  }
  const count = await agents.countDocuments();
  if (count === 1) {
    await agents.insertMany([
      {name:"Rohit Verma",email:"rohit@sahayak.local",password:await bcrypt.hash("demo123",10),role:"agent",team:"Technical",active:true,createdAt:now()},
      {name:"Sneha Iyer",email:"sneha@sahayak.local",password:await bcrypt.hash("demo123",10),role:"agent",team:"Billing",active:true,createdAt:now()}
    ]);
  }
  const settings = db.collection("settings");
  if (!(await settings.findOne({_id:"main"}))) {
    await settings.insertOne({_id:"main", brandName:"Sahayak Desk", accent:"#0f766e",
      position:"right", categories:["Billing","Technical","Account","Feature Request","General"]});
  }
}

function priorityHours(p) { return ({low:72,medium:24,high:8,urgent:4}[p] || 24); }
function publicTicket(t) {
  return {
    id:idOf(t._id), ref:t.ref, subject:t.subject, customerName:t.customerName,
    customerEmail:t.customerEmail, category:t.category, priority:t.priority,
    status:t.status, source:t.source, assigneeId:t.assigneeId ? idOf(t.assigneeId) : null,
    assigneeName:t.assigneeName || null, tags:t.tags||[], tagList:t.tags||[],
    createdAt:t.createdAt, updatedAt:t.updatedAt, dueAt:t.dueAt,
    firstResponseAt:t.firstResponseAt||null, resolvedAt:t.resolvedAt||null,
    csatScore:t.csatScore ?? null, csatComment:t.csatComment||null, messageCount:t.messageCount||0
  };
}

async function nextRef() {
  const counters = db.collection("counters");
  const r = await counters.findOneAndUpdate(
    {_id:"ticket"}, {$inc:{seq:1}}, {upsert:true, returnDocument:"after"}
  );
  return `HD-${1000 + Number(r.seq || 1)}`;
}

/* ---------------- AUTH (with debug logging) ---------------- */

app.post("/api/auth/login", async (req,res) => {
  try {
    const {email,password} = req.body || {};
    console.log("\n[LOGIN] raw body:", req.body);
    const normEmail = String(email||"").toLowerCase().trim();
    console.log("[LOGIN] normalized email:", normEmail);

    const a = await db.collection("agents").findOne({email:normEmail});
    console.log("[LOGIN] agent found in DB:", !!a);
    if (a) {
      console.log("[LOGIN] agent.active:", a.active, "| has password hash:", !!a.password);
    }

    if (!a) {
      console.log("[LOGIN] FAIL REASON: no agent with this email exists in DB");
      return res.status(401).json({message:"Invalid email or password"});
    }
    if (!a.active) {
      console.log("[LOGIN] FAIL REASON: agent.active is falsy");
      return res.status(401).json({message:"Invalid email or password"});
    }
    if (!a.password) {
      console.log("[LOGIN] FAIL REASON: agent has no password hash stored");
      return res.status(401).json({message:"Invalid email or password"});
    }

    const match = await bcrypt.compare(String(password||""), a.password);
    console.log("[LOGIN] bcrypt.compare result:", match);
    if (!match) {
      console.log("[LOGIN] FAIL REASON: password does not match stored hash");
      return res.status(401).json({message:"Invalid email or password"});
    }

    console.log("[LOGIN] SUCCESS for", normEmail);
    res.json(cleanAgent(a));
  } catch(e){ console.error("[LOGIN] error:", e); res.status(500).json({message:e.message}); }
});

app.post("/api/auth/signup", async (req,res) => {
  try {
    const {name,email,password} = req.body || {};
    console.log("\n[SIGNUP] raw body:", req.body);
    if (!name || !email || !password || String(password).length < 6)
      return res.status(400).json({message:"Name, valid email aur 6+ character password  are Required"});
    const em=normalizeEmail(email);
    const dup = await db.collection("agents").findOne({email:em});
    if (dup) {
      console.log("[SIGNUP] duplicate email found:", em);
      return res.status(409).json({message:"Email already exists"});
    }
    const doc={name:String(name).trim(),email:em,password:await bcrypt.hash(String(password),10),
      role:"admin",team:"Support",active:true,createdAt:now()};
    const r=await db.collection("agents").insertOne(doc);
    console.log("[SIGNUP] created agent:", em, "id:", r.insertedId.toString());
    res.status(201).json(cleanAgent({...doc,_id:r.insertedId}));
  } catch(e){ console.error("[SIGNUP] error:", e); res.status(500).json({message:e.message}); }
});

app.get("/api/agents", async (req,res) => {
  const arr=await db.collection("agents").find({}).sort({name:1}).toArray();
  res.json(arr.map(cleanAgent));
});
app.post("/api/agents", async (req,res) => {
  try {
    const {name,email,password="demo123",team="Support",role="agent",active=1}=req.body||{};
    if(!name||!email) return res.status(400).json({message:"Name aur email required"});
    const em=normalizeEmail(email);
    if(await db.collection("agents").findOne({email:em})) return res.status(409).json({message:"Email already exists"});
    const doc={name:String(name).trim(),email:em,password:await bcrypt.hash(String(password),10),
      role:role==="admin"?"admin":"agent",team:String(team),active:!!active,createdAt:now()};
    const r=await db.collection("agents").insertOne(doc);
    res.status(201).json(cleanAgent({...doc,_id:r.insertedId}));
  }catch(e){res.status(500).json({message:e.message});}
});
app.patch("/api/agents/:id", async(req,res)=>{
  const id=oid(req.params.id); if(!id) return res.status(400).json({message:"Invalid agent id"});
  const patch={...req.body}; delete patch._id;
  if(patch.password) patch.password=await bcrypt.hash(String(patch.password),10);
  if("active" in patch) patch.active=!!patch.active;
  if(patch.role) patch.role=patch.role==="admin"?"admin":"agent";
  await db.collection("agents").updateOne({_id:id},{$set:patch});
  const a=await db.collection("agents").findOne({_id:id}); res.json(cleanAgent(a));
});
app.delete("/api/agents/:id", async(req,res)=>{
  const id=oid(req.params.id); if(!id) return res.status(400).json({message:"Invalid agent id"});
  await db.collection("agents").deleteOne({_id:id});
  await db.collection("tickets").updateMany({assigneeId:id},{$set:{assigneeId:null,assigneeName:null,updatedAt:now()}});
  res.json({ok:true});
});

/* ---------------- TICKETS ---------------- */

async function createTicket(body, source) {
  const {subject,description,customerName,customerEmail,category="General",priority="medium"}=body||{};
  if(!subject||String(subject).trim().length<4) throw new Error("The subject should be at least 4 characters long");
  if(!description||String(description).trim().length<8) throw new Error("The detail should be at least 8 characters long");
  if(!customerName||String(customerName).trim().length<2) throw new Error("Name required");
  if(!customerEmail||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw new Error("Valid email required");
  const t=now(), due=new Date(Date.now()+priorityHours(priority)*3600000).toISOString();
  const doc={ref:await nextRef(),subject:String(subject).trim(),customerName:String(customerName).trim(),
    customerEmail:String(customerEmail).trim().toLowerCase(),category:String(category),priority,
    status:"open",source:source||"widget",assigneeId:null,assigneeName:null,tags:["new", String(category).toLowerCase().replace(/\s+/g,"-"), source||"widget"],
    createdAt:t,updatedAt:t,dueAt:due,firstResponseAt:null,resolvedAt:null,csatScore:null,csatComment:null};
  const r=await db.collection("tickets").insertOne(doc);
  await db.collection("messages").insertOne({_id:new ObjectId(),ticketId:r.insertedId,authorType:"customer",
    authorName:doc.customerName,agentId:null,body:String(description).trim(),internal:false,createdAt:t});
  await db.collection("tickets").updateOne({_id:r.insertedId},{$set:{messageCount:1}});
  await db.collection("activities").insertOne({ticketId:r.insertedId,actor:doc.customerName,text:"Created a ticket",createdAt:t});
  return publicTicket({...doc,_id:r.insertedId,messageCount:1});
}

// app.post("/api/public/tickets", async(req,res)=>{
//   try { res.status(201).json(await createTicket(req.body,"widget")); }
//   catch(e){res.status(400).json({message:e.message});}
// });

app.post("/api/public/tickets", async(req,res)=>{
  console.log("\n================ PUBLIC TICKET ================");
  console.log("BODY:", req.body);

  try {
    const ticket = await createTicket(req.body, "widget");

    console.log("TICKET CREATED:", ticket);

    res.status(201).json(ticket);
  } catch(e) {
    console.error("TICKET CREATE ERROR:", e);

    res.status(400).json({
      message: e.message
    });
  }
});


// app.post("/api/tickets", async(req,res)=>{
//   try { res.status(201).json(await createTicket(req.body,req.body.source||"phone")); }
//   catch(e){res.status(400).json({message:e.message});}
// });

app.post("/api/tickets", async(req,res)=>{
  console.log("\n================ ADMIN TICKET ================");
  console.log("BODY:", req.body);

  try {
    const ticket = await createTicket(
      req.body,
      req.body.source || "phone"
    );

    console.log("TICKET CREATED:", ticket);

    res.status(201).json(ticket);
  } catch(e) {
    console.error("TICKET CREATE ERROR:", e);

    res.status(400).json({
      message: e.message
    });
  }
});

function ticketFilter(q) {
  const f={};
  if(q.status && q.status!=="all") {
    if(q.status==="unresolved") f.status={$nin:["resolved","closed"]};
    else f.status=q.status;
  }
  if(q.priority && q.priority!=="all") f.priority=q.priority;
  if(q.category && q.category!=="all") f.category=q.category;
  if(q.assigneeId && q.assigneeId!=="all") f.assigneeId=q.assigneeId==="unassigned"?null:oid(q.assigneeId);
  if(q.tag && q.tag!=="all") f.tags=String(q.tag);
  if(q.search) {
    const rx={$regex:String(q.search),$options:"i"};
    f.$or=[{ref:rx},{subject:rx},{customerName:rx},{customerEmail:rx}];
  }
  return f;
}
app.get(["/api/tickets", "/api/tickets/"], async(req,res)=>{
  try {
  console.log("\n[TICKETS LIST] query params received:", req.query);
  const q={...req.query}; if(q.q && !q.search) q.search=q.q;
  const filter=ticketFilter(q);
  console.log("[TICKETS LIST] mongo filter built:", JSON.stringify(filter));

  const totalInCollection = await db.collection("tickets").countDocuments({});
  console.log("[TICKETS LIST] total tickets in collection (no filter):", totalInCollection);

  let sort={createdAt:-1};
  if(q.sort==="oldest")sort={createdAt:1};
  if(q.sort==="priority")sort={priority:1,createdAt:-1};
  if(q.sort==="due")sort={dueAt:1};
  const docs=await db.collection("tickets").find(filter).sort(sort).limit(500).toArray();
  console.log("[TICKETS LIST] docs matched after filter:", docs.length);

  const ids=docs.map(d=>d._id);
  const counts={};
  if(ids.length){ const mc=await db.collection("messages").aggregate([{$match:{ticketId:{$in:ids}}},{$group:{_id:"$ticketId",count:{$sum:1}}}]).toArray(); mc.forEach(x=>counts[String(x._id)]=x.count); }
  res.json(docs.map(d=>publicTicket({...d,messageCount:counts[String(d._id)]||0})));
  } catch (e) {
    console.error("[TICKETS LIST] GET /api/tickets failed:", e);
    res.status(500).json({message:"Tickets load nahi ho pa rahe", error:e.message});
  }
});
app.get("/api/tickets/:id", async(req,res)=>{
  const id=oid(req.params.id); if(!id)return res.status(400).json({message:"Invalid ticket id"});
  const t=await db.collection("tickets").findOne({_id:id});
  if(!t)return res.status(404).json({message:"Ticket not found"});
  const messages=await db.collection("messages").find({ticketId:id, $or:[{internal:false},{internal:{$exists:false}}]}).sort({createdAt:1}).toArray();
  const allMessages=await db.collection("messages").find({ticketId:id}).sort({createdAt:1}).toArray();
  const activities=await db.collection("activities").find({ticketId:id}).sort({createdAt:1}).toArray();
  res.json({ticket:publicTicket({...t,messageCount:allMessages.length}),messages:allMessages.map(m=>({id:idOf(m._id),authorType:m.authorType,authorName:m.authorName,
    agentId:m.agentId? idOf(m.agentId):null,body:m.body,internal:!!m.internal,createdAt:m.createdAt})),activities:activities.map(a=>({id:idOf(a._id),actor:a.actor,text:a.text,createdAt:a.createdAt}))});
});
app.patch("/api/tickets/:id", async(req,res)=>{
  const id=oid(req.params.id); if(!id)return res.status(400).json({message:"Invalid ticket id"});
  const p={...req.body}; delete p.actor; delete p._id;
  if(p.assigneeId!==undefined){
    p.assigneeId=p.assigneeId?oid(p.assigneeId):null;
    if(p.assigneeId){const a=await db.collection("agents").findOne({_id:p.assigneeId});p.assigneeName=a?.name||null;}
    else p.assigneeName=null;
  }
  if(p.tags && !Array.isArray(p.tags)) delete p.tags;
  if(p.status==="resolved" && !p.resolvedAt)p.resolvedAt=now();
  p.updatedAt=now();
  await db.collection("tickets").updateOne({_id:id},{$set:p});
  const updated=await db.collection("tickets").findOne({_id:id});
  const actor=req.body?.actor||"Admin";
  const changed=Object.keys(p).filter(k=>k!=="updatedAt").join(", ");
  if(changed) await db.collection("activities").insertOne({ticketId:id,actor,text:`Ticket update: ${changed}`,createdAt:p.updatedAt});
  res.json(publicTicket(updated));
});
app.post("/api/tickets/:id/messages",async(req,res)=>{
  const id=oid(req.params.id); if(!id)return res.status(400).json({message:"Invalid ticket id"});
  const t=await db.collection("tickets").findOne({_id:id}); if(!t)return res.status(404).json({message:"Not found"});
  const {body,internal=false,agentId,authorName="Agent",authorType="agent"}=req.body||{};
  if(!body||!String(body).trim())return res.status(400).json({message:"Message empty"});
  const created=now();
  await db.collection("messages").insertOne({ticketId:id,authorType,authorName,agentId:agentId?oid(agentId):null,body:String(body).trim(),internal:!!internal,createdAt:created});
  await db.collection("tickets").updateOne({_id:id},{$inc:{messageCount:1}});
  await db.collection("activities").insertOne({ticketId:id,actor:authorName,text:internal?"Added an internal note, sent a reply",createdAt:created});
  const patch={updatedAt:created};
  if(authorType==="agent"&&!internal&&!t.firstResponseAt)patch.firstResponseAt=created;
  await db.collection("tickets").updateOne({_id:id},{$set:patch});
  res.json({ok:true});
});
app.post("/api/tickets/bulk",async(req,res)=>{
  const {ids=[],patch={}}=req.body||{}; let updated=0;
  for(const raw of ids){const id=oid(raw);if(!id)continue;const p={...patch};delete p.actor;
    if(p.assigneeId){p.assigneeId=oid(p.assigneeId);const a=await db.collection("agents").findOne({_id:p.assigneeId});p.assigneeName=a?.name||null;}
    p.updatedAt=now(); const r=await db.collection("tickets").updateOne({_id:id},{$set:p});updated+=r.modifiedCount;}
  res.json({updated});
});
app.delete("/api/tickets/:id",async(req,res)=>{
  const id=oid(req.params.id);if(!id)return res.status(400).json({message:"Invalid ticket id"});
  await db.collection("tickets").deleteOne({_id:id});await db.collection("messages").deleteMany({ticketId:id});await db.collection("activities").deleteMany({ticketId:id});res.json({ok:true});
});

app.get("/api/public/tickets/:ref",async(req,res)=>{
  const t=await db.collection("tickets").findOne({ref:String(req.params.ref)});
  if(!t)return res.status(404).json({message:"Ticket not found"});
  const messages=await db.collection("messages").find({ticketId:t._id,internal:{$ne:true}}).sort({createdAt:1}).toArray();
  res.json({ticket:publicTicket(t),messages:messages.map(m=>({id:idOf(m._id),authorType:m.authorType,authorName:m.authorName,body:m.body,createdAt:m.createdAt,internal:false}))});
});
app.post("/api/public/tickets/:ref/messages",async(req,res)=>{
  const t=await db.collection("tickets").findOne({ref:String(req.params.ref)});
  if(!t)return res.status(404).json({message:"Ticket not found"});
  const body=String(req.body?.body||"").trim();if(!body)return res.status(400).json({message:"Message empty"});
  const created=now();await db.collection("messages").insertOne({_id:new ObjectId(),ticketId:t._id,authorType:"customer",authorName:t.customerName,agentId:null,body,internal:false,createdAt:created});
  await db.collection("tickets").updateOne({_id:t._id},{$set:{updatedAt:created,status:t.status==="resolved"?"open":t.status},$inc:{messageCount:1}});
  await db.collection("activities").insertOne({ticketId:t._id,actor:t.customerName,text:"The customer sent a reply",createdAt:created});
  res.json({ok:true});
});
app.post("/api/public/tickets/:ref/csat",async(req,res)=>{
  const t=await db.collection("tickets").findOne({ref:String(req.params.ref)});if(!t)return res.status(404).json({message:"Ticket not found"});
  const score=Math.max(1,Math.min(5,Number(req.body?.score||0)));await db.collection("tickets").updateOne({_id:t._id},{$set:{csatScore:score,updatedAt:now()}});
  res.json({ok:true});
});

app.get("/api/public/config",async(req,res)=>{
  const s=await db.collection("settings").findOne({_id:"main"});res.json(s||{categories:["Billing","Technical","Account","Feature Request","General"]});
});
app.get("/api/settings",async(req,res)=>{
  const s=await db.collection("settings").findOne({_id:"main"});res.json(s||{categories:["Billing","Technical","Account","Feature Request","General"]});
});
app.patch("/api/settings",async(req,res)=>{
  const p={...req.body};delete p._id;await db.collection("settings").updateOne({_id:"main"},{$set:p},{upsert:true});
  res.json(await db.collection("settings").findOne({_id:"main"}));
});

app.get("/api/articles",async(req,res)=>{
  const filter=req.query.q?{title:{$regex:String(req.query.q),$options:"i"}}:{};
  res.json(await db.collection("articles").find(filter).sort({updatedAt:-1}).toArray().then(a=>a.map(x=>({...x,id:idOf(x._id),_id:undefined}))));
});
app.post("/api/articles",async(req,res)=>{const {title,category="General",body,published=true}=req.body||{};if(!title||!body)return res.status(400).json({message:"Title/body required"});const doc={title,category,body,published:!!published,views:0,updatedAt:now()};const r=await db.collection("articles").insertOne(doc);res.status(201).json({...doc,id:idOf(r.insertedId)});});
app.patch("/api/articles/:id",async(req,res)=>{const id=oid(req.params.id);if(!id)return res.status(400).json({message:"Invalid id"});const p={...req.body,updatedAt:now()};delete p._id;await db.collection("articles").updateOne({_id:id},{$set:p});res.json({...p,id:req.params.id});});
app.delete("/api/articles/:id",async(req,res)=>{const id=oid(req.params.id);if(id)await db.collection("articles").deleteOne({_id:id});res.json({ok:true});});
app.get("/api/public/articles",async(req,res)=>{const q=String(req.query.q||"");const f={published:true};if(q)f.title={$regex:q,$options:"i"};const a=await db.collection("articles").find(f).sort({updatedAt:-1}).toArray();res.json(a.map(x=>({...x,id:idOf(x._id)})));});
app.get("/api/public/articles/:id",async(req,res)=>{const id=oid(req.params.id);if(!id)return res.status(404).json({message:"Not found"});const a=await db.collection("articles").findOne({_id:id,published:true});if(!a)return res.status(404).json({message:"Not found"});await db.collection("articles").updateOne({_id:id},{$inc:{views:1}});res.json({...a,id:idOf(a._id)});});
app.get("/api/canned",async(req,res)=>res.json(await db.collection("canned").find({}).sort({title:1}).toArray().then(a=>a.map(x=>({...x,id:idOf(x._id)})))));
app.post("/api/canned",async(req,res)=>{const {title,body}=req.body||{};const r=await db.collection("canned").insertOne({title,body});res.status(201).json({title,body,id:idOf(r.insertedId)});});
app.patch("/api/canned/:id",async(req,res)=>{const id=oid(req.params.id);if(id)await db.collection("canned").updateOne({_id:id},{$set:{title:req.body.title,body:req.body.body}});res.json({ok:true});});
app.delete("/api/canned/:id",async(req,res)=>{const id=oid(req.params.id);if(id)await db.collection("canned").deleteOne({_id:id});res.json({ok:true});});

app.get("/api/tags",async(req,res)=>{
  const docs=await db.collection("tickets").find({}, {projection:{tags:1}}).toArray();
  const counts={}; docs.forEach(t=>(Array.isArray(t.tags)?t.tags:[]).forEach(tag=>{counts[tag]=(counts[tag]||0)+1;}));
  res.json(Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([name,count])=>({name,count})));
});

app.get("/api/stats",async(req,res)=>{
  try {
    const tickets=await db.collection("tickets").find({}).toArray();
    const today=new Date().toISOString().slice(0,10);
    const unresolved=tickets.filter(t=>!["resolved","closed"].includes(t.status));
    const open=tickets.filter(t=>t.status==="open").length;
    const pending=tickets.filter(t=>t.status==="pending").length;
    const onHold=tickets.filter(t=>t.status==="on_hold").length;
    const unassigned=unresolved.filter(t=>!t.assigneeId).length;
    const overdue=unresolved.filter(t=>t.dueAt && new Date(t.dueAt).getTime()<Date.now()).length;
    const resolvedToday=tickets.filter(t=>t.resolvedAt?.slice(0,10)===today).length;
    const resolved=tickets.filter(t=>t.status==="resolved").length;
    const closed=tickets.filter(t=>t.status==="closed").length;
    const fr=tickets.filter(t=>t.firstResponseAt).map(t=>(new Date(t.firstResponseAt)-new Date(t.createdAt))/60000);
    const rr=tickets.filter(t=>t.resolvedAt).map(t=>(new Date(t.resolvedAt)-new Date(t.createdAt))/3600000);
    const cs=tickets.filter(t=>t.csatScore).map(t=>Number(t.csatScore));
    const priorities=["urgent","high","medium","low"];
    const byPriority=priorities.map(name=>({name,count:tickets.filter(t=>t.priority===name).length,value:tickets.filter(t=>t.priority===name).length}));
    const statusNames=["open","pending","on_hold","resolved","closed"];
    const byStatus=statusNames.map(name=>({name,value:tickets.filter(t=>t.status===name).length}));
    const cats=[...new Set(tickets.map(t=>t.category).filter(Boolean))];
    const byCategory=cats.map(name=>({name,value:tickets.filter(t=>t.category===name).length})).sort((a,b)=>b.value-a.value);
    const sources=[...new Set(tickets.map(t=>t.source).filter(Boolean))];
    const bySource=sources.map(name=>({name,value:tickets.filter(t=>t.source===name).length}));
    const tagSet=[...new Set(tickets.flatMap(t=>Array.isArray(t.tags)?t.tags:[]).filter(Boolean))];
    const byTag=tagSet.map(name=>({name,value:tickets.filter(t=>Array.isArray(t.tags)&&t.tags.includes(name)).length})).sort((a,b)=>b.value-a.value);
    const agentDocs=await db.collection("agents").find({}).toArray();
    const agentLoad=agentDocs.map(a=>({id:idOf(a._id),name:a.name,open:tickets.filter(t=>String(t.assigneeId)===String(a._id)&&!["resolved","closed"].includes(t.status)).length,resolved:tickets.filter(t=>String(t.assigneeId)===String(a._id)&&t.status==="resolved").length}));
    const trend=[];
    for(let i=13;i>=0;i--){const d=new Date(Date.now()-i*86400000).toISOString().slice(0,10);trend.push({date:d,created:tickets.filter(t=>t.createdAt?.slice(0,10)===d).length,resolved:tickets.filter(t=>t.resolvedAt?.slice(0,10)===d).length});}
    res.json({total:tickets.length,open,pending,onHold,unassigned,overdue,createdToday:tickets.filter(t=>t.createdAt?.slice(0,10)===today).length,resolvedToday,resolved,closed,
      avgFirstResponseMins:fr.length?Math.round(fr.reduce((a,b)=>a+b,0)/fr.length):null,
      avgResolutionHours:rr.length?Math.round(rr.reduce((a,b)=>a+b,0)/rr.length*10)/10:null,
      csatAvg:cs.length?Math.round(cs.reduce((a,b)=>a+b,0)/cs.length*10)/10:null,csatCount:cs.length,
      trend,byPriority,byStatus,byCategory,bySource,byTag,agentLoad});
  } catch(e){ console.error("GET /api/stats failed:",e); res.status(500).json({message:e.message}); }
});

app.get("/api/health",(req,res)=>res.json({ok:true,db:!!db}));

app.get(["/admin/signup", "/admin/signup/", "/admin-signup.html"], (req,res)=>
  res.sendFile(path.join(__dirname,"admin-signup.html"))
);

// ✅ widget.js — explicit CORS ke saath
app.get("/widget.js", (req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.sendFile(path.join(__dirname, "widget.js"), (err) => {
        if (err) {
            console.error("widget.js not found:", err.message);
            res.status(404).send("// widget.js not found");
        }
    });
});

app.get(/^\/assets\/(.+)$/i, (req,res,next)=>{
  const file = path.basename(req.params[0]);
  if (!/^[a-zA-Z0-9._-]+\.(?:js|css|map|png|jpg|jpeg|svg|webp|woff2?)$/i.test(file)) return res.status(404).end();
  const full = path.join(__dirname, "assets", file);
  res.sendFile(full, err=>{
    if (err && !res.headersSent) res.status(err.statusCode || 404).json({message:"Asset not found",asset:file});
  });
});

app.use(express.static(__dirname, { fallthrough: true, index: false }));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));

// (async()=>{
//   try {
//     client=new MongoClient(MONGO_URI);
//     await client.connect();
//     db=client.db(DB_NAME);
//     await seed();
//     app.listen(PORT,()=>console.log(`Sahayak Desk running: http://localhost:${PORT}`));
//   } catch(e) {
//     console.error("MongoDB connection failed:",e.message);
//     process.exit(1);
//   }
// })();


(async()=>{
  try {
    client = new MongoClient(MONGO_URI);

    await client.connect();

    db = client.db(DB_NAME);

    console.log("=================================");
    console.log("MongoDB URI:", MONGO_URI);
    console.log("MongoDB Database:", DB_NAME);
    console.log("=================================");

    await seed();

    app.listen(PORT, () =>
      console.log(`Sahayak Desk running: http://localhost:${PORT}`)
    );

  } catch(e) {
    console.error("MongoDB connection failed:", e.message);
    process.exit(1);
  }
})();


// require("dotenv").config();
// const express = require("express");
// const path = require("path");
// const bcrypt = require("bcryptjs");
// const { MongoClient, ObjectId } = require("mongodb");

// const app = express();
// const PORT = Number(process.env.PORT || 5000);
// const MONGO_URI = process.env.MONGO_URI;
// const DB_NAME = process.env.MONGO_DB_NAME || "sahayak_desk";

// if (!MONGO_URI) {
//   console.error("MONGO_URI missing. Put it in .env");
//   process.exit(1);
// }

// app.use(express.json({ limit: "1mb" }));
// app.use(express.urlencoded({ extended: true }));

// let db, client;
// const now = () => new Date().toISOString();
// const idOf = x => String(x);
// const normalizeEmail = v => String(v ?? "").trim().toLowerCase();
// const cleanAgent = a => a ? ({
//   id: idOf(a._id), name:a.name, email:a.email, role:a.role, team:a.team,
//   active: !!a.active
// }) : null;

// function oid(id) { try { return new ObjectId(id); } catch { return null; } }

// async function seed() {
//   const agents = db.collection("agents");
//   const existing = await agents.findOne({email:"jais@gmail.com"});
//   if (!existing) {
//     await agents.insertOne({
//       name:"Sahayak Admin", email:"jais@gmail.com",
//       password:await bcrypt.hash("admin123",10), role:"admin",
//       team:"Support", active:true, seededDemo:true, createdAt:now()
//     });
//   } else if (existing.seededDemo || existing.name === "Sahayak Admin") {
//     // Keep the built-in local demo login usable even if an older build stored
//     // an incompatible password hash. Custom admins are never overwritten.
//     const ok = await bcrypt.compare("admin123", existing.password || "");
//     if (!ok) await agents.updateOne({_id:existing._id}, {$set:{password:await bcrypt.hash("admin123",10), role:"admin", active:true, seededDemo:true}});
//   }
//   const count = await agents.countDocuments();
//   if (count === 1) {
//     await agents.insertMany([
//       {name:"Rohit Verma",email:"rohit@sahayak.local",password:await bcrypt.hash("demo123",10),role:"agent",team:"Technical",active:true,createdAt:now()},
//       {name:"Sneha Iyer",email:"sneha@sahayak.local",password:await bcrypt.hash("demo123",10),role:"agent",team:"Billing",active:true,createdAt:now()}
//     ]);
//   }
//   const settings = db.collection("settings");
//   if (!(await settings.findOne({_id:"main"}))) {
//     await settings.insertOne({_id:"main", brandName:"Sahayak Desk", accent:"#0f766e",
//       position:"right", categories:["Billing","Technical","Account","Feature Request","General"]});
//   }
// }

// function priorityHours(p) { return ({low:72,medium:24,high:8,urgent:4}[p] || 24); }
// function publicTicket(t) {
//   return {
//     id:idOf(t._id), ref:t.ref, subject:t.subject, customerName:t.customerName,
//     customerEmail:t.customerEmail, category:t.category, priority:t.priority,
//     status:t.status, source:t.source, assigneeId:t.assigneeId ? idOf(t.assigneeId) : null,
//     assigneeName:t.assigneeName || null, tags:t.tags||[], tagList:t.tags||[],
//     createdAt:t.createdAt, updatedAt:t.updatedAt, dueAt:t.dueAt,
//     firstResponseAt:t.firstResponseAt||null, resolvedAt:t.resolvedAt||null,
//     csatScore:t.csatScore ?? null, csatComment:t.csatComment||null, messageCount:t.messageCount||0
//   };
// }

// async function nextRef() {
//   const counters = db.collection("counters");
//   const r = await counters.findOneAndUpdate(
//     {_id:"ticket"}, {$inc:{seq:1}}, {upsert:true, returnDocument:"after"}
//   );
//   return `HD-${1000 + Number(r.seq || 1)}`;
// }

// app.post("/api/auth/login", async (req,res) => {
//   try {
//     const {email,password} = req.body || {};
//     const a = await db.collection("agents").findOne({email:String(email||"").toLowerCase().trim()});
//     if (!a || !a.active || !a.password || !(await bcrypt.compare(password ,a.password))) {
//       return res.status(401).json({message:"Invalid email or password"});
//     }
//     res.json(cleanAgent(a));
//   } catch(e){ res.status(500).json({message:e.message}); }
// });

// app.post("/api/auth/signup", async (req,res) => {
//   try {
//     const {name,email,password} = req.body || {};
//     if (!name || !email || !password || String(password).length < 6)
//       return res.status(400).json({message:"Name, valid email aur 6+ character password zaroori hai"});
//     const em=normalizeEmail(email);
//     if (await db.collection("agents").findOne({email:em}))
//       return res.status(409).json({message:"Ye email already registered hai"});
//     const doc={name:String(name).trim(),email:em,password:await bcrypt.hash(String(password),10),
//       role:"admin",team:"Support",active:true,createdAt:now()};
//     const r=await db.collection("agents").insertOne(doc);
//     res.status(201).json(cleanAgent({...doc,_id:r.insertedId}));
//   } catch(e){ res.status(500).json({message:e.message}); }
// });

// app.get("/api/agents", async (req,res) => {
//   const arr=await db.collection("agents").find({}).sort({name:1}).toArray();
//   res.json(arr.map(cleanAgent));
// });
// app.post("/api/agents", async (req,res) => {
//   try {
//     const {name,email,password="demo123",team="Support",role="agent",active=1}=req.body||{};
//     if(!name||!email) return res.status(400).json({message:"Name aur email required"});
//     const em=normalizeEmail(email);
//     if(await db.collection("agents").findOne({email:em})) return res.status(409).json({message:"Email already exists"});
//     const doc={name:String(name).trim(),email:em,password:await bcrypt.hash(String(password),10),
//       role:role==="admin"?"admin":"agent",team:String(team),active:!!active,createdAt:now()};
//     const r=await db.collection("agents").insertOne(doc);
//     res.status(201).json(cleanAgent({...doc,_id:r.insertedId}));
//   }catch(e){res.status(500).json({message:e.message});}
// });
// app.patch("/api/agents/:id", async(req,res)=>{
//   const id=oid(req.params.id); if(!id) return res.status(400).json({message:"Invalid agent id"});
//   const patch={...req.body}; delete patch._id;
//   if(patch.password) patch.password=await bcrypt.hash(String(patch.password),10);
//   if("active" in patch) patch.active=!!patch.active;
//   if(patch.role) patch.role=patch.role==="admin"?"admin":"agent";
//   await db.collection("agents").updateOne({_id:id},{$set:patch});
//   const a=await db.collection("agents").findOne({_id:id}); res.json(cleanAgent(a));
// });
// app.delete("/api/agents/:id", async(req,res)=>{
//   const id=oid(req.params.id); if(!id) return res.status(400).json({message:"Invalid agent id"});
//   await db.collection("agents").deleteOne({_id:id});
//   await db.collection("tickets").updateMany({assigneeId:id},{$set:{assigneeId:null,assigneeName:null,updatedAt:now()}});
//   res.json({ok:true});
// });

// async function createTicket(body, source) {
//   const {subject,description,customerName,customerEmail,category="General",priority="medium"}=body||{};
//   if(!subject||String(subject).trim().length<4) throw new Error("Subject kam se kam 4 characters ka ho");
//   if(!description||String(description).trim().length<8) throw new Error("Detail kam se kam 8 characters ki ho");
//   if(!customerName||String(customerName).trim().length<2) throw new Error("Naam required");
//   if(!customerEmail||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw new Error("Valid email required");
//   const t=now(), due=new Date(Date.now()+priorityHours(priority)*3600000).toISOString();
//   const doc={ref:await nextRef(),subject:String(subject).trim(),customerName:String(customerName).trim(),
//     customerEmail:String(customerEmail).trim().toLowerCase(),category:String(category),priority,
//     status:"open",source:source||"widget",assigneeId:null,assigneeName:null,tags:["new", String(category).toLowerCase().replace(/\s+/g,"-"), source||"widget"],
//     createdAt:t,updatedAt:t,dueAt:due,firstResponseAt:null,resolvedAt:null,csatScore:null,csatComment:null};
//   const r=await db.collection("tickets").insertOne(doc);
//   await db.collection("messages").insertOne({_id:new ObjectId(),ticketId:r.insertedId,authorType:"customer",
//     authorName:doc.customerName,agentId:null,body:String(description).trim(),internal:false,createdAt:t});
//   await db.collection("tickets").updateOne({_id:r.insertedId},{$set:{messageCount:1}});
//   await db.collection("activities").insertOne({ticketId:r.insertedId,actor:doc.customerName,text:"Ticket create kiya",createdAt:t});
//   return publicTicket({...doc,_id:r.insertedId,messageCount:1});
// }

// app.post("/api/public/tickets", async(req,res)=>{
//   try { res.status(201).json(await createTicket(req.body,"widget")); }
//   catch(e){res.status(400).json({message:e.message});}
// });
// app.post("/api/tickets", async(req,res)=>{
//   try { res.status(201).json(await createTicket(req.body,req.body.source||"phone")); }
//   catch(e){res.status(400).json({message:e.message});}
// });

// function ticketFilter(q) {
//   const f={};
//   if(q.status && q.status!=="all") {
//     if(q.status==="unresolved") f.status={$nin:["resolved","closed"]};
//     else f.status=q.status;
//   }
//   if(q.priority && q.priority!=="all") f.priority=q.priority;
//   if(q.category && q.category!=="all") f.category=q.category;
//   if(q.assigneeId && q.assigneeId!=="all") f.assigneeId=q.assigneeId==="unassigned"?null:oid(q.assigneeId);
//   if(q.tag && q.tag!=="all") f.tags=String(q.tag);
//   if(q.search) {
//     const rx={$regex:String(q.search),$options:"i"};
//     f.$or=[{ref:rx},{subject:rx},{customerName:rx},{customerEmail:rx}];
//   }
//   return f;
// }
// app.get(["/api/tickets", "/api/tickets/"], async(req,res)=>{
//   try {
//   const q={...req.query}; if(q.q && !q.search) q.search=q.q;
//   const filter=ticketFilter(q);
//   let sort={createdAt:-1};
//   if(q.sort==="oldest")sort={createdAt:1};
//   if(q.sort==="priority")sort={priority:1,createdAt:-1};
//   if(q.sort==="due")sort={dueAt:1};
//   const docs=await db.collection("tickets").find(filter).sort(sort).limit(500).toArray();
//   const ids=docs.map(d=>d._id);
//   const counts={};
//   if(ids.length){ const mc=await db.collection("messages").aggregate([{$match:{ticketId:{$in:ids}}},{$group:{_id:"$ticketId",count:{$sum:1}}}]).toArray(); mc.forEach(x=>counts[String(x._id)]=x.count); }
//   res.json(docs.map(d=>publicTicket({...d,messageCount:counts[String(d._id)]||0})));
//   } catch (e) {
//     console.error("GET /api/tickets failed:", e);
//     res.status(500).json({message:"Tickets load nahi ho pa rahe", error:e.message});
//   }
// });
// app.get("/api/tickets/:id", async(req,res)=>{
//   const id=oid(req.params.id); if(!id)return res.status(400).json({message:"Invalid ticket id"});
//   const t=await db.collection("tickets").findOne({_id:id});
//   if(!t)return res.status(404).json({message:"Ticket not found"});
//   const messages=await db.collection("messages").find({ticketId:id, $or:[{internal:false},{internal:{$exists:false}}]}).sort({createdAt:1}).toArray();
//   const allMessages=await db.collection("messages").find({ticketId:id}).sort({createdAt:1}).toArray();
//   const activities=await db.collection("activities").find({ticketId:id}).sort({createdAt:1}).toArray();
//   res.json({ticket:publicTicket({...t,messageCount:allMessages.length}),messages:allMessages.map(m=>({id:idOf(m._id),authorType:m.authorType,authorName:m.authorName,
//     agentId:m.agentId? idOf(m.agentId):null,body:m.body,internal:!!m.internal,createdAt:m.createdAt})),activities:activities.map(a=>({id:idOf(a._id),actor:a.actor,text:a.text,createdAt:a.createdAt}))});
// });
// app.patch("/api/tickets/:id", async(req,res)=>{
//   const id=oid(req.params.id); if(!id)return res.status(400).json({message:"Invalid ticket id"});
//   const p={...req.body}; delete p.actor; delete p._id;
//   if(p.assigneeId!==undefined){
//     p.assigneeId=p.assigneeId?oid(p.assigneeId):null;
//     if(p.assigneeId){const a=await db.collection("agents").findOne({_id:p.assigneeId});p.assigneeName=a?.name||null;}
//     else p.assigneeName=null;
//   }
//   if(p.tags && !Array.isArray(p.tags)) delete p.tags;
//   if(p.status==="resolved" && !p.resolvedAt)p.resolvedAt=now();
//   p.updatedAt=now();
//   await db.collection("tickets").updateOne({_id:id},{$set:p});
//   const updated=await db.collection("tickets").findOne({_id:id});
//   const actor=req.body?.actor||"Admin";
//   const changed=Object.keys(p).filter(k=>k!=="updatedAt").join(", ");
//   if(changed) await db.collection("activities").insertOne({ticketId:id,actor,text:`Ticket update: ${changed}`,createdAt:p.updatedAt});
//   res.json(publicTicket(updated));
// });
// app.post("/api/tickets/:id/messages",async(req,res)=>{
//   const id=oid(req.params.id); if(!id)return res.status(400).json({message:"Invalid ticket id"});
//   const t=await db.collection("tickets").findOne({_id:id}); if(!t)return res.status(404).json({message:"Not found"});
//   const {body,internal=false,agentId,authorName="Agent",authorType="agent"}=req.body||{};
//   if(!body||!String(body).trim())return res.status(400).json({message:"Message empty"});
//   const created=now();
//   await db.collection("messages").insertOne({ticketId:id,authorType,authorName,agentId:agentId?oid(agentId):null,body:String(body).trim(),internal:!!internal,createdAt:created});
//   await db.collection("tickets").updateOne({_id:id},{$inc:{messageCount:1}});
//   await db.collection("activities").insertOne({ticketId:id,actor:authorName,text:internal?"Internal note add kiya":"Reply bheja",createdAt:created});
//   const patch={updatedAt:created};
//   if(authorType==="agent"&&!internal&&!t.firstResponseAt)patch.firstResponseAt=created;
//   await db.collection("tickets").updateOne({_id:id},{$set:patch});
//   res.json({ok:true});
// });
// app.post("/api/tickets/bulk",async(req,res)=>{
//   const {ids=[],patch={}}=req.body||{}; let updated=0;
//   for(const raw of ids){const id=oid(raw);if(!id)continue;const p={...patch};delete p.actor;
//     if(p.assigneeId){p.assigneeId=oid(p.assigneeId);const a=await db.collection("agents").findOne({_id:p.assigneeId});p.assigneeName=a?.name||null;}
//     p.updatedAt=now(); const r=await db.collection("tickets").updateOne({_id:id},{$set:p});updated+=r.modifiedCount;}
//   res.json({updated});
// });
// app.delete("/api/tickets/:id",async(req,res)=>{
//   const id=oid(req.params.id);if(!id)return res.status(400).json({message:"Invalid ticket id"});
//   await db.collection("tickets").deleteOne({_id:id});await db.collection("messages").deleteMany({ticketId:id});await db.collection("activities").deleteMany({ticketId:id});res.json({ok:true});
// });

// app.get("/api/public/tickets/:ref",async(req,res)=>{
//   const t=await db.collection("tickets").findOne({ref:String(req.params.ref)});
//   if(!t)return res.status(404).json({message:"Ticket not found"});
//   const messages=await db.collection("messages").find({ticketId:t._id,internal:{$ne:true}}).sort({createdAt:1}).toArray();
//   res.json({ticket:publicTicket(t),messages:messages.map(m=>({id:idOf(m._id),authorType:m.authorType,authorName:m.authorName,body:m.body,createdAt:m.createdAt,internal:false}))});
// });
// app.post("/api/public/tickets/:ref/messages",async(req,res)=>{
//   const t=await db.collection("tickets").findOne({ref:String(req.params.ref)});
//   if(!t)return res.status(404).json({message:"Ticket not found"});
//   const body=String(req.body?.body||"").trim();if(!body)return res.status(400).json({message:"Message empty"});
//   const created=now();await db.collection("messages").insertOne({_id:new ObjectId(),ticketId:t._id,authorType:"customer",authorName:t.customerName,agentId:null,body,internal:false,createdAt:created});
//   await db.collection("tickets").updateOne({_id:t._id},{$set:{updatedAt:created,status:t.status==="resolved"?"open":t.status},$inc:{messageCount:1}});
//   await db.collection("activities").insertOne({ticketId:t._id,actor:t.customerName,text:"Customer ne reply bheja",createdAt:created});
//   res.json({ok:true});
// });
// app.post("/api/public/tickets/:ref/csat",async(req,res)=>{
//   const t=await db.collection("tickets").findOne({ref:String(req.params.ref)});if(!t)return res.status(404).json({message:"Ticket not found"});
//   const score=Math.max(1,Math.min(5,Number(req.body?.score||0)));await db.collection("tickets").updateOne({_id:t._id},{$set:{csatScore:score,updatedAt:now()}});
//   res.json({ok:true});
// });

// app.get("/api/public/config",async(req,res)=>{
//   const s=await db.collection("settings").findOne({_id:"main"});res.json(s||{categories:["Billing","Technical","Account","Feature Request","General"]});
// });
// app.get("/api/settings",async(req,res)=>{
//   const s=await db.collection("settings").findOne({_id:"main"});res.json(s||{categories:["Billing","Technical","Account","Feature Request","General"]});
// });
// app.patch("/api/settings",async(req,res)=>{
//   const p={...req.body};delete p._id;await db.collection("settings").updateOne({_id:"main"},{$set:p},{upsert:true});
//   res.json(await db.collection("settings").findOne({_id:"main"}));
// });

// app.get("/api/articles",async(req,res)=>{
//   const filter=req.query.q?{title:{$regex:String(req.query.q),$options:"i"}}:{};
//   res.json(await db.collection("articles").find(filter).sort({updatedAt:-1}).toArray().then(a=>a.map(x=>({...x,id:idOf(x._id),_id:undefined}))));
// });
// app.post("/api/articles",async(req,res)=>{const {title,category="General",body,published=true}=req.body||{};if(!title||!body)return res.status(400).json({message:"Title/body required"});const doc={title,category,body,published:!!published,views:0,updatedAt:now()};const r=await db.collection("articles").insertOne(doc);res.status(201).json({...doc,id:idOf(r.insertedId)});});
// app.patch("/api/articles/:id",async(req,res)=>{const id=oid(req.params.id);if(!id)return res.status(400).json({message:"Invalid id"});const p={...req.body,updatedAt:now()};delete p._id;await db.collection("articles").updateOne({_id:id},{$set:p});res.json({...p,id:req.params.id});});
// app.delete("/api/articles/:id",async(req,res)=>{const id=oid(req.params.id);if(id)await db.collection("articles").deleteOne({_id:id});res.json({ok:true});});
// app.get("/api/public/articles",async(req,res)=>{const q=String(req.query.q||"");const f={published:true};if(q)f.title={$regex:q,$options:"i"};const a=await db.collection("articles").find(f).sort({updatedAt:-1}).toArray();res.json(a.map(x=>({...x,id:idOf(x._id)})));});
// app.get("/api/public/articles/:id",async(req,res)=>{const id=oid(req.params.id);if(!id)return res.status(404).json({message:"Not found"});const a=await db.collection("articles").findOne({_id:id,published:true});if(!a)return res.status(404).json({message:"Not found"});await db.collection("articles").updateOne({_id:id},{$inc:{views:1}});res.json({...a,id:idOf(a._id)});});
// app.get("/api/canned",async(req,res)=>res.json(await db.collection("canned").find({}).sort({title:1}).toArray().then(a=>a.map(x=>({...x,id:idOf(x._id)})))));
// app.post("/api/canned",async(req,res)=>{const {title,body}=req.body||{};const r=await db.collection("canned").insertOne({title,body});res.status(201).json({title,body,id:idOf(r.insertedId)});});
// app.patch("/api/canned/:id",async(req,res)=>{const id=oid(req.params.id);if(id)await db.collection("canned").updateOne({_id:id},{$set:{title:req.body.title,body:req.body.body}});res.json({ok:true});});
// app.delete("/api/canned/:id",async(req,res)=>{const id=oid(req.params.id);if(id)await db.collection("canned").deleteOne({_id:id});res.json({ok:true});});

// app.get("/api/tags",async(req,res)=>{
//   const docs=await db.collection("tickets").find({}, {projection:{tags:1}}).toArray();
//   const counts={}; docs.forEach(t=>(Array.isArray(t.tags)?t.tags:[]).forEach(tag=>{counts[tag]=(counts[tag]||0)+1;}));
//   res.json(Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([name,count])=>({name,count})));
// });

// app.get("/api/stats",async(req,res)=>{
//   try {
//     const tickets=await db.collection("tickets").find({}).toArray();
//     const today=new Date().toISOString().slice(0,10);
//     const unresolved=tickets.filter(t=>!["resolved","closed"].includes(t.status));
//     const open=tickets.filter(t=>t.status==="open").length;
//     const pending=tickets.filter(t=>t.status==="pending").length;
//     const onHold=tickets.filter(t=>t.status==="on_hold").length;
//     const unassigned=unresolved.filter(t=>!t.assigneeId).length;
//     const overdue=unresolved.filter(t=>t.dueAt && new Date(t.dueAt).getTime()<Date.now()).length;
//     const resolvedToday=tickets.filter(t=>t.resolvedAt?.slice(0,10)===today).length;
//     const resolved=tickets.filter(t=>t.status==="resolved").length;
//     const closed=tickets.filter(t=>t.status==="closed").length;
//     const fr=tickets.filter(t=>t.firstResponseAt).map(t=>(new Date(t.firstResponseAt)-new Date(t.createdAt))/60000);
//     const rr=tickets.filter(t=>t.resolvedAt).map(t=>(new Date(t.resolvedAt)-new Date(t.createdAt))/3600000);
//     const cs=tickets.filter(t=>t.csatScore).map(t=>Number(t.csatScore));
//     const priorities=["urgent","high","medium","low"];
//     const byPriority=priorities.map(name=>({name,count:tickets.filter(t=>t.priority===name).length,value:tickets.filter(t=>t.priority===name).length}));
//     const statusNames=["open","pending","on_hold","resolved","closed"];
//     const byStatus=statusNames.map(name=>({name,value:tickets.filter(t=>t.status===name).length}));
//     const cats=[...new Set(tickets.map(t=>t.category).filter(Boolean))];
//     const byCategory=cats.map(name=>({name,value:tickets.filter(t=>t.category===name).length})).sort((a,b)=>b.value-a.value);
//     const sources=[...new Set(tickets.map(t=>t.source).filter(Boolean))];
//     const bySource=sources.map(name=>({name,value:tickets.filter(t=>t.source===name).length}));
//     const tagSet=[...new Set(tickets.flatMap(t=>Array.isArray(t.tags)?t.tags:[]).filter(Boolean))];
//     const byTag=tagSet.map(name=>({name,value:tickets.filter(t=>Array.isArray(t.tags)&&t.tags.includes(name)).length})).sort((a,b)=>b.value-a.value);
//     const agentDocs=await db.collection("agents").find({}).toArray();
//     const agentLoad=agentDocs.map(a=>({id:idOf(a._id),name:a.name,open:tickets.filter(t=>String(t.assigneeId)===String(a._id)&&!["resolved","closed"].includes(t.status)).length,resolved:tickets.filter(t=>String(t.assigneeId)===String(a._id)&&t.status==="resolved").length}));
//     const trend=[];
//     for(let i=13;i>=0;i--){const d=new Date(Date.now()-i*86400000).toISOString().slice(0,10);trend.push({date:d,created:tickets.filter(t=>t.createdAt?.slice(0,10)===d).length,resolved:tickets.filter(t=>t.resolvedAt?.slice(0,10)===d).length});}
//     res.json({total:tickets.length,open,pending,onHold,unassigned,overdue,createdToday:tickets.filter(t=>t.createdAt?.slice(0,10)===today).length,resolvedToday,resolved,closed,
//       avgFirstResponseMins:fr.length?Math.round(fr.reduce((a,b)=>a+b,0)/fr.length):null,
//       avgResolutionHours:rr.length?Math.round(rr.reduce((a,b)=>a+b,0)/rr.length*10)/10:null,
//       csatAvg:cs.length?Math.round(cs.reduce((a,b)=>a+b,0)/cs.length*10)/10:null,csatCount:cs.length,
//       trend,byPriority,byStatus,byCategory,bySource,byTag,agentLoad});
//   } catch(e){ console.error("GET /api/stats failed:",e); res.status(500).json({message:e.message}); }
// });

// app.get("/api/health",(req,res)=>res.json({ok:true,db:!!db}));

// // Standalone admin pages must be served explicitly before the SPA fallback.
// app.get(["/admin/signup", "/admin/signup/", "/admin-signup.html"], (req,res)=>
//   res.sendFile(path.join(__dirname,"admin-signup.html"))
// );

// // Serve hashed Vite assets explicitly. This prevents the SPA fallback from ever
// // returning index.html for a missing JS/CSS asset (which causes strict MIME errors).
// app.get(/^\/assets\/(.+)$/i, (req,res,next)=>{
//   const file = path.basename(req.params[0]);
//   if (!/^[a-zA-Z0-9._-]+\.(?:js|css|map|png|jpg|jpeg|svg|webp|woff2?)$/i.test(file)) return res.status(404).end();
//   const full = path.join(__dirname, "assets", file);
//   res.sendFile(full, err=>{
//     if (err && !res.headersSent) res.status(err.statusCode || 404).json({message:"Asset not found",asset:file});
//   });
// });

// // Static app. API routes and assets are registered before this fallback so
// // index.html can never masquerade as an API response or a JS/CSS asset.
// app.use(express.static(__dirname, { fallthrough: true, index: false }));
// app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));

// (async()=>{
//   try {
//     client=new MongoClient(MONGO_URI);
//     await client.connect();
//     db=client.db(DB_NAME);
//     await seed();
//     app.listen(PORT,()=>console.log(`Sahayak Desk running: http://localhost:${PORT}`));
//   } catch(e) {
//     console.error("MongoDB connection failed:",e.message);
//     process.exit(1);
//   }
// })();





// require("dotenv").config();

// const express = require("express");
// const path = require("path");
// const bcrypt = require("bcryptjs");
// const { MongoClient, ObjectId } = require("mongodb");

// const app = express();

// const PORT = Number(process.env.PORT || 5000);
// const MONGO_URI = process.env.MONGO_URI;
// const DB_NAME = process.env.MONGO_DB_NAME || "sahayak_desk";

// if (!MONGO_URI) {
//   console.error("MONGO_URI missing. Put it in .env");
//   process.exit(1);
// }

// app.use(express.json({ limit: "1mb" }));
// app.use(express.urlencoded({ extended: true }));

// let db;
// let client;

// const now = () => new Date().toISOString();

// const idOf = (x) => String(x);

// const normalizeEmail = (value) =>
//   String(value ?? "").trim().toLowerCase();

// function oid(id) {
//   try {
//     return new ObjectId(id);
//   } catch {
//     return null;
//   }
// }

// function cleanAgent(agent) {
//   if (!agent) return null;

//   return {
//     id: idOf(agent._id),
//     name: agent.name,
//     email: agent.email,
//     role: agent.role,
//     team: agent.team,
//     active: !!agent.active
//   };
// }

// /* =========================================================
//    DATABASE SEED
// ========================================================= */

// async function seed() {
//   const agents = db.collection("agents");

//   const adminEmail = "jais@gmail.com";
//   const adminPassword = "admin123";

//   const existing = await agents.findOne({
//     email: adminEmail
//   });

//   /*
//     IMPORTANT LOGIN FIX

//     If the default admin exists but:
//     - password is wrong
//     - password is missing
//     - account is inactive
//     - role is not admin

//     then repair the built-in demo admin.
//   */

//   if (!existing) {
//     await agents.insertOne({
//       name: "Sahayak Admin",
//       email: adminEmail,
//       password: await bcrypt.hash(adminPassword, 10),
//       role: "admin",
//       team: "Support",
//       active: true,
//       seededDemo: true,
//       createdAt: now()
//     });

//     console.log("Default admin created:");
//     console.log("Email: jais@gmail.com");
//     console.log("Password: admin123");
//   } else {
//     let passwordOK = false;

//     if (existing.password) {
//       try {
//         passwordOK = await bcrypt.compare(
//           adminPassword,
//           existing.password
//         );
//       } catch {
//         passwordOK = false;
//       }
//     }

//     if (
//       !passwordOK ||
//       existing.active !== true ||
//       existing.role !== "admin"
//     ) {
//       await agents.updateOne(
//         {
//           _id: existing._id
//         },
//         {
//           $set: {
//             password: await bcrypt.hash(adminPassword, 10),
//             role: "admin",
//             active: true,
//             seededDemo: true
//           }
//         }
//       );

//       console.log("Default admin credentials repaired:");
//       console.log("Email: jais@gmail.com");
//       console.log("Password: admin123");
//     } else {
//       console.log("Default admin verified:");
//       console.log("Email: jais@gmail.com");
//       console.log("Password: admin123");
//     }
//   }

//   /*
//     Demo agents
//   */

//   const count = await agents.countDocuments();

//   if (count === 1) {
//     await agents.insertMany([
//       {
//         name: "Rohit Verma",
//         email: "rohit@sahayak.local",
//         password: await bcrypt.hash("demo123", 10),
//         role: "agent",
//         team: "Technical",
//         active: true,
//         createdAt: now()
//       },
//       {
//         name: "Sneha Iyer",
//         email: "sneha@sahayak.local",
//         password: await bcrypt.hash("demo123", 10),
//         role: "agent",
//         team: "Billing",
//         active: true,
//         createdAt: now()
//       }
//     ]);
//   }

//   /*
//     Settings
//   */

//   const settings = db.collection("settings");

//   if (!(await settings.findOne({ _id: "main" }))) {
//     await settings.insertOne({
//       _id: "main",
//       brandName: "Sahayak Desk",
//       accent: "#0f766e",
//       position: "right",
//       categories: [
//         "Billing",
//         "Technical",
//         "Account",
//         "Feature Request",
//         "General"
//       ]
//     });
//   }
// }

// /* =========================================================
//    HELPERS
// ========================================================= */

// function priorityHours(priority) {
//   return {
//     low: 72,
//     medium: 24,
//     high: 8,
//     urgent: 4
//   }[priority] || 24;
// }

// function publicTicket(ticket) {
//   return {
//     id: idOf(ticket._id),
//     ref: ticket.ref,
//     subject: ticket.subject,
//     customerName: ticket.customerName,
//     customerEmail: ticket.customerEmail,
//     category: ticket.category,
//     priority: ticket.priority,
//     status: ticket.status,
//     source: ticket.source,

//     assigneeId: ticket.assigneeId
//       ? idOf(ticket.assigneeId)
//       : null,

//     assigneeName: ticket.assigneeName || null,

//     tags: ticket.tags || [],
//     tagList: ticket.tags || [],

//     createdAt: ticket.createdAt,
//     updatedAt: ticket.updatedAt,
//     dueAt: ticket.dueAt,

//     firstResponseAt: ticket.firstResponseAt || null,
//     resolvedAt: ticket.resolvedAt || null,

//     csatScore: ticket.csatScore ?? null,
//     csatComment: ticket.csatComment || null,

//     messageCount: ticket.messageCount || 0
//   };
// }

// async function nextRef() {
//   const counters = db.collection("counters");

//   const result = await counters.findOneAndUpdate(
//     {
//       _id: "ticket"
//     },
//     {
//       $inc: {
//         seq: 1
//       }
//     },
//     {
//       upsert: true,
//       returnDocument: "after"
//     }
//   );

//   return `HD-${1000 + Number(result.seq || 1)}`;
// }

// /* =========================================================
//    AUTH
// ========================================================= */

// app.post("/api/auth/login", async (req, res) => {
//   try {
//     const email = normalizeEmail(req.body?.email);
//     const password = String(req.body?.password || "");

//     console.log("\n========== LOGIN ATTEMPT ==========");
//     console.log("Email:", email);
//     console.log("Password received:", password ? "YES" : "NO");

//     if (!email || !password) {
//       console.log("LOGIN FAILED: Email or password missing");

//       return res.status(400).json({
//         message: "Email aur password required hai"
//       });
//     }

//     const agent = await db.collection("agents").findOne({
//       email
//     });

//     if (!agent) {
//       console.log("LOGIN FAILED: User not found");

//       return res.status(401).json({
//         message: "Invalid email or password"
//       });
//     }

//     console.log("User found:", agent.email);
//     console.log("Role:", agent.role);
//     console.log("Active:", agent.active);
//     console.log("Password hash exists:", !!agent.password);

//     if (!agent.active) {
//       console.log("LOGIN FAILED: Account inactive");

//       return res.status(401).json({
//         message: "Account inactive hai"
//       });
//     }

//     if (!agent.password) {
//       console.log("LOGIN FAILED: Password missing in database");

//       return res.status(401).json({
//         message: "Account password missing hai"
//       });
//     }

//     let passwordOK = false;

//     try {
//       passwordOK = await bcrypt.compare(
//         password,
//         agent.password
//       );
//     } catch (error) {
//       console.error(
//         "bcrypt compare error:",
//         error.message
//       );

//       passwordOK = false;
//     }

//     console.log("Password correct:", passwordOK);

//     if (!passwordOK) {
//       console.log("LOGIN FAILED: Wrong password");

//       return res.status(401).json({
//         message: "Invalid email or password"
//       });
//     }

//     console.log("LOGIN SUCCESS:", email);
//     console.log("=================================\n");

//     return res.json(cleanAgent(agent));

//   } catch (error) {
//     console.error(
//       "POST /api/auth/login failed:",
//       error
//     );

//     return res.status(500).json({
//       message: "Login server error",
//       error: error.message
//     });
//   }
// });

// /* =========================================================
//    AUTH SIGNUP
// ========================================================= */

// app.post("/api/auth/signup", async (req, res) => {
//   try {
//     const {
//       name,
//       email,
//       password
//     } = req.body || {};

//     if (
//       !name ||
//       !email ||
//       !password ||
//       String(password).length < 6
//     ) {
//       return res.status(400).json({
//         message:
//           "Name, valid email aur 6+ character password zaroori hai"
//       });
//     }

//     const normalizedEmail = normalizeEmail(email);

//     const exists = await db
//       .collection("agents")
//       .findOne({
//         email: normalizedEmail
//       });

//     if (exists) {
//       return res.status(409).json({
//         message: "Ye email already registered hai"
//       });
//     }

//     const doc = {
//       name: String(name).trim(),

//       email: normalizedEmail,

//       password: await bcrypt.hash(
//         String(password),
//         10
//       ),

//       role: "admin",
//       team: "Support",
//       active: true,

//       createdAt: now()
//     };

//     const result = await db
//       .collection("agents")
//       .insertOne(doc);

//     return res.status(201).json(
//       cleanAgent({
//         ...doc,
//         _id: result.insertedId
//       })
//     );

//   } catch (error) {
//     console.error(
//       "POST /api/auth/signup failed:",
//       error
//     );

//     return res.status(500).json({
//       message: error.message
//     });
//   }
// });

// /* =========================================================
//    AGENTS
// ========================================================= */

// app.get("/api/agents", async (req, res) => {
//   try {
//     const agents = await db
//       .collection("agents")
//       .find({})
//       .sort({
//         name: 1
//       })
//       .toArray();

//     res.json(
//       agents.map(cleanAgent)
//     );

//   } catch (error) {
//     res.status(500).json({
//       message: error.message
//     });
//   }
// });

// app.post("/api/agents", async (req, res) => {
//   try {
//     const {
//       name,
//       email,
//       password = "demo123",
//       team = "Support",
//       role = "agent",
//       active = 1
//     } = req.body || {};

//     if (!name || !email) {
//       return res.status(400).json({
//         message: "Name aur email required"
//       });
//     }

//     const normalizedEmail =
//       normalizeEmail(email);

//     const exists = await db
//       .collection("agents")
//       .findOne({
//         email: normalizedEmail
//       });

//     if (exists) {
//       return res.status(409).json({
//         message: "Email already exists"
//       });
//     }

//     const doc = {
//       name: String(name).trim(),

//       email: normalizedEmail,

//       password: await bcrypt.hash(
//         String(password),
//         10
//       ),

//       role:
//         role === "admin"
//           ? "admin"
//           : "agent",

//       team: String(team),

//       active: !!active,

//       createdAt: now()
//     };

//     const result = await db
//       .collection("agents")
//       .insertOne(doc);

//     res.status(201).json(
//       cleanAgent({
//         ...doc,
//         _id: result.insertedId
//       })
//     );

//   } catch (error) {
//     res.status(500).json({
//       message: error.message
//     });
//   }
// });

// app.patch("/api/agents/:id", async (req, res) => {
//   try {
//     const id = oid(req.params.id);

//     if (!id) {
//       return res.status(400).json({
//         message: "Invalid agent id"
//       });
//     }

//     const patch = {
//       ...req.body
//     };

//     delete patch._id;

//     if (patch.password) {
//       patch.password = await bcrypt.hash(
//         String(patch.password),
//         10
//       );
//     }

//     if ("active" in patch) {
//       patch.active = !!patch.active;
//     }

//     if (patch.role) {
//       patch.role =
//         patch.role === "admin"
//           ? "admin"
//           : "agent";
//     }

//     await db
//       .collection("agents")
//       .updateOne(
//         {
//           _id: id
//         },
//         {
//           $set: patch
//         }
//       );

//     const agent = await db
//       .collection("agents")
//       .findOne({
//         _id: id
//       });

//     res.json(
//       cleanAgent(agent)
//     );

//   } catch (error) {
//     res.status(500).json({
//       message: error.message
//     });
//   }
// });

// app.delete("/api/agents/:id", async (req, res) => {
//   try {
//     const id = oid(req.params.id);

//     if (!id) {
//       return res.status(400).json({
//         message: "Invalid agent id"
//       });
//     }

//     await db
//       .collection("agents")
//       .deleteOne({
//         _id: id
//       });

//     await db
//       .collection("tickets")
//       .updateMany(
//         {
//           assigneeId: id
//         },
//         {
//           $set: {
//             assigneeId: null,
//             assigneeName: null,
//             updatedAt: now()
//           }
//         }
//       );

//     res.json({
//       ok: true
//     });

//   } catch (error) {
//     res.status(500).json({
//       message: error.message
//     });
//   }
// });

// /* =========================================================
//    TICKET CREATION
// ========================================================= */

// async function createTicket(body, source) {
//   const {
//     subject,
//     description,
//     customerName,
//     customerEmail,
//     category = "General",
//     priority = "medium"
//   } = body || {};

//   if (
//     !subject ||
//     String(subject).trim().length < 4
//   ) {
//     throw new Error(
//       "Subject kam se kam 4 characters ka ho"
//     );
//   }

//   if (
//     !description ||
//     String(description).trim().length < 8
//   ) {
//     throw new Error(
//       "Detail kam se kam 8 characters ki ho"
//     );
//   }

//   if (
//     !customerName ||
//     String(customerName).trim().length < 2
//   ) {
//     throw new Error("Naam required");
//   }

//   if (
//     !customerEmail ||
//     !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
//       customerEmail
//     )
//   ) {
//     throw new Error(
//       "Valid email required"
//     );
//   }

//   const createdAt = now();

//   const dueAt =
//     new Date(
//       Date.now() +
//       priorityHours(priority) *
//       3600000
//     ).toISOString();

//   const document = {
//     ref: await nextRef(),

//     subject:
//       String(subject).trim(),

//     customerName:
//       String(customerName).trim(),

//     customerEmail:
//       String(customerEmail)
//         .trim()
//         .toLowerCase(),

//     category:
//       String(category),

//     priority,

//     status: "open",

//     source:
//       source || "widget",

//     assigneeId: null,

//     assigneeName: null,

//     tags: [
//       "new",

//       String(category)
//         .toLowerCase()
//         .replace(/\s+/g, "-"),

//       source || "widget"
//     ],

//     createdAt,
//     updatedAt: createdAt,
//     dueAt,

//     firstResponseAt: null,
//     resolvedAt: null,

//     csatScore: null,
//     csatComment: null
//   };

//   const result = await db
//     .collection("tickets")
//     .insertOne(document);

//   await db
//     .collection("messages")
//     .insertOne({
//       _id: new ObjectId(),

//       ticketId:
//         result.insertedId,

//       authorType: "customer",

//       authorName:
//         document.customerName,

//       agentId: null,

//       body:
//         String(description).trim(),

//       internal: false,

//       createdAt
//     });

//   await db
//     .collection("tickets")
//     .updateOne(
//       {
//         _id: result.insertedId
//       },
//       {
//         $set: {
//           messageCount: 1
//         }
//       }
//     );

//   await db
//     .collection("activities")
//     .insertOne({
//       ticketId:
//         result.insertedId,

//       actor:
//         document.customerName,

//       text:
//         "Ticket create kiya",

//       createdAt
//     });

//   return publicTicket({
//     ...document,

//     _id: result.insertedId,

//     messageCount: 1
//   });
// }

// /* =========================================================
//    CREATE TICKETS
// ========================================================= */

// app.post(
//   "/api/public/tickets",
//   async (req, res) => {
//     try {
//       const ticket =
//         await createTicket(
//           req.body,
//           "widget"
//         );

//       res.status(201).json(ticket);

//     } catch (error) {
//       res.status(400).json({
//         message: error.message
//       });
//     }
//   }
// );

// app.post(
//   "/api/tickets",
//   async (req, res) => {
//     try {
//       const ticket =
//         await createTicket(
//           req.body,
//           req.body.source || "phone"
//         );

//       res.status(201).json(ticket);

//     } catch (error) {
//       res.status(400).json({
//         message: error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    TICKET FILTER
// ========================================================= */

// function ticketFilter(query) {
//   const filter = {};

//   if (
//     query.status &&
//     query.status !== "all"
//   ) {
//     if (
//       query.status === "unresolved"
//     ) {
//       filter.status = {
//         $nin: [
//           "resolved",
//           "closed"
//         ]
//       };
//     } else {
//       filter.status =
//         query.status;
//     }
//   }

//   if (
//     query.priority &&
//     query.priority !== "all"
//   ) {
//     filter.priority =
//       query.priority;
//   }

//   if (
//     query.category &&
//     query.category !== "all"
//   ) {
//     filter.category =
//       query.category;
//   }

//   if (
//     query.assigneeId &&
//     query.assigneeId !== "all"
//   ) {
//     filter.assigneeId =
//       query.assigneeId ===
//       "unassigned"
//         ? null
//         : oid(query.assigneeId);
//   }

//   if (
//     query.tag &&
//     query.tag !== "all"
//   ) {
//     filter.tags =
//       String(query.tag);
//   }

//   if (query.search) {
//     const regex = {
//       $regex:
//         String(query.search),
//       $options: "i"
//     };

//     filter.$or = [
//       {
//         ref: regex
//       },
//       {
//         subject: regex
//       },
//       {
//         customerName: regex
//       },
//       {
//         customerEmail: regex
//       }
//     ];
//   }

//   return filter;
// }

// /* =========================================================
//    GET TICKETS
// ========================================================= */

// app.get(
//   [
//     "/api/tickets",
//     "/api/tickets/"
//   ],
//   async (req, res) => {
//     try {
//       const query = {
//         ...req.query
//       };

//       if (
//         query.q &&
//         !query.search
//       ) {
//         query.search =
//           query.q;
//       }

//       const filter =
//         ticketFilter(query);

//       let sort = {
//         createdAt: -1
//       };

//       if (
//         query.sort === "oldest"
//       ) {
//         sort = {
//           createdAt: 1
//         };
//       }

//       if (
//         query.sort === "priority"
//       ) {
//         sort = {
//           priority: 1,
//           createdAt: -1
//         };
//       }

//       if (
//         query.sort === "due"
//       ) {
//         sort = {
//           dueAt: 1
//         };
//       }

//       const tickets =
//         await db
//           .collection("tickets")
//           .find(filter)
//           .sort(sort)
//           .limit(500)
//           .toArray();

//       const ids =
//         tickets.map(
//           ticket => ticket._id
//         );

//       const counts = {};

//       if (ids.length) {
//         const messageCounts =
//           await db
//             .collection("messages")
//             .aggregate([
//               {
//                 $match: {
//                   ticketId: {
//                     $in: ids
//                   }
//                 }
//               },
//               {
//                 $group: {
//                   _id:
//                     "$ticketId",

//                   count: {
//                     $sum: 1
//                   }
//                 }
//               }
//             ])
//             .toArray();

//         messageCounts.forEach(
//           item => {
//             counts[
//               String(item._id)
//             ] = item.count;
//           }
//         );
//       }

//       res.json(
//         tickets.map(
//           ticket =>
//             publicTicket({
//               ...ticket,

//               messageCount:
//                 counts[
//                   String(ticket._id)
//                 ] || 0
//             })
//         )
//       );

//     } catch (error) {
//       console.error(
//         "GET /api/tickets failed:",
//         error
//       );

//       res.status(500).json({
//         message:
//           "Tickets load nahi ho pa rahe",

//         error:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    SINGLE TICKET
// ========================================================= */

// app.get(
//   "/api/tickets/:id",
//   async (req, res) => {
//     try {
//       const id =
//         oid(req.params.id);

//       if (!id) {
//         return res.status(400).json({
//           message:
//             "Invalid ticket id"
//         });
//       }

//       const ticket =
//         await db
//           .collection("tickets")
//           .findOne({
//             _id: id
//           });

//       if (!ticket) {
//         return res.status(404).json({
//           message:
//             "Ticket not found"
//         });
//       }

//       const messages =
//         await db
//           .collection("messages")
//           .find({
//             ticketId: id,
//             $or: [
//               {
//                 internal: false
//               },
//               {
//                 internal: {
//                   $exists: false
//                 }
//               }
//             ]
//           })
//           .sort({
//             createdAt: 1
//           })
//           .toArray();

//       const allMessages =
//         await db
//           .collection("messages")
//           .find({
//             ticketId: id
//           })
//           .sort({
//             createdAt: 1
//           })
//           .toArray();

//       const activities =
//         await db
//           .collection("activities")
//           .find({
//             ticketId: id
//           })
//           .sort({
//             createdAt: 1
//           })
//           .toArray();

//       res.json({
//         ticket: publicTicket({
//           ...ticket,

//           messageCount:
//             allMessages.length
//         }),

//         messages:
//           allMessages.map(
//             message => ({
//               id:
//                 idOf(message._id),

//               authorType:
//                 message.authorType,

//               authorName:
//                 message.authorName,

//               agentId:
//                 message.agentId
//                   ? idOf(
//                       message.agentId
//                     )
//                   : null,

//               body:
//                 message.body,

//               internal:
//                 !!message.internal,

//               createdAt:
//                 message.createdAt
//             })
//           ),

//         activities:
//           activities.map(
//             activity => ({
//               id:
//                 idOf(activity._id),

//               actor:
//                 activity.actor,

//               text:
//                 activity.text,

//               createdAt:
//                 activity.createdAt
//             })
//           )
//       });

//     } catch (error) {
//       console.error(
//         "GET ticket failed:",
//         error
//       );

//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    UPDATE TICKET
// ========================================================= */

// app.patch(
//   "/api/tickets/:id",
//   async (req, res) => {
//     try {
//       const id =
//         oid(req.params.id);

//       if (!id) {
//         return res.status(400).json({
//           message:
//             "Invalid ticket id"
//         });
//       }

//       const patch = {
//         ...req.body
//       };

//       delete patch.actor;
//       delete patch._id;

//       if (
//         patch.assigneeId !==
//         undefined
//       ) {
//         patch.assigneeId =
//           patch.assigneeId
//             ? oid(patch.assigneeId)
//             : null;

//         if (patch.assigneeId) {
//           const agent =
//             await db
//               .collection("agents")
//               .findOne({
//                 _id:
//                   patch.assigneeId
//               });

//           patch.assigneeName =
//             agent?.name ||
//             null;
//         } else {
//           patch.assigneeName =
//             null;
//         }
//       }

//       if (
//         patch.tags &&
//         !Array.isArray(
//           patch.tags
//         )
//       ) {
//         delete patch.tags;
//       }

//       if (
//         patch.status ===
//           "resolved" &&
//         !patch.resolvedAt
//       ) {
//         patch.resolvedAt =
//           now();
//       }

//       patch.updatedAt =
//         now();

//       await db
//         .collection("tickets")
//         .updateOne(
//           {
//             _id: id
//           },
//           {
//             $set: patch
//           }
//         );

//       const updated =
//         await db
//           .collection("tickets")
//           .findOne({
//             _id: id
//           });

//       const actor =
//         req.body?.actor ||
//         "Admin";

//       const changed =
//         Object.keys(
//           patch
//         )
//           .filter(
//             key =>
//               key !==
//               "updatedAt"
//           )
//           .join(", ");

//       if (changed) {
//         await db
//           .collection("activities")
//           .insertOne({
//             ticketId: id,

//             actor,

//             text:
//               `Ticket update: ${changed}`,

//             createdAt:
//               patch.updatedAt
//           });
//       }

//       res.json(
//         publicTicket(updated)
//       );

//     } catch (error) {
//       console.error(
//         "PATCH ticket failed:",
//         error
//       );

//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    TICKET MESSAGES
// ========================================================= */

// app.post(
//   "/api/tickets/:id/messages",
//   async (req, res) => {
//     try {
//       const id =
//         oid(req.params.id);

//       if (!id) {
//         return res.status(400).json({
//           message:
//             "Invalid ticket id"
//         });
//       }

//       const ticket =
//         await db
//           .collection("tickets")
//           .findOne({
//             _id: id
//           });

//       if (!ticket) {
//         return res.status(404).json({
//           message: "Not found"
//         });
//       }

//       const {
//         body,
//         internal = false,
//         agentId,
//         authorName = "Agent",
//         authorType = "agent"
//       } = req.body || {};

//       if (
//         !body ||
//         !String(body).trim()
//       ) {
//         return res.status(400).json({
//           message:
//             "Message empty"
//         });
//       }

//       const createdAt =
//         now();

//       await db
//         .collection("messages")
//         .insertOne({
//           ticketId: id,

//           authorType,

//           authorName,

//           agentId:
//             agentId
//               ? oid(agentId)
//               : null,

//           body:
//             String(body).trim(),

//           internal:
//             !!internal,

//           createdAt
//         });

//       await db
//         .collection("tickets")
//         .updateOne(
//           {
//             _id: id
//           },
//           {
//             $inc: {
//               messageCount: 1
//             }
//           }
//         );

//       await db
//         .collection("activities")
//         .insertOne({
//           ticketId: id,

//           actor:
//             authorName,

//           text:
//             internal
//               ? "Internal note add kiya"
//               : "Reply bheja",

//           createdAt
//         });

//       const patch = {
//         updatedAt:
//           createdAt
//       };

//       if (
//         authorType === "agent" &&
//         !internal &&
//         !ticket.firstResponseAt
//       ) {
//         patch.firstResponseAt =
//           createdAt;
//       }

//       await db
//         .collection("tickets")
//         .updateOne(
//           {
//             _id: id
//           },
//           {
//             $set: patch
//           }
//         );

//       res.json({
//         ok: true
//       });

//     } catch (error) {
//       console.error(
//         "POST message failed:",
//         error
//       );

//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    BULK TICKET UPDATE
// ========================================================= */

// app.post(
//   "/api/tickets/bulk",
//   async (req, res) => {
//     try {
//       const {
//         ids = [],
//         patch = {}
//       } = req.body || {};

//       let updated = 0;

//       for (
//         const rawId of ids
//       ) {
//         const id =
//           oid(rawId);

//         if (!id) continue;

//         const currentPatch =
//           {
//             ...patch
//           };

//         delete currentPatch.actor;

//         if (
//           currentPatch.assigneeId
//         ) {
//           currentPatch.assigneeId =
//             oid(
//               currentPatch.assigneeId
//             );

//           const agent =
//             await db
//               .collection("agents")
//               .findOne({
//                 _id:
//                   currentPatch.assigneeId
//               });

//           currentPatch.assigneeName =
//             agent?.name ||
//             null;
//         }

//         currentPatch.updatedAt =
//           now();

//         const result =
//           await db
//             .collection("tickets")
//             .updateOne(
//               {
//                 _id: id
//               },
//               {
//                 $set:
//                   currentPatch
//               }
//             );

//         updated +=
//           result.modifiedCount;
//       }

//       res.json({
//         updated
//       });

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    DELETE TICKET
// ========================================================= */

// app.delete(
//   "/api/tickets/:id",
//   async (req, res) => {
//     try {
//       const id =
//         oid(req.params.id);

//       if (!id) {
//         return res.status(400).json({
//           message:
//             "Invalid ticket id"
//         });
//       }

//       await db
//         .collection("tickets")
//         .deleteOne({
//           _id: id
//         });

//       await db
//         .collection("messages")
//         .deleteMany({
//           ticketId: id
//         });

//       await db
//         .collection("activities")
//         .deleteMany({
//           ticketId: id
//         });

//       res.json({
//         ok: true
//       });

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    PUBLIC TICKET
// ========================================================= */

// app.get(
//   "/api/public/tickets/:ref",
//   async (req, res) => {
//     try {
//       const ticket =
//         await db
//           .collection("tickets")
//           .findOne({
//             ref:
//               String(
//                 req.params.ref
//               )
//           });

//       if (!ticket) {
//         return res.status(404).json({
//           message:
//             "Ticket not found"
//         });
//       }

//       const messages =
//         await db
//           .collection("messages")
//           .find({
//             ticketId:
//               ticket._id,

//             internal: {
//               $ne: true
//             }
//           })
//           .sort({
//             createdAt: 1
//           })
//           .toArray();

//       res.json({
//         ticket:
//           publicTicket(ticket),

//         messages:
//           messages.map(
//             message => ({
//               id:
//                 idOf(message._id),

//               authorType:
//                 message.authorType,

//               authorName:
//                 message.authorName,

//               body:
//                 message.body,

//               createdAt:
//                 message.createdAt,

//               internal:
//                 false
//             })
//           )
//       });

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    PUBLIC TICKET MESSAGE
// ========================================================= */

// app.post(
//   "/api/public/tickets/:ref/messages",
//   async (req, res) => {
//     try {
//       const ticket =
//         await db
//           .collection("tickets")
//           .findOne({
//             ref:
//               String(
//                 req.params.ref
//               )
//           });

//       if (!ticket) {
//         return res.status(404).json({
//           message:
//             "Ticket not found"
//         });
//       }

//       const body =
//         String(
//           req.body?.body || ""
//         ).trim();

//       if (!body) {
//         return res.status(400).json({
//           message:
//             "Message empty"
//         });
//       }

//       const createdAt =
//         now();

//       await db
//         .collection("messages")
//         .insertOne({
//           _id:
//             new ObjectId(),

//           ticketId:
//             ticket._id,

//           authorType:
//             "customer",

//           authorName:
//             ticket.customerName,

//           agentId:
//             null,

//           body,

//           internal:
//             false,

//           createdAt
//         });

//       await db
//         .collection("tickets")
//         .updateOne(
//           {
//             _id:
//               ticket._id
//           },
//           {
//             $set: {
//               updatedAt:
//                 createdAt,

//               status:
//                 ticket.status ===
//                 "resolved"
//                   ? "open"
//                   : ticket.status
//             },

//             $inc: {
//               messageCount: 1
//             }
//           }
//         );

//       await db
//         .collection("activities")
//         .insertOne({
//           ticketId:
//             ticket._id,

//           actor:
//             ticket.customerName,

//           text:
//             "Customer ne reply bheja",

//           createdAt
//         });

//       res.json({
//         ok: true
//       });

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    CSAT
// ========================================================= */

// app.post(
//   "/api/public/tickets/:ref/csat",
//   async (req, res) => {
//     try {
//       const ticket =
//         await db
//           .collection("tickets")
//           .findOne({
//             ref:
//               String(
//                 req.params.ref
//               )
//           });

//       if (!ticket) {
//         return res.status(404).json({
//           message:
//             "Ticket not found"
//         });
//       }

//       const score =
//         Math.max(
//           1,
//           Math.min(
//             5,
//             Number(
//               req.body?.score || 0
//             )
//           )
//         );

//       await db
//         .collection("tickets")
//         .updateOne(
//           {
//             _id:
//               ticket._id
//           },
//           {
//             $set: {
//               csatScore:
//                 score,

//               updatedAt:
//                 now()
//             }
//           }
//         );

//       res.json({
//         ok: true
//       });

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    SETTINGS
// ========================================================= */

// app.get(
//   "/api/public/config",
//   async (req, res) => {
//     try {
//       const settings =
//         await db
//           .collection("settings")
//           .findOne({
//             _id: "main"
//           });

//       res.json(
//         settings || {
//           categories: [
//             "Billing",
//             "Technical",
//             "Account",
//             "Feature Request",
//             "General"
//           ]
//         }
//       );

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// app.get(
//   "/api/settings",
//   async (req, res) => {
//     try {
//       const settings =
//         await db
//           .collection("settings")
//           .findOne({
//             _id: "main"
//           });

//       res.json(
//         settings || {
//           categories: [
//             "Billing",
//             "Technical",
//             "Account",
//             "Feature Request",
//             "General"
//           ]
//         }
//       );

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// app.patch(
//   "/api/settings",
//   async (req, res) => {
//     try {
//       const patch = {
//         ...req.body
//       };

//       delete patch._id;

//       await db
//         .collection("settings")
//         .updateOne(
//           {
//             _id: "main"
//           },
//           {
//             $set: patch
//           },
//           {
//             upsert: true
//           }
//         );

//       const settings =
//         await db
//           .collection("settings")
//           .findOne({
//             _id: "main"
//           });

//       res.json(settings);

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    ARTICLES
// ========================================================= */

// app.get(
//   "/api/articles",
//   async (req, res) => {
//     try {
//       const filter =
//         req.query.q
//           ? {
//               title: {
//                 $regex:
//                   String(
//                     req.query.q
//                   ),
//                 $options: "i"
//               }
//             }
//           : {};

//       const articles =
//         await db
//           .collection("articles")
//           .find(filter)
//           .sort({
//             updatedAt: -1
//           })
//           .toArray();

//       res.json(
//         articles.map(
//           article => ({
//             ...article,

//             id:
//               idOf(
//                 article._id
//               ),

//             _id:
//               undefined
//           })
//         )
//       );

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// app.post(
//   "/api/articles",
//   async (req, res) => {
//     try {
//       const {
//         title,
//         category = "General",
//         body,
//         published = true
//       } = req.body || {};

//       if (!title || !body) {
//         return res.status(400).json({
//           message:
//             "Title/body required"
//         });
//       }

//       const document = {
//         title,

//         category,

//         body,

//         published:
//           !!published,

//         views: 0,

//         updatedAt:
//           now()
//       };

//       const result =
//         await db
//           .collection("articles")
//           .insertOne(
//             document
//           );

//       res.status(201).json({
//         ...document,

//         id:
//           idOf(
//             result.insertedId
//           )
//       });

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// app.patch(
//   "/api/articles/:id",
//   async (req, res) => {
//     try {
//       const id =
//         oid(req.params.id);

//       if (!id) {
//         return res.status(400).json({
//           message:
//             "Invalid id"
//         });
//       }

//       const patch = {
//         ...req.body,

//         updatedAt:
//           now()
//       };

//       delete patch._id;

//       await db
//         .collection("articles")
//         .updateOne(
//           {
//             _id: id
//           },
//           {
//             $set: patch
//           }
//         );

//       res.json({
//         ...patch,

//         id:
//           req.params.id
//       });

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// app.delete(
//   "/api/articles/:id",
//   async (req, res) => {
//     try {
//       const id =
//         oid(req.params.id);

//       if (id) {
//         await db
//           .collection("articles")
//           .deleteOne({
//             _id: id
//           });
//       }

//       res.json({
//         ok: true
//       });

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    PUBLIC ARTICLES
// ========================================================= */

// app.get(
//   "/api/public/articles",
//   async (req, res) => {
//     try {
//       const query =
//         String(
//           req.query.q || ""
//         );

//       const filter = {
//         published: true
//       };

//       if (query) {
//         filter.title = {
//           $regex: query,
//           $options: "i"
//         };
//       }

//       const articles =
//         await db
//           .collection("articles")
//           .find(filter)
//           .sort({
//             updatedAt: -1
//           })
//           .toArray();

//       res.json(
//         articles.map(
//           article => ({
//             ...article,

//             id:
//               idOf(
//                 article._id
//               )
//           })
//         )
//       );

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// app.get(
//   "/api/public/articles/:id",
//   async (req, res) => {
//     try {
//       const id =
//         oid(req.params.id);

//       if (!id) {
//         return res.status(404).json({
//           message:
//             "Not found"
//         });
//       }

//       const article =
//         await db
//           .collection("articles")
//           .findOne({
//             _id: id,

//             published: true
//           });

//       if (!article) {
//         return res.status(404).json({
//           message:
//             "Not found"
//         });
//       }

//       await db
//         .collection("articles")
//         .updateOne(
//           {
//             _id: id
//           },
//           {
//             $inc: {
//               views: 1
//             }
//           }
//         );

//       res.json({
//         ...article,

//         id:
//           idOf(article._id)
//       });

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    CANNED RESPONSES
// ========================================================= */

// app.get(
//   "/api/canned",
//   async (req, res) => {
//     try {
//       const canned =
//         await db
//           .collection("canned")
//           .find({})
//           .sort({
//             title: 1
//           })
//           .toArray();

//       res.json(
//         canned.map(
//           item => ({
//             ...item,

//             id:
//               idOf(item._id)
//           })
//         )
//       );

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// app.post(
//   "/api/canned",
//   async (req, res) => {
//     try {
//       const {
//         title,
//         body
//       } = req.body || {};

//       const result =
//         await db
//           .collection("canned")
//           .insertOne({
//             title,
//             body
//           });

//       res.status(201).json({
//         title,
//         body,

//         id:
//           idOf(
//             result.insertedId
//           )
//       });

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// app.patch(
//   "/api/canned/:id",
//   async (req, res) => {
//     try {
//       const id =
//         oid(req.params.id);

//       if (id) {
//         await db
//           .collection("canned")
//           .updateOne(
//             {
//               _id: id
//             },
//             {
//               $set: {
//                 title:
//                   req.body.title,

//                 body:
//                   req.body.body
//               }
//             }
//           );
//       }

//       res.json({
//         ok: true
//       });

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// app.delete(
//   "/api/canned/:id",
//   async (req, res) => {
//     try {
//       const id =
//         oid(req.params.id);

//       if (id) {
//         await db
//           .collection("canned")
//           .deleteOne({
//             _id: id
//           });
//       }

//       res.json({
//         ok: true
//       });

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    TAGS
// ========================================================= */

// app.get(
//   "/api/tags",
//   async (req, res) => {
//     try {
//       const tickets =
//         await db
//           .collection("tickets")
//           .find(
//             {},
//             {
//               projection: {
//                 tags: 1
//               }
//             }
//           )
//           .toArray();

//       const counts = {};

//       tickets.forEach(
//         ticket => {
//           (
//             Array.isArray(
//               ticket.tags
//             )
//               ? ticket.tags
//               : []
//           ).forEach(
//             tag => {
//               counts[tag] =
//                 (counts[tag] || 0) +
//                 1;
//             }
//           );
//         }
//       );

//       res.json(
//         Object.entries(
//           counts
//         )
//           .sort(
//             (a, b) =>
//               b[1] - a[1]
//           )
//           .map(
//             ([name, count]) => ({
//               name,
//               count
//             })
//           )
//       );

//     } catch (error) {
//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    STATS
// ========================================================= */

// app.get(
//   "/api/stats",
//   async (req, res) => {
//     try {
//       const tickets =
//         await db
//           .collection("tickets")
//           .find({})
//           .toArray();

//       const today =
//         new Date()
//           .toISOString()
//           .slice(0, 10);

//       const unresolved =
//         tickets.filter(
//           ticket =>
//             ![
//               "resolved",
//               "closed"
//             ].includes(
//               ticket.status
//             )
//         );

//       const open =
//         tickets.filter(
//           ticket =>
//             ticket.status ===
//             "open"
//         ).length;

//       const pending =
//         tickets.filter(
//           ticket =>
//             ticket.status ===
//             "pending"
//         ).length;

//       const onHold =
//         tickets.filter(
//           ticket =>
//             ticket.status ===
//             "on_hold"
//         ).length;

//       const unassigned =
//         unresolved.filter(
//           ticket =>
//             !ticket.assigneeId
//         ).length;

//       const overdue =
//         unresolved.filter(
//           ticket =>
//             ticket.dueAt &&
//             new Date(
//               ticket.dueAt
//             ).getTime() <
//               Date.now()
//         ).length;

//       const resolvedToday =
//         tickets.filter(
//           ticket =>
//             ticket.resolvedAt
//               ?.slice(0, 10) ===
//             today
//         ).length;

//       const resolved =
//         tickets.filter(
//           ticket =>
//             ticket.status ===
//             "resolved"
//         ).length;

//       const closed =
//         tickets.filter(
//           ticket =>
//             ticket.status ===
//             "closed"
//         ).length;

//       const firstResponses =
//         tickets
//           .filter(
//             ticket =>
//               ticket.firstResponseAt
//           )
//           .map(
//             ticket =>
//               (
//                 new Date(
//                   ticket.firstResponseAt
//                 ) -
//                 new Date(
//                   ticket.createdAt
//                 )
//               ) /
//               60000
//           );

//       const resolutions =
//         tickets
//           .filter(
//             ticket =>
//               ticket.resolvedAt
//           )
//           .map(
//             ticket =>
//               (
//                 new Date(
//                   ticket.resolvedAt
//                 ) -
//                 new Date(
//                   ticket.createdAt
//                 )
//               ) /
//               3600000
//           );

//       const csat =
//         tickets
//           .filter(
//             ticket =>
//               ticket.csatScore
//           )
//           .map(
//             ticket =>
//               Number(
//                 ticket.csatScore
//               )
//           );

//       const priorities = [
//         "urgent",
//         "high",
//         "medium",
//         "low"
//       ];

//       const byPriority =
//         priorities.map(
//           name => ({
//             name,

//             count:
//               tickets.filter(
//                 ticket =>
//                   ticket.priority ===
//                   name
//               ).length,

//             value:
//               tickets.filter(
//                 ticket =>
//                   ticket.priority ===
//                   name
//               ).length
//           })
//         );

//       const statusNames = [
//         "open",
//         "pending",
//         "on_hold",
//         "resolved",
//         "closed"
//       ];

//       const byStatus =
//         statusNames.map(
//           name => ({
//             name,

//             value:
//               tickets.filter(
//                 ticket =>
//                   ticket.status ===
//                   name
//               ).length
//           })
//         );

//       const categories = [
//         ...new Set(
//           tickets
//             .map(
//               ticket =>
//                 ticket.category
//             )
//             .filter(Boolean)
//         )
//       ];

//       const byCategory =
//         categories
//           .map(
//             name => ({
//               name,

//               value:
//                 tickets.filter(
//                   ticket =>
//                     ticket.category ===
//                     name
//                 ).length
//             })
//           )
//           .sort(
//             (a, b) =>
//               b.value -
//               a.value
//           );

//       const sources = [
//         ...new Set(
//           tickets
//             .map(
//               ticket =>
//                 ticket.source
//             )
//             .filter(Boolean)
//         )
//       ];

//       const bySource =
//         sources.map(
//           name => ({
//             name,

//             value:
//               tickets.filter(
//                 ticket =>
//                   ticket.source ===
//                   name
//               ).length
//           })
//         );

//       const tagSet = [
//         ...new Set(
//           tickets.flatMap(
//             ticket =>
//               Array.isArray(
//                 ticket.tags
//               )
//                 ? ticket.tags
//                 : []
//           )
//         )
//       ].filter(Boolean);

//       const byTag =
//         tagSet
//           .map(
//             name => ({
//               name,

//               value:
//                 tickets.filter(
//                   ticket =>
//                     Array.isArray(
//                       ticket.tags
//                     ) &&
//                     ticket.tags.includes(
//                       name
//                     )
//                 ).length
//             })
//           )
//           .sort(
//             (a, b) =>
//               b.value -
//               a.value
//           );

//       const agentDocs =
//         await db
//           .collection("agents")
//           .find({})
//           .toArray();

//       const agentLoad =
//         agentDocs.map(
//           agent => ({
//             id:
//               idOf(
//                 agent._id
//               ),

//             name:
//               agent.name,

//             open:
//               tickets.filter(
//                 ticket =>
//                   String(
//                     ticket.assigneeId
//                   ) ===
//                     String(
//                       agent._id
//                     ) &&
//                   ![
//                     "resolved",
//                     "closed"
//                   ].includes(
//                     ticket.status
//                   )
//               ).length,

//             resolved:
//               tickets.filter(
//                 ticket =>
//                   String(
//                     ticket.assigneeId
//                   ) ===
//                     String(
//                       agent._id
//                     ) &&
//                   ticket.status ===
//                     "resolved"
//               ).length
//           })
//         );

//       const trend = [];

//       for (
//         let i = 13;
//         i >= 0;
//         i--
//       ) {
//         const date =
//           new Date(
//             Date.now() -
//               i *
//                 86400000
//           )
//             .toISOString()
//             .slice(0, 10);

//         trend.push({
//           date,

//           created:
//             tickets.filter(
//               ticket =>
//                 ticket.createdAt
//                   ?.slice(
//                     0,
//                     10
//                   ) === date
//             ).length,

//           resolved:
//             tickets.filter(
//               ticket =>
//                 ticket.resolvedAt
//                   ?.slice(
//                     0,
//                     10
//                   ) === date
//             ).length
//         });
//       }

//       res.json({
//         total:
//           tickets.length,

//         open,

//         pending,

//         onHold,

//         unassigned,

//         overdue,

//         createdToday:
//           tickets.filter(
//             ticket =>
//               ticket.createdAt
//                 ?.slice(
//                   0,
//                   10
//                 ) === today
//           ).length,

//         resolvedToday,

//         resolved,

//         closed,

//         avgFirstResponseMins:
//           firstResponses.length
//             ? Math.round(
//                 firstResponses.reduce(
//                   (a, b) =>
//                     a + b,
//                   0
//                 ) /
//                   firstResponses.length
//               )
//             : null,

//         avgResolutionHours:
//           resolutions.length
//             ? Math.round(
//                 (
//                   resolutions.reduce(
//                     (a, b) =>
//                       a + b,
//                     0
//                   ) /
//                   resolutions.length
//                 ) *
//                   10
//               ) / 10
//             : null,

//         csatAvg:
//           csat.length
//             ? Math.round(
//                 (
//                   csat.reduce(
//                     (a, b) =>
//                       a + b,
//                     0
//                   ) /
//                   csat.length
//                 ) *
//                   10
//               ) / 10
//             : null,

//         csatCount:
//           csat.length,

//         trend,

//         byPriority,

//         byStatus,

//         byCategory,

//         bySource,

//         byTag,

//         agentLoad
//       });

//     } catch (error) {
//       console.error(
//         "GET /api/stats failed:",
//         error
//       );

//       res.status(500).json({
//         message:
//           error.message
//       });
//     }
//   }
// );

// /* =========================================================
//    HEALTH
// ========================================================= */

// app.get(
//   "/api/health",
//   (req, res) => {
//     res.json({
//       ok: true,
//       db: !!db
//     });
//   }
// );

// /* =========================================================
//    ADMIN SIGNUP PAGE
// ========================================================= */

// app.get(
//   [
//     "/admin/signup",
//     "/admin/signup/",
//     "/admin-signup.html"
//   ],
//   (req, res) => {
//     res.sendFile(
//       path.join(
//         __dirname,
//         "admin-signup.html"
//       )
//     );
//   }
// );

// /* =========================================================
//    VITE ASSETS
// ========================================================= */

// app.get(
//   /^\/assets\/(.+)$/i,
//   (req, res) => {
//     const file =
//       path.basename(
//         req.params[0]
//       );

//     if (
//       !/^[a-zA-Z0-9._-]+\.(?:js|css|map|png|jpg|jpeg|svg|webp|woff2?)$/i.test(
//         file
//       )
//     ) {
//       return res
//         .status(404)
//         .end();
//     }

//     const fullPath =
//       path.join(
//         __dirname,
//         "assets",
//         file
//       );

//     res.sendFile(
//       fullPath,
//       error => {
//         if (
//           error &&
//           !res.headersSent
//         ) {
//           res
//             .status(
//               error.statusCode ||
//                 404
//             )
//             .json({
//               message:
//                 "Asset not found",

//               asset:
//                 file
//             });
//         }
//       }
//     );
//   }
// );

// /* =========================================================
//    STATIC FILES
// ========================================================= */

// app.use(
//   express.static(
//     __dirname,
//     {
//       fallthrough: true,
//       index: false
//     }
//   )
// );

// /* =========================================================
//    SPA FALLBACK
// ========================================================= */

// app.get(
//   "*",
//   (req, res) => {
//     res.sendFile(
//       path.join(
//         __dirname,
//         "index.html"
//       )
//     );
//   }
// );

// /* =========================================================
//    START SERVER
// ========================================================= */

// (async () => {
//   try {
//     client =
//       new MongoClient(
//         MONGO_URI
//       );

//     await client.connect();

//     db =
//       client.db(
//         DB_NAME
//       );

//     console.log(
//       "MongoDB connected:",
//       DB_NAME
//     );

//     await seed();

//     app.listen(
//       PORT,
//       () => {
//         console.log(
//           `Sahayak Desk running: http://localhost:${PORT}`
//         );

//         console.log(
//           "Default login:"
//         );

//         console.log(
//           "Email: jais@gmail.com"
//         );

//         console.log(
//           "Password: admin123"
//         );
//       }
//     );

//   } catch (error) {
//     console.error(
//       "MongoDB connection failed:",
//       error.message
//     );

//     process.exit(1);
//   }
// })();

