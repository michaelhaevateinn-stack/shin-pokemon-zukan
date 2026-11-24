'use strict';
(() => {
 const $=id=>document.getElementById(id);
 const TYPES=['ノーマル','ほのお','みず','でんき','くさ','こおり','かくとう','どく','じめん','ひこう','エスパー','むし','いわ','ゴースト','ドラゴン','あく','はがね','フェアリー'];
 const validTypes=types=>Array.isArray(types)&&types.length>=1&&types.length<=3&&new Set(types).size===types.length&&types.every(type=>TYPES.includes(type));
 const COURSES={
  regional:['リージョンフォーム','既存ポケモンをもとに、別の地方の気候や暮らしに適応したすがたを考えたい。元のポケモンらしさを残しながら、新しいタイプや見た目を一緒に決めて。'],
  evolution:['進化系','既存ポケモンをもとに、新しい進化先や分岐進化を考えたい。進化前の特徴を引き継ぎ、何がどう成長したかが伝わる見た目を一緒に考えて。'],
  model:['〇〇モデル','動物・道具・食べ物など、好きなものをモデルにしたオリジナルのポケモンを考えたい。モチーフの特徴が見た目やタイプにどう出るか一緒に考えて。']
 };
 const MAX_IMAGE=2*1024*1024, MAX_UPLOAD=20*1024*1024, MAX_ENTRIES=150, MAX_BACKUP=45*1024*1024;
 let cloud=null, cloudSession=0, cloudState='unconfigured', cloudEmail=null, sharedRows=[], listRun=0, pendingShared=null;
 let preview=null, pendingImage=null, uploadSeq=0, cardURLs=[], saving=false, importing=false, imageWorking=false;
 const active=session=>cloudState==='ready'&&session===cloudSession;
 const status=(id,msg)=>{if($(id))$(id).textContent=msg;};
 const report=(id,msg)=>status(id,msg);
 const make=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 function readPrompt(){
  const form=$('promptForm'), course=form.querySelector('input[name="course"]:checked')?.value;
  if(!Object.hasOwn(COURSES,course))return '';
  const [title,brief]=COURSES[course];
  const theme=$('promptTheme').value.trim().slice(0,120);
  return ['ゲボラ、みはっけんポケモンを一緒につくろう！','コース：'+title,brief,
    theme?'最初のタネ：'+theme:'最初のタネはまだ決めていないよ。',
    'まず、考える順番に合わせて質問を1つだけして。答えたら次の質問へ進んで、名前・タイプ（ふつうは1つか2つ、特別な案なら3つまで。重複なし）・見た目を一緒に決めたい。私が迷ったら、その質問への候補を3つだけ出して。',
    '内容がまとまったら、画像を作る前に案を短く確認して。私がOKしたら、このポケモン1体の全身が見える画像を1枚作り、図鑑登録用に「名前」と「タイプ」を書いてね。'
  ].join('\n');
 }
 function renderPrompt(){
  const val=readPrompt();
  $('promptOutput').value=val;
  $('copyPrompt').disabled=!val;
  return val;
 }
 $('promptForm').addEventListener('submit',ev=>{ev.preventDefault();report('promptStatus',renderPrompt()?'プロンプトが できたよ。コピーして ゲボラに おくってね。':'コースを えらんでね。');});
 $('promptForm').addEventListener('change',()=>{renderPrompt();report('promptStatus','');});
 $('promptTheme').addEventListener('input',()=>{renderPrompt();report('promptStatus','');});
 $('copyPrompt').addEventListener('click',async()=>{
  const value=renderPrompt();if(!value)return;
  try{
   if(!navigator.clipboard?.writeText)throw Error('clipboard unavailable');
   await navigator.clipboard.writeText(value);
   report('promptStatus','コピーしたよ。ゲボラの チャットに はりつけてね。');
  }catch{
   const field=$('promptOutput');field.focus();field.select();
   try{field.setSelectionRange(0,field.value.length);}catch{}
   let copied=false;try{copied=document.execCommand('copy');}catch{}
   report('promptStatus',copied?'コピーしたよ。ゲボラの チャットに はりつけてね。':'自動コピーできなかったよ。選んだ文を 長押しして コピーしてね。');
  }
 });
 for(const [id,placeholder] of [['entryType1','タイプを えらぶ'],['entryType2','なし'],['entryType3','なし']]){
  const el=$(id); if(!el)continue; el.replaceChildren();
  for(const val of ['',...TYPES]){const option=make('option',val||placeholder);option.value=val;el.append(option);}
 }
 function imageBlob(source){
  return new Promise((resolve,reject)=>{
   const url=URL.createObjectURL(source), image=new Image();
   image.onerror=()=>{URL.revokeObjectURL(url);reject(Error('画像を読み込めなかったよ。PNG・JPG・WebPで ためしてね。'));};
   image.onload=()=>{
    URL.revokeObjectURL(url);
    const w=image.naturalWidth,h=image.naturalHeight;
    if(!w||!h||w*h>50e6){reject(Error('画像が大きすぎるよ。小さくして ためしてね。'));return;}
    const canvas=document.createElement('canvas');const scale=Math.min(1,1000/Math.max(w,h));
    canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
    const ctx=canvas.getContext('2d');
    if(!ctx){reject(Error('画像を処理できなかったよ。'));return;}
    ctx.drawImage(image,0,0,canvas.width,canvas.height);
    canvas.toBlob(blob=>blob?.size&&blob.size<=MAX_IMAGE?resolve(blob):reject(Error('画像を保存できる大きさにできなかったよ。')),'image/webp',.84);
   };
   image.src=url;
  });
 }
 function setPreview(blob){
  if(preview)URL.revokeObjectURL(preview);
  preview=blob?URL.createObjectURL(blob):null;
  const img=$('entryPreview');
  if(preview)img.src=preview;else img.removeAttribute('src');
  img.hidden=!preview;
 }
 $('entryImage').addEventListener('change',async()=>{
  const token=++uploadSeq, file=$('entryImage').files?.[0];
  pendingImage=null;imageWorking=false;setPreview(null);report('entryStatus','');
  if(!file)return;
  const isImage=/^image\/(?:png|jpeg|webp|gif|avif|heic|heif)$/i.test(file.type)||(!file.type&&/\.(png|jpe?g|webp|gif|avif|heic|heif)$/i.test(file.name));
  if(!isImage||!file.size||file.size>MAX_UPLOAD){
   report('entryStatus','20MB以下の PNG・JPG・WebPなどの画像を えらんでね。');return;
  }
  imageWorking=true;report('entryStatus','画像を じゅんびしているよ…');
  try{const blob=await imageBlob(file);if(token!==uploadSeq)return;pendingImage=blob;setPreview(blob);report('entryStatus','画像を えらんだよ。');}
  catch(error){if(token===uploadSeq)report('entryStatus',error.message);}
  finally{if(token===uploadSeq)imageWorking=false;}
 });
 function renderList(){
  for(const url of cardURLs)URL.revokeObjectURL(url);cardURLs=[];
  const list=$('entryList');list.replaceChildren();
  const displayed=sharedRows;
  if(!displayed.length)list.append(make('p','共有の記録は まだありません。'));
  for(const entry of displayed){
   const article=make('article');article.className='entry-card';
   const img=make('img');img.loading='lazy';img.alt=entry.name;
   const url=URL.createObjectURL(entry.image);cardURLs.push(url);img.src=url;article.append(img);
   article.append(make('h3',entry.name));
   const tags=make('div');tags.className='entry-types';
   for(const type of entry.types){const tag=make('span',type);tag.className='entry-type';tags.append(tag);}
   article.append(tags);list.append(article);
  }
  status('entryCount',displayed.length+'ひき');
  $('exportEntries').disabled=cloudState!=='ready'||!sharedRows.length;
 }
 $('entryForm').addEventListener('submit',async ev=>{
  ev.preventDefault();if(cloudState!=='ready'||saving||importing)return;
  if(imageWorking){report('entryStatus','画像の じゅんびが おわるまで まってね。');return;}
  const name=$('entryName').value.trim(),t1=$('entryType1').value;
  const types=[t1,$('entryType2').value,$('entryType3')?.value].filter(Boolean);
  if(!name||name.length>40||!t1||!validTypes(types)||!pendingImage){
   report('entryStatus','名前と 画像、タイプ（かぶらないように）を えらんでね。');return;
  }
  {
   const submitted=uploadSeq, session=cloudSession;
   const signature=JSON.stringify([submitted,name,types]);
   if(!pendingShared||pendingShared.signature!==signature){
    pendingShared={signature,entry:{id:crypto.randomUUID?.()||('z'+Date.now()+Math.random()),name,types,image:pendingImage,saved:Date.now()}};
   }
   const draft=pendingShared; saving=true;
   report('entryStatus','家族の図鑑に登録中…');
   try{
    const result=await cloud.putIfMissing(draft.entry);
    if(result!=='added'&&result!=='existing')throw Error('Save failed');
    if(session!==cloudSession||cloudState!=='ready'){
     report('entryStatus','ログインが変わったため確認できなかったよ。入力は残してあるよ。');
     return;
    }
    pendingShared=null;
    if(submitted===uploadSeq){ev.target.reset();uploadSeq++;pendingImage=null;setPreview(null);}
    report('entryStatus',name+'を家族の図鑑に登録したよ！');
    await loadShared();
   }catch{
    if(active(session))report('entryStatus','家族の図鑑に登録できなかったよ。入力は残してあるので、もういちど試してね。');
   }finally{saving=false;}
   return;
  }
 });
 const backupMessage=msg=>report($('backupStatus')?'backupStatus':'entryStatus',msg);
 function dataURL(blob){return new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=()=>reject(fr.error);fr.readAsDataURL(blob);});}
 $('exportEntries')?.addEventListener('click',async()=>{
  if(cloudState!=='ready')return;
  const session=cloudSession;
  try{
   const copied=await cloud.list();
   if(!active(session)||!copied.length)return;
   const entries=[];let size=0;
   for(const item of copied){
    const {image,...rest}=item,encoded=await dataURL(image);size+=encoded.length;
    if(size>MAX_BACKUP)throw Error('ファイルが大きすぎて 書き出せなかったよ。');
    entries.push({...rest,image:encoded});
   }
   if(!active(session))return;
   const url=URL.createObjectURL(new Blob([JSON.stringify({format:'mihakken-pokemon-zukan',version:1,entries})],{type:'application/json'}));
   const link=make('a');link.href=url;link.download='mihakken-pokemon-zukan.json';document.body.append(link);link.click();link.remove();
   setTimeout(()=>URL.revokeObjectURL(url),2000);backupMessage('図鑑の バックアップを 書き出したよ。');
  }catch(error){if(active(session))backupMessage(error.message||'バックアップを 書き出せなかったよ。');}
 });
 $('importEntries')?.addEventListener('change',async ev=>{
  const file=ev.target.files?.[0];ev.target.value='';
  if(!file||cloudState!=='ready'||importing||saving)return;
  const session=cloudSession; importing=true; let added=0,existing=0,writing=false;
  try{
   if(file.size>MAX_BACKUP)throw Error('バックアップ ファイルが 大きすぎるよ。');
   const raw=JSON.parse(await file.text());
   if(raw.format!=='mihakken-pokemon-zukan'||raw.version!==1||!Array.isArray(raw.entries)||raw.entries.length>MAX_ENTRIES)throw Error('この図鑑の バックアップを えらんでね。');
   const ids=new Set(), additions=[];
   for(const row of raw.entries){
    const {id,name,types,image,saved}=row||{};
    if(typeof id!=='string'||id==='.'||id==='..'||!/^[-a-z0-9.]{1,75}$/i.test(id)||typeof name!=='string'||!name.trim()||name.length>40||
       !validTypes(types)||
       typeof image!=='string'||image.length>MAX_IMAGE*1.4||!/^data:image\/(?:png|webp|jpeg);base64,[a-z0-9+/=]+$/i.test(image)||
       !Number.isSafeInteger(saved)||saved<0)throw Error('こわれた 図鑑データがあるよ。何も 追加しなかったよ。');
    if(ids.has(id))continue;ids.add(id);
    const [,mime,encoded]=image.match(/^data:([^;]+);base64,(.+)$/i);
    const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
    const blob=await imageBlob(new Blob([bytes],{type:mime}));
    additions.push({id,name:name.trim(),types,image:blob,saved});
   }
   if(!active(session)||!additions.length)return;
   writing=true;
   for(const row of additions){
    if(!active(session))return;
    backupMessage('共有図鑑に読み込み中… '+(added+existing)+' / '+additions.length);
    const result=await cloud.putIfMissing(row);
    if(result==='added')added++;else if(result==='existing')existing++;else throw Error('Save failed');
   }
   if(active(session)){
    await loadShared();
    if(active(session))backupMessage(added+'ひき追加したよ。'+existing+'ひきは登録済みだよ。');
   }
  }catch(error){
   if(active(session)){
    if(writing){
     await loadShared();
     if(active(session))backupMessage(added+'ひき追加したところで止まったよ。同じファイルを読み込めば、残りを追加できるよ。');
    }else backupMessage(error instanceof SyntaxError?'この図鑑の バックアップを えらんでね。':error.message||'読み込めなかったよ。');
   }
  }finally{importing=false;}
 });
 const notices={
  unconfigured:'共有はまだ設定されていません。',
  connecting:'共有図鑑に接続中…',
  signedOut:'家族の共有図鑑を見るには ログインしてね。',
  unauthorized:'このアカウントは共有図鑑の許可がありません。',
  ready:'家族の共有図鑑に接続したよ。',
  error:'共有図鑑に接続できなかったよ。'
 };
 function cloudChanged(info){
  const state=info?.state||'unconfigured', email=info?.email||null;
  if(state!==cloudState||email!==cloudEmail){
   cloudSession++;listRun++;sharedRows=[];
   report('cloudActionStatus','');backupMessage('');report('entryStatus','');
   $('entryForm').reset();uploadSeq++;pendingImage=null;pendingShared=null;imageWorking=false;setPreview(null);
  }
  const changed=state!==cloudState||email!==cloudEmail;
  cloudState=state;cloudEmail=email;
  report('cloudStatus',notices[state]||notices.error);
  const diagnostic=$('cloudDiagnostics'), ownUid=$('cloudUid');
  if(diagnostic&&ownUid){
   diagnostic.hidden=state!=='unauthorized';
   ownUid.value=state==='unauthorized'?(cloud?.diagnosticsUid?.()||''):'';
   report('cloudReason',({
    'google-unverified':'確認コード A：Googleログインの確認情報がそろっていません。',
    'rules-denied':'確認コード D：このGoogleアカウントは家族の共有図鑑に許可されていません。',
    'access-denied':'確認コード E：Firestoreが共有図鑑へのアクセスを拒否しました。'
   })[info?.reason]||'');
   if(state!=='unauthorized')diagnostic.open=false;
  }
  if($('cloudSignIn'))$('cloudSignIn').hidden=!['signedOut','error'].includes(state);
  if($('cloudSignOut'))$('cloudSignOut').hidden=!['ready','unauthorized','error'].includes(state);
  $('familyContent').hidden=state!=='ready';
  $('familyNav').hidden=state!=='ready';
  $('cloudRefresh').hidden=state!=='ready';
  renderList();
  if(state==='ready'&&changed)void loadShared();
 }
 function hookCloud(){
  if(cloud||!window.dexCloud?.subscribe)return;
  cloud=window.dexCloud;
  cloud.subscribe(cloudChanged);
 }
 async function loadShared(){
  if(cloudState!=='ready')return;
  const token=++listRun, session=cloudSession;
  report('cloudActionStatus','共有図鑑を 読み込んでいるよ…');
  try{
   const rows=await cloud.list();
   if(token!==listRun||session!==cloudSession||cloudState!=='ready')return;
   sharedRows=rows.filter(row=>row&&typeof row.name==='string'&&row.name.length<=40&&validTypes(row.types)&&row.image instanceof Blob&&row.image.size<=MAX_IMAGE).sort((a,b)=>b.saved-a.saved);
   renderList();
   report('cloudActionStatus','共有図鑑を 表示中。');
  }catch{
   if(token===listRun&&session===cloudSession)report('cloudActionStatus','共有図鑑を 読み込めなかったよ。もういちど 試してね。');
  }
 }
 $('cloudSignIn')?.addEventListener('click',async()=>{
  try{await cloud?.signIn();}
  catch(error){
   const blocked=['auth/popup-blocked','auth/operation-not-supported-in-this-environment'].includes(error?.code);
   report('cloudActionStatus',blocked?'Safariなどのブラウザで開いて、ポップアップを許可してから、もういちどログインしてね。':'ログインできなかったよ。もういちど 試してね。');
  }
 });
 $('cloudSignOut')?.addEventListener('click',async()=>{try{await cloud?.signOut();}catch{report('cloudActionStatus','ログアウトできなかったよ。もういちど 試してね。');}});
 $('cloudRefresh').addEventListener('click',loadShared);
 window.addEventListener?.('dexCloudReady',hookCloud);
 hookCloud();if(!cloud)cloudChanged({state:'unconfigured'});
 renderPrompt();
})();
