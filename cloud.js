import {firebaseConfig} from './firebase-config.js';

const FIREBASE_SDK='https://www.gstatic.com/firebasejs/11.10.0/';
const LIMIT=150, IMAGE_LIMIT=850*1024;
const MIME=new Set(['image/webp','image/png','image/jpeg']);
const TYPES=new Set(['ノーマル','ほのお','みず','でんき','くさ','こおり','かくとう','どく','じめん','ひこう','エスパー','むし','いわ','ゴースト','ドラゴン','あく','はがね','フェアリー']);
const ID=/^[a-z0-9.-]{1,75}$/i;
const observers=new Set();
let current={state:'unconfigured'}, auth, db, sdkAuth, sdkDb, provider, uid=null, generation=0;
function announce(state,email=null,reason=null){
 current=Object.freeze({state,email,reason}); for(const observer of observers){try{observer(current)}catch{}}
}
function token(){
 const who=auth?.currentUser;
 if(current.state!=='ready'||!uid||who?.uid!==uid)throw Error('No authorized family session');
 const tick=generation,key=uid;
 const check=()=>{if(tick!==generation||current.state!=='ready'||uid!==key||auth?.currentUser?.uid!==key)throw Error('Family session changed');};
 check.fail=error=>{
  if(error?.code==='permission-denied'&&tick===generation&&uid===key&&auth?.currentUser?.uid===key){
   generation++;uid=null;announce('unauthorized',null,'access-denied');
  }
  throw error;
 };
 return check;
}
function checkedMeta(row){
 const {id,name,types,saved}=row??{};
 if(typeof id!=='string'||!ID.test(id)||id==='.'||id==='..'||typeof name!=='string'||!name.trim()||name.trim().length>40||
  !Array.isArray(types)||!types.length||types.length>3||new Set(types).size!==types.length||types.some(t=>!TYPES.has(t))||
  !Number.isSafeInteger(saved)||saved<0)throw Error('Invalid dex entry');
 return {id,name:name.trim(),types:[...types],saved};
}
async function decodeCloudImage(blob){
 if(typeof createImageBitmap==='function'){
  try{return await createImageBitmap(blob)}catch{}
 }
 const url=URL.createObjectURL(blob);
 try{
  const img=new Image();
  return await new Promise((resolve,reject)=>{img.onload=()=>resolve(img);img.onerror=reject;img.src=url});
 }finally{URL.revokeObjectURL(url)}
}
async function cloudImage(blob,check){
 if(!(blob instanceof Blob)||!blob.size||!MIME.has(blob.type)||blob.size>2*1024*1024)throw Error('Invalid image');
 if(blob.size<=IMAGE_LIMIT)return blob;
 const img=await decodeCloudImage(blob);
 try{
  check();
  for(const side of [1100,850,650,450,320]){
   const scale=Math.min(1,side/Math.max(img.width,img.height));
   const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));
   canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
   const next=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.78));check();
   if(next?.size&&next.size<=IMAGE_LIMIT&&MIME.has(next.type))return next;
  }
 }finally{img.close?.();}
 throw Error('Shared image too large; local original retained');
}
async function observe(user){
 const seq=++generation;
 uid=null;
 if(!user){announce('signedOut');return}
 announce('connecting',user.email||null);
 try{
  const info=await sdkAuth.getIdTokenResult(user);
  if(seq!==generation||auth.currentUser?.uid!==user.uid)return;
  if(info.signInProvider!=='google.com'||info.claims.email_verified!==true){announce('unauthorized',null,'google-unverified');return}
  const member=await sdkDb.getDocFromServer(sdkDb.doc(db,'familyDexMembers',user.uid));
  if(seq!==generation||auth.currentUser?.uid!==user.uid)return;
  let membership=member.exists()?member.data():null;
  if(!membership){
   // Cross-check a missing result with the official SDK's direct server read.
   // Same Firebase app, signed-in account, database, document and security rules.
   const lite=await import(FIREBASE_SDK+'firebase-firestore-lite.js');
   const exact=await lite.getDoc(lite.doc(lite.getFirestore(auth.app),'familyDexMembers',user.uid));
   if(seq!==generation||auth.currentUser?.uid!==user.uid)return;
   if(!exact.exists()){announce('unauthorized',null,'member-missing');return}
   membership=exact.data();
  }
  if(membership?.enabled!==true){announce('unauthorized',null,'member-disabled');return}
  uid=user.uid;announce('ready',user.email||null);
 }catch(error){
  if(seq!==generation)return;
  announce(error?.code==='permission-denied'?'unauthorized':'error',null,error?.code==='permission-denied'?'rules-denied':null);
 }
}
const cloud={
 diagnosticsUid(){return current.state==='unauthorized' ? auth?.currentUser?.uid??'' : ''},
 subscribe(fn){observers.add(fn);fn(current);return ()=>observers.delete(fn)},
 async signIn(){
  if(!auth)throw Error('Not configured');
  // GitHub Pages is cross-site to Firebase Auth; do not send Safari into the redirect fallback.
  return sdkAuth.signInWithPopup(auth,provider);
 },
 async signOut(){if(!auth)return;const old=auth.currentUser;generation++;uid=null;announce('connecting');try{await sdkAuth.signOut(auth)}catch(error){await observe(old);throw error}},
 async list(){
  const check=token();
  try{
  const entryCollection=sdkDb.collection(db,'familyDexEntries');
  const rows=[];let last;
  for(;;){
   const q=sdkDb.query(entryCollection,sdkDb.orderBy('saved','desc'),...(last?[sdkDb.startAfter(last)]:[]),sdkDb.limit(LIMIT));
   const snap=await sdkDb.getDocsFromServer(q);check();
   for(const d of snap.docs){
    try{
     const data=d.data(),meta=checkedMeta({...data,id:d.id});
     if(!MIME.has(data.mime)||!(data.image instanceof sdkDb.Bytes))continue;
     const bytes=data.image.toUint8Array();
     if(bytes.length&&bytes.length<=IMAGE_LIMIT)rows.push({...meta,image:new Blob([bytes],{type:data.mime})});
    }catch{}
   }
   if(snap.docs.length<LIMIT)return rows;
   last=snap.docs.at(-1);
  }
  }catch(error){check.fail(error)}
 },
 async putIfMissing(row){
  const check=token(),meta=checkedMeta(row);
  try{
  const ref=sdkDb.doc(db,'familyDexEntries',meta.id);
  const original=await sdkDb.getDocFromServer(ref);check();
  if(original.exists())return 'existing';
  const image=await cloudImage(row.image,check);check();
  const raw=await image.arrayBuffer();check();
  const payload={name:meta.name,types:meta.types,saved:meta.saved,mime:image.type,image:sdkDb.Bytes.fromUint8Array(new Uint8Array(raw))};
  return await sdkDb.runTransaction(db,async tx=>{
   check();const present=await tx.get(ref);check();
   if(present.exists())return 'existing';
   tx.set(ref,payload);return 'added';
  });
  }catch(error){check.fail(error)}
 }
};
window.dexCloud=Object.freeze(cloud);window.dispatchEvent(new Event('dexCloudReady'));
if(firebaseConfig?.projectId&&firebaseConfig?.apiKey&&firebaseConfig?.authDomain&&firebaseConfig?.appId){
 announce('connecting');
 const base=FIREBASE_SDK;
 try{
  const [sdkApp,a,f]=await Promise.all([import(base+'firebase-app.js'),import(base+'firebase-auth.js'),import(base+'firebase-firestore.js')]);
  sdkAuth=a;sdkDb=f;
  const app=sdkApp.initializeApp(firebaseConfig);
  auth=a.getAuth(app);db=f.getFirestore(app);provider=new a.GoogleAuthProvider();
  provider.setCustomParameters({prompt:'select_account'});
  a.onAuthStateChanged(auth,observe,()=>announce('error'));
 }catch{announce('error')}
}
