import {lookup} from 'node:dns/promises';
import https from 'node:https';
import {isIP} from 'node:net';
import {Readable} from 'node:stream';
export function publicAddress(address) {
 if(address.includes(':')) return /^[23][a-f0-9]{3}:/i.test(address) && !/^2001:(db8|0):/i.test(address);
 const parts=address.split('.').map(Number); if(parts.length!==4||parts.some(n=>!Number.isInteger(n)||n<0||n>255))return false;
 const [a,b,c]=parts;return a>0&&a<224&&a!==10&&a!==127&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0&&c===0||b===0&&c===2))&&!(a===100&&b>=64&&b<=127)&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);
}
// Pin the resolved public IP for this request, while keeping the declared host for TLS.
export function routedAddress(address,hostname) {
  // System TUN clients map public hostnames into the benchmarking range. TLS
  // still verifies the declared host; literal IP/local names never get this exception.
  return publicAddress(address) || /^198\.(18|19)\./.test(address) && !isIP(hostname) && hostname.includes('.') && !/\.(local|localhost|internal)$/.test(hostname);
}
async function abortable(promise, signal) {
 if(!signal)return promise;
 signal.throwIfAborted();
 let onAbort;
 const aborted=new Promise((_,reject)=>{onAbort=()=>reject(signal.reason??new Error('请求已取消。'));signal.addEventListener('abort',onAbort,{once:true});});
 try{return await Promise.race([promise,aborted]);}finally{signal.removeEventListener('abort',onAbort);}
}
export async function secureRequest(address, options = {}) {
 const {allowRedirectResponses=false,...requestOptions}=options;
 const url=new URL(address);if(url.protocol!=='https:'||url.username||url.password)throw new Error('网络请求地址无效。');
 options.signal?.throwIfAborted();
 const resolved=await abortable(lookup(url.hostname,{all:true}),options.signal);if(!resolved.length||resolved.some(row=>!routedAddress(row.address,url.hostname)))throw new Error('插件网络代理禁止访问本机和私有网络。');
 options.signal?.throwIfAborted();const selected=resolved[0],request=new Request(address,requestOptions),body=request.body?Buffer.from(await request.arrayBuffer()):null;
 return new Promise((resolve,reject)=>{
  const headers=Object.fromEntries(request.headers);if(body)headers['content-length']=String(body.length);
  const req=https.request(url,{method:request.method,headers,signal:options.signal,lookup:(_host,settings,callback)=>{if(settings.all)callback(null,[selected]);else callback(null,selected.address,selected.family);}},response=>{
   const values=new Headers();for(const [key,value] of Object.entries(response.headers)) if(value!==undefined)values.set(key,Array.isArray(value)?value.join(', '):value);
   // Redirects remain errors; credentials are never forwarded to another origin.
   if(response.statusCode>=300&&response.statusCode<400){
    if(!allowRedirectResponses){response.destroy();reject(new Error('服务重定向被拒绝。'));return;}
    resolve(new Response(null,{status:response.statusCode,headers:values}));
    response.resume();
    return;
   }
   resolve(new Response([204,205,304].includes(response.statusCode)?null:Readable.toWeb(response),{status:response.statusCode,headers:values}));
  });req.once('error',reject);req.end(body);
 });
}
