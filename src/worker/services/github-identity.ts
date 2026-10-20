const decode = (value:string) => Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
let keyCache:{expires:number;keys:Array<JsonWebKey & {kid:string}>}|undefined;

/** Only the preparation workflow committed on main may upload prepared media. */
export async function verifyPreparationRunner(authorization:string|undefined):Promise<boolean> {
 if(!authorization?.startsWith('Bearer '))return false;
 try {
  const parts=authorization.slice(7).split('.');if(parts.length!==3)return false;
  const [headerPart,payloadPart,signature]=parts;
  const header=JSON.parse(new TextDecoder().decode(decode(headerPart)));
  const claims=JSON.parse(new TextDecoder().decode(decode(payloadPart)));
  const now=Date.now()/1000;
  if(header.alg!=='RS256' || claims.iss!=='https://token.actions.githubusercontent.com' || claims.aud!=='minattoflix-media'
   || claims.repository!=='rafaelminatto1/minattoflix-v2' || claims.ref!=='refs/heads/main'
   || claims.workflow_ref!=='rafaelminatto1/minattoflix-v2/.github/workflows/prepare-media.yml@refs/heads/main'
   || !Number.isFinite(claims.exp) || claims.exp<=now || claims.nbf>now+30)return false;
  if(!keyCache || keyCache.expires<Date.now()) {
   const response=await fetch('https://token.actions.githubusercontent.com/.well-known/jwks',{signal:AbortSignal.timeout(10000)});
   if(!response.ok)return false;
   const data=await response.json() as {keys:Array<JsonWebKey & {kid:string}>};
   keyCache={keys:data.keys,expires:Date.now()+300000};
  }
  const jwk=keyCache.keys.find(item=>item.kid===header.kid);if(!jwk)return false;
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(signature),new TextEncoder().encode(`${headerPart}.${payloadPart}`));
 }catch{return false;}
}
