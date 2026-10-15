const {JSDOM}=require((process.env.JSDOM_DIR||'.')+'/node_modules/jsdom');const fs=require('fs');
const html=fs.readFileSync(process.argv[2],'utf8');
let fails=0;const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)fails++;};
const now=Date.now();
function mkApi(over){over=over||{};return async(url,opts)=>{
 const j=o=>({status:200,json:async()=>o});
 const u=url.split('?')[0];
 const data={
 '/api/status':{mode:'live',breaker:{tripped:false}},
 '/api/balance':{success:true,balance:1234.5,available:900},
 '/api/positions':{success:true,positions:[{symbol:'ETHUSDT',side:'Buy',size:'0.45',entryPrice:'3412.1000',markPrice:'3438.9000',unrealisedPnl:'12.06',leverage:'5',positionValue:'1547.5'}]},
 '/api/trade-log':{success:true,trades:[{status:'CLOSED',symbol:'SOLUSDT',side:'Buy',realizedPnl:'14.6',roiPct:'29.2',closedAt:new Date(now-3600e3).toISOString()},{status:'CLOSED',symbol:'<img src=x onerror=alert(1)>',side:'Sell',realizedPnl:'-8.2',roiPct:'-16',closedAt:new Date(now-7200e3).toISOString()}]},
 '/api/fleet-status':{success:true,lateAfterSecs:270,bots:[{name:'YM ORACLE I',lastSeenAt:now-30e3,online:true},{name:'YM ORACLE II',lastSeenAt:now-300e3,online:true},{name:'YM ORACLE III',lastSeenAt:now-900e3,online:false},{name:'YM ORACLE IV',lastSeenAt:now-60e3,online:true}]},
 '/api/exec-reports':{success:true,reports:[{at:now-360e3,sev:'fail',kind:'ORDER',symbol:'PEPEUSDT',side:'SELL',text:'Not enough free balance',detail:'wanted $100'}]},
 '/api/sync-status':{success:true,mode:'live',masterOpen:1,loggedOpen:1,lastOkAt:now,staleOpen:0,lastError:null,lastRecovered:null},
 };
 return j(Object.assign(data,over)[u]||{success:true});};}
async function boot(prefs,over){
 const dom=new JSDOM(html,{runScripts:'dangerously',url:'http://localhost/dashboard',beforeParse(w){
  w.fetch=mkApi(over);w.prompt=()=>null;
  if(prefs)w.localStorage.setItem('ym_dash_prefs',JSON.stringify(prefs));}});
 await new Promise(r=>setTimeout(r,300));return dom;}
(async()=>{
 let d=await boot(null);let w=d.window,D=w.document;
 ok(D.documentElement.dataset.theme==='midnight','default theme midnight');
 ok(D.querySelector('.hero'),'cockpit layout by default');
 ok(/\$1,234\.50/.test(D.body.textContent),'balance shown');
 ok(/ETH/.test(D.body.textContent)&&/LONG/.test(D.body.textContent),'position shown');
 ok(D.querySelector('img')===null,'symbol is escaped (no injected img)');
 ok(/3 of 4 online/.test(D.body.textContent),'bots: 3 of 4 online');
 ok(/Late/.test(D.body.textContent),'late bot flagged');
 ok(/PEPE short order failed/.test(D.body.textContent),'alert shown');
 ok(/In step with Bybit/.test(D.body.textContent),'sync line');
 // settings
 D.querySelector('[data-act=settings]').click();
 ok(D.querySelector('.drawer'),'settings opens');
 D.querySelector('[data-act=theme][data-v=daylight]').click();
 ok(D.documentElement.dataset.theme==='daylight','theme switches to daylight');
 ok(JSON.parse(w.localStorage.getItem('ym_dash_prefs')).theme==='daylight','theme saved');
 D.querySelector('[data-act=hide]').click();
 ok(!/\$1,234\.50/.test(D.querySelector('#app').textContent)&&/••••/.test(D.querySelector('#app').textContent),'amounts hidden');
 D.querySelector('[data-act=layout][data-v=glance]').click();
 ok(!D.querySelector('.hero')&&D.querySelector('.gbal'),'glance layout');
 ok(D.querySelector('[data-act=acc][data-key=alerts]').getAttribute('aria-expanded')==='true','alerts auto-open on problem');
 ok(D.querySelector('[data-act=acc][data-key=pos]').getAttribute('aria-expanded')==='false','positions closed by default');
 D.querySelector('[data-act=closeSettings]').click();
 ok(!D.querySelector('.drawer'),'settings closes');
 D.querySelector('[data-act=acc][data-key=pos]').click();
 ok(D.querySelector('[data-act=acc][data-key=pos]').getAttribute('aria-expanded')==='true','accordion toggles');
 // halt two-tap
 let calls=[];const orig=w.fetch;w.fetch=async(u,o)=>{calls.push(u.split('?')[0]);return orig(u,o);};
 D.querySelector('[data-act=halt]').click();
 ok(!calls.includes('/api/halt'),'first halt tap does not halt');
 D.querySelector('[data-act=halt]').click();await new Promise(r=>setTimeout(r,50));
 ok(calls.includes('/api/halt'),'second tap halts');
 // go live modal (from paper)
 let d2=await boot({layout:'cockpit',theme:'ember'},{'/api/status':{mode:'paper',breaker:{tripped:false}},'/api/positions':{success:true,positions:[]},'/api/exec-reports':{success:true,reports:[]}});
 D=d2.window.document;
 ok(D.documentElement.dataset.theme==='ember','saved theme restored on load');
 ok(/Paper mode: no real orders/.test(D.body.textContent),'paper banner');
 D.querySelector('[data-act=mode]').click();
 ok(D.querySelector('#liveIn'),'live modal opens');
 let c2=[];const o2=d2.window.fetch;d2.window.fetch=async(u,o)=>{c2.push(u.split('?')[0]);return o2(u,o);};
 D.querySelector('[data-act=liveGo]').click();await new Promise(r=>setTimeout(r,30));
 ok(!c2.includes('/api/mode'),'cannot go live without typing LIVE');
 const inp=D.querySelector('#liveIn');inp.value='LIVE';inp.dispatchEvent(new d2.window.Event('input'));
 D.querySelector('[data-act=liveGo]').click();await new Promise(r=>setTimeout(r,30));
 ok(c2.includes('/api/mode'),'go live after typing LIVE');
 // all-clear glance sentence
 let d3=await boot({layout:'glance'},{'/api/exec-reports':{success:true,reports:[]},'/api/fleet-status':{success:true,lateAfterSecs:270,bots:[1,2,3].map(i=>({name:'YM ORACLE '+'I'.repeat(i),lastSeenAt:now-20e3,online:true}))}});
 ok(/All good/.test(d3.window.document.body.textContent),'glance says all good when healthy');
 process.exit(fails?1:0);})();
