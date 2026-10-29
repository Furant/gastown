import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt=promisify(scryptCb);
export const hashToken = token => createHash('sha256').update(token).digest('hex');
export async function hashPassword(password) {
 if(typeof password!=='string'||password.length<12||password.length>256) throw Object.assign(new Error('Password must be 12–256 characters'),{status:400,code:'invalid_password'});
 const salt=randomBytes(16),key=await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
 return `scrypt$16384$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}
export async function verifyPassword(password,encoded) {
 try {const [kind,n,r,p,saltHex,keyHex]=encoded.split('$');if(kind!=='scrypt')return false;const expected=Buffer.from(keyHex,'hex');const actual=await scrypt(password,Buffer.from(saltHex,'hex'),expected.length,{N:Number(n),r:Number(r),p:Number(p),maxmem:64*1024*1024});return expected.length===actual.length&&timingSafeEqual(expected,actual);}catch{return false;}
}
export const randomToken=(bytes=32)=>randomBytes(bytes).toString('base64url');
