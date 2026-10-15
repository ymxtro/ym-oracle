const {JSDOM}=require((process.env.JSDOM_DIR||'.')+'/node_modules/jsdom');const fs=require('fs');
const R=process.env.RELAY_DIR||process.argv[2];
let fails=0;const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)fails++;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const now=Date.now();
function mkApi(st){return async(url,opts)=>{
 const j=(o,s)=>({status:s||200,json:async()=>o});const u=url.split('?')[0];
 if(u==='/api/master-key'&&opts&&opts.method==='POST'){const b=JSON.parse(opts.body);st.posts.push(b);
   if(st.need&&!b.confirmOpen)return j({success:false,needConfirm:true,open:2,message:'2 trades are still open on the current account.'},409);
   if(b.apiKey==='BAD')return j({success:false,message:'Bybit rejected this key: API key is invalid'},400);
   st.hint='••••'+b.apiKey.slice(-4);st.source='saved';st.env=b.env;return j({success:true,hint:st.hint,env:b.env,equity:1234.5});}
 if(u==='/api/master-key/reset'){st.source='render';st.hint='••••env1';return j({success:true,hint:st.hint,env:'live'});}
 if(u==='/api/master-key')return j({success:true,hint:st.hint,hasKey:true,env:st.env,source:st.source,canSave:true});
 const data={'/api/status':{mode:'live',masterEnv:'live',breaker:{tripped:false}},'/api/balance':{success:true,balance:100,available:90},'/api/positions':{success:true,positions:[]},'/api/trade-log':{success:true,trades:[]},
  '/api/fleet-status':{success:true,lateAfterSecs:270,bots:['I','II','III','IV'].map(i=>({name:'YM ORACLE '+i,lastSeenAt:now-20e3,online:true}))},'/api/exec-reports':{success:true,reports:[]},'/api/sync-status':{success:true,masterOpen:0,loggedOpen:0,lastOkAt:now,staleOpen:0}};
 return j(data[u]||{success:true});};}
async function boot(file,st,pw){const html=fs.readFileSync(R+'/public/'+file,'utf8');
 const dom=new JSDOM(html,{runScripts:'dangerously',url:'http://localhost/',beforeParse(w){w.fetch=mkApi(st);w.prompt=()=>null;w.localStorage.setItem('ym_dash_pw',pw||'x');}});
 await sleep(300);return dom;}
(async()=>{
 const st={posts:[],hint:'••••env1',source:'render',env:'live'};
 let d=await boot('dashboard.html',st);let w=d.window,D=w.document;
 D.querySelector('[data-act=settings]').click();await sleep(100);
 ok(/Trading account/.test(D.querySelector('.drawer').textContent)&&/••••env1/.test(D.querySelector('.drawer').textContent),'settings shows the current key hint, not the key');
 ok(/from Render settings/.test(D.querySelector('.drawer').textContent),'says the key comes from Render');
 ok([...D.querySelectorAll('.drawer a')].map(a=>a.getAttribute('href')).join()==='/,/admin,/join','Go to links: Home, Admin, Sign-up');
 D.querySelector('[data-act=acctOpen]').click();
 ok(D.querySelector('#acctSecret').type==='password','secret field is masked');
 D.querySelector('[data-act=acctSave]').click();await sleep(50);
 ok(/both the key and the secret/.test(D.querySelector('.drawer').textContent)&&st.posts.length===0,'empty form is refused locally');
 const set=(id,v)=>{const i=D.querySelector('#'+id);i.value=v;i.dispatchEvent(new w.Event('input',{bubbles:true}));};
 set('acctKey','BAD');set('acctSecret','s');D.querySelector('[data-act=acctSave]').click();await sleep(100);
 ok(/rejected this key/.test(D.querySelector('.drawer').textContent),'server refusal is shown');
 ok(D.querySelector('#acctKey').value==='BAD','typed values survive a re-render');
 st.need=true;set('acctKey','NEWKEY9999');D.querySelector('[data-act=acctEnv][data-v=demo]').click();
 ok(D.querySelector('#acctKey').value==='NEWKEY9999','values kept when switching Live/Demo');
 D.querySelector('[data-act=acctSave]').click();await sleep(100);
 ok(/2 trades are still open/.test(D.querySelector('.drawer').textContent)&&/Switch anyway/.test(D.querySelector('.drawer').textContent),'open trades ask for confirmation');
 D.querySelector('[data-act=acctSave]').click();await sleep(150);
 ok(st.posts[st.posts.length-1].confirmOpen===true&&st.posts[st.posts.length-1].env==='demo','confirmed save sends confirmOpen and the chosen env');
 ok(/Saved\. Now trading with ••••9999 \(Demo\)/.test(D.querySelector('.drawer').textContent)&&/saved from this page/.test(D.querySelector('.drawer').textContent),'success message and source updated');
 ok(!D.querySelector('.drawer').innerHTML.includes('NEWKEY9999'),'the key is cleared from the page after saving');
 D.querySelector('[data-act=acctOpen]').click();
 D.querySelector('[data-act=acctReset]').click();ok(/Tap again/.test(D.querySelector('.drawer').textContent),'reset needs a second tap');
 D.querySelector('[data-act=acctReset]').click();await sleep(150);
 ok(/from Render settings/.test(D.querySelector('.drawer').textContent),'reset returns to Render settings');
 // hub
 let h=await boot('home.html',{posts:[]});D=h.window.document;
 ok(/Trade signals/.test(D.body.textContent)&&/Create your account/.test(D.body.textContent)&&/Admin console/.test(D.body.textContent),'landing welcomes visitors and keeps the owner links in the footer');
 const hrefs=[...D.querySelectorAll('a')].map(a=>a.getAttribute('href')).filter(Boolean);
 ok(['/join#signup','/join#login','/join','/admin'].every(x=>hrefs.includes(x))&&!hrefs.includes('/dashboard'),'landing links go to sign up, log in and the one admin console');
 ok(D.querySelector('footer').textContent.includes('Admin console')&&!D.querySelector('main').textContent.includes('Admin console'),'admin access sits in the footer only');
 ok(D.getElementById('status').textContent.trim()==='','no owner status and no password prompt for a visitor');
 let h2=await boot('home.html',{posts:[]});
 process.exit(fails?1:0);})();
