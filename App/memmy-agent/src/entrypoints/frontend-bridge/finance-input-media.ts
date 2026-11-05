import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Resolve only an authenticated gateway's own signed webui upload. Never fetch a URL. */
export function resolveFinanceInputMedia(ref:string,secret:Buffer,mediaDir:string,uploadDir:string):string {
  const fail=()=>{throw new Error("請重新加入 PDF，文件連結無效或已過期。");};
  let route=ref;
  if(!ref.startsWith("/")) {
    let url:URL;try{url=new URL(ref);}catch{return fail();}
    if(url.protocol!=="http:" || !["127.0.0.1","localhost"].includes(url.hostname) || url.username || url.password || url.search || url.hash)return fail();
    route=url.pathname;
  }
  const match=/^\/api\/media\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(route);
  if(!match)return fail();
  const [,signature,payload]=match;
  const supplied=Buffer.from(signature!,"base64url");
  const expected=crypto.createHmac("sha256",secret).update(payload!).digest().subarray(0,16);
  if(supplied.length!==expected.length || !crypto.timingSafeEqual(supplied,expected))return fail();
  const relative=Buffer.from(payload!,"base64url").toString("utf8");
  if(!relative || relative.includes("\0") || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p=>p===".."))return fail();
  try {
    const root=fs.realpathSync(uploadDir),real=fs.realpathSync(path.resolve(fs.realpathSync(mediaDir),relative)),rel=path.relative(root,real);
    if(!rel || rel.startsWith("..") || path.isAbsolute(rel) || !fs.statSync(real).isFile() || path.extname(real).toLowerCase()!==".pdf")return fail();
    return real;
  } catch{return fail();}
}
